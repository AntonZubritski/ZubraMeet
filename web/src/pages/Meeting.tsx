// Страница встречи: захват камеры/микрофона, сигналинг, WebRTC, рендер сетки.
//
// Поддерживает два режима:
// - SFU: текущий — WS-сигналинг к нашему серверу + MeetConnection (publish/subscribe PC)
// - P2P: mesh через Trystero/Nostr — P2PMeetConnection. Без своего WS-сервера.
//
// Mode resolution:
// - props.mode === 'sfu'  → SFU
// - props.mode === 'p2p'  → P2P
// - props.mode === 'auto' (default) → fetch /api/mode → { mode: 'sfu'|'p2p' }.
//   404/network err → fallback на P2P (например, при деплое статики на GitHub Pages).
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { navigate } from '../App';
import { SignalClient, buildWsUrl } from '../lib/signal';
import { MeetConnection, type MeetConnectionEvents } from '../lib/webrtc';
import { P2PMeetConnection, type P2PMeetEvents } from '../lib/p2p';
import {
  DEFAULT_SCREEN_QUALITY,
  type ScreenQuality,
} from '../lib/screen-quality';
import type {
  ConnectionStats,
  ConnectivityResp,
  Diagnosis,
  Endpoint,
  EndpointKind,
  PeerInfo,
  RelayInfo,
  RelayStatusResp,
} from '../types';
import VideoGrid from '../components/VideoGrid';
import Controls from '../components/Controls';
import ConnectionBadge from '../components/ConnectionBadge';
import ChatPanel, { type ChatPanelMessage } from '../components/ChatPanel';
import ReactionsLayer, {
  type FloatingReaction,
} from '../components/ReactionsLayer';

type Mode = 'sfu' | 'p2p';

interface Props {
  roomId: string;
  mode?: 'auto' | 'sfu' | 'p2p';
  // Pre-shared password из URL hash. Если задан — Trystero шифрует ВСЁ:
  // signaling SDP/ICE через Nostr-relays + data-channel сообщения. Peer без
  // правильного password просто не установит peer-connection.
  password?: string;
}

interface PeerEntry {
  stream: MediaStream;
  name: string;
  // Видео-track выключен (track.muted = true). Камера на стороне peer'а off,
  // либо track ещё не пошёл. Используется для рендера placeholder с аватаром.
  camMuted?: boolean;
  // Аналогично для аудио (на будущее — пока в UI не используется).
  micMuted?: boolean;
}

// Удалённый screen-share от пира. Ключ — `${peerId}:${stream.id}` (на случай
// если один пир пошлёт несколько screen-стримов; пока маловероятно, но не дороже).
interface RemoteScreenEntry {
  stream: MediaStream;
  peerName: string;
  peerId: string;
}

const NAME_KEY = 'zubrameet.name';
const STATS_INTERVAL_MS = 2000;

// Публичный URL статики, на который ссылаются P2P-инвайты независимо от того,
// где запущен хост (localhost / behind CGNAT / etc). Гость идёт на этот URL и
// поднимает Trystero-комнату с тем же roomId через Nostr.
const P2P_PUBLIC_HOST = 'https://antonzubritski.github.io/ZubraMeet';

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
  padding: '10px 16px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--panel)',
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--fg)',
};

const roomIdStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  background: 'var(--bg)',
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--border)',
  fontSize: 13,
  letterSpacing: 1,
};

const inviteBtnStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '6px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
  fontSize: 12,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  transition: 'background 160ms ease, border-color 160ms ease, color 160ms ease, transform 80ms ease',
};

// Состояние "только что скопировано" — зелёная заливка + чёрный текст,
// плюс лёгкий tap-effect через scale.
const inviteBtnCopiedStyle: CSSProperties = {
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
  color: '#0a0a0a',
  transform: 'scale(0.97)',
};

const relayBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  background: 'rgba(34, 197, 94, 0.12)',
  border: '1px solid rgba(34, 197, 94, 0.4)',
  color: 'var(--accent)',
  borderRadius: 6,
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const relayStopBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid currentColor',
  color: 'inherit',
  padding: '2px 6px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 10,
};

const modeBadgeStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
};

const secureBadgeStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid rgba(34, 197, 94, 0.4)',
  background: 'rgba(34, 197, 94, 0.12)',
  color: 'var(--accent)',
  whiteSpace: 'nowrap',
};

const insecureBadgeStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid rgba(234, 179, 8, 0.4)',
  background: 'rgba(234, 179, 8, 0.12)',
  color: '#eab308',
  whiteSpace: 'nowrap',
};

// Жёлтый "ненавязчивый" банер-подсказка на время активной screen-share.
// Показывается под header'ом — напоминает, что управлять трансляцией нужно
// через нашу кнопку, а не через native overlay браузера сверху.
const screenHintStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  background: 'rgba(234, 179, 8, 0.10)',
  borderBottom: '1px solid rgba(234, 179, 8, 0.30)',
  color: '#eab308',
  fontSize: 12,
  lineHeight: 1.35,
  flexShrink: 0,
};

// Красный banner для ошибок screen-share (mirror loop и т.п.).
const screenErrorStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  background: 'rgba(239, 68, 68, 0.10)',
  borderBottom: '1px solid rgba(239, 68, 68, 0.40)',
  color: 'var(--danger)',
  fontSize: 13,
  lineHeight: 1.35,
  flexShrink: 0,
};

const gridContainerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  position: 'relative',
  overflow: 'hidden',
  paddingBottom: 88, // место под фиксированный Controls
};

const errorPageStyle: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  gap: 16,
  textAlign: 'center',
};

const errorBoxStyle: CSSProperties = {
  maxWidth: 480,
  padding: 20,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const errorTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 600,
  color: 'var(--danger)',
};

const errorMsgStyle: CSSProperties = {
  margin: 0,
  color: 'var(--muted)',
  fontSize: 14,
  lineHeight: 1.5,
};

const errorBtnStyle: CSSProperties = {
  padding: '10px 16px',
  background: 'var(--accent)',
  color: '#0a0a0a',
  border: 'none',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  alignSelf: 'center',
};

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 200,
  pointerEvents: 'auto',
};

const overlayBoxStyle: CSSProperties = {
  padding: '20px 28px',
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  alignItems: 'center',
  fontSize: 14,
  color: 'var(--fg)',
  minWidth: 240,
};

interface ErrorStateProps {
  message: string;
  hint?: string;
  onBack(): void;
}

function ErrorState({ message, hint, onBack }: ErrorStateProps) {
  return (
    <div style={errorPageStyle}>
      <div style={errorBoxStyle}>
        <h2 style={errorTitleStyle}>Не получилось подключиться</h2>
        <p style={errorMsgStyle}>{message}</p>
        {hint && <p style={errorMsgStyle}>{hint}</p>}
        <button type="button" style={errorBtnStyle} onClick={onBack}>
          Назад
        </button>
      </div>
    </div>
  );
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_LADDER: MediaTrackConstraints[] = [
  { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
];

/**
 * Пытаемся получить камеру+микрофон, спускаемся по лестнице 1080p→720p→480p,
 * затем audio-only.
 */
async function acquireMedia(): Promise<MediaStream> {
  const errors: string[] = [];
  for (const video of VIDEO_LADDER) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video,
        audio: AUDIO_CONSTRAINTS,
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  // Последний шанс — audio-only.
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: AUDIO_CONSTRAINTS,
    });
  } catch (err) {
    const last = err instanceof Error ? err.message : String(err);
    throw new Error(`getUserMedia: ${errors.join(' | ')} (audio-only: ${last})`);
  }
}

const ENDPOINT_KIND_META: Record<EndpointKind, { icon: string; label: string }> = {
  local: { icon: '📡', label: 'Локально' },
  lan: { icon: '🏠', label: 'LAN' },
  internet: { icon: '🌍', label: 'Интернет' },
};

