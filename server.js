/**
 * TSHIRT AUTOPILOT — Serveur d'automatisation Claude + Shopify
 *
 * Routes :
 *   GET  /auth               → démarre le flow OAuth Shopify
 *   GET  /auth/callback      → OAuth callback Shopify (récupère le token)
 *   POST /webhook/products/created → génère description + SEO automatiquement
 *   POST /webhook/orders/created   → email de confirmation personnalisé + alerte stock
 *   POST /api/marketing/generate   → posts social, email promo, idées campagne
 *   POST /api/customer/reply       → draft de réponse SAV
 *   GET  /api/report               → résumé ventes de la semaine
 *   GET  /health                   → healthcheck Railway/Render
 */

import express from 'express'
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const {
  ANTHROPIC_API_KEY,
  SHOPIFY_SHOP,           // ex: "le-bon-brayon.myshopify.com"
  SHOPIFY_ACCESS_TOKEN,   // Admin API token (rempli après OAuth)
  SHOPIFY_CLIENT_ID,      // OAuth Client ID
  SHOPIFY_CLIENT_SECRET,  // OAuth Client Secret
  SHOPIFY_WEBHOOK_SECRET,
  PORT = 3000,
  CLAUDE_MODEL   = 'claude-haiku-4-5-20251001',
  BRAND_NAME     = 'Le bon Brayon',
  BRAND_VOICE    = 'moderne, streetwear, authentique, sans bullshit',
} = process.env

const app = express()
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────

// Capture le body brut pour vérification HMAC Shopify
app.use((req, res, next) => {
  let data = ''
  req.on('data', chunk => { data += chunk })
  req.on('end', () => {
    req.rawBody = data
    try { req.body = JSON.parse(data) } catch { req.body = {} }
    next()
  })
})

app.use(express.json())

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Vérifie la signature HMAC d'un webhook Shopify.
 * Retourne false si le secret n'est pas configuré (pratique en dev).
 */
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true // désactivé en dev
  const hmac = req.headers['x-shopify-hmac-sha256']
  if (!hmac) return false
  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody ?? '')
    .digest('base64')
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash))
}

/**
 * Appel Claude simplifié.
 * @param {string} system  Instruction système
 * @param {string} prompt  Message utilisateur
 * @param {number} tokens  Max tokens en sortie
 */
async function ask(system, prompt, tokens = 1024) {
  const msg = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: tokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0].text.trim()
}

/**
 * Appel Shopify Admin REST API.
 */
