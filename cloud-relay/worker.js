// Optional: Eigener Cloudflare Worker + Durable Object WebSocket Relay (Port 443 WSS)
// 100% iOS- & Firewall-kompatibel, kostenloser Cloudflare Workers Free Tier reicht locker!
//
// Deploy-Kurzanleitung (wrangler.toml):
//   name = "chordpro-relay"
//   main = "worker.js"
//   compatibility_date = "2024-09-01"
//   [[durable_objects.bindings]]
//   name = "ROOMS"
//   class_name = "StageRoom"
//   [[migrations]]
//   tag = "v1"
//   new_sqlite_classes = ["StageRoom"]
//
// Danach: `npx wrangler deploy` -> URL in ChordPro Studio unter "Eigener Cloud-Relay" eintragen:
//   wss://chordpro-relay.<dein-name>.workers.dev/ws

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws' || request.headers.get('Upgrade') !== 'websocket') {
      return new Response('ChordPro Studio WSS Relay OK', { status: 200 });
    }
    const room = (url.searchParams.get('room') || 'stage').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'stage';
    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(request);
  }
};

export class StageRoom {
  constructor(state) {
    this.state = state;
    this.lastSong = null;
    this.lastScroll = null;
    this.lastBlackout = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') || 'ctrl';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, [role]);

    if (role === 'display') {
      if (this.lastSong) server.send(this.lastSong);
      if (this.lastScroll) server.send(this.lastScroll);
      if (this.lastBlackout) server.send(this.lastBlackout);
    }
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const str = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let parsed = null;
    try { parsed = JSON.parse(str); } catch { /* ignore */ }

    if (parsed) {
      if (parsed.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', ts: parsed.ts, peers: this.state.getWebSockets().length }));
        return;
      }
      if (parsed.t === 'song') { this.lastSong = str; this.lastScroll = null; }
      else if (parsed.t === 'scroll') this.lastScroll = str;
      else if (parsed.t === 'blackout') this.lastBlackout = str;
    }

    for (const sock of this.state.getWebSockets()) {
      if (sock !== ws) {
        try { sock.send(str); } catch { /* ignore */ }
      }
    }
  }

  webSocketClose() {
    this.broadcastPresence();
  }

  broadcastPresence() {
    let ctrl = 0, display = 0;
    for (const sock of this.state.getWebSockets()) {
      const tags = this.state.getTags(sock);
      if (tags.includes('ctrl')) ctrl++;
      if (tags.includes('display')) display++;
    }
    const msg = JSON.stringify({ t: 'presence', ctrl, display });
    for (const sock of this.state.getWebSockets()) {
      try { sock.send(msg); } catch { /* ignore */ }
    }
  }
}
