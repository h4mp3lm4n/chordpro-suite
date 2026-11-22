#!/usr/bin/env node
// ChordPro Studio – Local Stage Server (Zero Dependencies, Node.js >= 18)
// Enables 100% offline, ultra-low-latency iPad <-> Laptop remote control over LAN/Hotspot
// + optional shared .cho song folder sync!

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const PORT = parseInt(getArg('--port', process.env.PORT || '3000'), 10) || 3000;
const defaultSongsDir = path.join(__dirname, 'songs');
const explicitSongsDir = getArg('--songs', process.env.SONGS_DIR || '');
const SONGS_DIR = explicitSongsDir
  ? path.resolve(explicitSongsDir)
  : (fs.existsSync(defaultSongsDir) ? defaultSongsDir : null);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function getLanIps() {
  const nets = os.networkInterfaces();
  const wifi = [];
  const lan = [];
  const other = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const isVirtual =
        /vethernet|wsl|docker|vmware|virtualbox|vbox|host-only|tailscale|zerotier|wireguard|loopback|nordlynx|tun|tap/i.test(name) ||
        a.address.startsWith('192.168.56.') ||
        a.address.startsWith('169.254.');
      if (isVirtual) {
        other.push({ name, address: a.address });
      } else if (/wi-?fi|wlan|wireless|airport|en0/i.test(name)) {
        wifi.push({ name, address: a.address });
      } else {
        lan.push({ name, address: a.address });
      }
    }
  }
  return [...wifi, ...lan, ...other].map(x => x.address);
}

// --- Room State Management ---
const rooms = new Map();

function getRoom(roomId) {
  const key = String(roomId || 'stage').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'stage';
  if (!rooms.has(key)) {
    rooms.set(key, {
      wsClients: new Set(),
      sseClients: new Set(),
      lastSong: null,
      lastScroll: null,
      lastBlackout: { t: 'blackout', on: false }
    });
  }
  return rooms.get(key);
}

function broadcastRoom(roomId, msgStr, sender = null) {
  const room = getRoom(roomId);
  let parsed = null;
  try { parsed = JSON.parse(msgStr); } catch { /* ignore */ }

  if (parsed) {
    if (parsed.t === 'song') {
      room.lastSong = msgStr;
      room.lastScroll = null;
    } else if (parsed.t === 'scroll') {
      room.lastScroll = msgStr;
    } else if (parsed.t === 'blackout') {
      room.lastBlackout = parsed;
    } else if (parsed.t === 'ping') {
      // Reply directly with pong to sender for latency measurement
      const pong = JSON.stringify({ t: 'pong', ts: parsed.ts, peers: room.wsClients.size + room.sseClients.size });
      if (sender && sender.send) sender.send(pong);
      return;
    }
  }

  for (const client of room.wsClients) {
    if (client !== sender) client.send(msgStr);
  }
  for (const res of room.sseClients) {
    if (res !== sender) {
      try { res.write(`data: ${msgStr}\n\n`); } catch { room.sseClients.delete(res); }
    }
  }
}

function sendInitialState(room, sendFn) {
  if (room.lastSong) sendFn(room.lastSong);
  if (room.lastScroll) sendFn(room.lastScroll);
  if (room.lastBlackout && room.lastBlackout.on) sendFn(JSON.stringify(room.lastBlackout));
}

function broadcastPresence(roomId) {
  const room = getRoom(roomId);
  const roles = { ctrl: 0, display: 0 };
  for (const c of room.wsClients) if (roles[c.role] !== undefined) roles[c.role]++;
  for (const c of room.sseClients) if (roles[c.role] !== undefined) roles[c.role]++;
  const msg = JSON.stringify({ t: 'presence', ...roles });
  for (const c of room.wsClients) c.send(msg);
  for (const r of room.sseClients) {
    try { r.write(`data: ${msg}\n\n`); } catch { room.sseClients.delete(r); }
  }
}

