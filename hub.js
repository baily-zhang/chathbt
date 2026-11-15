// ChatHBT hub: all matchmaking state and rules, with no I/O of its own.
// Shared by the Node server (server.js) and the Cloudflare Worker (worker/index.js).
// A client is given a `write(text)` function for its live stream; every message is also
// numbered and kept in a small mailbox so clients behind buffering proxies can poll instead.

const MAX_REJECTS = 2;    // after this many "too smart" rejections we give up and let it through
const AFK_MS = 60000;     // a human who types nothing on a prompt for this long is considered asleep
const GONE_MS = 8000;     // a client with no stream that hasn't polled for this long has left
const SMART_LIMIT = 2; // score (0..10) at which an answer counts as too smart. Low on purpose: be dumb.

const SMART_WORDS = /\b(therefore|furthermore|moreover|consequently|hence|thus|however|approximately|specifically|essentially|fundamentally|according to|in conclusion|nevertheless|whereas)\b/gi;

// Cheap local score 0..10, also computed live in the model console (same rules).
export function heuristicScore(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const avgLen = words.reduce((s, w) => s + w.length, 0) / (words.length || 1);
  let score = 0;
  score += Math.min(4, text.length / 30);                 // long answers are suspicious
  score += Math.min(3, (text.match(SMART_WORDS) || []).length * 1.5);
  score += avgLen > 6 ? 2 : avgLen > 5 ? 1 : 0;           // big words
  score += /\d/.test(text) && /[.;:]/.test(text) ? 0.5 : 0;
  // Proper grammar is suspicious too: capital letters, full stops, commas.
  score += (/^[A-Z]/.test(text.trim()) ? 0.6 : 0) + (/[.!?]$/.test(text.trim()) ? 0.6 : 0) + Math.min(1.2, (text.match(/,/g) || []).length * 0.4);
  return Math.min(10, Math.round(score * 10) / 10);
}

