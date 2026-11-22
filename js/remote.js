// Hybrid Remote Control Engine (Tablet <-> Laptop / Beamer)
// Mode 1 (Auto): Local Laptop Server (ws:// + SSE fallback, 100% offline, <5ms latency)
// Mode 2 (Online): WSS Relay (Custom Cloudflare Worker Port 443 OR Zero-Setup MQTT-over-WSS)
// Works identically on iPadOS, Android tablets & desktops (no WebRTC / no iOS mDNS blocks)

import { $, esc, lsGet, lsSet, uid, showToast } from './utils.js';
import { qrToSvg } from './qr.js';

// Verified reliable MQTT-over-WSS broker (fixed primary so both devices ALWAYS land on the exact same broker!)
const DEFAULT_MQTT_BROKER = 'wss://test.mosquitto.org:8081/mqtt';

// --- Minimal Zero-Dependency MQTT 3.1.1 over WebSocket Client ---
class MiniMqttClient {
  constructor(url, clientId, topic, onMessage, onOpen, onClose) {
    this.url = url;
    this.clientId = clientId;
    this.topic = topic;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.pingTimer = null;
    this.closed = false;
    this.pktId = 1;
    this._connect();
  }

  _encodeVarLen(len) {
    const out = [];
    do {
      let byte = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) byte |= 0x80;
      out.push(byte);
    } while (len > 0);
    return out;
  }

  _encodeStr(str) {
    const b = new TextEncoder().encode(str);
    return new Uint8Array([(b.length >> 8) & 0xff, b.length & 0xff, ...b]);
  }

  _concat(...arrs) {
    const total = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }

  _sendPacket(typeByte, body) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const lenBytes = new Uint8Array(this._encodeVarLen(body.length));
    this.ws.send(this._concat(new Uint8Array([typeByte]), lenBytes, body));
  }

  _connect() {
    try {
      this.ws = new WebSocket(this.url, 'mqtt');
    } catch {
      this.onClose('connect-error');
      return;
    }
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      // MQTT 3.1.1 CONNECT packet
      const proto = this._encodeStr('MQTT');
      const header = new Uint8Array([4, 0x02, 0x00, 30]); // v3.1.1, clean session, 30s keepalive
      const cid = this._encodeStr(this.clientId);
      this._sendPacket(0x10, this._concat(proto, header, cid));
    };

    this.ws.onmessage = e => {
      const chunk = new Uint8Array(e.data);
      this.buf = this._concat(this.buf, chunk);
      this._drain();
    };

    this.ws.onerror = () => {
      // onclose will follow
    };

    this.ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (!this.closed) this.onClose('closed');
    };
  }

  _drain() {
    while (this.buf.length >= 2) {
      let mult = 1, remLen = 0, idx = 1, byte = 0;
      let completeLen = false;
      while (idx < this.buf.length) {
        byte = this.buf[idx++];
        remLen += (byte & 0x7f) * mult;
        if ((byte & 0x80) === 0) { completeLen = true; break; }
        mult *= 128;
        if (idx > 5) return;
      }
      if (!completeLen || this.buf.length < idx + remLen) return;

      const pktType = this.buf[0] >> 4;
      const flags = this.buf[0] & 0x0f;
      const body = this.buf.subarray(idx, idx + remLen);
      this.buf = this.buf.subarray(idx + remLen);

      if (pktType === 2) {
        // CONNACK
        if (body[1] === 0) {
          // Subscribe to room topic
          const pid = this.pktId++;
          const topicBytes = this._encodeStr(this.topic);
          this._sendPacket(0x82, this._concat(new Uint8Array([(pid >> 8) & 0xff, pid & 0xff]), topicBytes, new Uint8Array([0])));
        } else {
          this.close();
          this.onClose('connack-error');
        }
      } else if (pktType === 9) {
        // SUBACK -> Ready!
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          this._sendPacket(0xC0, new Uint8Array(0)); // PINGREQ
        }, 20000);
        this.onOpen();
      } else if (pktType === 3) {
        // PUBLISH
        const tLen = (body[0] << 8) | body[1];
        const qos = (flags >> 1) & 3;
        const payStart = 2 + tLen + (qos > 0 ? 2 : 0);
        const text = new TextDecoder().decode(body.subarray(payStart));
        this.onMessage(text);
      }
    }
  }

  send(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const tBytes = this._encodeStr(this.topic);
    const pBytes = new TextEncoder().encode(text);
    this._sendPacket(0x30, this._concat(tBytes, pBytes));
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
  }
}

