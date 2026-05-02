// ICE-конфигурация для WebRTC: STUN + бесплатные публичные TURN.
//
// Используется обоими режимами:
//  - SFU (web/src/lib/webrtc.ts) — DEFAULT_ICE_SERVERS у обоих PeerConnection.
//  - P2P (web/src/lib/p2p.ts)    — rtcConfig для Trystero.
//
// TURN-серверы — OpenRelay от Metered.ca: бесплатный публичный TURN
// без регистрации, ~5GB/мес лимит. Источник: https://www.metered.ca/tools/openrelay/
// Нужен для пробивания symmetric NAT (≈15–20% сетей, в основном корпоративные
// и часть мобильных провайдеров) — в этих случаях STUN не помогает и без TURN
// видеосессия не установится.
export const PUBLIC_ICE_SERVERS: RTCIceServer[] = [
  // STUN — публичные, бесплатные.
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },

  // TURN — OpenRelay free public.
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];
