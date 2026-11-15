// End-to-end checks against a running ChatHBT server (Node or Worker).
const B = process.argv[2] || 'http://127.0.0.1:3006';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const conns = [];
function client(role, id, q = '') {
  const c = { id, msgs: [], ctrl: new AbortController() };
  c.of = (t) => c.msgs.filter((m) => m.type === t);
  fetch(`${B}/events?role=${role}&id=${id}${q}`, { signal: c.ctrl.signal }).then(async (r) => {
    const rd = r.body.getReader(), d = new TextDecoder(); let buf = '';
    for (;;) { const { value, done } = await rd.read(); if (done) break; buf += d.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ch = buf.slice(0, i); buf = buf.slice(i + 2); const l = ch.split('\n').find((x) => x.startsWith('data: ')); if (l) c.msgs.push(JSON.parse(l.slice(6))); } }
  }).catch(() => {});
  c.close = () => c.ctrl.abort();
  conns.push(c);
  return c;
}
const uid = (p) => p + Math.random().toString(36).slice(2, 8);

// 1. basic ask -> draft -> answer
{
  const m = client('model', uid('m')), a = client('asker', uid('a')); await sleep(300);
  const { qid } = await post('/ask', { id: a.id, text: 'why is the sky blue' }); await sleep(200);
  ok(m.of('question').some((x) => x.qid === qid), '1 model receives question');
  ok(a.of('matched').some((x) => x.qid === qid), '1 asker told matched');
  await post('/draft', { id: m.id, qid, text: 'uh' }); await sleep(150);
  ok(a.of('draft').some((x) => x.text === 'uh'), '1 asker receives draft');
  const r = await post('/answer', { id: m.id, qid, text: 'bc blue lol' }); await sleep(150);
  ok(r.ok && a.of('answer').some((x) => x.text === 'bc blue lol'), '1 asker receives dumb answer');
  // 2. too smart: rejected twice, then let through
  const q2 = (await post('/ask', { id: a.id, text: 'q2' })).qid; await sleep(200);
  const smart = 'Rayleigh scattering, therefore shorter wavelengths scatter approximately more strongly.';
  const r1 = await post('/answer', { id: m.id, qid: q2, text: smart });
  const r2 = await post('/answer', { id: m.id, qid: q2, text: smart });
  const r3 = await post('/answer', { id: m.id, qid: q2, text: smart }); await sleep(150);
  ok(r1.tooSmart && r2.tooSmart && r3.ok, '2 judge rejects twice then lets it through', JSON.stringify([r1, r2, r3]));
  ok(a.of('lobotomy').length === 2, '2 asker sees two lobotomy notes', a.of('lobotomy').length);
  // 3. break: no prompts until wake
  await post('/break', { id: m.id }); await sleep(100);
  const q3 = (await post('/ask', { id: a.id, text: 'q3' })).qid; await sleep(300);
  ok(!m.of('question').some((x) => x.qid === q3), '3 model on break gets nothing');
  await post('/wake', { id: m.id }); await sleep(200);
  ok(m.of('question').some((x) => x.qid === q3), '3 after wake the queued question arrives');
  // 4. glitch
  await post('/glitch', { id: m.id, qid: q3 }); await sleep(150);
  ok(a.of('glitch').some((x) => x.qid === q3), '4 asker receives glitch');
  // 5. cancel
  const q5 = (await post('/ask', { id: a.id, text: 'q5' })).qid; await sleep(200);
  await post('/cancel', { id: a.id, qid: q5 }); await sleep(150);
  ok(m.of('cancel').some((x) => x.qid === q5), '5 model told when asker stops');
  // 6. answering a cancelled question does nothing
  const r6 = await post('/answer', { id: m.id, qid: q5, text: 'late' });
  ok(r6.ok === false, '6 late answer to cancelled question is refused');
  m.close(); a.close();
}
await sleep(300);

// 7. stage isolation
{
  const ms = client('model', uid('ms'), '&stage'), mn = client('model', uid('mn')), as = client('asker', uid('as')), an = client('asker', uid('an')); await sleep(300);
  const s1 = (await post('/ask', { id: as.id, text: 'stage1', to: 'stage' })).qid;
  const n1 = (await post('/ask', { id: an.id, text: 'aud1' })).qid; await sleep(300);
  ok(ms.of('question').some((x) => x.qid === s1) && !ms.of('question').some((x) => x.qid === n1), '7 stage model only gets stage question');
  ok(mn.of('question').some((x) => x.qid === n1) && !mn.of('question').some((x) => x.qid === s1), '7 audience model only gets audience question');
  [ms, mn, as, an].forEach((c) => c.close());
}
await sleep(300);

