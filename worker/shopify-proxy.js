// Cloudflare Worker "shopify-proxy".
// Secrets/vars (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET  — from the Shopify Dev Dashboard app
//   ACCESS_KEY                                 — password the tool sends instead of a shpat_ token
//   SHOPIFY_SHOP                               — e.g. yourstore.myshopify.com

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Shopify-Token, Content-Type',
  'Access-Control-Expose-Headers': 'X-Link',
};

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status, headers: { ...CORS, 'Content-Type': 'application/json' },
});

let cached = null; // { token, expiresAt }

async function getClientCredentialsToken(env, force = false) {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.token;
  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Shopify token request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  // Refresh 5 minutes before Shopify's 24h expiry
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return cached.token;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // ── GOOGLE DRIVE PROXY ──────────────────────────────────────
    if (url.pathname === '/gdrive') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('Missing id', { status: 400, headers: CORS });

      let dlUrl = `https://drive.google.com/uc?export=download&id=${id}&confirm=t`;
      let res   = await fetch(dlUrl, { redirect: 'follow' });

      // Google returns an HTML virus-scan page for large files; extract the confirm token and retry
      const ct = res.headers.get('Content-Type') || '';
      if (ct.includes('text/html')) {
        const html    = await res.text();
        const confirm = html.match(/confirm=([0-9A-Za-z_-]+)/)?.[1];
        if (confirm) {
          dlUrl = `https://drive.google.com/uc?export=download&id=${id}&confirm=${confirm}`;
          res   = await fetch(dlUrl, { redirect: 'follow' });
        }
      }

      const blob = await res.arrayBuffer();
      return new Response(blob, {
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': res.headers.get('Content-Type') || 'image/jpeg',
          'Content-Disposition': `attachment; filename="${id}.jpg"`,
        }
      });
    }

    // ── SHOPIFY PROXY ───────────────────────────────────────────
    let shop    = (url.searchParams.get('shop') || '').toLowerCase();
    const given = request.headers.get('X-Shopify-Token') || '';
    const query = url.searchParams.get('query') || 'status=unfulfilled&limit=250&fields=id,order_number,created_at,line_items';

    if (!shop || !given) return json({ errors: 'Missing shop or token' }, 400);

    const useAppCreds = env.ACCESS_KEY && safeEqual(given, env.ACCESS_KEY);
    if (useAppCreds) {
      if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || !env.SHOPIFY_SHOP) {
        return json({ errors: 'Worker is missing SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET or SHOPIFY_SHOP' }, 500);
      }
      if (shop !== env.SHOPIFY_SHOP.toLowerCase()) {
        return json({ errors: `This access key only works for ${env.SHOPIFY_SHOP}` }, 403);
      }
      shop = env.SHOPIFY_SHOP;
    }

    const callShopify = token => fetch(`https://${shop}/admin/api/2024-01/orders.json?${query}`, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    });

    let shopifyRes;
    try {
      if (useAppCreds) {
        shopifyRes = await callShopify(await getClientCredentialsToken(env));
        if (shopifyRes.status === 401) {
          shopifyRes = await callShopify(await getClientCredentialsToken(env, true));
        }
      } else {
        shopifyRes = await callShopify(given);
      }
    } catch (e) {
      return json({ errors: e.message }, 502);
    }

    const body = await shopifyRes.text();

    return new Response(body, {
      status: shopifyRes.status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        'X-Link': shopifyRes.headers.get('Link') || '',
      }
    });
  }
};
