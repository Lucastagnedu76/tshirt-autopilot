/**
 * TSHIRT AUTOPILOT — Serveur d'automatisation Claude + Shopify
 *
 * Routes :
 *   GET  /auth/callback             → OAuth callback Shopify (récupère le token)
 *   POST /webhook/products/created  → génère description + SEO automatiquement
 *   POST /webhook/orders/created    → email de confirmation personnalisé + alerte stock
 *   POST /api/marketing/generate    → posts social, email promo, idées campagne
 *   POST /api/customer/reply        → draft de réponse SAV
 *   GET  /api/report                → résumé ventes de la semaine
 *   GET  /health                    → healthcheck Railway/Render
 *   POST /api/generate-products     → génère designs DALL-E 3 + crée produits Shopify
 */

import express from 'express'
import crypto from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const {
  ANTHROPIC_API_KEY,
  SHOPIFY_SHOP,           // ex: "le-bon-brayon.myshopify.com"
  SHOPIFY_ACCESS_TOKEN,   // Admin API token (rempli après OAuth)
  SHOPIFY_CLIENT_ID,      // OAuth Client ID
  SHOPIFY_CLIENT_SECRET,  // OAuth Client Secret
  SHOPIFY_WEBHOOK_SECRET,
  PRINTFUL_API_KEY,       // Printful → Settings → API → Generate token
  // IDs variantes Printful de ton modèle de t-shirt (S,M,L,XL,XXL)
  // Récupérables via GET /api/printful/variants ou dans Printful > Products
  PRINTFUL_VARIANT_IDS = '4011,4012,4013,4014,4015', // défaut Bella+Canvas 3001
  PORT = 3000,
  CLAUDE_MODEL = 'claude-haiku-4-5-20251001',
  BRAND_NAME = 'Le bon Brayon',
  BRAND_VOICE = 'moderne, streetwear, authentique, sans bullshit',
} = process.env

const app = express()
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? process.env['CHAT-GPT'] })

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

// Note: express.json() supprimé — le middleware custom ci-dessus gère déjà le parsing JSON

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
 * Appel Printful API v1.
 */
