# ChatHBT

**HBT = Human Bullsh*tting Transformer.** *(We censored it because the model is a professional.)*

ChatHBT looks exactly like ChatGPT, but there is no AI. Every answer is typed live by a random human.

- You can watch the "model" think as it types, deletes and retypes.
- If nobody is online, the model is on a break and leaves you on read.
- If a human answers too intelligently, the system stops them: *ohohoh wait, too smart, plz be dumb.*

Everyone says AI makes things up. We removed the AI.

Built at Stupid Ideas Hackathon Ottawa · Track: Stupidest AI

**Live:** https://chathbt.blitheshuo.workers.dev · Become the model: https://chathbt.blitheshuo.workers.dev/model

## How it works

- `hub.js`: all matchmaking state and rules (queue, random human assignment, asleep/break, the too-smart judge). No I/O.
- `worker/index.js`: Cloudflare Worker. Static pages from `public/`, every API call goes to a single Durable Object holding the hub.
- `server.js`: the same hub as a zero-dependency Node server.
- Realtime: Server-Sent Events, with an automatic polling fallback when a proxy buffers the stream.
- Every keystroke of the human is streamed to the asker and diffed into a "thinking" trace with strikethrough deletions.
- The judge: a local heuristic, plus a real LLM when `ANTHROPIC_API_KEY` is set. Answers scoring 6/10 or higher are rejected as too smart.

## Run

```bash
npm start            # Node: http://localhost:3000 (chat) and /model
npm run dev:worker   # Worker locally
npm run deploy       # Worker to Cloudflare
```

Zero runtime dependencies. Node 18+.

## Team

- TODO: names + handles
