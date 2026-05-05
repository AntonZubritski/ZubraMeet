// zubrameet-signal — WebSocket signaling через Cloudflare Durable Objects.
// Каждая комната = один DO instance, держит presence (peerId + sessionId
// каждого подключённого клиента) и форвардит JSON-сообщения между ними.
//
// Endpoints:
//   GET  /                  → health
//   GET  /room/<roomId>     → WebSocket upgrade, требует ?peerId=...
//
// Сообщения от клиента:
//   { type: 'announce', sessionId: '<cf-realtime-session-id>' }
//   { type: 'signal', target: <peerId>, payload: <any> }   — точечная пересылка
// Сообщения от Worker'а клиенту:
//   { type: 'welcome', peerId, peers: [{peerId, sessionId?}, ...] }
//   { type: 'peer-joined', peerId, sessionId? }
//   { type: 'peer-left', peerId }
//   { type: 'signal', from: <peerId>, payload: <any> }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Upgrade',
};

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // peerId → { ws, sessionId|null }
    this.peers = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const peerId = url.searchParams.get('peerId');
    if (!peerId || !/^[A-Za-z0-9_-]{4,64}$/.test(peerId)) {
      return new Response('valid peerId query param required', { status: 400 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    // Дубликат peerId — закрываем старое (типично reconnect)
    if (this.peers.has(peerId)) {
      try { this.peers.get(peerId).ws.close(1000, 'replaced'); } catch { /* ignore */ }
      this.peers.delete(peerId);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.acceptSession(server, peerId);
    return new Response(null, { status: 101, webSocket: client });
  }

  acceptSession(ws, peerId) {
    ws.accept();
    const entry = { ws, sessionId: null };
    this.peers.set(peerId, entry);

    // Welcome — список уже-присутствующих peer'ов с их sessionId.
    const others = Array.from(this.peers.entries())
      .filter(([id]) => id !== peerId)
      .map(([id, e]) => ({ peerId: id, sessionId: e.sessionId }));
    try {
      ws.send(JSON.stringify({ type: 'welcome', peerId, peers: others }));
    } catch { /* ignore */ }

    // Уведомляем остальных что прибыл новый (sessionId придёт позже через announce)
    this.broadcast(peerId, { type: 'peer-joined', peerId, sessionId: null });

    ws.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch { return; }
      if (!data || typeof data !== 'object') return;

      if (data.type === 'announce' && typeof data.sessionId === 'string') {
        // Обновляем sessionId и рассылаем обновление всем
        entry.sessionId = data.sessionId;
        this.broadcast(peerId, { type: 'peer-joined', peerId, sessionId: data.sessionId });
        return;
      }
      if (data.type === 'signal' && typeof data.target === 'string') {
        const target = this.peers.get(data.target);
        if (!target) return;
        try {
          target.ws.send(JSON.stringify({
            type: 'signal',
            from: peerId,
            payload: data.payload,
          }));
        } catch {
          this.peers.delete(data.target);
        }
        return;
      }
    });

    const cleanup = () => {
      if (this.peers.get(peerId) !== entry) return;
      this.peers.delete(peerId);
      this.broadcast(peerId, { type: 'peer-left', peerId });
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  broadcast(exceptPeerId, msg) {
    const json = JSON.stringify(msg);
    for (const [id, entry] of this.peers) {
      if (id === exceptPeerId) continue;
      try { entry.ws.send(json); } catch { this.peers.delete(id); }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('zubrameet-signal OK\n', {
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' },
      });
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{4,64})$/);
    if (!m) return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    const id = env.ROOMS.idFromName(m[1]);
    return env.ROOMS.get(id).fetch(request);
  },
};
