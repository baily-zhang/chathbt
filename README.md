# ChatHBT

**HBT = Human Bullsh*tting Transformer.** *(We censored it because the model is a professional.)*

ChatHBT looks exactly like ChatGPT, but there is no AI. Every answer is typed live by a random human.

- You can watch the "model" think as it types, deletes and retypes.
- If nobody is online, the model is on a break and leaves you on read.
- If a human answers too intelligently, the system stops them: *ohohoh wait, too smart, plz be dumb.*
- Humans get one-click dumb answers, a break button, and a button that refuses to answer and crashes your app instead (screen glitch or a fake "this chat can't be reached" page).

Everyone says AI makes things up. We removed the AI.

Built at Stupid Ideas Hackathon Ottawa · Track: Stupidest AI

**Live:** https://chathbt.blitheshuo.workers.dev · Become the model: https://chathbt.blitheshuo.workers.dev/model

## How it works

- `hub.js`: all matchmaking state and rules (queue, random human assignment, breaks, stage routing, the too-smart judge). No I/O.
- `worker/index.js`: Cloudflare Worker. Static pages from `public/`, every API call goes to a single Durable Object holding the hub.
- `server.js`: the same hub as a zero-dependency Node server.
- Realtime: Server-Sent Events, with an automatic polling fallback when a proxy buffers the stream. Messages carry a boot id so pages recover after a server restart or a locked phone.
- A human who types nothing for 45s loses the prompt to another free human. Page reloads never leave questions stuck.
- Every keystroke of the human is streamed to the asker and diffed into a "thinking" trace with strikethrough deletions.
- The judge: a local heuristic, plus a real LLM when `ANTHROPIC_API_KEY` is set (`npx wrangler secret put ANTHROPIC_API_KEY`). Answers scoring 2/10 or higher are rejected as too smart. Length, big words, "therefore", and even proper grammar (capital letters, full stops, commas) count as smart. After two rejections the answer goes through anyway.

## Live demo setup

- Presenter's console: `/model?stage` (only takes stage questions, which are never reassigned).
- Stage chat on the big screen: `/?to=stage` (questions only go to the stage console).
- Audience: show `/qr?for=model` so people scan in as models; they answer each other, never the stage.
- `/qr?for=ask` and `/qr` (both codes) also exist.
- `/?fresh` wipes this browser's chat history before recording. `/debug` shows who is connected. `/health` shows the deployed build.

## Run

```bash
npm start            # Node: http://localhost:3000 (chat) and /model
npm run dev:worker   # Worker locally
npm run deploy       # Worker to Cloudflare (stamps a build id so the Durable Object restarts onto new code)
PORT=3006 npm start & npm test   # 24 end-to-end checks against a local server
node tests/load.mjs http://127.0.0.1:8799 120 80 2   # load test: 120 models, 80 askers
```

Local load test (Worker under wrangler dev): 500 people, 500 questions, 0 errors, p50 33ms.

Zero runtime dependencies. Node 18+.

## Team

- TODO: names + handles