// 8. model disconnects mid-question -> requeued to another model (after GONE_MS ~8s)
{
  const m1 = client('model', uid('m1')), a = client('asker', uid('a')); await sleep(300);
  const q = (await post('/ask', { id: a.id, text: 'who has it' })).qid; await sleep(200);
  ok(m1.of('question').some((x) => x.qid === q), '8 first model got it');
  m1.close(); const m2 = client('model', uid('m2'));
  await sleep(11000);
  ok(m2.of('question').some((x) => x.qid === q), '8 question moves to second model after first disconnects');
  // 9. asker disconnects -> model told cancel
  a.close(); await sleep(11000);
  ok(m2.of('cancel').some((x) => x.qid === q), '9 model told cancel after asker leaves');
  m2.close();
}

// 10. reload: /reset clears orphans; model reload gets its prompt back
{
  const m = client('model', uid('m')); const aid = uid('a'); const a = client('asker', aid); await sleep(300);
  const q = (await post('/ask', { id: aid, text: 'before reload' })).qid; await sleep(200);
  // model page reloads (same id, new stream)
  m.close(); const m2 = client('model', m.id); await sleep(400);
  ok(m2.of('question').some((x) => x.qid === q), '10 reloaded model page gets its prompt back');
  // asker page reloads: reset cancels it
  await post('/reset', { id: aid }); await sleep(200);
  ok(m2.of('cancel').some((x) => x.qid === q), '10 asker reload cancels the orphan');
  const q2 = (await post('/ask', { id: aid, text: 'after reload' })).qid; await sleep(200);
  ok(m2.of('question').some((x) => x.qid === q2), '10 next question reaches the freed model');
  m2.close(); a.close();
}

// 11. poll fallback works and doesn't replay old history
{
  const id = uid('p');
  await fetch(`${B}/poll?role=asker&id=${id}&since=0`).then((r) => r.json());
  const m = client('model', uid('m')); await sleep(300);
  const q = (await post('/ask', { id, text: 'via poll' })).qid; await sleep(300);
  const msgs = await fetch(`${B}/poll?role=asker&id=${id}&since=0`).then((r) => r.json());
  ok(msgs.some((x) => x.type === 'matched' && x.qid === q), '11 polling client receives matched');
  m.close();
}

// 12. bad input
{
  const r = await post('/ask', { id: '', text: 'x' });
  ok(!!r.error, '12 ask without id rejected');
  const r2 = await post('/answer', { id: 'nobody', qid: '99999', text: 'x' });
  ok(r2.ok === false, '12 answer to unknown question refused');
}

// 13. a polling page that goes quiet >8s (evicted) and comes back must not go deaf
{
  const id = uid('pz');
  let msgs = await fetch(`${B}/poll?role=model&id=${id}&since=0`).then((r) => r.json());
  await sleep(1500);
  msgs = await fetch(`${B}/poll?role=model&id=${id}&since=0`).then((r) => r.json());
  const last = Math.max(0, ...msgs.map((m) => m.seq)), oldBoot = msgs.at(-1)?.boot;
  await sleep(11000); // phone locked: no polls, record evicted
  await fetch(`${B}/poll?role=model&id=${id}&since=${last}&boot=${oldBoot}`).then((r) => r.json()); // comes back (re-joins)
  const a = client('asker', uid('a')); await sleep(300);
  const q = (await post('/ask', { id: a.id, text: 'after unlock' })).qid; await sleep(300);
  const after = await fetch(`${B}/poll?role=model&id=${id}&since=${last}&boot=${oldBoot}`).then((r) => r.json());
  ok(after.some((m) => m.type === 'question' && m.qid === q), '13 page back from a locked screen still receives prompts', JSON.stringify(after.map((m) => m.type)));
  ok(after.some((m) => m.boot !== oldBoot), '13 and sees a new boot id so it resets its counter');
  a.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
conns.forEach((c) => c.close());
process.exit(fail ? 1 : 0);
