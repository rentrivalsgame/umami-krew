/* Umami Krew — Cloudflare Worker
   Serves the game (static asset) and a WebSocket signaling hub (Durable Object).
   Game traffic itself is peer-to-peer WebRTC, so this stays within free-tier limits. */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const id = env.HUB.idFromName('hub');
      return env.HUB.get(id).fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return env.ASSETS.fetch(req);
  }
};

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class Hub {
  constructor(state, env) {
    this.rooms = new Map(); // code -> {host, peers:Map(id->ws), nextId, started}
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.wire(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }

  mkCode() {
    let c;
    do { c = Array.from({ length: 4 }, () => ALPHA[Math.random() * ALPHA.length | 0]).join(''); }
    while (this.rooms.has(c));
    return c;
  }

  wire(ws) {
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'create') {
        const code = this.mkCode();
        ws.room = code; ws.pid = 0; ws.isHost = true;
        this.rooms.set(code, { host: ws, peers: new Map(), nextId: 1 });
        this.send(ws, { t: 'room', code });
      } else if (m.t === 'join') {
        const r = this.rooms.get(String(m.code || '').toUpperCase());
        if (!r) return this.send(ws, { t: 'err', m: 'Room not found' });
        if (r.peers.size >= 7) return this.send(ws, { t: 'err', m: 'Room full' });
        if (r.started) return this.send(ws, { t: 'err', m: 'Game already started' });
        ws.room = String(m.code).toUpperCase(); ws.pid = r.nextId++;
        r.peers.set(ws.pid, ws);
        this.send(ws, { t: 'joined', id: ws.pid });
        this.send(r.host, { t: 'peer', id: ws.pid, name: String(m.name || 'CHEF').slice(0, 12), style: String(m.style || 'classic').slice(0, 12) });
      } else if (m.t === 'sig' || m.t === 'rly') {
        const r = this.rooms.get(ws.room); if (!r) return;
        if (m.to === 0) this.send(r.host, { t: m.t, from: ws.pid, d: m.d });
        else this.send(r.peers.get(m.to), { t: m.t, from: ws.pid, d: m.d });
      } else if (m.t === 'bc') {
        const r = this.rooms.get(ws.room); if (!r || ws !== r.host) return;
        for (const p of r.peers.values()) this.send(p, { t: 'rly', from: 0, d: m.d });
      } else if (m.t === 'lock') {
        const r = this.rooms.get(ws.room); if (r && ws === r.host) r.started = true;
      }
    });
    const bye = () => {
      const r = this.rooms.get(ws.room); if (!r) return;
      if (ws.isHost) {
        for (const p of r.peers.values()) this.send(p, { t: 'hostgone' });
        this.rooms.delete(ws.room);
      } else {
        r.peers.delete(ws.pid);
        this.send(r.host, { t: 'gone', id: ws.pid });
        for (const p of r.peers.values()) this.send(p, { t: 'gone', id: ws.pid });
      }
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }
}