// formatRelayDuration форматирует Math.floor(seconds) → "Xч Ym" / "Ym Zс".
function formatRelayDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${s}с`;
  return `${s}с`;
}

// formatRelayCost: HOUR_PRICE_EUR=0.006 (Hetzner cx22 ≈ €0.006/час).
function formatRelayCost(ms: number): string {
  const HOUR_PRICE_EUR = 0.006;
  const hours = ms / 3_600_000;
  const cost = hours * HOUR_PRICE_EUR;
  return `€${cost.toFixed(4)}`;
}

/**
 * Резолвит mode для встречи.
 * - 'sfu' / 'p2p' — возвращаем как есть.
 * - 'auto' — спрашиваем сервер /api/mode. На любую ошибку (404, network, parse)
 *   фолбэк на 'p2p' (статика без сервера = только P2P).
 */
async function resolveMode(prop: 'auto' | 'sfu' | 'p2p'): Promise<Mode> {
  if (prop === 'sfu' || prop === 'p2p') return prop;
  try {
    const r = await fetch('/api/mode');
    if (!r.ok) return 'p2p';
    const data = (await r.json()) as { mode?: unknown };
    if (data.mode === 'sfu' || data.mode === 'p2p') return data.mode;
    return 'p2p';
  } catch {
    return 'p2p';
  }
}

export default function Meeting({ roomId, mode: modeProp = 'auto', password }: Props) {
  // Резолвится один раз на mount; до этого UI ждёт.
  const [resolvedMode, setResolvedMode] = useState<Mode | null>(
    modeProp === 'sfu' || modeProp === 'p2p' ? modeProp : null,
  );

  // Pre-join screen: до setJoined(true) не запускаем getUserMedia/signaling.
  // Это даёт гостю шанс ввести имя и понять, куда он попал, до того как браузер
  // спросит разрешение на камеру.
  //
  // Auto-join: если roomId совпадает с sessionStorage 'zubrameet.autojoin'
  // (хост только что создал мит из Landing) — пропускаем pre-join. Pre-join
  // нужен только гостю по invite-ссылке.
  const [joined, setJoined] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      const flag = window.sessionStorage.getItem('zubrameet.autojoin');
      const hasName = (window.localStorage.getItem(NAME_KEY) ?? '').trim().length > 0;
      if (flag === roomId && hasName) {
        window.sessionStorage.removeItem('zubrameet.autojoin');
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  });
  const [pendingName, setPendingName] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return window.localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });

  // localStream + peers + ui-флаги
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenSharing, setScreenSharing] = useState<boolean>(false);
  // Флаг "ссылка только что скопирована" — для визуального feedback'а
  // на кнопке «Скопировать ссылку» (зелёная подсветка + текст ✓ Скопировано).
  // Сбрасывается через 1.5с автоматически.
  const [inviteCopied, setInviteCopied] = useState<boolean>(false);
  // Выбранное пользователем качество демонстрации экрана. Применяется при
  // следующем startScreenShare. Меняется через dropdown в Controls. Во время
  // активной трансляции не меняется (preset фиксируется на старте).
  const [screenQuality, setScreenQuality] = useState<ScreenQuality>(DEFAULT_SCREEN_QUALITY);
  const [peers, setPeers] = useState<Map<string, PeerEntry>>(() => new Map());
  // Удалённые screen-share стримы (только в P2P-режиме — в SFU всё прилетает
  // через onRemoteTrack как обычный track одного stream'а).
  const [remoteScreens, setRemoteScreens] = useState<Map<string, RemoteScreenEntry>>(
    () => new Map(),
  );
  const [micOn, setMicOn] = useState<boolean>(true);
  const [camOn, setCamOn] = useState<boolean>(true);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<boolean>(false);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  // Share-panel state (host-only — гости получат 403 и панель не отрисуется).
  // В P2P-режиме всю панель не показываем (используется одна кнопка "copy link").
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [endpointsErr, setEndpointsErr] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showAdvice, setShowAdvice] = useState<boolean>(false);
  const [rechecking, setRechecking] = useState<boolean>(false);

  // Cloud relay state. relay !== null → активная VM в облаке (TURN-сервер).
  // tickMs обновляется каждую секунду чтобы перерисовывать стоимость и uptime.
  const [relay, setRelay] = useState<RelayInfo | null>(null);
  const [relayBusy, setRelayBusy] = useState<boolean>(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [, setNowTick] = useState<number>(0);

  // Ошибка screen-share, которую надо показать пользователю (например,
  // mirror-loop detection). Очищается через таймер.
  const [screenShareError, setScreenShareError] = useState<string | null>(null);

  // Auto-hide chrome (header + Controls) после 5с бездействия. Любая активность
  // (mousemove, mousedown, touchstart, keydown, wheel) сбрасывает таймер и
  // показывает chrome. В скрытом состоянии bar/header получают pointer-events:
  // none — первый тап показывает chrome (через listener), второй уже работает
  // как обычно. См. useEffect ниже.
  const [chromeVisible, setChromeVisible] = useState<boolean>(true);
  const idleTimerRef = useRef<number | null>(null);

  // Chat state. messages — все полученные/отправленные сообщения; chatOpen —
  // открыт ли sidebar; unreadChat — счётчик непрочитанных (увеличивается при
  // приходе чужого сообщения когда панель закрыта; сбрасывается на open).
  // Сообщения НЕ персистятся между переподключениями к комнате — это
  // эфемерный data-channel чат, как в Google Meet/Zoom без записи.
  const [chatMessages, setChatMessages] = useState<ChatPanelMessage[]>([]);
  const [chatOpen, setChatOpen] = useState<boolean>(false);
  const [unreadChat, setUnreadChat] = useState<number>(0);
  // Чтобы коллбэк onChatMessage внутри P2PMeetEvents (создаваемый ОДИН раз
  // при start()) видел актуальное chatOpen без устаревшего closure.
  const chatOpenRef = useRef<boolean>(false);
  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  // Reactions state. Каждая активная floating-реакция держится 5 секунд
  // (соответствует CSS-анимации zubrameet-reaction-fall). Чистим через
  // setTimeout, чтобы DOM-нода ушла после завершения анимации.
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);

  // Refs на длинноживущие объекты, чтобы cleanup точно их закрыл.
  const signalRef = useRef<SignalClient | null>(null);
  const sfuConnectionRef = useRef<MeetConnection | null>(null);
  const p2pConnectionRef = useRef<P2PMeetConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const statsTimerRef = useRef<number | null>(null);
  const recoveringRef = useRef<boolean>(false);
  // peerId → displayName (peer.id из welcome/peer-joined может НЕ совпадать со stream.id —
  // см. webrtc.ts: TODO mid→peerId mapping. Пока храним по обоим ключам как сможем.)
  const peerNamesRef = useRef<Map<string, string>>(new Map());
  // P2P: буфер последнего media-state от peer'а на случай, если он пришёл
  // ДО onRemoteStream (тогда peers Map ещё не имеет записи и мы бы потеряли
  // апдейт). При создании записи применим буферизованное состояние.
  const peerMediaBufRef = useRef<Map<string, { cam: boolean; mic: boolean }>>(new Map());
  // Уже виденные remote-screen ключи — чтобы auto-fullscreen-эффект ниже
  // триггерился только на ВПЕРВЫЕ добавленные screen-tile'ы, а не на любой
  // ре-рендер remoteScreens (имя обновилось и т.д.).
  const seenRemoteScreensRef = useRef<Set<string>>(new Set());
  // Чтобы избежать двойной инициализации в StrictMode dev.
  const startedRef = useRef<boolean>(false);

  const myName: string = (() => {
    try {
      return window.localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  })();

  // Mode resolution. Запускаем только если mode prop = 'auto' и ещё не резолвили.
  useEffect(() => {
    if (resolvedMode !== null) return;
    let cancelled = false;
    void resolveMode(modeProp).then((m) => {
      if (!cancelled) setResolvedMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, [modeProp, resolvedMode]);

  // Auto-hide chrome (header + Controls) после 5 секунд бездействия. Запускаем
  // только когда joined === true — в pre-join screen чрома и нет, и его layout
  // совсем другой. Любая активность (mousemove/mousedown/touchstart/keydown/
  // wheel) сбрасывает таймер и показывает chrome. На unmount/leave убираем
  // listeners и таймер.
  useEffect(() => {
    if (!joined) {
      // На pre-join всегда показываем chrome (если вернёмся в joined-state,
      // эффект перезапустится и снова поставит таймер).
      setChromeVisible(true);
      return;
    }

    const HIDE_AFTER_MS = 5000;

    const arm = (): void => {
      setChromeVisible(true);
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        setChromeVisible(false);
      }, HIDE_AFTER_MS);
    };

    arm();

    const events: (keyof DocumentEventMap)[] = [
      'mousemove',
      'mousedown',
      'touchstart',
      'keydown',
      'wheel',
    ];
    for (const ev of events) {
      window.addEventListener(ev, arm, { passive: true });
    }

    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      for (const ev of events) {
        window.removeEventListener(ev, arm);
      }
    };
  }, [joined]);

  // Recover camera/microphone после sleep/wake.
  // Останавливаем старые треки, getUserMedia заново, replaceLocalTracks на publishPC.
  // В P2P-режиме replaceLocalTracks не реализован — просто обновляем local-state.
  const recoverMedia = async (): Promise<void> => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    try {
      const oldStream = localStreamRef.current;
      let newStream: MediaStream;
      try {
        newStream = await acquireMedia();
      } catch (err) {
        console.error('[Meeting] recoverMedia: acquireMedia failed', err);
        return;
      }
      // Стопим старые треки только после того, как новый стрим успешно получен.
      if (oldStream) {
        for (const t of oldStream.getTracks()) {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
      }
      // Применяем текущие mute-флаги к новому стриму.
      for (const t of newStream.getAudioTracks()) {
        t.enabled = micOn;
      }
      for (const t of newStream.getVideoTracks()) {
        t.enabled = camOn;
      }
      // Подвешиваем listeners на новые треки.
      attachTrackListeners(newStream);

      localStreamRef.current = newStream;
      setLocalStream(newStream);

      const conn = sfuConnectionRef.current;
      if (conn) {
        try {
          await conn.replaceLocalTracks(newStream);
        } catch (err) {
          console.error('[Meeting] recoverMedia: replaceLocalTracks failed', err);
        }
      }
      // P2P: replace на лету не делаем — Trystero сам не предоставляет
      // удобного API для bulk-replace; при wake-from-sleep пользователь всё
      // равно почти всегда переподключается. Оставляем как известное ограничение.
    } finally {
      recoveringRef.current = false;
    }
  };

  // Подвешивает listeners на 'ended'/'mute' для каждого track.
  // Возвращает cleanup.
  const attachTrackListeners = (stream: MediaStream): void => {
    for (const t of stream.getTracks()) {
      const onEnded = (): void => {
        console.warn('[Meeting] track ended:', t.kind);
        void recoverMedia();
      };
      const onMute = (): void => {
        // Браузер пометил track как muted (например, экран заснул).
        // Не сразу зовём recovery — даём шанс восстановиться (onunmute).
        // Если через 1.5с всё ещё muted — recovery.
        const k = t.kind;
        window.setTimeout(() => {
          if (t.muted && t.readyState !== 'ended') {
            console.warn('[Meeting] track still muted after grace:', k);
            void recoverMedia();
          }
        }, 1500);
      };
      t.addEventListener('ended', onEnded);
      t.addEventListener('mute', onMute);
    }
  };

  // Главный lifecycle: одна setup-функция, один cleanup. Стартует только
  // когда resolvedMode известен (для 'auto' сначала ждём /api/mode) И
  // пользователь нажал "Присоединиться" (joined === true).
  useEffect(() => {
    if (!joined) return;
    if (resolvedMode === null) return;
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const cleanup = (): void => {
      if (statsTimerRef.current !== null) {
        window.clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
      if (sfuConnectionRef.current) {
        try {
          sfuConnectionRef.current.close();
        } catch {
          /* ignore */
        }
        sfuConnectionRef.current = null;
      }
      if (p2pConnectionRef.current) {
        try {
          p2pConnectionRef.current.close();
        } catch {
          /* ignore */
        }
        p2pConnectionRef.current = null;
      }
      if (signalRef.current) {
        try {
          signalRef.current.close();
        } catch {
          /* ignore */
        }
        signalRef.current = null;
      }
      const ls = localStreamRef.current;
      if (ls) {
        for (const t of ls.getTracks()) {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
        localStreamRef.current = null;
      }
    };

    void (async () => {
      // 1. Камера/микрофон.
      let stream: MediaStream;
      try {
        stream = await acquireMedia();
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return;
      }
      if (cancelled) {
        for (const t of stream.getTracks()) {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      attachTrackListeners(stream);

      if (resolvedMode === 'sfu') {
        await startSfu(stream, cancelled);
      } else {
        await startP2P(stream, cancelled);
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, resolvedMode, joined]);

  // Стартует SFU-pipeline: SignalClient + MeetConnection + stats poller.
  const startSfu = async (stream: MediaStream, cancelled: boolean): Promise<void> => {
    // 2. Сигналинг.
    const signal = new SignalClient(buildWsUrl(roomId, myName));
    signalRef.current = signal;
    try {
      await signal.connect();
    } catch (err) {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Не удалось подключиться к серверу: ${msg}`);
      return;
    }
    if (cancelled) return;

    // 3. WebRTC events.
    const events: MeetConnectionEvents = {
      onLocalStream: () => {
        // localStream уже в state.
      },
      onRemoteTrack: (peerId, track, remoteStream) => {
        // peerId = stream.id (см. webrtc.ts TODO).
        // Подбираем имя из ранее накопленной мапы: пробуем сначала peerId,
        // затем stream.id, иначе fallback.
        const namesMap = peerNamesRef.current;
        const fallback = namesMap.get(peerId) ?? namesMap.get(remoteStream.id) ?? 'Участник';

        setPeers((prev) => {
          const next = new Map(prev);
          const existing = next.get(peerId);
          if (existing) {
            // Обновляем track в существующем стриме при необходимости.
            const has = existing.stream
              .getTracks()
              .some((t) => t.id === track.id);
            if (!has) {
              try {
                existing.stream.addTrack(track);
              } catch {
                /* ignore */
              }
            }
            next.set(peerId, { stream: existing.stream, name: existing.name });
          } else {
            next.set(peerId, { stream: remoteStream, name: fallback });
          }
          return next;
        });
      },
      onPeerJoined: (peer: PeerInfo) => {
        peerNamesRef.current.set(peer.id, peer.name);
        // Обновляем имя в уже существующих записях, если ключ совпал.
        setPeers((prev) => {
          if (!prev.has(peer.id)) return prev;
          const next = new Map(prev);
          const cur = next.get(peer.id);
          if (cur) {
            next.set(peer.id, { stream: cur.stream, name: peer.name });
          }
          return next;
        });
      },
      onPeerLeft: (peerId: string) => {
        peerNamesRef.current.delete(peerId);
        setPeers((prev) => {
          if (!prev.has(peerId)) return prev;
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      },
      onConnectionState: () => {
        // Состояние можно отрисовать позднее; ConnectionBadge сейчас читает stats.
      },
      onError: (err: Error) => {
        // Логируем, но не валим UI: ошибки сигналинга/WebRTC могут быть некритичными.
        console.error('[Meeting]', err);
        if (/signal disconnected/i.test(err.message)) {
          setReconnecting(true);
        }
        if (/reconnect failed/i.test(err.message)) {
          // Окончательно — показываем error-state.
          setReconnecting(false);
          setError(err.message);
        }
      },
      onScreenShareStarted: () => {
        // Уже выставили в handleToggleScreenShare; этот колбэк нужен на случай
        // программного запуска screen share в будущем.
      },
      onScreenShareStopped: () => {
        // Может прийти после reconnect или после browser "Stop sharing".
        setScreenSharing(false);
        setScreenStream(null);
      },
      onReconnecting: (attempt: number) => {
        setReconnecting(true);
        setReconnectAttempt(attempt);
      },
      onReconnected: () => {
        setReconnecting(false);
        setReconnectAttempt(0);
        // После reconnect peers сбрасываются — старые удалятся через peer-left
        // от сервера новой сессии не придёт, поэтому чистим вручную.
        peerNamesRef.current.clear();
        setPeers(new Map());
      },
    };

    const conn = new MeetConnection(signal, events);
    sfuConnectionRef.current = conn;

    try {
      await conn.start(stream);
    } catch (err) {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Не удалось запустить медиасессию: ${msg}`);
      return;
    }
    if (cancelled) return;

    // 4. Stats poller.
    statsTimerRef.current = window.setInterval(() => {
      const c = sfuConnectionRef.current;
      if (!c) return;
      void c.getStats().then((s) => {
        setStats(s);
      });
    }, STATS_INTERVAL_MS);
  };

  // Стартует P2P-pipeline: P2PMeetConnection через Trystero/Nostr.
  // Без своего WS, без stats-poller (Trystero не выставляет агрегированные stats).
  const startP2P = async (stream: MediaStream, cancelled: boolean): Promise<void> => {
    const myDisplay = myName.trim().length > 0 ? myName : 'Гость';
    const events: P2PMeetEvents = {
      onLocalStream: () => {
        // уже в state.
      },
      onRemoteStream: (peerId, remoteStream, name, kind) => {
        if (kind === 'screen') {
          // Ключ remoteScreens — уникальный per (peerId,streamId). Если пир
          // пере-расшарит экран (например, остановил и запустил снова через
          // native browser overlay), у нового стрима будет другой stream.id.
          // Чтобы не получить ДВА tile'а от одного peer'а, перед добавлением
          // нового screen-стрима снимаем все старые от этого же peer'а —
          // максимум 1 screen-tile на peer.
          const key = `${peerId}:${remoteStream.id}`;
          setRemoteScreens((prev) => {
            const next = new Map(prev);
            for (const [k, v] of prev) {
              if (v.peerId === peerId) next.delete(k);
            }
            next.set(key, { stream: remoteStream, peerName: name, peerId });
            return next;
          });
          // Когда пир остановит share — все его screen-треки кончатся.
          // Подвешиваем onended на video-track чтобы убрать tile.
          for (const t of remoteStream.getVideoTracks()) {
            const onEnded = (): void => {
              setRemoteScreens((prev) => {
                if (!prev.has(key)) return prev;
                const next = new Map(prev);
                next.delete(key);
                return next;
              });
            };
            t.addEventListener('ended', onEnded);
          }
          return;
        }
        // camera (default)
        // Подписываемся на mute/unmute видео-track'а удалённого peer'а —
        // браузер выставляет track.muted = true когда удалённая сторона
        // отключила свой track (track.enabled=false на их стороне или
        // выключение камеры). Это back-up к 'media' action — track.muted
        // срабатывает при replaceTrack/потере данных, action — при явном
        // toggle. Оставляем оба для надёжности.
        const updateCamMuted = (muted: boolean): void => {
          setPeers((prev) => {
            const cur = prev.get(peerId);
            if (!cur) return prev;
            if ((cur.camMuted ?? false) === muted) return prev;
            const next = new Map(prev);
            next.set(peerId, { ...cur, camMuted: muted });
            return next;
          });
        };
        const videoTracks = remoteStream.getVideoTracks();
        const trackCamMuted =
          videoTracks.length === 0 || videoTracks.every((t) => t.muted);
        for (const t of videoTracks) {
          t.addEventListener('mute', () => updateCamMuted(true));
          t.addEventListener('unmute', () => updateCamMuted(false));
        }
        // Если peer уже прислал media-state до stream'а (race) — применяем его
        // как initial. Иначе доверяем track.muted.
        const buffered = peerMediaBufRef.current.get(peerId);
        const initialCamMuted = buffered ? !buffered.cam : trackCamMuted;
        const initialMicMuted = buffered ? !buffered.mic : false;
        setPeers((prev) => {
          const next = new Map(prev);
          next.set(peerId, {
            stream: remoteStream,
            name,
            camMuted: initialCamMuted,
            micMuted: initialMicMuted,
          });
          return next;
        });
      },
      onPeerJoined: (peerId, name) => {
        peerNamesRef.current.set(peerId, name);
        // Если поток уже есть — обновляем имя.
        setPeers((prev) => {
          if (!prev.has(peerId)) return prev;
          const next = new Map(prev);
          const cur = next.get(peerId);
          if (cur) {
            next.set(peerId, { stream: cur.stream, name });
          }
          return next;
        });
        // И в screen-tiles тоже обновим имя.
        setRemoteScreens((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [k, v] of prev) {
            if (v.peerId === peerId && v.peerName !== name) {
              next.set(k, { ...v, peerName: name });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      onPeerLeft: (peerId) => {
        peerNamesRef.current.delete(peerId);
        peerMediaBufRef.current.delete(peerId);
        setPeers((prev) => {
          if (!prev.has(peerId)) return prev;
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
        // И прибираем все screen-tiles этого пира.
        setRemoteScreens((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [k, v] of prev) {
            if (v.peerId === peerId) {
              next.delete(k);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      onConnectionState: () => {
        // Не показываем per-peer состояние в UI — только агрегат через ConnectionBadge.
      },
      onError: (err) => {
        console.error('[Meeting/p2p]', err);
        // P2P-ошибки в целом не валят сессию (Nostr-relay может временно отвалиться).
      },
      onScreenShareStarted: () => {
        // Установлено в handleToggleScreenShare; колбэк нужен на случай
        // программного запуска screen share в будущем.
      },
      onScreenShareStopped: () => {
        // Может прийти при browser "Stop sharing" — синхронизируем UI.
        setScreenSharing(false);
        setScreenStream(null);
      },
      onPeerMediaState: (peerId, state) => {
        // Удалённый peer broadcast'нул новое cam/mic. Обновляем флаги — это
        // даёт visual placeholder (аватар вместо застывшего кадра) и
        // mic-off icon на тайле собеседника.
        // Буферизуем — если стрим ещё не пришёл, peers.get(peerId) пуст и
        // мы потеряли бы апдейт. onRemoteStream применит из буфера.
        peerMediaBufRef.current.set(peerId, { cam: state.cam, mic: state.mic });
        setPeers((prev) => {
          const cur = prev.get(peerId);
          if (!cur) return prev;
          const camMuted = !state.cam;
          const micMuted = !state.mic;
          if ((cur.camMuted ?? false) === camMuted && (cur.micMuted ?? false) === micMuted) {
            return prev;
          }
          const next = new Map(prev);
          next.set(peerId, { ...cur, camMuted, micMuted });
          return next;
        });
      },
      onPeerScreenState: (peerId, state) => {
        // Удалённый peer явно сообщил о состоянии своего screen-share.
        // active=false — гарантированный teardown ВСЕХ его screen-tile'ов.
        // Это back-up на случай, если track.onended не доставится через
        // Trystero (происходит, например, когда peer закрывает share через
        // native browser overlay, а не через нашу кнопку).
        // active=true — ничего активно не делаем; основной канал — addStream/
        // onRemoteStream сам прислал и стрим, и metadata.
        if (!state.active) {
          setRemoteScreens((prev) => {
            let changed = false;
            const next = new Map(prev);
            for (const [k, v] of prev) {
              if (v.peerId === peerId) {
                next.delete(k);
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      },
      onChatMessage: (peerId, msg) => {
        // peerId === 'self' — наше собственное сообщение (P2PMeetConnection
        // эмитит его локально для единообразного UI). Помечаем local=true,
        // чтобы ChatPanel выровнял/подсветил иначе.
        const local = peerId === 'self';
        setChatMessages((prev) => {
          // Дедуп по id — на случай если кто-то когда-нибудь добавит relay/repeat.
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, { ...msg, local }];
        });
        // Если чат закрыт И сообщение пришло от ДРУГОГО — увеличиваем
        // unread-счётчик. Свои сообщения (local) не считаем.
        if (!local && !chatOpenRef.current) {
          setUnreadChat((c) => c + 1);
        }
      },
      onReaction: (_peerId, payload) => {
        // Создаём floating-emoji с уникальным id, рандомной горизонтальной
        // позицией и sway. Через 5s удаляем из state — анимация уже завершилась
        // и DOM-нода больше не нужна.
        const id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const leftPct = 10 + Math.random() * 80; // 10–90%
        const swayPx = (Math.random() * 2 - 1) * 50; // ±50px
        const reaction: FloatingReaction = {
          id,
          emoji: payload.emoji,
          leftPct,
          swayPx,
        };
        setReactions((prev) => [...prev, reaction]);
        window.setTimeout(() => {
          setReactions((prev) => prev.filter((r) => r.id !== id));
        }, 5000);
      },
    };

    const conn = new P2PMeetConnection(roomId, myDisplay, events, password);
    p2pConnectionRef.current = conn;

    try {
      await conn.start(stream);
    } catch (err) {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Не удалось подключиться к P2P-комнате: ${msg}`);
      return;
    }
  };

  // visibilitychange → если вкладка снова видна и треки сломаны, восстановить.
  // До join — listener не нужен (никаких треков ещё нет).
  useEffect(() => {
    if (!joined) return;
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      const ls = localStreamRef.current;
      if (!ls) return;
      const broken = ls.getTracks().some(
        (t) => t.readyState === 'ended' || t.muted,
      );
      if (broken) {
        void recoverMedia();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);

  // Polling /api/relay/status каждые 30с. Гостям сервер отдаст 403 — silently
  // skip. tick-таймер раз в 1с перерисовывает duration/cost-индикатор.
  // Запускаем только после join — до этого relay-индикатор не отрисуется.
  // В P2P-режиме (serverless / GitHub Pages) бэка нет — пропускаем polling.
  useEffect(() => {
    if (!joined) return;
    if (resolvedMode !== 'sfu') return;
    let cancelled = false;
    const fetchRelay = (): void => {
      fetch('/api/relay/status')
        .then(async (r) => {
          if (r.status === 403) return null;
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as RelayStatusResp;
        })
        .then((d) => {
          if (cancelled) return;
          if (!d || !d.active) {
            setRelay(null);
          } else {
            // d — RelayInfo + active:true. TS narrowing уже это знает.
            const { active: _ignored, ...info } = d;
            setRelay(info as RelayInfo);
          }
        })
        .catch(() => {
          // Network error / endpoint missing — silently skip; индикатор просто не покажется.
        });
    };
    fetchRelay();
    const pollId = window.setInterval(fetchRelay, 30_000);
    const tickId = window.setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      window.clearInterval(tickId);
    };
  }, [joined, resolvedMode]);

  const handleStartRelay = (): void => {
    if (relayBusy) return;
    setRelayBusy(true);
    setRelayError(null);
    fetch('/api/relay/start', { method: 'POST' })
      .then(async (r) => {
        if (r.status === 403) {
          setRelayError('Запуск relay доступен только на машине хоста.');
          return null;
        }
        if (r.status === 503) {
          // Cloud-relay не сконфигурирован — отправляем на /settings.
          navigate('/settings?provider=hetzner');
          return null;
        }
        const data = (await r.json()) as { error?: string } & Partial<RelayInfo>;
        if (!r.ok) {
          throw new Error(data.error ?? `HTTP ${r.status}`);
        }
        return data as RelayInfo;
      })
      .then((info) => {
        if (info && info.id) {
          setRelay(info);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setRelayError(msg);
      })
      .finally(() => {
        setRelayBusy(false);
      });
  };

  const handleStopRelay = (): void => {
    if (relayBusy) return;
    setRelayBusy(true);
    setRelayError(null);
    fetch('/api/relay/stop', { method: 'POST' })
      .then(async (r) => {
        if (r.status === 403) return;
        if (!r.ok) {
          const data = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${r.status}`);
        }
        setRelay(null);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setRelayError(msg);
      })
      .finally(() => {
        setRelayBusy(false);
      });
  };

  // Fetch connectivity options. Только в SFU-режиме (в P2P нет /api/connectivity).
  // Только хост (с localhost) получит 200; гости — 403.
  // Запускаем только после join — share-panel всё равно не показывается до join.
  useEffect(() => {
    if (!joined) return;
    if (resolvedMode !== 'sfu') return;
    let cancelled = false;
    fetch('/api/connectivity')
      .then(async (r) => {
        if (r.status === 403) {
          // Гость — silently skip, панель показывать не надо.
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ConnectivityResp;
      })
      .then((d) => {
        if (!cancelled && d) {
          setEndpoints(d.endpoints);
          // graceful: старый сервер мог не присылать diagnosis
          setDiagnosis(d.diagnosis ?? null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setEndpointsErr(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedMode, joined]);

  // Auto-fullscreen для впервые появившегося remote screen-tile.
  // Browsers требуют user-gesture для requestFullscreen() — поэтому шанс
  // успеха у этой попытки невелик. Если не получилось — silent skip; у нас
  // также есть большая overlay-кнопка по центру тайла (см. VideoTile), которая
  // делает то же самое, но уже от user-gesture (клика).
  // Также прибираем seenRemoteScreensRef от ключей, которых больше нет.
  useEffect(() => {
    const seen = seenRemoteScreensRef.current;
    // Сначала вычищаем удалённые ключи, чтобы при пересоздании того же
    // (peerId,streamId) auto-fullscreen сработал снова.
    for (const key of Array.from(seen)) {
      if (!remoteScreens.has(key)) seen.delete(key);
    }
    // Найти новые.
    const fresh: string[] = [];
    for (const key of remoteScreens.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        fresh.push(key);
      }
    }
    if (fresh.length === 0) return;

    // Пробуем auto-fullscreen для последнего нового тайла. setTimeout — даём
    // VideoGrid отрендерить DOM.
    const lastKey = fresh[fresh.length - 1];
    if (typeof lastKey !== 'string') return;
    const tileId = `screen-${lastKey}`;
    const timerId = window.setTimeout(() => {
      // Не пытаемся, если уже что-то в fullscreen.
      if (document.fullscreenElement) return;
      // querySelector с экранированными "опасными" символами в id (на всякий
      // случай — peerId/streamId UUID-подобные, но мало ли).
      const safe = (window as unknown as { CSS?: { escape?: (s: string) => string } })
        .CSS?.escape
        ? CSS.escape(tileId)
        : tileId.replace(/"/g, '\\"');
      const el = document.querySelector(
        `[data-screen-tile-id="${safe}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      const req = el.requestFullscreen?.bind(el);
      if (!req) return;
      void req().catch(() => {
        // Browser обычно блокирует без user-gesture — это ожидаемо.
        // У VideoTile есть большая overlay-кнопка для ручного fullscreen.
      });
    }, 200);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [remoteScreens]);

  const handleRecheck = (): void => {
    if (rechecking) return;
    setRechecking(true);
    setEndpointsErr(null);
    fetch('/api/connectivity')
      .then(async (r) => {
        if (r.status === 403) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ConnectivityResp;
      })
      .then((d) => {
        if (d) {
          setEndpoints(d.endpoints);
          setDiagnosis(d.diagnosis ?? null);
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setEndpointsErr(msg);
      })
      .finally(() => {
        setRechecking(false);
      });
  };

  const handleCopyEndpoint = (key: string, url: string): void => {
    const hash = password ? `#${password}` : '';
    const fullUrl = `${url}/m/${roomId}${hash}`;
    const onCopied = (): void => {
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur));
      }, 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard
        .writeText(fullUrl)
        .then(onCopied)
        .catch((err: unknown) => {
          console.error('[Meeting] clipboard write failed', err);
        });
    } else {
      console.log('[Meeting] copy fallback:', fullUrl);
      onCopied();
    }
  };

  const handleToggleMic = (): void => {
    const ls = localStreamRef.current;
    if (!ls) return;
    const enabled = !micOn;
    for (const t of ls.getAudioTracks()) {
      t.enabled = enabled;
    }
    setMicOn(enabled);
    // P2P: явно broadcast'им новое state. track.enabled=false НЕ триггерит
    // track.muted на удалённой стороне, поэтому без этого собеседник не узнает.
    // Передаём новые значения (camOn для камеры остаётся прежним).
    p2pConnectionRef.current?.setMediaState({ cam: camOn, mic: enabled });
  };

  const handleToggleCam = (): void => {
    const ls = localStreamRef.current;
    if (!ls) return;
    const enabled = !camOn;
    for (const t of ls.getVideoTracks()) {
      t.enabled = enabled;
    }
    setCamOn(enabled);
    // См. комментарий в handleToggleMic.
    p2pConnectionRef.current?.setMediaState({ cam: enabled, mic: micOn });
  };

  const handleToggleScreenShare = (): void => {
    // Screen-share работает в обоих режимах — выбираем активное соединение.
    // SFU и P2P API совместимы по сигнатуре start/stopScreenShare.
    const sfu = sfuConnectionRef.current;
    const p2p = p2pConnectionRef.current;
    const conn: {
      startScreenShare(quality?: ScreenQuality): Promise<MediaStream>;
      stopScreenShare(): Promise<void>;
    } | null = sfu ?? p2p ?? null;
    if (!conn) return;
    if (screenSharing) {
      void conn
        .stopScreenShare()
        .then(() => {
          setScreenSharing(false);
          setScreenStream(null);
        })
        .catch((err: unknown) => {
          console.error('[Meeting] stopScreenShare failed', err);
          setScreenSharing(false);
          setScreenStream(null);
        });
    } else {
      // Пред-отчищаем ошибку — если повторно жмём после mirror-loop reject.
      setScreenShareError(null);
      void conn
        .startScreenShare(screenQuality)
        .then((s) => {
          setScreenStream(s);
          setScreenSharing(true);
        })
        .catch((err: unknown) => {
          // Юзер cancel'нул picker — DOMException NotAllowedError.
          const name = err instanceof DOMException ? err.name : '';
          if (name === 'NotAllowedError' || name === 'AbortError') {
            return;
          }
          // Mirror-loop reject прилетает обычным Error (не DOMException) с
          // нашим message. Показываем юзеру в UI; auto-clear через 8 сек.
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Meeting] startScreenShare failed', err);
          setScreenShareError(msg);
          window.setTimeout(() => {
            setScreenShareError((cur) => (cur === msg ? null : cur));
          }, 8000);
        });
    }
  };

  // Открыть/закрыть чат-sidebar. На открытие — сбрасываем unread-счётчик
  // (мы только что увидели всё, что было). На закрытие — оставляем как есть.
  const handleToggleChat = (): void => {
    setChatOpen((prev) => {
      const next = !prev;
      if (next) setUnreadChat(0);
      return next;
    });
  };

  // Отправка чат-сообщения. В SFU режиме — пока no-op (нет data-channel
  // action'ов в MeetConnection); чат работает только в P2P.
  const handleSendChat = (text: string): void => {
    p2pConnectionRef.current?.sendChatMessage(text);
  };

  // Отправка emoji-реакции. Аналогично — только P2P.
  const handleSendReaction = (emoji: string): void => {
    p2pConnectionRef.current?.sendReaction(emoji);
  };

  const handleLeave = (): void => {
    // Cleanup произойдёт автоматически в useEffect-return при размонтировании,
    // но ручная очистка тут гарантирует, что треки/WS закроются ещё до навигации.
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (sfuConnectionRef.current) {
      try {
        sfuConnectionRef.current.close();
      } catch {
        /* ignore */
      }
      sfuConnectionRef.current = null;
    }
    if (p2pConnectionRef.current) {
      try {
        p2pConnectionRef.current.close();
      } catch {
        /* ignore */
      }
      p2pConnectionRef.current = null;
    }
    if (signalRef.current) {
      try {
        signalRef.current.close();
      } catch {
        /* ignore */
      }
      signalRef.current = null;
    }
    const ls = localStreamRef.current;
    if (ls) {
      for (const t of ls.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      localStreamRef.current = null;
    }
    navigate('/');
  };

  // Invite link. В P2P — статика на GitHub Pages с тем же roomId. В SFU —
  // origin текущей страницы + /m/<roomId>.
  // Если есть password — добавляем как fragment (#<pw>); fragment НЕ уходит
  // на HTTP-сервер, только клиент его видит → pre-shared key для E2EE.
  const buildInviteUrl = (): string => {
    const hash = password ? `#${password}` : '';
    if (resolvedMode === 'p2p') {
      return `${P2P_PUBLIC_HOST}/p2p/${roomId}${hash}`;
    }
    return `${window.location.origin}/m/${roomId}${hash}`;
  };

  const handleCopyInvite = (): void => {
    const url = buildInviteUrl();
    const showFeedback = (): void => {
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard
        .writeText(url)
        .then(() => {
          console.log('[Meeting] invite copied:', url);
          showFeedback();
        })
        .catch((err: unknown) => {
          console.error('[Meeting] clipboard write failed', err);
        });
    } else {
      console.log('[Meeting] invite link:', url);
      showFeedback();
    }
  };

  // Pre-join: пользователь нажимает "Присоединиться" → сохраняем имя и
  // выставляем joined=true. Дальше setup-effect выше получит media и поднимет
  // signaling/peerConnection.
  const handleJoin = (): void => {
    const trimmed = pendingName.trim();
    if (trimmed.length === 0) return;
    try {
      window.localStorage.setItem(NAME_KEY, trimmed);
    } catch {
      // localStorage может быть недоступен (Safari Private). Не блокируем join —
      // имя проживёт в текущей вкладке через myName-getter ниже.
    }
    setJoined(true);
  };

  if (error) {
    return (
      <ErrorState
        message={error}
        hint="Проверьте, что в браузере разрешён доступ к камере и микрофону для этого сайта."
        onBack={() => navigate('/')}
      />
    );
  }

  // Pre-join screen — рендерим до того, как пользователь явно согласился
  // присоединиться. Никакого getUserMedia/signaling/PC до этого момента.
  if (!joined) {
    // Лейбл режима для бейджика. Если auto и пока null — "Определяю…".
    const preJoinModeLabel: string =
      resolvedMode === 'p2p'
        ? '🌐 Через интернет'
        : resolvedMode === 'sfu'
        ? '📡 Через хост'
        : 'Определяю режим подключения…';

    const preJoinPageStyle: CSSProperties = {
      minHeight: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    };
    const preJoinContainerStyle: CSSProperties = {
      width: '100%',
      maxWidth: 420,
      background: 'var(--panel)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: '28px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
    };
    const preJoinTitleStyle: CSSProperties = {
      margin: 0,
      fontSize: 'clamp(22px, 3.5vw, 28px)',
      fontWeight: 700,
      textAlign: 'center',
    };
    const preJoinSubStyle: CSSProperties = {
      textAlign: 'center',
      color: 'var(--muted)',
      fontSize: 14,
    };
    const preJoinLabelStyle: CSSProperties = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontSize: 13,
      color: 'var(--muted)',
    };
    const preJoinInputStyle: CSSProperties = {
      width: '100%',
      padding: '10px 12px',
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      color: 'var(--fg)',
      fontSize: 15,
      outline: 'none',
    };
    const preJoinBtnStyle: CSSProperties = {
      width: '100%',
      padding: '12px 16px',
      background: 'var(--accent)',
      color: '#0a0a0a',
      border: 'none',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: 600,
      cursor: pendingName.trim().length === 0 ? 'not-allowed' : 'pointer',
      opacity: pendingName.trim().length === 0 ? 0.5 : 1,
    };
    const preJoinModeStyle: CSSProperties = {
      textAlign: 'center',
      fontSize: 11,
      color: 'var(--muted)',
    };
    const preJoinRoomIdStyle: CSSProperties = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      background: 'var(--bg)',
      padding: '2px 8px',
      borderRadius: 4,
      border: '1px solid var(--border)',
      fontSize: 13,
      letterSpacing: 1,
    };

    return (
      <div style={preJoinPageStyle}>
        <div style={preJoinContainerStyle}>
          <h2 style={preJoinTitleStyle}>Присоединиться к миту</h2>
          <div style={preJoinSubStyle}>
            Мит: <code style={preJoinRoomIdStyle}>{roomId}</code>
          </div>

          <label style={preJoinLabelStyle}>
            Ваше имя
            <input
              type="text"
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pendingName.trim().length > 0) {
                  e.preventDefault();
                  handleJoin();
                }
              }}
              placeholder="Как вас представить"
              autoFocus
              style={preJoinInputStyle}
              maxLength={64}
            />
          </label>

          <button
            type="button"
            disabled={pendingName.trim().length === 0}
            onClick={handleJoin}
            style={preJoinBtnStyle}
          >
            Присоединиться
          </button>

          <div style={preJoinModeStyle}>{preJoinModeLabel}</div>
        </div>
      </div>
    );
  }

  // Пока mode не резолвится — рисуем минимальный loader, чтобы не дёргать
  // setup-эффект с null'ом.
  if (resolvedMode === null) {
    return (
      <div style={pageStyle}>
        <div style={headerStyle}>
          <h1 style={titleStyle}>
            Мит <span style={roomIdStyle}>{roomId}</span>
          </h1>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
          Определяю режим подключения…
        </div>
      </div>
    );
  }

  // Собираем тайлы для VideoGrid.
  const tiles: Array<{
    id: string;
    stream: MediaStream;
    name: string;
    isLocal?: boolean;
    micMuted?: boolean;
    camMuted?: boolean;
    isScreen?: boolean;
    isLocalScreen?: boolean;
  }> = [];

  if (localStream) {
    tiles.push({
      id: 'local',
      stream: localStream,
      // VideoTile сам добавляет " (вы)" для isLocal — но по ТЗ хотим видеть имя + " (вы)".
      // Чтобы не было двойного " (вы)", передаём чистое имя.
      name: myName.trim().length > 0 ? myName : 'Вы',
      isLocal: true,
      micMuted: !micOn,
      camMuted: !camOn,
    });
  }

  if (screenStream) {
    const myDisplay = myName.trim().length > 0 ? myName : 'Вы';
    tiles.push({
      id: 'local-screen',
      stream: screenStream,
      name: myDisplay,
      // isLocal=true → VideoTile замьютит audio (ну и audio в screen у нас всё равно false).
      isLocal: true,
      isScreen: true,
      isLocalScreen: true,
    });
  }

  for (const [pid, entry] of peers) {
    tiles.push({
      id: pid,
      stream: entry.stream,
      name: entry.name && entry.name.length > 0 ? entry.name : 'Участник',
      camMuted: entry.camMuted,
      micMuted: entry.micMuted,
    });
  }

  // Удалённые screen-share стримы (P2P). В SFU удалённый screen прилетает
  // через onRemoteTrack и попадает в peers как часть стрима того же пира.
  for (const [key, entry] of remoteScreens) {
    const peerName =
      entry.peerName && entry.peerName.length > 0 ? entry.peerName : 'Участник';
    tiles.push({
      id: `screen-${key}`,
      stream: entry.stream,
      name: `Экран: ${peerName}`,
      isScreen: true,
    });
  }

  // Подготовка строк для share-panel (только если SFU + endpoints получены).
  const showSharePanel = resolvedMode === 'sfu' && endpoints !== null;
  const hasIPv6 =
    diagnosis !== null && diagnosis.publicIPv6.length > 0;

  const modeBadgeLabel =
    resolvedMode === 'p2p' ? '🌐 Через интернет' : '📡 Через хост';
  const modeBadgeTitle =
    resolvedMode === 'p2p'
      ? 'Видео идёт напрямую между участниками (peer-to-peer). Сигналинг — через распределённую Nostr-сеть. Без серверов посередине.'
      : 'Видео идёт через создателя мита (он работает локальным сервером для всех гостей).';

  // Динамические стили для auto-hide:
  // - header едет вверх (translateY(-100%)), opacity 0, pointer-events: none.
  // - gridContainer в скрытом состоянии расширяется на всю высоту (paddingBottom: 0),
  //   потому что Controls тоже уехал вниз.
  const headerDynamicStyle: CSSProperties = chromeVisible
    ? {
        ...headerStyle,
        transform: 'translateY(0)',
        opacity: 1,
        transition: 'transform 250ms ease, opacity 250ms ease',
      }
    : {
        ...headerStyle,
        transform: 'translateY(-100%)',
        opacity: 0,
        pointerEvents: 'none',
        transition: 'transform 250ms ease, opacity 250ms ease',
      };
  const gridContainerDynamicStyle: CSSProperties = chromeVisible
    ? gridContainerStyle
    : {
        ...gridContainerStyle,
        paddingBottom: 0,
        transition: 'padding-bottom 250ms ease',
      };

  return (
    <div style={pageStyle}>
      <div style={headerDynamicStyle}>
        <h1 style={titleStyle}>
          Мит <span style={roomIdStyle}>{roomId}</span>
        </h1>
        <span style={modeBadgeStyle} data-tip={modeBadgeTitle}>
          {modeBadgeLabel}
        </span>
        {resolvedMode === 'p2p' && (
          password ? (
            <span
              style={secureBadgeStyle}
              data-tip="Зашифровано: видео, аудио и сигналинг защищены паролем из ссылки. Без полной ссылки подключиться нельзя."
            >
              🔒 Зашифровано
            </span>
          ) : (
            <span
              style={insecureBadgeStyle}
              data-tip="Кто угодно с этим ID может зайти. Создайте новый мит, чтобы получить защищённую ссылку с паролем."
            >
              ⚠ Без шифрования
            </span>
          )
        )}
        {resolvedMode === 'sfu' && <ConnectionBadge stats={stats} />}
        {relay && (() => {
          // Парсим createdAt → Date. Если невалидный — fallback на 0 длительность.
          const createdMs = (() => {
            const t = Date.parse(relay.createdAt);
            return Number.isFinite(t) ? t : Date.now();
          })();
          const elapsed = Date.now() - createdMs;
          const dur = formatRelayDuration(elapsed);
          const cost = formatRelayCost(elapsed);
          return (
            <span style={relayBadgeStyle} title={`TURN ${relay.publicIP}:${relay.turnPort}`}>
              <span aria-hidden="true">🌐</span>
              <span>Relay активен · €0.006/час · ~{dur} · {cost}</span>
              <button
                type="button"
                style={relayStopBtnStyle}
                onClick={handleStopRelay}
                disabled={relayBusy}
                title="Остановить relay"
              >
                {relayBusy ? '…' : 'Stop'}
              </button>
            </span>
          );
        })()}
        <button
          type="button"
          style={{ ...inviteBtnStyle, ...(inviteCopied ? inviteBtnCopiedStyle : {}) }}
          onClick={handleCopyInvite}
          aria-live="polite"
        >
          {inviteCopied ? (
            <>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Скопировано
            </>
          ) : (
            'Скопировать ссылку'
          )}
        </button>
      </div>

      {screenSharing && (
        <div style={screenHintStyle} role="status" aria-live="polite">
          <span aria-hidden="true">🖥</span>
          <span>
            Вы демонстрируете экран. Управляйте трансляцией кнопкой в
            панели снизу — баннер браузера сверху может выключить её
            некорректно (тайл застрянет у собеседников).
          </span>
        </div>
      )}

      {screenShareError && (
        <div style={screenErrorStyle} role="alert" aria-live="assertive">
          <span aria-hidden="true">⚠️</span>
          <span style={{ flex: 1 }}>{screenShareError}</span>
          <button
            type="button"
            onClick={() => setScreenShareError(null)}
            style={{
              background: 'transparent',
              border: '1px solid currentColor',
              color: 'inherit',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Скрыть
          </button>
        </div>
      )}

      {showSharePanel && (
        <div style={{ padding: '10px 16px', flexShrink: 0 }}>
          <div className="share-panel">
            <div className="share-panel-title">🔗 Поделиться</div>
            {endpoints!.map((ep, idx) => {
              const key = `${ep.kind}-${ep.host}-${ep.port}-${idx}`;
              const meta = ENDPOINT_KIND_META[ep.kind];
              const fullUrl = `${ep.url}/m/${roomId}${password ? `#${password}` : ''}`;
              const isCopied = copiedKey === key;
              // Для internet-эндпойнтов уточняем семейство IP в лейбле,
              // т.к. их теперь может быть до двух (ipv4 + ipv6).
              const familySuffix =
                ep.kind === 'internet' && ep.family
                  ? ep.family === 'ipv4'
                    ? ' (IPv4)'
                    : ' (IPv6)'
                  : '';
              const label = `${meta.label}${familySuffix}`;
              return (
                <div key={key} className="share-row">
                  <span className="share-row-label">
                    <span aria-hidden="true">{meta.icon}</span>
                    <span>{label}</span>
                  </span>
                  <span className="share-row-url" title={fullUrl}>
                    {fullUrl}
                  </span>
                  <button
                    type="button"
                    className={`share-row-copy${isCopied ? ' copied' : ''}`}
                    onClick={() => handleCopyEndpoint(key, ep.url)}
                  >
                    {isCopied ? '✓ Скопировано' : 'copy'}
                  </button>
                </div>
              );
            })}
          </div>

          {diagnosis && diagnosis.status === 'lan-only' && (
            <div className="diagnosis-banner lan-only">
              <div className="diagnosis-banner-row">
                <span>
                  <span aria-hidden="true">ℹ️ </span>
                  Интернет недоступен — работает только локально и в твоей Wi-Fi
                </span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="diagnosis-recheck"
                    onClick={handleRecheck}
                    disabled={rechecking}
                  >
                    {rechecking ? 'Проверяю…' : 'Перепроверить'}
                  </button>
                  <button
                    type="button"
                    className="diagnosis-banner-toggle"
                    onClick={() => setShowAdvice((v) => !v)}
                  >
                    {showAdvice ? 'Скрыть ▲' : 'Как открыть для интернета? ▼'}
                  </button>
                </span>
              </div>
              {showAdvice && (
                <div className="diagnosis-banner-advice">
                  <ul>
                    <li>
                      UPnP не сработал — возможно отключён на роутере. Включи
                      UPnP в админке роутера и перезапусти ZubraMeet.
                    </li>
                    <li>
                      Или вручную пробрось порт 7443/TCP на роутере на
                      ip-вашего-компа.
                    </li>
                    <li>
                      Или используй mesh-VPN (Tailscale, ZeroTier) чтобы гости
                      были в твоей виртуальной сети.
                    </li>
                  </ul>
                </div>
              )}
            </div>
          )}

          {diagnosis && diagnosis.status === 'behind-cgnat' && (
            <div className="diagnosis-banner behind-cgnat">
              <div className="diagnosis-banner-row">
                <span>
                  <span aria-hidden="true">⚠️ </span>
                  Ты за CGNAT провайдера — гости из интернета не подключатся
                  напрямую
                </span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {!relay && (
                    <button
                      type="button"
                      className="diagnosis-relay-start"
                      onClick={handleStartRelay}
                      disabled={relayBusy}
                      title="Поднять временную VM в облаке для TURN-relay"
                    >
                      {relayBusy ? 'Создаю VM… 30 сек' : '🚀 Запустить временный relay (€0.006/час)'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="diagnosis-recheck"
                    onClick={handleRecheck}
                    disabled={rechecking}
                  >
                    {rechecking ? 'Проверяю…' : 'Перепроверить'}
                  </button>
                  <button
                    type="button"
                    className="diagnosis-banner-toggle"
                    onClick={() => setShowAdvice((v) => !v)}
                  >
                    {showAdvice ? 'Скрыть ▲' : 'Что делать? ▼'}
                  </button>
                </span>
              </div>
              {relayError && (
                <div style={{ fontSize: 12, color: 'var(--danger)' }}>
                  Ошибка relay: {relayError}
                </div>
              )}
              {showAdvice && (
                <div className="diagnosis-banner-advice">
                  <div>
                    CGNAT — провайдер делит публичный IP между сотнями
                    абонентов. Прямой проброс невозможен.
                  </div>
                  <div>Варианты:</div>
                  <ul>
                    <li>
                      Запросить у провайдера «белый IP» (часто платная опция,
                      ~50–200₽/мес)
                    </li>
                    <li>
                      Использовать IPv6 (если провайдер выдаёт)
                      {hasIPv6
                        ? ' — у нас определён, см. IPv6-ссылку выше'
                        : ' — у нас не определён, проверь настройки сети'}
                    </li>
                    <li>
                      Поднять reverse-tunnel через свой VPS (frp, wireguard) —
                      нужен €3/мес VPS
                    </li>
                    <li>Mesh-VPN (Tailscale, ZeroTier) — гости ставят клиент</li>
                  </ul>
                </div>
              )}
            </div>
          )}

          {diagnosis &&
            diagnosis.status === 'behind-cgnat' &&
            hasIPv6 && (
              <div className="diagnosis-banner ok-with-ipv6">
                <span>
                  <span aria-hidden="true">✅ </span>
                  IPv6 определён — гости с IPv6 (большинство мобильных) смогут
                  подключиться по IPv6-ссылке
                </span>
              </div>
            )}
        </div>
      )}

      {!showSharePanel && resolvedMode === 'sfu' && endpointsErr && (
        <div
          style={{
            padding: '10px 16px',
            color: 'var(--muted)',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          Не удалось получить варианты подключения ({endpointsErr})
        </div>
      )}

      <div style={gridContainerDynamicStyle}>
        <VideoGrid tiles={tiles} />
      </div>

      <Controls
        micOn={micOn}
        camOn={camOn}
        screenSharing={screenSharing}
        screenQuality={screenQuality}
        onToggleMic={handleToggleMic}
        onToggleCam={handleToggleCam}
        onToggleScreenShare={handleToggleScreenShare}
        onChangeScreenQuality={setScreenQuality}
        onLeave={handleLeave}
        onCopyInvite={handleCopyInvite}
        onSendReaction={handleSendReaction}
        chatOpen={chatOpen}
        unreadChat={unreadChat}
        onToggleChat={handleToggleChat}
        hidden={!chromeVisible}
      />

      {/* Чат-sidebar. Не размонтируем — чтобы сохранить ввод/историю при
          закрытии. Visibility — через transform/opacity (см. ChatPanel). */}
      {chatOpen && (
        <ChatPanel
          messages={chatMessages}
          onSend={handleSendChat}
          onClose={handleToggleChat}
          hidden={!chromeVisible}
        />
      )}

      {/* Floating emoji-реакции поверх всего. pointer-events: none — не
          мешают кликам. Чистится через setTimeout в onReaction. */}
      <ReactionsLayer reactions={reactions} />

      {reconnecting && (
        <div style={overlayStyle} role="alert" aria-live="assertive">
          <div style={overlayBoxStyle}>
            <div>Переподключение…</div>
            {reconnectAttempt > 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Попытка {reconnectAttempt}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
