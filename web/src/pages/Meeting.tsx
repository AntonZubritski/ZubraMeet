// Страница встречи: захват камеры/микрофона, сигналинг, WebRTC, рендер сетки.
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { navigate } from '../App';
import { SignalClient, buildWsUrl } from '../lib/signal';
import { MeetConnection, type MeetConnectionEvents } from '../lib/webrtc';
import type { ConnectionStats, PeerInfo } from '../types';
import VideoGrid from '../components/VideoGrid';
import Controls from '../components/Controls';
import ConnectionBadge from '../components/ConnectionBadge';

interface Props {
  roomId: string;
}

interface PeerEntry {
  stream: MediaStream;
  name: string;
}

const NAME_KEY = 'zubrameet.name';
const STATS_INTERVAL_MS = 2000;

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
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
};

const resBadgeStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--muted)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  cursor: 'help',
};

const gridContainerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
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

function getVideoSize(stream: MediaStream | null): { w: number; h: number } | null {
  if (!stream) return null;
  const v = stream.getVideoTracks()[0];
  if (!v) return null;
  const settings = v.getSettings();
  const w = typeof settings.width === 'number' ? settings.width : 0;
  const h = typeof settings.height === 'number' ? settings.height : 0;
  if (w === 0 || h === 0) return null;
  return { w, h };
}

export default function Meeting({ roomId }: Props) {
  // localStream + peers + ui-флаги
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenSharing, setScreenSharing] = useState<boolean>(false);
  const [peers, setPeers] = useState<Map<string, PeerEntry>>(() => new Map());
  const [micOn, setMicOn] = useState<boolean>(true);
  const [camOn, setCamOn] = useState<boolean>(true);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<boolean>(false);
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

  // Refs на длинноживущие объекты, чтобы cleanup точно их закрыл.
  const signalRef = useRef<SignalClient | null>(null);
  const connectionRef = useRef<MeetConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const statsTimerRef = useRef<number | null>(null);
  const recoveringRef = useRef<boolean>(false);
  // peerId → displayName (peer.id из welcome/peer-joined может НЕ совпадать со stream.id —
  // см. webrtc.ts: TODO mid→peerId mapping. Пока храним по обоим ключам как сможем.)
  const peerNamesRef = useRef<Map<string, string>>(new Map());
  // Чтобы избежать двойной инициализации в StrictMode dev.
  const startedRef = useRef<boolean>(false);

  const myName: string = (() => {
    try {
      return window.localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  })();

  // Recover camera/microphone после sleep/wake.
  // Останавливаем старые треки, getUserMedia заново, replaceLocalTracks на publishPC.
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

      const conn = connectionRef.current;
      if (conn) {
        try {
          await conn.replaceLocalTracks(newStream);
        } catch (err) {
          console.error('[Meeting] recoverMedia: replaceLocalTracks failed', err);
        }
      }
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

  // Главный lifecycle: одна setup-функция, один cleanup.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const cleanup = (): void => {
      if (statsTimerRef.current !== null) {
        window.clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
      if (connectionRef.current) {
        try {
          connectionRef.current.close();
        } catch {
          /* ignore */
        }
        connectionRef.current = null;
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
      connectionRef.current = conn;

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
        const c = connectionRef.current;
        if (!c) return;
        void c.getStats().then((s) => {
          setStats(s);
        });
      }, STATS_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // visibilitychange → если вкладка снова видна и треки сломаны, восстановить.
  useEffect(() => {
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
  }, []);

  const handleToggleMic = (): void => {
    const ls = localStreamRef.current;
    if (!ls) return;
    const enabled = !micOn;
    for (const t of ls.getAudioTracks()) {
      t.enabled = enabled;
    }
    setMicOn(enabled);
  };

  const handleToggleCam = (): void => {
    const ls = localStreamRef.current;
    if (!ls) return;
    const enabled = !camOn;
    for (const t of ls.getVideoTracks()) {
      t.enabled = enabled;
    }
    setCamOn(enabled);
  };

  const handleToggleScreenShare = (): void => {
    const conn = connectionRef.current;
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
      void conn
        .startScreenShare()
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
          console.error('[Meeting] startScreenShare failed', err);
        });
    }
  };

  const handleLeave = (): void => {
    // Cleanup произойдёт автоматически в useEffect-return при размонтировании,
    // но ручная очистка тут гарантирует, что треки/WS закроются ещё до навигации.
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (connectionRef.current) {
      try {
        connectionRef.current.close();
      } catch {
        /* ignore */
      }
      connectionRef.current = null;
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

  const handleCopyInvite = (): void => {
    const url = `${window.location.origin}/m/${roomId}`;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard
        .writeText(url)
        .then(() => {
          console.log('[Meeting] invite copied:', url);
        })
        .catch((err: unknown) => {
          console.error('[Meeting] clipboard write failed', err);
        });
    } else {
      console.log('[Meeting] invite link:', url);
    }
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

  // Собираем тайлы для VideoGrid.
  const tiles: Array<{
    id: string;
    stream: MediaStream;
    name: string;
    isLocal?: boolean;
    micMuted?: boolean;
    camMuted?: boolean;
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
      name: `Экран: ${myDisplay}`,
      // isLocal=true → VideoTile замьютит audio (ну и audio в screen у нас всё равно false).
      isLocal: true,
    });
  }

  for (const [pid, entry] of peers) {
    tiles.push({
      id: pid,
      stream: entry.stream,
      name: entry.name && entry.name.length > 0 ? entry.name : 'Участник',
    });
  }

  const size = getVideoSize(localStream);
  const resTitle = size
    ? `Локальное видео: ${size.w}×${size.h}`
    : 'Локальное видео: только аудио';
  const resBadge = size ? `${size.w}×${size.h}` : 'audio-only';

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>
          Мит <span style={roomIdStyle}>{roomId}</span>
        </h1>
        <ConnectionBadge stats={stats} />
        <span style={resBadgeStyle} title={resTitle}>
          {resBadge}
        </span>
        <button type="button" style={inviteBtnStyle} onClick={handleCopyInvite}>
          Скопировать ссылку
        </button>
      </div>

      <div style={gridContainerStyle}>
        <VideoGrid tiles={tiles} />
      </div>

      <Controls
        micOn={micOn}
        camOn={camOn}
        screenSharing={screenSharing}
        onToggleMic={handleToggleMic}
        onToggleCam={handleToggleCam}
        onToggleScreenShare={handleToggleScreenShare}
        onLeave={handleLeave}
        onCopyInvite={handleCopyInvite}
      />

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
