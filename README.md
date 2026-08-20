# Umami Krew — 2cade.com

Couch + online co-op cooking game. One static page + a tiny WebSocket
signaling hub; gameplay itself is peer-to-peer WebRTC (host-authoritative),
so server usage stays near zero.

## Hosting (Cloudflare Workers)
- `worker.js` — serves the game and `/ws` signaling (Durable Object `Hub`)
- `wrangler.jsonc` — Workers config (static assets from `./public`)
- `public/index.html` — the entire game

Deployed via Cloudflare Workers Builds: push to this repo → auto deploy.
Custom domain: add `2cade.com` as a Worker domain once the zone is on Cloudflare.

## Self-hosting alternative (any Node box)
`server.js` + `npm i ws` + `node server.js` serves the same thing on :8080.
