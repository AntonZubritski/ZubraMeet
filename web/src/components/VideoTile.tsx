import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Avatar from 'boring-avatars';

// Палитра под dark-тему (зелёный/бирюзовый/янтарь/розовый/индиго).
const AVATAR_COLORS = ['#22c55e', '#06b6d4', '#fbbf24', '#ec4899', '#6366f1'];

interface Props {
  stream: MediaStream;
  name: string;
  isLocal?: boolean;
  micMuted?: boolean;
  camMuted?: boolean;
  // НОВОЕ — рендерим как screen-share (объект другой aspect, в layout другая зона).
  // Сам тайл этот флаг почти не использует (визуально не отличается), но
  // для screen-share нужно objectFit: contain (а не cover) и подпись.
  isScreen?: boolean;
  isLocalScreen?: boolean;
}

const tileStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  background: '#000',
  border: '1px solid var(--border)',
  borderRadius: 8,
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  // Плавный переход свечения при изменении volumeLevel — без него ring
  // дёргался бы пиксель-в-пиксель на каждый rAF (некрасиво и заметно глазу).
  transition: 'box-shadow 80ms linear',
};

// Порог "говорит/не говорит" — среднее frequency-bin значение (0-255).
// 25 — после noise-suppression в getUserMedia это уверенно отделяет тишину
// и фоновый шум от речи. Слишком высокий порог = не реагирует на тихую речь;
// слишком низкий = ring загорается от шороха клавиатуры.
const SPEAKING_THRESHOLD = 25;

// Placeholder с аватаром накладывается ПОВЕРХ <video> когда камера выключена.
// position: absolute — чтобы video не размонтировался: srcObject остаётся
// прикреплённым, и при возврате камеры мы НЕ потеряем поток (известный баг
// React conditional rendering + srcObject).
const placeholderStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  background: 'var(--panel)',
  color: 'var(--fg)',
  userSelect: 'none',
};

const placeholderAvatarWrapStyle: CSSProperties = {
  width: 'clamp(80px, 18vh, 160px)',
  height: 'clamp(80px, 18vh, 160px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const placeholderNameStyle: CSSProperties = {
  fontSize: 'clamp(13px, 1.4vw, 16px)',
  fontWeight: 500,
  color: 'var(--muted)',
  maxWidth: '90%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
};

const nameOverlayStyle: CSSProperties = {
  position: 'absolute',
  left: 8,
  bottom: 8,
  padding: '3px 8px 3px 3px',
  background: 'rgba(0, 0, 0, 0.55)',
  borderRadius: 999,
  color: 'var(--fg)',
  fontSize: 12,
  lineHeight: 1,
  maxWidth: 'calc(100% - 48px)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const nameOverlayAvatarStyle: CSSProperties = {
  width: 18,
  height: 18,
  flexShrink: 0,
  borderRadius: '50%',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

// mic-off перенесли в верхний-левый, чтобы не перекрывать кнопку fullscreen справа.
const micOffStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.55)',
  borderRadius: '50%',
  color: 'var(--danger)',
  pointerEvents: 'none',
};

const fullscreenBtnBaseStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 28,
  height: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.55)',
  border: 'none',
  borderRadius: 6,
  color: 'var(--fg)',
  cursor: 'pointer',
  padding: 0,
  transition: 'opacity 120ms ease',
};

function MicOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

// 4 уголка наружу — «развернуть».
function FullscreenEnterIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 9 4 4 9 4" />
      <polyline points="20 9 20 4 15 4" />
      <polyline points="4 15 4 20 9 20" />
      <polyline points="20 15 20 20 15 20" />
    </svg>
  );
}

// 4 уголка внутрь — «свернуть».
function FullscreenExitIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 4 9 9 4 9" />
      <polyline points="15 4 15 9 20 9" />
      <polyline points="9 20 9 15 4 15" />
      <polyline points="15 20 15 15 20 15" />
    </svg>
  );
}

