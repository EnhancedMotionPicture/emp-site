// EMP waitlist capture — Vercel serverless function.
//
// Storage: if a Vercel KV / Upstash Redis integration is connected, signups are
// persisted to a Redis set ("emp:waitlist") and an append-only list
// ("emp:waitlist:log") via the REST API — no npm dependency required.
// If no KV env vars are present, the function still accepts the signup and logs
// it to the function output, so the form works the moment the site is deployed.
//
// To enable persistence: in the Vercel dashboard add the "Upstash for Redis"
// (KV) integration to this project — it auto-injects KV_REST_API_URL and
// KV_REST_API_TOKEN. Optionally add NOTIFY_WEBHOOK_URL to forward signups
// somewhere (Slack/Zapier/etc.) and ADMIN_TOKEN to read the list back.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function kv(command) {
  // command: array, e.g. ["SADD", "emp:waitlist", "a@b.com"]
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  return res.json();
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) {
      // Vercel may have parsed it already
      try {
        resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
        return;
      } catch (_) {}
    }
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); }
    });
  });
}

export default async function handler(req, res) {
  // --- Admin read: GET /api/waitlist?token=ADMIN_TOKEN ---
  if (req.method === 'GET') {
    const token = (req.query && req.query.token) || '';
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!KV_URL || !KV_TOKEN) return res.status(200).json({ emails: [], note: 'KV not configured' });
    try {
      const members = await kv(['SMEMBERS', 'emp:waitlist']);
      const count = await kv(['SCARD', 'emp:waitlist']);
      return res.status(200).json({ count: count.result, emails: members.result || [] });
    } catch (e) {
      return res.status(500).json({ error: 'Read failed' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await readBody(req);
  const email = String((body && body.email) || '').trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const entry = {
    email,
    ts: new Date().toISOString(),
    ref: (req.headers && req.headers.referer) || null,
  };

  // Persist if KV configured
  if (KV_URL && KV_TOKEN) {
    try {
      await kv(['SADD', 'emp:waitlist', email]);
      await kv(['RPUSH', 'emp:waitlist:log', JSON.stringify(entry)]);
    } catch (e) {
      console.error('KV write failed:', e);
    }
  } else {
    console.log('WAITLIST SIGNUP (no KV configured):', JSON.stringify(entry));
  }

  if (process.env.NOTIFY_WEBHOOK_URL) {
    try {
      await fetch(process.env.NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `New EMP waitlist signup: ${email}`, ...entry }),
      });
    } catch (e) {
      console.error('Webhook notify failed:', e);
    }
  }

  return res.status(200).json({ ok: true });
}
