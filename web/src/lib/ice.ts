// ICE-конфигурация для WebRTC: STUN + TURN.
//
// TURN-credentials выдаёт наш Cloudflare Worker (zubrameet-turn) на основе
// Cloudflare Realtime TURN — free 1TB/мес relay-трафика, работает из
// большинства стран без блокировок. Ранее использовался OpenRelay free public
// (`openrelayproject:openrelayproject`) — он перестал отвечать (gathering
// зависал, ноль relay-кандидатов), что ломало P2P между клиентами за
// двойным CGNAT (типичный сценарий мобильный↔мобильный из разных стран).
//
// API контракт Worker'а:
//   GET https://zubrameet-turn.ant-zubritski.workers.dev/
//   →   { iceServers: { urls: string[], username: string, credential: string } }
// Worker внутри POST'ит на CF Realtime TURN API с Bearer-token (хранится как
// Worker secret) и возвращает короткоживущие credentials с TTL=24h.
//
// Используется обоими режимами:
//  - SFU (web/src/lib/webrtc.ts) — DEFAULT_ICE_SERVERS у обоих PeerConnection.
//  - P2P (web/src/lib/p2p.ts)    — rtcConfig для Trystero.

const TURN_WORKER_URL = 'https://zubrameet-turn.ant-zubritski.workers.dev/';

// Запасной набор только из STUN'ов — на случай если Worker недоступен (404,
// CF down, юзер offline для этого fetch'а). Без TURN P2P между двумя
// symmetric-NAT клиентами не пробьётся, но хотя бы простые случаи (один
// клиент с нормальным NAT) продолжат работать. Также экспортируется для
// использования в местах, где нужен синхронный default (MeetConnection).
export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// In-memory cache. Worker отдаёт TTL=24h, кэшируем на ~12h чтобы перевыпуск
// шёл с запасом до истечения и пользователь, который сидит в мите долго,
// не остался с протухшими credentials.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEntry {
  servers: RTCIceServer[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<RTCIceServer[]> | null = null;

/**
 * Возвращает свежий ICE-config (STUN + TURN с короткоживущими credentials).
 * Кэширует результат на 12h, дедуплицирует параллельные вызовы. При сбое
 * Worker'а — возвращает только STUN-fallback (без TURN).
 */
export async function getIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.servers;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const res = await fetch(TURN_WORKER_URL, { method: 'GET' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(
          `[zubrameet/ice] TURN worker returned ${res.status}: ${text}; falling back to STUN-only`,
        );
        return FALLBACK_ICE_SERVERS;
      }
      const json: unknown = await res.json();
      const servers = parseWorkerResponse(json);
      if (!servers) {
        console.warn(
          '[zubrameet/ice] TURN worker returned unexpected shape; falling back to STUN-only',
          json,
        );
        return FALLBACK_ICE_SERVERS;
      }
      cache = { servers, fetchedAt: Date.now() };
      console.info(
        `[zubrameet/ice] loaded ICE config from TURN worker (${servers.length} server entries)`,
      );
      return servers;
    } catch (err) {
      console.warn(
        '[zubrameet/ice] TURN worker fetch failed, falling back to STUN-only',
        err,
      );
      return FALLBACK_ICE_SERVERS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// CF Worker возвращает либо `{ iceServers: { urls, username, credential } }`
// (single object), либо `{ iceServers: [{...}, {...}] }` (array). Поддерживаем
// оба варианта чтобы не сломаться при изменении CF API.
function parseWorkerResponse(json: unknown): RTCIceServer[] | null {
  if (!json || typeof json !== 'object') return null;
  const ice = (json as { iceServers?: unknown }).iceServers;
  if (!ice) return null;
  if (Array.isArray(ice)) {
    return ice.filter((s): s is RTCIceServer => !!s && typeof s === 'object');
  }
  if (typeof ice === 'object') {
    return [ice as RTCIceServer];
  }
  return null;
}
