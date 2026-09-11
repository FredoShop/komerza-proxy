/**
 * Komerza EU Proxy — run this on a host with an EU (or otherwise allowed) IP so that
 * calls to api.komerza.com egress from an allowed country. This fixes the Cloudflare
 * 403 "Service unavailable in your region" that Russian-region Cloudflare Workers hit.
 *
 * WHERE TO HOST (pick one, must be in an ALLOWED country e.g. Germany/EU):
 *   - Hetzner / any VPS in Germany  (most reliable, ~€4/mo)
 *   - Render.com  (region: Frankfurt)  — free tier works
 *   - Railway / Fly.io  (region: EU)
 *
 * SETUP:
 *   1. Deploy this file as a Node service (Node 18+; uses built-in fetch).
 *   2. Set env vars:
 *        PROXY_SECRET   = <a long random string>   (shared with the Platega worker)
 *        PORT           = 8080   (or whatever the host assigns)
 *   3. Note the public URL it gets (e.g. https://cheatshub-komerza.onrender.com).
 *   4. In the Platega (and other) workers set:
 *        KOMERZA_PROXY_URL    = that URL
 *        KOMERZA_PROXY_SECRET = same value as PROXY_SECRET
 *
 * The worker sends its Komerza request to  {KOMERZA_PROXY_URL}/komerza/<path>  with the
 * header  X-Proxy-Secret: <secret>.  The proxy forwards it verbatim to
 * https://api.komerza.com/<path>  from its own (allowed) IP, and returns the response.
 */
const http = require('http');

const KOMERZA_BASE = 'https://api.komerza.com';
const SECRET = process.env.PROXY_SECRET || '';
const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
  try {
    // Health check
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'komerza-eu-proxy' }));
    }
    // Test the proxy -> Komerza path directly (no auth needed; hits a harmless endpoint).
    // Open /komerza-test in your browser: if you see Komerza JSON or a normal error,
    // the proxy's IP is NOT region-blocked. If you see "Service unavailable in your
    // region", then Render's region IS blocked and you must move the proxy elsewhere.
    if (req.url === '/komerza-test') {
      try {
        const r = await fetch('https://api.komerza.com/', { headers: { 'origin': 'https://dashboard.komerza.com' } });
        const t = await r.text();
        const blocked = /unavailable in your region|regulatory restrictions/i.test(t);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ komerzaStatus: r.status, regionBlocked: blocked, sample: t.slice(0, 200) }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
      }
    }
    // Auth
    if (!SECRET || req.headers['x-proxy-secret'] !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    // Only forward /komerza/* paths
    if (!req.url.startsWith('/komerza/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
    const komerzaPath = req.url.slice('/komerza'.length); // keep leading slash
    const target = KOMERZA_BASE + komerzaPath;

    // Read body (if any)
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    // Forward the important headers (auth), NOT the client IP.
    const fwdHeaders = { 'origin': 'https://dashboard.komerza.com' };
    if (req.headers['authorization']) fwdHeaders['authorization'] = req.headers['authorization'];
    if (req.headers['content-type']) fwdHeaders['content-type'] = req.headers['content-type'];

    const upstream = await fetch(target, {
      method: req.method,
      headers: fwdHeaders,
      body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body,
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
  }
});

server.listen(PORT, () => console.log('Komerza EU proxy listening on ' + PORT));