export function createHub({ apiKey, judgeModel = 'claude-haiku-5-5' } = {}) {
  const clients = new Map();   // id -> { write|null, role, busy, asleep, box, seq, seen }
  const questions = new Map(); // qid -> { qid, askerId, text, model, modelId, rejects, active }
  const queue = [];            // qids waiting for a free human
  let qSeq = 1;
  const later = (fn) => Promise.resolve().then(fn);

  // ---------- messaging ----------
  function send(id, msg) {
    const c = clients.get(id);
    if (!c) return;
    const m = { ...msg, seq: ++c.seq };
    c.box.push(m);
    if (c.box.length > 300) c.box.splice(0, c.box.length - 300);
    if (c.write) {
      try { c.write(`data: ${JSON.stringify(m)}\n\n`); }
      catch { c.write = null; c.seen = Date.now(); }
    }
  }
  function join(id, role) {
    let c = clients.get(id);
    if (!c) { c = { write: null, role, busy: null, asleep: false, box: [], seq: 0, seen: Date.now() }; clients.set(id, c); later(assign); }
    c.seen = Date.now();
    return c;
  }
  function leave(id) {
    clients.delete(id);
    for (const q of [...questions.values()]) {
      if (q.askerId === id) { if (q.modelId) send(q.modelId, { type: 'cancel', qid: q.qid }); finish(q.qid); }
      else if (q.modelId === id) { q.modelId = null; queue.unshift(q.qid); } // human vanished: requeue
    }
    assign();
  }
  const humans = () => [...clients].filter(([, c]) => c.role === 'model');

  function broadcastStats() {
    const stats = { type: 'stats', humans: humans().length, busy: humans().filter(([, c]) => c.busy).length, queue: queue.length };
    for (const id of clients.keys()) send(id, stats);
  }

  // Hand queued questions to random idle humans.
  function assign() {
    while (queue.length) {
      const idle = humans().filter(([, c]) => !c.busy && !c.asleep);
      if (!idle.length) break;
      const q = questions.get(queue.shift());
      if (!q) continue;
      const [mid, m] = idle[Math.floor(Math.random() * idle.length)];
      m.busy = q.qid;
      q.modelId = mid;
      q.active = Date.now();
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

  // Run every ~2s: drop vanished clients, and take prompts away from humans who fell asleep.
  function tick() {
    const now = Date.now();
    for (const [id, c] of clients) if (!c.write && now - c.seen > GONE_MS) leave(id);
    for (const q of questions.values()) {
      if (!q.modelId || now - q.active < AFK_MS) continue;
      const m = clients.get(q.modelId);
      // Only this prompt moves on; the human stays available (an explicit break is what stops prompts).
      if (m) { m.busy = null; send(q.modelId, { type: 'asleep', qid: q.qid }); }
      q.modelId = null;
      queue.unshift(q.qid);
      send(q.askerId, { type: 'asleep', qid: q.qid });
      assign();
    }
  }

  // ---------- the "too smart" judge ----------
  async function aiScore(question, answer) {
    if (!apiKey) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: judgeModel,
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
    return { score, reason: ai?.reason || null, by: ai ? 'ai' : 'heuristic', tooSmart: score >= SMART_LIMIT };
  }

  // ---------- actions (POST bodies) ----------
  const mine = (b) => { const q = questions.get(b.qid); return q && q.modelId === b.id ? q : null; };
  const routes = {
    async '/ask'(b) {
      const text = String(b.text || '').trim().slice(0, 2000);
      if (!b.id || !text) return { error: 'bad request' };
      if (!clients.has(b.id)) join(b.id, 'asker'); // e.g. the server just restarted and the stream hasn't reconnected yet
      const qid = String(qSeq++);
      questions.set(qid, { qid, askerId: b.id, text, model: String(b.model || 'HBT-5'), modelId: null, rejects: 0 });
      queue.push(qid);
      later(assign);
      return { qid };
    },
    async '/wake'(b) {
      const c = clients.get(b.id);
      if (c) { c.asleep = false; assign(); }
      return { ok: true };
    },
    async '/draft'(b) {
      const q = mine(b);
      if (q) { q.active = Date.now(); send(q.askerId, { type: 'draft', qid: q.qid, text: String(b.text || '').slice(0, 4000) }); }
      return { ok: true };
    },
    async '/answer'(b) {
      const q = mine(b);
      const text = String(b.text || '').trim().slice(0, 4000);
      if (!q || !text) return { ok: false };
      q.active = Date.now();
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
      const c = clients.get(b.id);
      if (c) c.asleep = true; // on break: no prompts until /wake
      const q = mine(b);
      if (q) { send(q.askerId, { type: 'break', qid: q.qid }); finish(q.qid); }
      assign();
      return { ok: true };
    },
    // The human refuses to answer and crashes the asker's app instead (a fake bug).
    async '/glitch'(b) {
      const q = mine(b);
      if (q) { send(q.askerId, { type: 'glitch', qid: q.qid, variant: Math.floor(Math.random() * 3) }); finish(q.qid); assign(); }
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

  return {
    routes,
    tick,
    smartLimit: SMART_LIMIT,
    judgeLabel: apiKey ? `AI (${judgeModel})` : 'heuristic only (set ANTHROPIC_API_KEY for AI)',
    // A live stream opened. Returns a function to call when it closes.
    connect(id, role, write) {
      const c = join(id, role === 'model' ? 'model' : 'asker');
      c.write = write;
      c.asleep = false; // a freshly opened page is awake by definition
      assign();
      return () => { if (c.write === write) { c.write = null; c.seen = Date.now(); } };
    },
    // Polling fallback: everything after `since`.
    poll(id, role, since) {
      if (!id) return [];
      const c = join(id, role === 'model' ? 'model' : 'asker');
      return c.box.filter((m) => m.seq > (Number(since) || 0));
    },
  };
}