// --- Hybrid Remote Controller ---
export function createRemote({ onReceive, onStatusChange, onOpenModal }) {
  const clientId = 'cp-' + uid().slice(0, 8);

  const state = {
    serverInfo: null,        // Filled if local laptop server detected
    selectedIp: '',          // Optional override if laptop has multiple LAN/Wi-Fi adapters
    mode: 'online',          // 'local' | 'custom-wss' | 'online-mqtt'
    role: null,              // 'ctrl' | 'display' | null
    room: '',
    connected: false,
    reconnecting: false,
    peers: { ctrl: 0, display: 0 },
    latencyMs: null,
    error: '',
    customRelayUrl: lsGet('cp_relay_url', ''),
    blackout: false
  };

  let transport = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let pingTimer = null;
  let helloTimer = null;
  let lastPongAt = 0;
  let manualDisconnect = false;

  async function detectServer() {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1400);
        const res = await fetch('/api/info', { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (res.ok) {
          const info = await res.json();
          if (info && info.mode === 'local-server') {
            state.serverInfo = info;
            state.mode = 'local';
            return info;
          }
        }
      } catch {
        // Static web host (Netlify / GitHub Pages)
      }
    }
    state.serverInfo = null;
    state.mode = state.customRelayUrl ? 'custom-wss' : 'online-mqtt';
    return null;
  }

  function generateRoomCode() {
    const len = state.mode === 'local' ? 4 : 6;
    const min = Math.pow(10, len - 1);
    return String(Math.floor(min + Math.random() * (9 * min)));
  }

  function getJoinUrl(targetRole = 'ctrl') {
    let base;
    if (state.serverInfo && state.serverInfo.primaryUrl) {
      if (state.selectedIp) {
        base = `http://${state.selectedIp}:${state.serverInfo.port}/`;
      } else {
        base = state.serverInfo.primaryUrl + '/';
      }
    } else {
      base = location.origin + location.pathname;
    }
    const params = new URLSearchParams();
    params.set('remote', targetRole);
    params.set('room', state.room);
    if (state.mode === 'custom-wss' && state.customRelayUrl) {
      params.set('relay', state.customRelayUrl);
    }
    return `${base}?${params.toString()}`;
  }

  function notify() {
    renderModal();
    if (onStatusChange) onStatusChange(state);
  }

  function send(msgObj) {
    if (!transport || !state.connected) return;
    try {
      transport.send(JSON.stringify({ ...msgObj, _sid: clientId }));
    } catch {
      // ignore
    }
  }

  function hasRemotePeer() {
    return state.role === 'display' ? state.peers.ctrl > 0 : state.peers.display > 0;
  }

  function handleIncoming(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || msg._sid === clientId) return;

    if (msg.t === 'ping') {
      // Reply directly so peer-to-peer latency works in both local and online MQTT mode
      send({ t: 'pong', ts: msg.ts, role: state.role });
      return;
    }

    if (msg.t === 'pong') {
      lastPongAt = Date.now();
      if (msg.ts) state.latencyMs = Math.max(1, Date.now() - msg.ts);
      if (msg.role === 'ctrl') state.peers.ctrl = Math.max(1, state.peers.ctrl);
      if (msg.role === 'display') state.peers.display = Math.max(1, state.peers.display);
      notify();
      return;
    }

    if (msg.t === 'test-ping') {
      showToast('📡 Test-Signal von der Gegenseite empfangen!', 2500);
      send({ t: 'test-ack' });
      return;
    }

    if (msg.t === 'test-ack') {
      showToast('✅ Gegenseite hat das Test-Signal bestätigt!', 2500);
      return;
    }

    if (msg.t === 'presence') {
      state.peers = { ctrl: msg.ctrl || 0, display: msg.display || 0 };
      if (state.role === 'ctrl' && state.peers.display > 0 && onReceive) {
        onReceive({ t: 'hello' });
      }
      notify();
      return;
    }

    if (msg.t === 'hello') {
      if (msg.role === 'ctrl') state.peers.ctrl = Math.max(1, state.peers.ctrl);
      if (msg.role === 'display') state.peers.display = Math.max(1, state.peers.display);
      send({ t: 'peer-hi', role: state.role });
      notify();
      if (onReceive) onReceive(msg);
      return;
    }

    if (msg.t === 'peer-hi') {
      if (msg.role === 'ctrl') state.peers.ctrl = Math.max(1, state.peers.ctrl);
      if (msg.role === 'display') state.peers.display = Math.max(1, state.peers.display);
      notify();
      // If a display just greeted us while we're controller, immediately push current song!
      if (state.role === 'ctrl' && msg.role === 'display' && onReceive) {
        onReceive({ t: 'hello' });
      }
      return;
    }

    if (onReceive) onReceive(msg);
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    // Periodically announce presence until the other device responds (solves join-order race!)
    helloTimer = setInterval(() => {
      if (!state.connected) return;
      if (!hasRemotePeer()) {
        send({ t: 'hello', role: state.role });
      } else {
        clearInterval(helloTimer);
        helloTimer = null;
      }
    }, 2500);

    pingTimer = setInterval(() => {
      if (!state.connected) return;
      if (state.mode !== 'online-mqtt' && Date.now() - lastPongAt > 14000) {
        scheduleReconnect(true);
        return;
      }
      if (state.mode !== 'online-mqtt' || hasRemotePeer()) {
        send({ t: 'ping', ts: Date.now() });
      }
    }, 5000);
  }

  function stopHeartbeat() {
    clearInterval(pingTimer);
    clearInterval(helloTimer);
    pingTimer = null;
    helloTimer = null;
  }

  function teardownTransport() {
    stopHeartbeat();
    clearTimeout(reconnectTimer);
    if (transport) {
      try { transport.close(); } catch { /* ignore */ }
      transport = null;
    }
    state.connected = false;
  }

  function scheduleReconnect(immediate = false) {
    if (manualDisconnect || !state.role || !state.room) return;
    teardownTransport();
    state.reconnecting = true;
    notify();
    const delay = immediate ? 150 : Math.min(8000, 600 * Math.pow(1.6, reconnectAttempt));
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      if (!manualDisconnect && state.role) openConnection();
    }, delay);
  }

  function openConnection() {
    teardownTransport();
    state.error = '';

    const onOpen = () => {
      state.connected = true;
      state.reconnecting = false;
      state.error = '';
      reconnectAttempt = 0;
      startHeartbeat();
      send({ t: 'hello', role: state.role });
      if (state.mode === 'online-mqtt') send({ t: 'peer-hi', role: state.role });
      notify();
    };

    const onDrop = reason => {
      if (manualDisconnect) return;
      state.connected = false;
      if (reason && reconnectAttempt > 2) {
        state.error = 'Verbindung unterbrochen – versuche erneuten Verbindungsaufbau…';
      }
      scheduleReconnect(false);
    };

    if (state.mode === 'local') {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${location.host}/ws?room=${encodeURIComponent(state.room)}&role=${encodeURIComponent(state.role)}`;
      openPlainWebSocket(wsUrl, onOpen, () => {
        // Fallback to SSE + POST on local server if WS is blocked
        openLocalSse(onOpen, onDrop);
      });
    } else if (state.mode === 'custom-wss' && state.customRelayUrl) {
      const sep = state.customRelayUrl.includes('?') ? '&' : '?';
      const wsUrl = `${state.customRelayUrl}${sep}room=${encodeURIComponent(state.room)}&role=${encodeURIComponent(state.role)}`;
      openPlainWebSocket(wsUrl, onOpen, onDrop);
    } else {
      const topic = `chordpro-studio/v2/room/${state.room}`;
      transport = new MiniMqttClient(DEFAULT_MQTT_BROKER, clientId, topic, handleIncoming, onOpen, onDrop);
    }
  }

  function openPlainWebSocket(wsUrl, onOpen, onDrop) {
    let opened = false;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      onDrop('ws-construct-error');
      return;
    }
    const timeout = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch { /* ignore */ }
        onDrop('timeout');
      }
    }, 5000);

    ws.onopen = () => {
      opened = true;
      clearTimeout(timeout);
      onOpen();
    };
    ws.onmessage = e => handleIncoming(e.data);
    ws.onclose = () => {
      clearTimeout(timeout);
      onDrop('closed');
    };
    ws.onerror = () => {
      // onclose handles fallback/reconnect
    };
    transport = {
      send: txt => { if (ws.readyState === WebSocket.OPEN) ws.send(txt); },
      close: () => { clearTimeout(timeout); ws.onclose = null; ws.close(); }
    };
  }

  function openLocalSse(onOpen, onDrop) {
    const url = `/api/events?room=${encodeURIComponent(state.room)}&role=${encodeURIComponent(state.role)}`;
    const es = new EventSource(url);
    es.onopen = () => onOpen();
    es.onmessage = e => handleIncoming(e.data);
    es.onerror = () => {
      es.close();
      onDrop('sse-error');
    };
    transport = {
      send: txt => {
        fetch(`/api/send?room=${encodeURIComponent(state.room)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: txt
        }).catch(() => {});
      },
      close: () => es.close()
    };
  }

  function start(role, roomCode = '') {
    manualDisconnect = false;
    state.role = role;
    state.room = (roomCode || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || generateRoomCode();
    state.peers = { ctrl: 0, display: 0 };
    state.latencyMs = null;
    state.error = '';
    reconnectAttempt = 0;
    notify();
    openConnection();
  }

  function stop() {
    manualDisconnect = true;
    teardownTransport();
    state.role = null;
    state.room = '';
    state.reconnecting = false;
    state.peers = { ctrl: 0, display: 0 };
    state.latencyMs = null;
    state.error = '';
    state.blackout = false;
    notify();
  }

  function setCustomRelayUrl(url) {
    const clean = String(url || '').trim();
    state.customRelayUrl = clean;
    lsSet('cp_relay_url', clean);
    if (!state.serverInfo) {
      state.mode = clean ? 'custom-wss' : 'online-mqtt';
    }
    notify();
  }

  // iOS Safari & PWA Resilience: instant reconnect when waking up or returning to foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.role && !manualDisconnect) {
      if (!state.connected) {
        scheduleReconnect(true);
      } else {
        // Verify socket is still alive after iOS suspension
        send({ t: 'ping', ts: Date.now() });
        if (state.role === 'ctrl') {
          if (onReceive) onReceive({ t: 'hello' });
        } else {
          send({ t: 'hello', role: 'display' });
        }
      }
    }
  });

  window.addEventListener('online', () => {
    if (state.role && !manualDisconnect && !state.connected) {
      scheduleReconnect(true);
    }
  });

  // --- Modal UI ---
  function renderModal() {
    const container = $('#syb');
    if (!container) return;

    const modeBadge = state.mode === 'local'
      ? `<span class="badge badge-ok">⚡ Lokaler Laptop-Server (Offline, WLAN)</span>`
      : state.mode === 'custom-wss'
        ? `<span class="badge badge-ok">☁️ Eigener Cloud-Relay (WSS Port 443)</span>`
        : `<span class="badge badge-info">🌐 Online WSS-Relay (iPadOS &amp; Android)</span>`;

    let html = `<div style="margin-bottom:10px">${modeBadge}</div>`;

    if (state.role) {
      const paired = hasRemotePeer();
      const statusDot = !state.connected
        ? (state.reconnecting ? '🟡 Verbinde neu…' : '🟡 Verbinde mit Server…')
        : paired
          ? '🟢 Gekoppelt &amp; bereit'
          : '🟡 Relay aktiv · Warte auf Gegenseite…';
      const roleLabel = state.role === 'display' ? '🖥 Anzeige (Laptop / Beamer)' : '🎹 Steuerung (Tablet)';
      const latencyTxt = state.latencyMs != null ? ` · ${state.latencyMs} ms` : '';
      const peerTxt = state.role === 'display'
        ? (state.peers.ctrl > 0 ? ` · ${state.peers.ctrl} Steuerung verbunden` : '')
        : (state.peers.display > 0 ? ` · ${state.peers.display} Anzeige verbunden` : '');

      html += `
        <div class="remote-card">
          <div class="remote-status">${statusDot}${latencyTxt}${peerTxt}</div>
          <div class="muted" style="margin-top:2px">Rolle: <b>${roleLabel}</b> · Raum: <code class="room-code-inline">${esc(state.room)}</code></div>
        </div>`;

      if (state.role === 'display') {
        const joinUrl = getJoinUrl('ctrl');
        let qrSvg = '';
        try { qrSvg = qrToSvg(joinUrl, 190); } catch { /* ignore */ }
        const ipPicker = state.serverInfo && state.serverInfo.ips && state.serverInfo.ips.length > 1
          ? `<div class="flex items-center gap-1" style="margin-top:6px;font-size:12px"><span class="muted">WLAN-IP:</span><select id="sy-ip" style="min-height:26px;font-size:12px">${state.serverInfo.ips.map(ip => `<option value="${esc(ip)}"${(state.selectedIp || state.serverInfo.ips[0]) === ip ? ' selected' : ''}>${esc(ip)}</option>`).join('')}</select></div>`
          : '';
        html += `
          <div class="qr-panel">
            <div class="qr-box">${qrSvg}</div>
            <div class="qr-info">
              <div class="qr-step">1. Tablet-Kamera auf den QR-Code halten</div>
              <div class="muted" style="font-size:12px;margin:4px 0 8px">Funktioniert auf iPad (Safari) &amp; Android (Chrome) – kein WebRTC-Block. Sobald am Tablet ein Song in Live Stage startet, blendet sich dieses Fenster automatisch aus.</div>
              <div class="qr-code-num">${esc(state.room)}</div>
              ${ipPicker}
              <div class="muted" style="font-size:11px;word-break:break-all;margin-top:6px">${esc(joinUrl)}</div>
              <div class="flex gap-2 flex-wrap" style="margin-top:8px">
                <button class="btn-sm" id="sy-copy">Link kopieren</button>
                <button class="btn-sm" id="sy-beamer-qr">📺 QR auf Beamer zeigen</button>
                <button class="btn-sm" id="sy-test">🧪 Test-Signal</button>
              </div>
            </div>
          </div>`;
      } else {
        html += `
          <p class="muted" style="font-size:13px;margin:10px 0">
            Öffne jetzt <b>Live Stage</b>: Jeder Songwechsel, jedes Scrollen, jeder Sektions-Sprung und <b>Beamer Schwarz</b> wird direkt an die Anzeige übertragen.
          </p>
          <div class="flex gap-2 flex-wrap">
            <button id="sy-go-stage" class="pri">🎤 Live Stage öffnen</button>
            <button id="sy-resync">↻ Neu synchronisieren</button>
            <button id="sy-test">🧪 Test-Signal</button>
          </div>`;
      }

      html += `<div style="margin-top:12px"><button id="sy-stop" class="danger">Verbindung trennen</button></div>`;
    } else {
      html += `
        <p style="margin:0 0 10px;font-size:14px">Wähle die Rolle dieses Geräts:</p>
        <div class="remote-roles">
          <button id="sy-display" class="role-btn">
            <span class="role-title">🖥 Anzeige (Laptop / Beamer)</span>
            <span class="role-desc">Erzeugt Raum-Code &amp; QR-Code fürs Tablet. Empfängt Song, Scroll &amp; Blackout.</span>
          </button>
          <div class="role-btn role-ctrl-box">
            <span class="role-title">🎹 Steuerung (Tablet)</span>
            <span class="role-desc">Code der Anzeige eingeben (oder einfach deren QR-Code mit iPad / Android scannen):</span>
            <div class="flex gap-2" style="margin-top:8px">
              <input type="text" id="sy-code-in" inputmode="numeric" maxlength="12" placeholder="${state.mode === 'local' ? '4-stellig' : '6-stellig'}" style="width:120px;text-align:center;font-weight:700;letter-spacing:2px">
              <button id="sy-join" class="pri">Verbinden</button>
            </div>
          </div>
        </div>`;

      if (state.mode !== 'local') {
        html += `
          <details class="remote-adv">
            <summary>⚙ Offline-Bühne &amp; Eigener Cloud-Relay</summary>
            <div style="margin-top:8px;font-size:12px;line-height:1.5">
              <p><b>100 % Offline (ohne Internet):</b> Starte auf dem Laptop <code>start-stage-server.bat</code> (oder <code>node server.mjs</code>) und verbinde Laptop &amp; Tablet per WLAN/Hotspot. Die App erkennt den lokalen Server dann automatisch!</p>
              <p style="margin-top:8px"><b>Eigener Cloudflare WSS-Relay (Port 443, optional):</b></p>
              <div class="flex gap-2" style="margin-top:4px">
                <input type="text" id="sy-relay-in" value="${esc(state.customRelayUrl)}" placeholder="wss://chordpro-relay.xxx.workers.dev/ws" style="flex:1;font-size:12px">
                <button class="btn-sm" id="sy-relay-save">Speichern</button>
              </div>
              <p class="muted" style="margin-top:4px">Leer lassen für den eingebauten Standard-WSS-Relay. Vorlage liegt in <code>cloud-relay/worker.js</code>.</p>
            </div>
          </details>`;
      } else {
        html += `
          <p class="muted" style="font-size:12px;margin-top:10px">
            ✅ Läuft lokal auf <code>${esc(state.serverInfo.primaryUrl)}</code> – 100 % offline, kein Internet und kein WebRTC nötig!
          </p>`;
      }
    }

    if (state.error) {
      html += `<p style="color:#f59e0b;font-size:13px;margin-top:8px">${esc(state.error)}</p>`;
    }

    container.innerHTML = html;

    // Bind events
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('sy-display', () => start('display'));
    on('sy-join', () => {
      const code = ($('#sy-code-in')?.value || '').trim();
      if (!code) { showToast('Bitte Raum-Code eingeben'); return; }
      start('ctrl', code);
    });
    const codeInput = $('#sy-code-in');
    if (codeInput) {
      codeInput.onkeydown = e => { if (e.key === 'Enter') $('#sy-join')?.click(); };
    }
    on('sy-stop', stop);
    on('sy-copy', () => {
      const url = getJoinUrl('ctrl');
      navigator.clipboard?.writeText(url).then(() => showToast('Link kopiert')).catch(() => showToast(url));
    });
    on('sy-beamer-qr', () => showBeamerQrOverlay());
    on('sy-go-stage', () => {
      $('#md').classList.remove('show');
      window.dispatchEvent(new CustomEvent('cp:open-stage'));
    });
    on('sy-resync', () => {
      if (onReceive) onReceive({ t: 'hello' });
      showToast('Synchronisiert');
    });
    on('sy-test', () => {
      send({ t: 'test-ping' });
      showToast('Test-Signal gesendet…');
    });
    on('sy-relay-save', () => {
      setCustomRelayUrl($('#sy-relay-in')?.value || '');
      showToast(state.customRelayUrl ? 'Eigener Cloud-Relay gespeichert' : 'Standard-WSS-Relay aktiv');
    });
    const ipSel = $('#sy-ip');
    if (ipSel) {
      ipSel.onchange = e => { state.selectedIp = e.target.value; renderModal(); };
    }
  }

  function showBeamerQrOverlay() {
    let ov = $('#beamer-qr-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'beamer-qr-overlay';
      document.body.appendChild(ov);
    }
    const joinUrl = getJoinUrl('ctrl');
    ov.innerHTML = `
      <div class="bqr-card">
        <h2>Tablet verbinden</h2>
        <div class="bqr-svg">${qrToSvg(joinUrl, 300)}</div>
        <div class="bqr-code">Code: <b>${esc(state.room)}</b></div>
        <div class="bqr-url">${esc(joinUrl)}</div>
        <button class="pri" id="bqr-close" style="margin-top:16px">Schließen</button>
      </div>`;
    ov.classList.add('show');
    $('#md').classList.remove('show');
    $('#bqr-close').onclick = () => ov.classList.remove('show');
    ov.onclick = e => { if (e.target === ov) ov.classList.remove('show'); };
  }

  async function initFromUrl() {
    await detectServer();
    const params = new URLSearchParams(location.search);
    const remoteRole = params.get('remote');
    const room = params.get('room');
    const relay = params.get('relay');
    if (relay && /^wss?:\/\//i.test(relay)) {
      setCustomRelayUrl(relay);
    }
    if ((remoteRole === 'ctrl' || remoteRole === 'display') && room) {
      start(remoteRole, room);
      // Clean URL query params so reload doesn't get stuck if user disconnects
      try {
        const cleanUrl = location.pathname;
        history.replaceState(null, '', cleanUrl);
      } catch { /* ignore */ }
      return remoteRole;
    }
    return null;
  }

  return {
    state,
    detectServer,
    initFromUrl,
    start,
    stop,
    send,
    renderModal,
    showBeamerQrOverlay,
    openModal: () => {
      renderModal();
      if (onOpenModal) onOpenModal();
    }
  };
}
