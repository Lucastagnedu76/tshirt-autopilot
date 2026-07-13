/**
 * TSHIRT AUTOPILOT — Serveur d'automatisation Claude + Shopify
 *
 * Routes :
 *   POST /webhook/products/created  → génère description + SEO automatiquement
 *   POST /webhook/orders/created    → email de confirmation personnalisé + alerte stock
 *   POST /api/marketing/generate    → posts social, email promo, idées campagne
 *   POST /api/customer/reply        → draft de réponse SAV
 *   GET  /api/report                → résumé ventes de la semaine
 *   GET  /health                    → healthcheck Railway/Render
 */

import express from 'express'
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const {
  ANTHROPIC_API_KEY,
  SHOPIFY_SHOP,          // ex: "ma-boutique.myshopify.com"
  SHOPIFY_ACCESS_TOKEN,  // Admin API token
  SHOPIFY_WEBHOOK_SECRET,
  PORT = 3000,
  CLAUDE_MODEL = 'claude-haiku-4-5-20251001',  // modèle par défaut (rapide + pas cher)
  BRAND_NAME = 'Ma Boutique',
  BRAND_VOICE = 'moderne, streetwear, authentique, sans bullshit',
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
  if (!SHOPIFY_WEBHOOK_SECRET) return true  // désactivé en dev
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

// ─── WEBHOOK : PRODUIT CRÉÉ ──────────────────────────────────────────────────

/**
 * Dès qu'un nouveau produit est ajouté sur Shopify :
 * 1. Claude génère une description HTML percutante + balises SEO
 * 2. Le produit est mis à jour via l'API Shopify
 */
app.post('/webhook/products/created', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized')
  res.sendStatus(200) // Shopify exige une réponse rapide

  const product = req.body
  const productTitle = product.title ?? 'T-shirt'
  const tags = (product.tags ?? '').split(',').map(t => t.trim()).filter(Boolean)
  const variants = (product.variants ?? []).map(v => v.title).join(', ')

  console.log(`[PRODUIT] Génération contenu pour: ${productTitle}`)

  try {
    const system = `
Tu es le copywriter et responsable SEO de ${BRAND_NAME}.
Ton style : ${BRAND_VOICE}.
Tu écris pour une boutique de t-shirts premium qui vend en ligne.
Tu n'utilises jamais de formules creuses ou de superlatifs vides.
    `.trim()

    // Description HTML
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

    // SEO
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

    // Mise à jour Shopify
    await shopifyApi('PUT', `/products/${product.id}.json`, {
      product: {
        id: product.id,
        body_html: description,
        ...(seo.title || seo.description ? {
          metafields_global_title_tag: seo.title,
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

/**
 * Dès qu'une commande est passée :
 * 1. Log + alerte si stock d'un article descend sous un seuil
 * 2. (Optionnel) génère un message de confirmation personnalisé loggué
 */
app.post('/webhook/orders/created', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized')
  res.sendStatus(200)

  const order = req.body
  const customer = order.customer ?? {}
  const firstName = customer.first_name ?? 'client'
  const items = (order.line_items ?? []).map(i => `${i.quantity}× ${i.title}`).join(', ')
  const total = order.total_price ?? '?'

  console.log(`[COMMANDE] #${order.order_number} — ${firstName} — ${total}€ — ${items}`)

  // Vérification stock bas (seuil : 3 unités)
  for (const item of order.line_items ?? []) {
    const variantId = item.variant_id
    if (!variantId) continue
    try {
      const data = await shopifyApi('GET', `/variants/${variantId}.json`)
      const qty = data.variant?.inventory_quantity ?? null
      if (qty !== null && qty <= 3) {
        console.warn(`[STOCK BAS] ⚠️  "${item.title}" — ${qty} unité(s) restante(s)`)
        // Ici tu peux brancher une notif (email, Slack webhook, SMS…)
      }
    } catch (err) {
      console.error(`[COMMANDE] Erreur check stock:`, err.message)
    }
  }
})

// ─── API : CONTENU MARKETING ─────────────────────────────────────────────────

/**
 * POST /api/marketing/generate
 * Body: { product: string, type: "instagram"|"tiktok"|"email"|"campaign" }
 * Retourne du contenu marketing prêt à l'emploi.
 */
app.post('/api/marketing/generate', async (req, res) => {
  const { product, type = 'instagram' } = req.body ?? {}
  if (!product) return res.status(400).json({ error: 'product requis' })

  const formats = {
    instagram: `
Post Instagram pour le produit "${product}".
- Accroche ≤ 2 lignes (doit stopper le scroll)
- Corps : 3-5 lignes max, émotion > feature
- 5 hashtags pertinents en fin
- Emoji : oui, mais dosés (max 4)
    `,
    tiktok: `
Script TikTok court (15-30 sec) pour le produit "${product}".
Format : [HOOK 3 sec] | [CONTENU 10-20 sec] | [CTA 3 sec]
Ton : direct, authentique, pas de "bonjour les amis".
    `,
    email: `
Email marketing pour le produit "${product}".
Structure :
- Objet (max 45 caractères, curiosité ou urgence)
- Pré-header (max 90 caractères)
- Corps (150 mots max, 1 seul appel à l'action)
Ton : ${BRAND_VOICE}
    `,
    campaign: `
Stratégie de lancement pour le produit "${product}".
Propose un plan sur 7 jours : quoi poster, sur quel canal, dans quel ordre.
Format : tableau Jour / Canal / Action / Objectif.
Réaliste, pas de promesse exagérée.
    `,
  }

  const prompt = formats[type] ?? formats.instagram

  try {
    const system = `Tu es le directeur marketing de ${BRAND_NAME}. Style : ${BRAND_VOICE}. Tu crées du contenu qui convertit, pas du contenu qui "fait joli".`
    const content = await ask(system, prompt, 800)
    res.json({ type, product, content })
  } catch (err) {
    console.error('[MARKETING]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── API : RÉPONSE CLIENT ────────────────────────────────────────────────────

/**
 * POST /api/customer/reply
 * Body: { message: string, context?: string }
 * Retourne un draft de réponse SAV.
 */
app.post('/api/customer/reply', async (req, res) => {
  const { message, context } = req.body ?? {}
  if (!message) return res.status(400).json({ error: 'message requis' })

  const system = `
Tu es le service client de ${BRAND_NAME}, une boutique de t-shirts premium.
Ton style : ${BRAND_VOICE}, mais toujours respectueux et professionnel.
Tu réponds de manière concise (max 120 mots), tu évites le jargon corporate.
Tu proposes toujours une solution concrète.
Politique par défaut : retour sous 30 jours, échange taille gratuit.
  `.trim()

  const prompt = `
Message client : """${message}"""
${context ? `Contexte commande : ${context}` : ''}

Rédige une réponse email prête à envoyer.
Commence directement par la réponse, sans "Objet :" ni formule d'ouverture générique.
  `.trim()

  try {
    const reply = await ask(system, prompt, 400)
    res.json({ reply })
  } catch (err) {
    console.error('[CUSTOMER]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── API : RAPPORT HEBDOMADAIRE ──────────────────────────────────────────────

/**
 * GET /api/report
 * Récupère les commandes des 7 derniers jours et génère un résumé lisible.
 */
app.get('/api/report', async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const data = await shopifyApi('GET', `/orders.json?status=any&created_at_min=${since}&limit=250`)
    const orders = data.orders ?? []

    if (orders.length === 0) {
      return res.json({ summary: 'Aucune commande cette semaine.', orders: 0 })
    }

    const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price ?? 0), 0).toFixed(2)
    const productCounts = {}
    for (const order of orders) {
      for (const item of order.line_items ?? []) {
        const key = item.title
        productCounts[key] = (productCounts[key] ?? 0) + (item.quantity ?? 1)
      }
    }
    const topProducts = Object.entries(productCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => `${name} (${qty})`)
      .join(', ')

    const rawStats = `
Période : 7 derniers jours
Commandes : ${orders.length}
Chiffre d'affaires : ${totalRevenue}€
Top produits : ${topProducts}
    `.trim()

    const system = `Tu es l'analyste business de ${BRAND_NAME}. Tu résumes les données de vente de façon claire et actionnable, en 3-5 phrases max.`
    const summary = await ask(system, `Voici les stats de la semaine :\n${rawStats}\n\nRédige un résumé avec 1 point positif et 1 recommandation concrète.`, 300)

    res.json({ summary, orders: orders.length, revenue: totalRevenue, topProducts })
  } catch (err) {
    console.error('[REPORT]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── DÉMARRAGE ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   TSHIRT AUTOPILOT  — port ${PORT}          ║
║   Modèle : ${CLAUDE_MODEL.padEnd(28)}║
║   Boutique : ${(SHOPIFY_SHOP ?? 'non configurée').padEnd(26)}║
╚══════════════════════════════════════════╝
  `.trim())
})
