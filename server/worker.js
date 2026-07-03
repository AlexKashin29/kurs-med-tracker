/* Курс — push-сервер (Cloudflare Worker)
   POST /subscribe   {sub, slots:[{time:"HH:MM", days:[0..6]}], tz: minutesEastOfUTC}
   POST /unsubscribe {endpoint}
   cron * * * * *    шлёт пустой push в момент приёма; SW на клиенте сам решает, что показать */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function keyOf(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/subscribe') {
      const body = await req.json().catch(() => null);
      if (!body?.sub?.endpoint || !Array.isArray(body.slots)) return json({ error: 'bad request' }, 400);
      const rec = { sub: body.sub, slots: body.slots.slice(0, 64), tz: Number(body.tz) || 0 };
      await env.SUBS.put(await keyOf(body.sub.endpoint), JSON.stringify(rec));
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/unsubscribe') {
      const body = await req.json().catch(() => null);
      if (!body?.endpoint) return json({ error: 'bad request' }, 400);
      await env.SUBS.delete(await keyOf(body.endpoint));
      return json({ ok: true });
    }

    return json({ app: 'kurs-push', ok: true });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};

async function tick(env) {
  const now = new Date();
  const list = await env.SUBS.list();
  for (const { name } of list.keys) {
    const raw = await env.SUBS.get(name);
    if (!raw) continue;
    const rec = JSON.parse(raw);
    const local = new Date(now.getTime() + rec.tz * 60000);
    const hm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
    const dow = (local.getUTCDay() + 6) % 7; // Пн=0
    const due = rec.slots.some(s => s.time === hm && (!s.days?.length || s.days.includes(dow)));
    if (!due) continue;
    const status = await sendPush(rec.sub, env);
    if (status === 404 || status === 410) await env.SUBS.delete(name); // подписка умерла
  }
}

/* --- Web Push без payload: только VAPID-заголовки, шифрование не нужно --- */
async function sendPush(sub, env) {
  const endpoint = new URL(sub.endpoint);
  const aud = `${endpoint.protocol}//${endpoint.host}`;
  const jwt = await vapidJwt(aud, env);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '300',
      Urgency: 'high',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
  });
  return res.status;
}

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vapidJwt(aud, env) {
  const header = b64u(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(new TextEncoder().encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:alekskashin29@gmail.com',
  })));
  const key = await crypto.subtle.importKey(
    'jwk', JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64u(sig)}`;
}
