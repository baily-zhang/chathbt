// ChatHBT — Human Bullsh*tting Transformer
// Zero-dependency Node server. All the rules live in hub.js; this file is just HTTP.
//   Server -> browser: Server-Sent Events on /events (or /poll if a proxy buffers SSE)
//   Browser -> server: JSON POSTs (/ask, /draft, /answer, /break, /wake, /cancel)
// Optional: ANTHROPIC_API_KEY lets a real AI judge whether the human is too smart.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHub } from './hub.js';

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const hub = createHub({ apiKey: process.env.ANTHROPIC_API_KEY, judgeModel: process.env.JUDGE_MODEL });
setInterval(hub.tick, 2000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;

  if (url.pathname === '/events') {
    if (!q.get('id')) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hello\n\n');
    const close = hub.connect(q.get('id'), q.get('role'), (t) => res.write(t), q.has('stage'));
    const ping = setInterval(() => res.write(': ping\n\n'), 5000);
    res.on('close', () => { clearInterval(ping); close(); }); // res, not req: req 'close' can fire as soon as a GET has no body left
    return;
  }
  if (url.pathname === '/poll') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(hub.poll(q.get('id'), q.get('role'), q.get('since'), q.has('stage'), q.get('boot'))));
  }
  if (url.pathname === '/debug') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(hub.debug())); }
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'POST' && hub.routes[url.pathname]) {
    const out = await hub.routes[url.pathname](await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  const name = { '/': '/index.html', '/model': '/model.html', '/qr': '/qr.html' }[url.pathname] || url.pathname;
  const file = path.join(PUBLIC, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  console.log('ChatHBT is up');
  console.log(`  chat:  http://localhost:${PORT}`);
  console.log(`  model: http://localhost:${PORT}/model`);
  if (lan) console.log(`  LAN:   http://${lan.address}:${PORT}`);
  console.log(`  judge: ${hub.judgeLabel}`);
});