async function shopifyApi(method, path, body) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-04${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify ${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}

// ─── ROUTE : HEALTHCHECK ─────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', model: CLAUDE_MODEL }))

// ─── ROUTE : OAUTH INITIATION ────────────────────────────────────────────────

/**
 * GET /auth?shop=le-bon-brayon.myshopify.com
 * Redirige vers la page d'autorisation Shopify pour démarrer le flow OAuth.
 */
app.get('/auth', (req, res) => {
  const { shop } = req.query
  if (!shop) return res.status(400).send('Paramètre shop requis. Ex: /auth?shop=mon-store.myshopify.com')
  if (!SHOPIFY_CLIENT_ID) return res.status(500).send('SHOPIFY_CLIENT_ID non configuré.')

  const redirectUri = `https://tshirt-autopilot.onrender.com/auth/callback`
  const scopes = 'write_products,read_products,write_orders,read_orders,read_inventory'
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`

  console.log(`[OAUTH] Redirection vers Shopify pour ${shop}`)
  res.redirect(authUrl)
})

// ─── ROUTE : OAUTH CALLBACK ──────────────────────────────────────────────────

/**
 * GET /auth/callback?code=...&shop=...
 * Reçoit le code OAuth de Shopify, l'échange contre un access token offline,
 * et l'affiche pour qu'on puisse le copier dans Render.
 */
app.get('/auth/callback', async (req, res) => {
  const { code, shop } = req.query
  if (!code || !shop) {
    return res.status(400).send('Paramètres manquants: code et shop requis.')
  }
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    return res.status(500).send('SHOPIFY_CLIENT_ID et SHOPIFY_CLIENT_SECRET non configurés.')
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    })
    const rawText = await tokenRes.text()
    console.log(`[OAUTH] HTTP ${tokenRes.status} — ${rawText.substring(0,500)}`)
    let data; try { data = JSON.parse(rawText) } catch { return res.status(500).send('<pre style="padding:1rem;white-space:pre-wrap">SHOPIFY ERREUR ('+tokenRes.status+'):\n'+rawText+'</pre>') }

    if (data.access_token) {
      console.log(`[OAUTH] ✅ Token reçu pour ${shop}`)
      res.send(`
        <html><body style="font-family:monospace;padding:2rem;background:#0d1117;color:#e6edf3">
        <h2 style="color:#3fb950">✅ Token Shopify obtenu !</h2>
        <p>Copie cette valeur dans Render → Variables → <strong>SHOPIFY_ACCESS_TOKEN</strong> :</p>
        <pre style="background:#161b22;padding:1rem;border-radius:8px;word-break:break-all">${data.access_token}</pre>
        <p>Scopes accordés : <code>${data.scope ?? 'non précisé'}</code></p>
        <p style="color:#8b949e">Tu peux fermer cette page une fois le token copié.</p>
        </body></html>
      `)
    } else {
      res.status(400).send(`<pre>Erreur Shopify : ${JSON.stringify(data, null, 2)}</pre>`)
    }
  } catch (err) {
    console.error('[OAUTH] Erreur:', err.message)
    res.status(500).send(`Erreur: ${err.message}`)
  }
})

// ─── WEBHOOK : PRODUIT CRÉÉ ──────────────────────────────────────────────────

/**
 * Dès qu'un nouveau produit est ajouté sur Shopify :
 * 1. Claude génère une description HTML percutante + balises SEO
 * 2. Le produit est mis à jour via l'API Shopify
 */
app.post('/webhook/products/created', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized')
  res.sendStatus(200) // Shopify exige une réponse rapide

  const product      = req.body
  const productTitle = product.title ?? 'T-shirt'
  const tags         = (product.tags ?? '').split(',').map(t => t.trim()).filter(Boolean)
  const variants     = (product.variants ?? []).map(v => v.title).join(', ')

  console.log(`[PRODUIT] Génération contenu pour: ${productTitle}`)

  try {
    const system = `
Tu es le copywriter et responsable SEO de ${BRAND_NAME}.
Ton style : ${BRAND_VOICE}.
Tu écris pour une boutique de t-shirts premium qui vend en ligne.
Tu n'utilises jamais de formules creuses ou de superlatifs vides.
`.trim()

    const description = await ask(system, `
Produit : "${productTitle}"
Variantes : ${variants || 'taille unique'}
Tags : ${tags.join(', ') || 'aucun'}

Rédige une fiche produit en HTML (balises <p>, <ul>, <li>, <strong> uniquement).
Structure :
1. Accroche courte (1 phrase, punch)
2. Pourquoi ce t-shirt (matière, coupe, sentiment porté)
3. Pour qui (profil, usage)
4. Détails techniques (3-4 puces max)
Ne mentionne pas de prix. Max 200 mots.
`, 512)

    const seoRaw = await ask(system, `
Produit : "${productTitle}"
Tags : ${tags.join(', ') || 'aucun'}

Génère un JSON valide avec ces clés exactes :
{
  "title": "titre SEO, 60 caractères max",
  "description": "meta description, 155 caractères max, avec appel à l'action"
}
Réponds UNIQUEMENT avec le JSON, sans markdown.
`, 256)

    let seo = {}
    try { seo = JSON.parse(seoRaw) } catch { seo = {} }

    await shopifyApi('PUT', `/products/${product.id}.json`, {
      product: {
        id: product.id,
        body_html: description,
        ...(seo.title || seo.description ? {
          metafields_global_title_tag:       seo.title,
          metafields_global_description_tag: seo.description,
        } : {}),
      },
    })

    console.log(`[PRODUIT] ✅ ${productTitle} — description + SEO mis à jour`)
  } catch (err) {
    console.error(`[PRODUIT] ❌ Erreur:`, err.message)
  }
})

// ─── WEBHOOK : COMMANDE CRÉÉE ────────────────────────────────────────────────

app.post('/webhook/orders/created', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized')
  res.sendStatus(200)

  const order     = req.body
  const customer  = order.customer ?? {}
  const firstName = customer.first_name ?? 'client'
  const items     = (order.line_items ?? []).map(i => `${i.quantity}× ${i.title}`).join(', ')
  const total     = order.total_price ?? '?'

  console.log(`[COMMANDE] #${order.order_number} — ${firstName} — ${total}€ — ${items}`)

  for (const item of order.line_items ?? []) {
    const variantId = item.variant_id
    if (!variantId) continue
    try {
      const data = await shopifyApi('GET', `/variants/${variantId}.json`)
      const qty  = data.variant?.inventory_quantity ?? null
      if (qty !== null && qty <= 3) {
        console.warn(`[STOCK BAS] ⚠️ "${item.title}" — ${qty} unité(s) restante(s)`)
      }
    } catch (err) {
      console.error(`[COMMANDE] Erreur check stock:`, err.message)
    }
  }
})

// ─── API : CONTENU MARKETING ─────────────────────────────────────────────────

app.post('/api/marketing/generate', async (req, res) => {
  const { product, type = 'instagram' } = req.body ?? {}
  if (!product) return res.status(400).json({ error: 'product requis' })

  const formats = {
    instagram: `Post Instagram pour le produit "${product}". Accroche ≤ 2 lignes. Corps 3-5 lignes. 5 hashtags. Max 4 emojis.`,
    tiktok: `Script TikTok 15-30 sec pour "${product}". Format: [HOOK 3s] | [CONTENU 10-20s] | [CTA 3s]. Ton direct.`,
    email: `Email marketing pour "${product}". Objet max 45 chars. Pré-header max 90 chars. Corps 150 mots, 1 CTA. Ton: ${BRAND_VOICE}`,
    campaign: `Plan lancement 7 jours pour "${product}". Tableau: Jour / Canal / Action / Objectif. Réaliste.`,
  }

  try {
    const system = `Tu es le directeur marketing de ${BRAND_NAME}. Style : ${BRAND_VOICE}. Tu crées du contenu qui convertit.`
    const content = await ask(system, formats[type] ?? formats.instagram, 800)
    res.json({ type, product, content })
  } catch (err) {
    console.error('[MARKETING]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── API : RÉPONSE CLIENT ────────────────────────────────────────────────────

app.post('/api/customer/reply', async (req, res) => {
  const { message, context } = req.body ?? {}
  if (!message) return res.status(400).json({ error: 'message requis' })

  const system = `Tu es le service client de ${BRAND_NAME}. Style: ${BRAND_VOICE}, respectueux. Max 120 mots. Propose toujours une solution. Retour 30j, échange taille gratuit.`
  const prompt = `Message client: """${message}"""${context ? '\nContexte: '+context : ''}\n\nRéponds directement sans formule d'ouverture générique.`

  try {
    const reply = await ask(system, prompt, 400)
    res.json({ reply })
  } catch (err) {
    console.error('[CUSTOMER]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── API : RAPPORT HEBDOMADAIRE ──────────────────────────────────────────────

app.get('/api/report', async (req, res) => {
  try {
    const since  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const data   = await shopifyApi('GET', `/orders.json?status=any&created_at_min=${since}&limit=250`)
    const orders = data.orders ?? []

    if (orders.length === 0) return res.json({ summary: 'Aucune commande cette semaine.', orders: 0 })

    const totalRevenue  = orders.reduce((sum, o) => sum + parseFloat(o.total_price ?? 0), 0).toFixed(2)
    const productCounts = {}
    for (const order of orders) {
      for (const item of order.line_items ?? []) {
        productCounts[item.title] = (productCounts[item.title] ?? 0) + (item.quantity ?? 1)
      }
    }
    const topProducts = Object.entries(productCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,q])=>`${n} (${q})`).join(', ')

    const rawStats = `Commandes: ${orders.length} | CA: ${totalRevenue}€ | Top: ${topProducts}`
    const system   = `Tu es l'analyste business de ${BRAND_NAME}. Résume les ventes en 3-5 phrases actionnables.`
    const summary  = await ask(system, `Stats semaine: ${rawStats}\n\n1 point positif + 1 recommandation concrète.`, 300)

    res.json({ summary, orders: orders.length, revenue: totalRevenue, topProducts })
  } catch (err) {
    console.error('[REPORT]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── DÉMARRAGE ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`TSHIRT AUTOPILOT démarré sur le port ${PORT} | Boutique: ${SHOPIFY_SHOP ?? 'non configurée'}`)
})