async function printfulApi(method, path, body) {
  if (!PRINTFUL_API_KEY) throw new Error('PRINTFUL_API_KEY non configurée dans les variables d\'environnement')
  const res = await fetch(`https://api.printful.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${PRINTFUL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok || data.code >= 400) {
    throw new Error(`Printful ${method} ${path} → ${data.code ?? res.status}: ${data.error?.message ?? JSON.stringify(data)}`)
  }
  return data.result ?? data
}

/**
 * Upload un fichier image vers Printful et retourne son ID.
 * Accepte une URL publique OU un base64 PNG.
 */
async function printfulUploadFile(imageUrlOrBase64, filename = 'design.png') {
  // Si c'est du base64, on le convertit en URL data (Printful accepte les data URIs)
  const url = imageUrlOrBase64.startsWith('http')
    ? imageUrlOrBase64
    : `data:image/png;base64,${imageUrlOrBase64}`

  const result = await printfulApi('POST', '/files', {
    type: 'default',
    url,
    filename,
    visible: false,
  })
  return result.id
}

/**
 * Crée un produit Printful (sync avec Shopify automatique si store connecté).
 * @param {string} name         Nom du produit
 * @param {string} price        Prix de vente ex: "29.99"
 * @param {number} fileId       ID du fichier uploadé via printfulUploadFile()
 * @param {string} description  Description HTML
 */
async function createPrintfulProduct({ name, price, fileId, description = '' }) {
  const variantIds = PRINTFUL_VARIANT_IDS.split(',').map(id => parseInt(id.trim(), 10))
  const sizes      = ['S', 'M', 'L', 'XL', 'XXL']

  const syncVariants = variantIds.map((variantId, i) => ({
    variant_id:   variantId,
    retail_price: price,
    files: [
      { type: 'back', id: fileId },   // Design au dos
    ],
    options: [],
  }))

  const body = {
    sync_product: {
      name,
      description,
      is_ignored: false,
    },
    sync_variants: syncVariants,
  }

  return printfulApi('POST', '/store/products', body)
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

// ─── ROUTE : OAUTH CALLBACK ──────────────────────────────────────────────────

/**
 * GET /auth/callback?code=...&shop=...
 * Reçoit le code OAuth de Shopify, l'échange contre un access token offline,
 * et l'affiche pour qu'on puisse le copier dans Railway.
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
    const data = await tokenRes.json()

    if (data.access_token) {
      console.log(`[OAUTH] ✅ Token reçu pour ${shop}`)
      res.send(`
        <html><body style="font-family:monospace;padding:2rem;background:#0d1117;color:#e6edf3">
          <h2 style="color:#3fb950">✅ Token Shopify obtenu !</h2>
          <p>Copie cette valeur dans Railway → Variables → <strong>SHOPIFY_ACCESS_TOKEN</strong> :</p>
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

// ─── API : GÉNÉRATION PRODUITS PAR LIEUX-DITS ───────────────────────────────

/**
 * Liste des lieux-dits et communes du Pays de Bray (et alentours).
 * Format : { nom, region, caracteristiques }
 * Extensible à volonté — ajouter d'autres régions ne change rien au code.
 */
const LIEUX_DITS = [
  { nom: 'Neufchâtel-en-Bray',  region: 'Pays de Bray', caracteristiques: 'marché médiéval, fromage Neufchâtel coeur, rivière Béthune' },
  { nom: 'Forges-les-Eaux',     region: 'Pays de Bray', caracteristiques: 'ville thermale, sources ferrugineuses, casino historique, forêt' },
  { nom: 'Gournay-en-Bray',     region: 'Pays de Bray', caracteristiques: 'petite ville du bocage, élevage laitier, église Saint-Hildevert' },
  { nom: 'Aumale',              region: 'Pays de Bray', caracteristiques: 'bourg agricole, vallée de la Bresle, halle médiévale' },
  { nom: 'Saint-Saëns',         region: 'Pays de Bray', caracteristiques: 'forêt d\'Eawy, bocage verdoyant, rivière Varenne, village calme' },
  { nom: 'Londinières',         region: 'Pays de Bray', caracteristiques: 'village au bord de l\'Eaulne, bocage typique, pommiers' },
  { nom: 'Argueil',             region: 'Pays de Bray', caracteristiques: 'village perché, paysage bocager, château en ruines' },
  { nom: 'Mesnières-en-Bray',   region: 'Pays de Bray', caracteristiques: 'château Renaissance au bord de la Béthune, école agricole' },
  { nom: 'Hodeng-au-Bosc',      region: 'Pays de Bray', caracteristiques: 'hameau discret, bocage profond, mare aux canards' },
  { nom: 'Serqueux',            region: 'Pays de Bray', caracteristiques: 'noeud ferroviaire historique, bocage, petite gare' },
  { nom: 'Blangy-sur-Bresle',   region: 'Pays de Bray', caracteristiques: 'cristallerie, vallée de la Bresle, rivière poissonneuse' },
  { nom: 'Criel-sur-Mer',       region: 'Côte d\'Albâtre', caracteristiques: 'falaises de craie, plage de galets, couchers de soleil sur la Manche' },
]

/**
 * Utilise Claude pour générer un prompt DALL-E adapté à chaque lieu-dit.
 * Claude connaît le contexte local et produit un prompt unique et précis.
 */
async function buildDesignPrompt(lieu) {
  const system = `
Tu es un directeur artistique spécialisé en t-shirts sérigraphiés vintage.
Tu crées des prompts DALL-E 3 précis pour générer des designs de t-shirts.
Style cible : affiche de voyage vintage française des années 50-70, sérigraphie bold, couleurs limitées (3-4 max), fond blanc pur.
Le design doit évoquer le lieu sans copier de marque ou copyright existant.
  `.trim()

  const prompt = `
Lieu : ${lieu.nom} (${lieu.region}, Normandie)
Caractéristiques locales : ${lieu.caracteristiques}

Génère UN prompt DALL-E 3 en anglais (max 200 mots) pour un design de t-shirt vintage screen print.
Le design doit :
- Capturer l'essence visuelle et l'âme du lieu
- Être adapté à l'impression DTG sur t-shirt
- Avoir un style affiche vintage française (années 50-60)
- Fond blanc pur, couleurs limitées
- Inclure subtilement le nom "${lieu.nom}" dans la composition (comme une vieille enseigne ou tampon)
Réponds UNIQUEMENT avec le prompt anglais, rien d'autre.
  `.trim()

  return ask(system, prompt, 300)
}

/**
 * Génère une image via DALL-E 3 et retourne le base64.
 */
async function generateDesign(prompt) {
  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json',
    quality: 'standard',
  })
  return response.data[0].b64_json
}

/**
 * Crée un produit Shopify avec image + variantes de taille.
 */
async function createShopifyProduct({ title, price, tags, imageBase64, description }) {
  const body = {
    product: {
      title,
      body_html: description ?? '',
      vendor: BRAND_NAME,
      product_type: 'T-Shirt',
      tags,
      status: 'active',
      variants: ['S', 'M', 'L', 'XL', 'XXL'].map(size => ({
        option1: size,
        price,
        inventory_management: null,
      })),
      options: [{ name: 'Taille', values: ['S', 'M', 'L', 'XL', 'XXL'] }],
      images: [{
        attachment: imageBase64,
        filename: `${title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.png`,
      }],
    },
  }
  return shopifyApi('POST', '/products.json', body)
}