// --- Pure Node.js RFC 6455 WebSocket Implementation ---
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeWsFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const roomId = url.searchParams.get('room') || 'stage';
  const role = url.searchParams.get('role') || 'ctrl';
  const room = getRoom(roomId);

  const client = {
    role,
    send(text) {
      if (!socket.destroyed && socket.writable) {
        try { socket.write(encodeWsFrame(text, 0x1)); } catch { /* ignore */ }
      }
    }
  };

  room.wsClients.add(client);
  broadcastPresence(roomId);
  if (role === 'display') {
    sendInitialState(room, msg => client.send(msg));
  }

  let buf = Buffer.alloc(0);

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + payloadLen) return;

      const payload = Buffer.allocUnsafe(payloadLen);
      buf.copy(payload, 0, offset, offset + payloadLen);
      if (masked) {
        for (let i = 0; i < payloadLen; i++) {
          payload[i] ^= buf[maskOffset + (i & 3)];
        }
      }

      buf = buf.subarray(offset + payloadLen);

      if (opcode === 0x8) {
        // Close
        try { socket.write(encodeWsFrame(Buffer.alloc(0), 0x8)); } catch { /* ignore */ }
        socket.end();
        return;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        try { socket.write(encodeWsFrame(payload, 0xA)); } catch { /* ignore */ }
      } else if (opcode === 0x1) {
        // Text frame
        broadcastRoom(roomId, payload.toString('utf8'), client);
      }
    }
  });

  const cleanup = () => {
    room.wsClients.delete(client);
    broadcastPresence(roomId);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// --- HTTP Request Handler ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // API: Server info & LAN URLs
  if (pathname === '/api/info') {
    const ips = getLanIps();
    const primaryUrl = ips.length ? `http://${ips[0]}:${PORT}` : `http://localhost:${PORT}`;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      mode: 'local-server',
      port: PORT,
      ips,
      primaryUrl,
      songsDir: Boolean(SONGS_DIR)
    }));
    return;
  }

  // API: SSE fallback stream
  if (pathname === '/api/events') {
    const roomId = url.searchParams.get('room') || 'stage';
    const role = url.searchParams.get('role') || 'ctrl';
    const room = getRoom(roomId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.role = role;
    res.write(': connected\n\n');
    room.sseClients.add(res);
    broadcastPresence(roomId);
    if (role === 'display') {
      sendInitialState(room, msg => res.write(`data: ${msg}\n\n`));
    }

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      room.sseClients.delete(res);
      broadcastPresence(roomId);
    });
    return;
  }

  // API: HTTP POST fallback for sending messages
  if (pathname === '/api/send' && req.method === 'POST') {
    const roomId = url.searchParams.get('room') || 'stage';
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 512_000) req.destroy(); });
    req.on('end', () => {
      broadcastRoom(roomId, body, null);
      res.writeHead(204);
      res.end();
    });
    return;
  }

  // API: Shared local songs folder
  if (pathname === '/api/songs' && req.method === 'GET') {
    if (!SONGS_DIR) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No songs directory configured' }));
      return;
    }
    try {
      const files = fs.readdirSync(SONGS_DIR)
        .filter(f => /\.(cho|chordpro|crd|pro|txt)$/i.test(f))
        .map(file => ({
          file,
          text: fs.readFileSync(path.join(SONGS_DIR, file), 'utf8')
        }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(files));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/songs/') && req.method === 'PUT') {
    if (!SONGS_DIR) {
      res.writeHead(404);
      res.end();
      return;
    }
    const baseName = path.basename(pathname.slice('/api/songs/'.length));
    if (!baseName || baseName.startsWith('.') || !/\.(cho|chordpro|crd|pro|txt)$/i.test(baseName)) {
      res.writeHead(400);
      res.end('Invalid filename');
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        fs.writeFileSync(path.join(SONGS_DIR, baseName), body, 'utf8');
        res.writeHead(204);
        res.end();
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
    return;
  }

  // Static files
  const relPath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.resolve(__dirname, '.' + relPath);
  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
});

server.on('upgrade', handleUpgrade);

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIps();
  console.log('\n=======================================================');
  console.log('  🎸 ChordPro Studio – Lokaler Stage-Server aktiv!');
  console.log('=======================================================');
  console.log(`  Laptop (Beamer):  http://localhost:${PORT}`);
  if (ips.length) {
    ips.forEach(ip => console.log(`  Tablet (im WLAN): http://${ip}:${PORT}`));
  } else {
    console.log('  Hinweis: Kein WLAN/LAN erkannt – Hotspot aktivieren!');
  }
  if (SONGS_DIR) {
    console.log(`  Song-Ordner:      ${SONGS_DIR} (automatisch synchron)`);
  } else {
    console.log('  Tipp: Lege einen Ordner "songs" hier an für gemeinsamen');
    console.log('        .cho-Zugriff auf Laptop & Tablet (iPad / Android)!');
  }
  console.log('=======================================================\n');
  console.log('  Drücke Strg+C zum Beenden.\n');
});
