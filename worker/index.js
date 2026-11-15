// ChatHBT on Cloudflare Workers.
// Static pages come from ./public (Workers Static Assets). Every API call goes to ONE
// Durable Object, so all humans and askers share the same in-memory hub (hub.js).
import { createHub } from '../hub.js';

const API = new Set(['/events', '/poll', '/health', '/ask', '/draft', '/answer', '/break', '/wake', '/cancel']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (API.has(url.pathname)) return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};

export class Hub {
  constructor(state, env) {
    this.hub = createHub({ apiKey: env.ANTHROPIC_API_KEY, judgeModel: env.JUDGE_MODEL || undefined });
    setInterval(() => this.hub.tick(), 2000);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    if (url.pathname === '/events') {
      if (!q.get('id')) return new Response('missing id', { status: 400 });
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      let close = () => {};
      let ping;
      const write = (t) => { writer.write(enc.encode(t)).catch(() => { clearInterval(ping); close(); }); };
      write(': hello\n\n');
      close = this.hub.connect(q.get('id'), q.get('role'), write);
      ping = setInterval(() => write(': ping\n\n'), 15000);
      request.signal?.addEventListener('abort', () => { clearInterval(ping); close(); });
      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' } });
    }
    if (url.pathname === '/poll') return json(this.hub.poll(q.get('id'), q.get('role'), q.get('since')));
    if (url.pathname === '/health') return new Response('ok');
    const route = this.hub.routes[url.pathname];
    if (request.method === 'POST' && route) {
      let body = {};
      try { body = await request.json(); } catch {}
      return json(await route(body));
    }
    return new Response('not found', { status: 404 });
  }
}