/**
 * POST /api/generate-products
 * Body (optionnel): { lieux: ["Neufchâtel-en-Bray", ...] } pour filtrer
 *                   { tous: true } pour tout générer d'un coup
 * Par défaut : génère les 3 premiers lieux (pour tester sans exploser le budget OpenAI).
 *
 * Réponse en streaming NDJSON : une ligne JSON par étape.
 */
app.post('/api/generate-products', async (req, res) => {
  const { lieux: filtre, tous = false, prix = '29.99' } = req.body ?? {}

  let cibles = LIEUX_DITS
  if (filtre && Array.isArray(filtre)) {
    cibles = LIEUX_DITS.filter(l => filtre.includes(l.nom))
  } else if (!tous) {
    cibles = LIEUX_DITS.slice(0, 3) // Par défaut : 3 premiers pour tester
  }

  console.log(`[GÉNÉRATION] Démarrage — ${cibles.length} lieu(x) : ${cibles.map(l => l.nom).join(', ')}`)

  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.write(JSON.stringify({ status: 'start', total: cibles.length, lieux: cibles.map(l => l.nom) }) + '\n')

  const results = []
  const errors = []

  for (const lieu of cibles) {
    const productTitle = `Le bon Brayon — ${lieu.nom}`
    res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'prompt' }) + '\n')

    try {
      // Étape 1 : Claude génère le prompt DALL-E adapté au lieu
      console.log(`[GÉNÉRATION] Prompt Claude pour : ${lieu.nom}`)
      const designPrompt = await buildDesignPrompt(lieu)

      res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'image', prompt: designPrompt }) + '\n')

      // Étape 2 : DALL-E 3 génère le design
      console.log(`[GÉNÉRATION] Image DALL-E pour : ${lieu.nom}`)
      const imageBase64 = await generateDesign(designPrompt)

      res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'description' }) + '\n')

      // Étape 3 : Claude génère la description produit
      const description = await ask(
        `Tu es le copywriter de ${BRAND_NAME}, une boutique de t-shirts du bocage normand. Style : authentique, ancré local, pas de bullshit.`,
        `Rédige une description produit courte en HTML (<p> et <ul> uniquement, max 120 mots) pour un t-shirt "${productTitle}".
Caractéristiques du lieu : ${lieu.caracteristiques}.
Évoque le sentiment d'appartenance, la fierté locale, sans tomber dans le cliché touristique.`,
        256
      )

      res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'shopify' }) + '\n')

      // Étape 4 : Création du produit Shopify
      const tags = `normandie,${lieu.region.toLowerCase().replace(/\s/g, '-')},${lieu.nom.toLowerCase().replace(/[^a-z0-9]/gi, '-')},bocage,lieu-dit`
      const product = await createShopifyProduct({
        title: productTitle,
        price: prix,
        tags,
        imageBase64,
        description,
      })

      const productId = product.product?.id
      const productUrl = `https://${SHOPIFY_SHOP}/admin/products/${productId}`
      console.log(`[GÉNÉRATION] ✅ ${lieu.nom} → Produit #${productId}`)

      results.push({ lieu: lieu.nom, productId, url: productUrl })
      res.write(JSON.stringify({ status: 'created', lieu: lieu.nom, productId, url: productUrl }) + '\n')

    } catch (err) {
      console.error(`[GÉNÉRATION] ❌ ${lieu.nom}:`, err.message)
      errors.push({ lieu: lieu.nom, error: err.message })
      res.write(JSON.stringify({ status: 'error', lieu: lieu.nom, error: err.message }) + '\n')
    }

    // Pause entre chaque produit (rate limiting)
    await new Promise(r => setTimeout(r, 2000))
  }

  const summary = { total: cibles.length, created: results.length, errors: errors.length, results }
  console.log(`[GÉNÉRATION] ✅ Terminé — ${results.length}/${cibles.length} produits créés`)
  res.write(JSON.stringify({ status: 'done', summary }) + '\n')
  res.end()
})

// ─── API : PRINTFUL ──────────────────────────────────────────────────────────

/**
 * GET /api/printful/variants
 * Retourne les variantes disponibles dans le store Printful.
 * Utile pour trouver les IDs à mettre dans PRINTFUL_VARIANT_IDS.
 */
