/* Umami Krew — 2cade.com game server
   Static hosting + WebSocket signaling for WebRTC peer-to-peer play.
   Game traffic is P2P (DataChannels); this server only matchmakes and
   relays as a fallback, so CPU/bandwidth stay near zero. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  const fp = path.join(ROOT, path.normalize(url));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': url === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

/* ---------------- rooms ---------------- */
const rooms = new Map();          // code -> {host, peers:Map(id->ws), nextId}
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const mkCode = () => { let c = ''; do { c = Array.from({ length: 4 }, () => ALPHA[Math.random() * ALPHA.length | 0]).join(''); } while (rooms.has(c)); return c; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const roster = r => [{ id: 0, name: r.hostName || 'Host', host: true },
  ...[...r.peers.values()].map(p => ({ id: p.pid, name: p.pname || 'Chef' }))];
const sendAll = (r, o) => { send(r.host, o); for (const p of r.peers.values()) send(p, o); };
const pushRoster = r => sendAll(r, { t: 'roster', list: roster(r) });

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => ws.alive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'create') {
      const code = mkCode();
      ws.room = code; ws.pid = 0; ws.isHost = true;
      ws.pname = String(m.name || 'Host').slice(0, 12);
      rooms.set(code, { host: ws, peers: new Map(), nextId: 1, hostName: ws.pname });
      send(ws, { t: 'room', code });
      pushRoster(rooms.get(code));
    } else if (m.t === 'join') {
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) return send(ws, { t: 'err', m: 'Room not found' });
      if (r.peers.size >= 7) return send(ws, { t: 'err', m: 'Room full' });
      if (r.started) return send(ws, { t: 'err', m: 'Game already started' });
      ws.room = ws.roomCode = String(m.code).toUpperCase(); ws.pid = r.nextId++;
      ws.pname = String(m.name || 'CHEF').slice(0, 12);
      r.peers.set(ws.pid, ws);
      send(ws, { t: 'joined', id: ws.pid, code: ws.room });
      send(r.host, { t: 'peer', id: ws.pid, name: ws.pname, style: String(m.style || 'classic').slice(0, 12) });
      pushRoster(r);
      sendAll(r, { t: 'chat', sys: 1, msg: ws.pname + ' joined the krew' });
    } else if (m.t === 'sig' || m.t === 'rly') {
      // targeted relay: WebRTC signaling, or game messages when P2P is unavailable
      const r = rooms.get(ws.room); if (!r) return;
      if (m.to === 0) send(r.host, { t: m.t, from: ws.pid, d: m.d });
      else send(r.peers.get(m.to), { t: m.t, from: ws.pid, d: m.d });
    } else if (m.t === 'bc') {
      // host broadcast fallback (snapshots when P2P fails)
      const r = rooms.get(ws.room); if (!r || ws !== r.host) return;
      for (const p of r.peers.values()) send(p, { t: 'rly', from: 0, d: m.d });
    } else if (m.t === 'chat') {
      const r = rooms.get(ws.room); if (!r) return;
      const txt = String(m.msg || '').slice(0, 160);
      if (!txt.trim()) return;
      sendAll(r, { t: 'chat', from: ws.pid, name: ws.pname || 'Chef', msg: txt });
    } else if (m.t === 'lock') {
      const r = rooms.get(ws.room); if (r && ws === r.host) r.started = true;
    }
  });
  ws.on('close', () => {
    const r = rooms.get(ws.room); if (!r) return;
    if (ws.isHost) {
      for (const p of r.peers.values()) send(p, { t: 'hostgone' });
      rooms.delete(ws.room);
    } else {
      r.peers.delete(ws.pid);
      send(r.host, { t: 'gone', id: ws.pid });
      for (const p of r.peers.values()) send(p, { t: 'gone', id: ws.pid });
      pushRoster(r);
      sendAll(r, { t: 'chat', sys: 1, msg: (ws.pname || 'A chef') + ' left the room' });
    }
  });
});

/* dead-connection sweep + empty-room GC */
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
}, 30000);

server.listen(PORT, () => console.log('Umami Krew server on :' + PORT));
