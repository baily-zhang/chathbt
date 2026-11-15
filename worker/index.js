// ChatHBT on Cloudflare Workers.
// Static pages come from ./public (Workers Static Assets). Every API call goes to ONE
// Durable Object, so all humans and askers share the same in-memory hub (hub.js).
import { createHub } from '../hub.js';

const API = new Set(['/events', '/poll', '/health', '/ask', '/draft', '/answer', '/break', '/wake', '/glitch', '/cancel', '/debug', '/reset']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (API.has(url.pathname)) {
      // Tell the hub which deploy is calling, so an object still running old code can restart itself.
      const req = new Request(request);
      req.headers.set('x-build', env.BUILD || '');
      return env.HUB.get(env.HUB.idFromName('hub-2')).fetch(req);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.build = env.BUILD || '';
    this.hub = createHub({ apiKey: env.ANTHROPIC_API_KEY, judgeModel: env.JUDGE_MODEL || undefined });
    setInterval(() => this.hub.tick(), 2000);
  }

  async fetch(request) {
    // A Durable Object with open connections keeps running the code it started with, even after
    // a deploy. If a request comes from a newer deploy, restart so the next request gets new code.
    const caller = request.headers.get('x-build') || '';
    if (caller && this.build && caller !== this.build) {
      this.state.abort('new deploy');
      return new Response('restarting, try again', { status: 503, headers: { 'Retry-After': '1' } });
    }
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
      close = this.hub.connect(q.get('id'), q.get('role'), write, q.has('stage'));
      ping = setInterval(() => write(': ping\n\n'), 15000);
      request.signal?.addEventListener('abort', () => { clearInterval(ping); close(); });
      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' } });
    }
    if (url.pathname === '/debug') return json(this.hub.debug());
    if (url.pathname === '/poll') return json(this.hub.poll(q.get('id'), q.get('role'), q.get('since'), q.has('stage')));
    if (url.pathname === '/health') return new Response(`ok limit=${this.hub.smartLimit} build=${this.build}`);
    const route = this.hub.routes[url.pathname];
    if (request.method === 'POST' && route) {
      let body = {};
      try { body = await request.json(); } catch {}
      return json(await route(body));
    }
    return new Response('not found', { status: 404 });
  }
}
