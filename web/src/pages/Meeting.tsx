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

/**
 * Пытаемся получить камеру+микрофон, при падении — fallback на только аудио.
 */
async function acquireMedia(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err1) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      const msg1 = err1 instanceof Error ? err1.message : String(err1);
      throw new Error(`getUserMedia: ${msg1} (audio-only fallback: ${msg2})`);
    }
  }
}

export default function Meeting({ roomId }: Props) {
  // localStream + peers + ui-флаги
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<Map<string, PeerEntry>>(() => new Map());
  const [micOn, setMicOn] = useState<boolean>(true);
  const [camOn, setCamOn] = useState<boolean>(true);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs на длинноживущие объекты, чтобы cleanup точно их закрыл.
  const signalRef = useRef<SignalClient | null>(null);
  const connectionRef = useRef<MeetConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const statsTimerRef = useRef<number | null>(null);
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
  for (const [pid, entry] of peers) {
    tiles.push({
      id: pid,
      stream: entry.stream,
      name: entry.name && entry.name.length > 0 ? entry.name : 'Участник',
    });
  }

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>
          Мит <span style={roomIdStyle}>{roomId}</span>
        </h1>
        <ConnectionBadge stats={stats} />
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
        onToggleMic={handleToggleMic}
        onToggleCam={handleToggleCam}
        onLeave={handleLeave}
        onCopyInvite={handleCopyInvite}
      />
    </div>
  );
}
