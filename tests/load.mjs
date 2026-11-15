// Load test: N people connect over SSE; some are models, some ask. Models type drafts and answer.
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const MODELS = +(process.argv[3] || 120), ASKERS = +(process.argv[4] || 80), QUESTIONS_EACH = +(process.argv[5] || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reqs = 0, errs = 0; const lat = [];
async function post(path, body) {
  const t = Date.now(); reqs++;
  try { const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) errs++; const j = await r.json(); lat.push(Date.now() - t); return j; }
  catch { errs++; return {}; }
}
function stream(role, id, onMsg) {
  const ctrl = new AbortController(); reqs++;
  (async () => {
    try {
      const r = await fetch(`${BASE}/events?role=${role}&id=${id}`, { signal: ctrl.signal });
      const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const line = chunk.split('\n').find((l) => l.startsWith('data: ')); if (line) onMsg(JSON.parse(line.slice(6))); } }
    } catch (e) { if (e.name !== 'AbortError') errs++; }
  })();
  return () => ctrl.abort();
}
const answered = []; let asked = 0;
const closers = [];
// models
for (let m = 0; m < MODELS; m++) {
  const id = 'lm' + m;
  closers.push(stream('model', id, async (msg) => {
    if (msg.type !== 'question') return;
    let text = '';
    for (const w of ['uh', ' maybe', ' the', ' moon', ' lol']) { text += w; await sleep(300); await post('/draft', { id, qid: msg.qid, text }); }
    await post('/answer', { id, qid: msg.qid, text: 'maybe the moon lol' });
  }));
}
// askers
const start = Date.now();
for (let a = 0; a < ASKERS; a++) {
  const id = 'la' + a; const sent = new Map(); let drafts = 0;
  closers.push(stream('asker', id, (msg) => {
    if (msg.type === 'draft') drafts++;
    if (msg.type === 'answer' && sent.has(msg.qid)) { answered.push(Date.now() - sent.get(msg.qid)); sent.delete(msg.qid); }
  }));
  (async () => {
    await sleep(1500 + Math.random() * 1500);
    for (let q = 0; q < QUESTIONS_EACH; q++) {
      const t = Date.now(); const r = await post('/ask', { id, text: 'q ' + a + '-' + q, model: 'HBT-5' }); asked++;
      if (r.qid) sent.set(r.qid, t);
      await sleep(4000 + Math.random() * 2000);
    }
  })();
}
// wait for answers
const total = ASKERS * QUESTIONS_EACH;
for (let i = 0; i < 60 && answered.length < total; i++) await sleep(1000);
closers.forEach((c) => c());
lat.sort((a, b) => a - b); answered.sort((a, b) => a - b);
const p = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : '-';
console.log(JSON.stringify({ people: MODELS + ASKERS, asked, answered: answered.length, of: total, requests: reqs, errors: errs,
  post_ms_p50: p(lat, .5), post_ms_p95: p(lat, .95), post_ms_max: lat.at(-1), answer_ms_p50: p(answered, .5), answer_ms_p95: p(answered, .95), seconds: Math.round((Date.now() - start) / 1000) }, null, 1));
process.exit(0);
