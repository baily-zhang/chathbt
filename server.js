// ChatHBT — Human Bullshitting Transformer
// Zero-dependency Node server.
//   Server -> browser: Server-Sent Events on /events
//   Browser -> server: JSON POSTs (/ask, /draft, /answer, /break, /cancel)
// Optional: set ANTHROPIC_API_KEY so a real AI judges whether the human is too smart.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-haiku-5-5';
const MAX_REJECTS = 2; // after this many "too smart" rejections we give up and let it through

const clients = new Map();   // id -> { res, role, busy: qid|null }
const questions = new Map(); // qid -> { qid, askerId, text, model, modelId, rejects }
const queue = [];            // qids waiting for a free human
let qSeq = 1;

// ---------- messaging ----------
function send(id, msg) {
  const c = clients.get(id);
  if (c) c.res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
const humans = () => [...clients].filter(([, c]) => c.role === 'model');

function broadcastStats() {
  const stats = { type: 'stats', humans: humans().length, busy: humans().filter(([, c]) => c.busy).length, queue: queue.length };
  for (const id of clients.keys()) send(id, stats);
}

// Hand queued questions to random idle humans.
function assign() {
  while (queue.length) {
    const idle = humans().filter(([, c]) => !c.busy);
    if (!idle.length) break;
    const q = questions.get(queue.shift());
    if (!q) continue;
    const [mid, m] = idle[Math.floor(Math.random() * idle.length)];
    m.busy = q.qid;
    q.modelId = mid;
    send(mid, { type: 'question', qid: q.qid, text: q.text, model: q.model });
    send(q.askerId, { type: 'matched', qid: q.qid });
  }
  queue.forEach((qid, i) => { const q = questions.get(qid); if (q) send(q.askerId, { type: 'waiting', qid, position: i + 1 }); });
  broadcastStats();
}

function finish(qid) {
  const q = questions.get(qid);
  if (!q) return;
  questions.delete(qid);
  const i = queue.indexOf(qid);
  if (i >= 0) queue.splice(i, 1);
  const m = q.modelId && clients.get(q.modelId);
  if (m && m.busy === qid) m.busy = null;
}

// ---------- the "too smart" judge ----------
const SMART_WORDS = /\b(therefore|furthermore|moreover|consequently|hence|thus|however|approximately|specifically|essentially|fundamentally|according to|in conclusion|nevertheless|whereas)\b/gi;

// Cheap local score 0..10, also used live in the browser (same rules).
function heuristicScore(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const avgLen = words.reduce((s, w) => s + w.length, 0) / (words.length || 1);
  let score = 0;
  score += Math.min(4, text.length / 60);                 // long answers are suspicious
  score += Math.min(3, (text.match(SMART_WORDS) || []).length * 1.5);
  score += avgLen > 6 ? 2 : avgLen > 5 ? 1 : 0;           // big words
  score += /\d/.test(text) && /[.;:]/.test(text) ? 0.5 : 0;
  return Math.min(10, Math.round(score * 10) / 10);
}

async function aiScore(question, answer) {
  if (!API_KEY) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 60,
        system: 'You grade answers for a parody chatbot where humans must answer DUMBLY. Rate how intelligent, correct and well-reasoned the answer is from 0 (gloriously dumb) to 10 (genius). Reply exactly as: <score>|<a short sassy reason, max 8 words>',
        messages: [{ role: 'user', content: `Question: ${question}\nAnswer: ${answer}` }],
      }),
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const out = (await r.json()).content?.[0]?.text || '';
    const [s, reason] = out.split('|');
    const score = parseFloat(s);
    return Number.isFinite(score) ? { score, reason: (reason || '').trim() } : null;
  } catch { return null; }
}

async function judge(question, answer) {
  const ai = await aiScore(question, answer);
  const local = heuristicScore(answer);
  const score = ai ? Math.max(ai.score, local) : local;
  return { score, reason: ai?.reason || null, by: ai ? 'ai' : 'heuristic', tooSmart: score >= 6 };
}

// ---------- routes ----------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
const mine = (b) => { const q = questions.get(b.qid); return q && q.modelId === b.id ? q : null; };

const routes = {
  async '/ask'(b) {
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!clients.has(b.id) || !text) return { error: 'bad request' };
    const qid = String(qSeq++);
    questions.set(qid, { qid, askerId: b.id, text, model: String(b.model || 'HBT-5'), modelId: null, rejects: 0 });
    queue.push(qid);
    setImmediate(assign);
    return { qid };
  },
  async '/draft'(b) {
    const q = mine(b);
    if (q) send(q.askerId, { type: 'draft', qid: q.qid, text: String(b.text || '').slice(0, 4000) });
    return { ok: true };
  },
  async '/answer'(b) {
    const q = mine(b);
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!q || !text) return { ok: false };
    if (q.rejects < MAX_REJECTS) {
      const verdict = await judge(q.text, text);
      if (!questions.has(q.qid)) return { ok: false }; // asker left while we judged
      if (verdict.tooSmart) {
        q.rejects++;
        send(q.askerId, { type: 'lobotomy', qid: q.qid, attempt: q.rejects });
        return { ok: false, ...verdict };
      }
    }
    send(q.askerId, { type: 'answer', qid: q.qid, text });
    finish(q.qid);
    assign();
    return { ok: true };
  },
  async '/break'(b) {
    const q = mine(b);
    if (q) { send(q.askerId, { type: 'break', qid: q.qid }); finish(q.qid); assign(); }
    return { ok: true };
  },
  async '/cancel'(b) {
    const q = questions.get(b.qid);
    if (q && q.askerId === b.id) {
      if (q.modelId) send(q.modelId, { type: 'cancel', qid: q.qid });
      finish(q.qid);
      assign();
    }
    return { ok: true };
  },
};

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function openStream(req, res, url) {
  const id = url.searchParams.get('id');
  const role = url.searchParams.get('role') === 'model' ? 'model' : 'asker';
  if (!id) { res.writeHead(400); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': hello\n\n');
  clients.set(id, { res, role, busy: null });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    const c = clients.get(id);
    if (!c || c.res !== res) return; // a newer connection replaced this one
    clients.delete(id);
    for (const q of [...questions.values()]) {
      if (q.askerId === id) { if (q.modelId) send(q.modelId, { type: 'cancel', qid: q.qid }); finish(q.qid); }
      else if (q.modelId === id) { q.modelId = null; queue.unshift(q.qid); } // human vanished: requeue
    }
    assign();
  });
  assign();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') return openStream(req, res, url);
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

  if (req.method === 'POST' && routes[url.pathname]) {
    const out = await routes[url.pathname](await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  const name = { '/': '/index.html', '/model': '/model.html' }[url.pathname] || url.pathname;
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
  console.log(`  judge: ${API_KEY ? 'AI (' + JUDGE_MODEL + ')' : 'heuristic only (set ANTHROPIC_API_KEY for AI)'}`);
});