export default function VideoTile({
  stream,
  name,
  isLocal = false,
  micMuted = false,
  camMuted = false,
  isScreen = false,
  isLocalScreen = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  // 0..100. Используется для box-shadow ring'а — чем громче, тем больше glow.
  const [volumeLevel, setVolumeLevel] = useState<number>(0);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
  }, [stream]);

  // Audio-уровень через Web Audio API. Создаём AudioContext + AnalyserNode
  // и в каждом rAF берём средний уровень частот → пишем в state. Если
  // средний > порога — компонент пульсирует зелёным glow вокруг тайла.
  //
  // Screen-share без аудио, или треков ещё нет — ничего не делаем (analyser
  // не создаём, ring не показывается).
  //
  // Локальный тайл (isLocal=true) muted (анти-эхо), но source всё равно
  // получает данные — пользователь видит индикатор и собственного голоса. Это OK.
  useEffect(() => {
    // Если у стрима нет audio-tracks — analyser не нужен.
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setVolumeLevel(0);
      return;
    }
    // Если все audio-треки muted (нет данных) — тоже ничего не делаем; при
    // unmute new effect не пере-запустится (зависим только от stream id),
    // поэтому всё равно пробуем создать analyser — Web Audio с muted track
    // будет просто давать нули, без ошибок.

    type AudioCtor = typeof AudioContext;
    const Ctor: AudioCtor | undefined =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return;

    let ctx: AudioContext | null;
    try {
      ctx = new Ctor();
    } catch {
      // AudioContext requires user gesture — но к моменту рендера VideoTile
      // пользователь уже нажал "Присоединиться", так что обычно норм. На
      // случай редких краёв (pre-render) — silently skip.
      return;
    }

    let source: MediaStreamAudioSourceNode | null = null;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      void ctx.close().catch(() => {});
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let rafId = 0;
    let cancelled = false;

    const tick = (): void => {
      if (cancelled) return;
      analyser.getByteFrequencyData(buf);
      // Среднее по всем bin'ам. 0..255.
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] ?? 0;
      const avg = sum / buf.length;
      // Маппим 0..255 → 0..100, с лёгким clamp'ом снизу чтобы шум не светился.
      const level = avg < SPEAKING_THRESHOLD ? 0 : Math.min(100, (avg - SPEAKING_THRESHOLD) * 2);
      // setState каждый rAF — React 18 батчит, но мы всё равно избегаем
      // ре-рендера если значение почти то же (округляем до 2 единиц).
      setVolumeLevel((prev) => (Math.abs(prev - level) < 2 ? prev : level));
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      try {
        source?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        analyser.disconnect();
      } catch {
        /* ignore */
      }
      // close() возвращает Promise — best-effort.
      void ctx?.close().catch(() => {
        /* ignore — context может быть уже closed */
      });
    };
  }, [stream]);

  // Слушаем глобальный fullscreenchange — пользователь может выйти из
  // полноэкранного режима через Esc, тогда контейнер перестаёт быть fullscreen,
  // и мы должны переключить иконку обратно на «развернуть».
  useEffect(() => {
    const onChange = (): void => {
      const el = containerRef.current;
      if (!el) {
        setIsFullscreen(false);
        return;
      }
      setIsFullscreen(document.fullscreenElement === el);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  const handleToggleFullscreen = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      // Уже мы в fullscreen — выходим.
      void document.exitFullscreen().catch((err: unknown) => {
        console.error('[VideoTile] exitFullscreen failed', err);
      });
      return;
    }
    if (document.fullscreenElement) {
      // В fullscreen другой элемент — сначала выходим из него, потом входим.
      void document
        .exitFullscreen()
        .then(() => el.requestFullscreen())
        .catch((err: unknown) => {
          console.error('[VideoTile] requestFullscreen failed', err);
        });
      return;
    }
    void el.requestFullscreen().catch((err: unknown) => {
      console.error('[VideoTile] requestFullscreen failed', err);
    });
  };

  // Для screen-share не обрезаем (objectFit: contain), для камеры — cover.
  const videoStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: isScreen ? 'contain' : 'cover',
    display: 'block',
    background: '#000',
  };

  // Для local-screen приписываем «(ваш экран)», для остальных стандарт.
  const displayName = isLocalScreen
    ? `${name} (ваш экран)`
    : isLocal
      ? `${name} (вы)`
      : name;

  const fullscreenBtnStyle: CSSProperties = {
    ...fullscreenBtnBaseStyle,
    opacity: hovered || isFullscreen ? 1 : 0,
    pointerEvents: hovered || isFullscreen ? 'auto' : 'none',
  };

  // Speaking ring — зелёный (accent #22c55e) glow вокруг всего тайла,
  // расширяется пропорционально volumeLevel (0..100). При тишине — 0px.
  // Используем два слоя box-shadow: внешний (большой, мягкий) + внутренний
  // (тонкая чёткая обводка), чтобы и было видно на тёмном фоне, и не
  // выглядело размыто.
  const speaking = volumeLevel > 0;
  const ringSize = speaking ? 4 + volumeLevel / 8 : 0; // 0..16.5px
  const ringAlpha = speaking ? 0.3 + volumeLevel / 250 : 0; // 0.3..0.7
  const tileDynamicStyle: CSSProperties = {
    ...tileStyle,
    boxShadow: speaking
      ? `0 0 0 2px rgba(34, 197, 94, ${ringAlpha + 0.2}), 0 0 ${ringSize * 2}px ${ringSize}px rgba(34, 197, 94, ${ringAlpha})`
      : 'none',
  };

  return (
    <div
      ref={containerRef}
      style={tileDynamicStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Видео ВСЕГДА в DOM с прикреплённым srcObject. При камере off мы
          просто накладываем placeholder сверху — video продолжает жить и
          мгновенно появляется при включении (без re-attach stream). */}
      <video
        ref={videoRef}
        style={videoStyle}
        autoPlay
        playsInline
        muted={isLocal || micMuted}
      />
      {camMuted && (
        <div style={placeholderStyle} aria-label={`Камера выключена: ${name}`}>
          <div style={placeholderAvatarWrapStyle}>
            <Avatar
              size="100%"
              name={name || '?'}
              variant="beam"
              colors={AVATAR_COLORS}
            />
          </div>
          <div style={placeholderNameStyle} title={name}>
            {displayName}
          </div>
        </div>
      )}

      <div style={nameOverlayStyle} title={name}>
        <span style={nameOverlayAvatarStyle} aria-hidden="true">
          <Avatar size={18} name={name || '?'} variant="beam" colors={AVATAR_COLORS} />
        </span>
        <span>{displayName}</span>
      </div>

      {micMuted && (
        <div style={micOffStyle} title="Микрофон выключен" aria-label="Микрофон выключен">
          <MicOffIcon />
        </div>
      )}

      <button
        type="button"
        style={fullscreenBtnStyle}
        onClick={handleToggleFullscreen}
        title={isFullscreen ? 'Свернуть' : 'Развернуть'}
        aria-label={isFullscreen ? 'Свернуть' : 'Развернуть'}
      >
        {isFullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
      </button>
    </div>
  );
}