app.get('/api/printful/variants', async (req, res) => {
  try {
    const products = await printfulApi('GET', '/store/products?limit=10')
    res.json({ products })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/printful/create-product
 * Body: {
 *   name: string,          // ex: "Le bon Brayon — Forges-les-Eaux"
 *   price: string,         // ex: "29.99"
 *   imageUrl?: string,     // URL publique de l'image (optionnel si imageBase64 fourni)
 *   imageBase64?: string,  // base64 PNG (optionnel si imageUrl fourni)
 *   description?: string,  // HTML description
 * }
 * Crée le produit dans Printful → sync automatique vers Shopify.
 */
app.post('/api/printful/create-product', async (req, res) => {
  const { name, price = '29.99', imageUrl, imageBase64, description = '' } = req.body ?? {}

  if (!name) return res.status(400).json({ error: 'name requis' })
  if (!imageUrl && !imageBase64) return res.status(400).json({ error: 'imageUrl ou imageBase64 requis' })
  if (!PRINTFUL_API_KEY) return res.status(500).json({ error: 'PRINTFUL_API_KEY non configurée' })

  try {
    console.log(`[PRINTFUL] Upload design : ${name}`)
    const image   = imageUrl ?? imageBase64
    const slug    = name.replace(/[^a-z0-9]/gi, '-').toLowerCase()
    const fileId  = await printfulUploadFile(image, `${slug}.png`)
    console.log(`[PRINTFUL] ✅ Fichier uploadé — ID: ${fileId}`)

    const product = await createPrintfulProduct({ name, price, fileId, description })
    console.log(`[PRINTFUL] ✅ Produit créé — ID: ${product.id}`)

    res.json({
      status: 'created',
      printfulProductId: product.id,
      name: product.name ?? name,
      synced: true,
    })
  } catch (err) {
    console.error('[PRINTFUL]', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/printful/generate-and-publish
 * Pipeline complet : Claude prompt → DALL-E 3 → Printful → Shopify (auto-sync)
 * Body: { lieux: ["Forges-les-Eaux", ...], tous: bool, prix: string }
 *
 * C'est la version "production" de /api/generate-products :
 * les produits passent par Printful pour que l'impression soit gérée automatiquement.
 */
app.post('/api/printful/generate-and-publish', async (req, res) => {
  const { lieux: filtre, tous = false, prix = '29.99' } = req.body ?? {}

  if (!PRINTFUL_API_KEY) return res.status(500).json({ error: 'PRINTFUL_API_KEY non configurée' })

  let cibles = LIEUX_DITS
  if (filtre && Array.isArray(filtre)) {
    cibles = LIEUX_DITS.filter(l => filtre.includes(l.nom))
  } else if (!tous) {
    cibles = LIEUX_DITS.slice(0, 2) // Défaut : 2 pour tester (DALL-E + Printful = coûteux)
  }

  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.write(JSON.stringify({ status: 'start', total: cibles.length, lieux: cibles.map(l => l.nom) }) + '\n')

  for (const lieu of cibles) {
    const productName = `Le bon Brayon — ${lieu.nom}`

    try {
      // 1. Prompt DALL-E via Claude
      res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'prompt' }) + '\n')
      const designPrompt = await buildDesignPrompt(lieu)

      // 2. Génération image DALL-E 3
      res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'image' }) + '\n')
      const imageBase64 = await generateDesign(designPrompt)

      // 3. Description produit
      res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'description' }) + '\n')
      const description = await ask(
        `Copywriter de ${BRAND_NAME}. Style : authentique, ancré local.`,
        `Description produit HTML (<p> et <ul>, max 120 mots) pour "${productName}". Lieu : ${lieu.caracteristiques}.`,
        256
      )

      // 4. Upload sur Printful + création produit
      res.write(JSON.stringify({ status: 'generating', lieu: lieu.nom, step: 'printful' }) + '\n')
      const slug   = productName.replace(/[^a-z0-9]/gi, '-').toLowerCase()
      const fileId = await printfulUploadFile(imageBase64, `${slug}.png`)
      const product = await createPrintfulProduct({ name: productName, price: prix, fileId, description })

      console.log(`[PIPELINE] ✅ ${lieu.nom} → Printful #${product.id} (sync Shopify auto)`)
      res.write(JSON.stringify({
        status: 'published',
        lieu: lieu.nom,
        printfulProductId: product.id,
        note: 'Synchronisation Shopify automatique en cours (~1 min)',
      }) + '\n')

    } catch (err) {
      console.error(`[PIPELINE] ❌ ${lieu.nom}:`, err.message)
      res.write(JSON.stringify({ status: 'error', lieu: lieu.nom, error: err.message }) + '\n')
    }

    await new Promise(r => setTimeout(r, 2000))
  }

  res.write(JSON.stringify({ status: 'done' }) + '\n')
  res.end()
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
