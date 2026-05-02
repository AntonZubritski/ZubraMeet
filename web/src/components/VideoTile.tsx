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
  // ID тайла, прокинутый из VideoGrid. Когда isScreen=true и !isLocalScreen,
  // используется как data-screen-tile-id, чтобы Meeting.tsx мог найти DOM-узел
  // и попытаться вызвать requestFullscreen() при появлении нового remote screen.
  tileId?: string;
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
};

// Порог "говорит/не говорит" — среднее frequency-bin значение (0-255).
// 25 — после noise-suppression в getUserMedia это уверенно отделяет тишину
// и фоновый шум от речи. Слишком высокий порог = не реагирует на тихую речь;
// слишком низкий = ring загорается от шороха клавиатуры.
//
// Hysteresis: чтобы не дребезжало в окрестности порога:
//   START — выше этого уровня считаем "говорит"
//   STOP  — ниже этого уровня выключаем (пауза в речи / тишина)
// Разница ~25 пунктов исключает мерцание на дыхании/фоне.
const SPEAKING_START = 45;
const SPEAKING_STOP = 20;

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
  position: 'relative',
  width: 'clamp(80px, 18vh, 160px)',
  height: 'clamp(80px, 18vh, 160px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

// Talking ripples — 3 концентрических круга расходятся от аватара (CSS keyframe
// `zubrameet-ripple` объявлен в styles.css). Прячутся под аватар через z-index.
// Sizing — 100% от wrap'а; круги стартуют как точка-аватар, разрастаются ×2.4
// и тускнеют. Animation play-state регулируется speaking прямо в style props.
const rippleBaseStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  border: '2px solid #22c55e',
  pointerEvents: 'none',
  willChange: 'transform, opacity',
  animation: 'zubrameet-ripple 1.6s ease-out infinite',
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

// PiP-кнопка — слева от fullscreen-кнопки, только для screen-tile'ов.
const pipBtnBaseStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 44, // слева от fullscreen (8 + 28 + 8 gap)
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

// Большая overlay-кнопка, которая лежит ПО ЦЕНТРУ remote screen-tile'а
// когда он не в fullscreen. Цель: дать пользователю user gesture, через
// который можно вызвать requestFullscreen() — это скрывает browser chrome
// и баннер «Демонстрировать вкладку» сверху.
const fullscreenOverlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  // pointerEvents 'auto' — кнопка перехватывает клик. По дизайну она почти
  // прозрачная, но при hover проявляется centered pill с подсказкой.
  pointerEvents: 'auto',
};

const fullscreenOverlayPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 16px',
  background: 'rgba(0, 0, 0, 0.65)',
  borderRadius: 999,
  color: '#fff',
  fontSize: 13,
  fontWeight: 500,
  pointerEvents: 'none',
  border: '1px solid rgba(255, 255, 255, 0.18)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  transition: 'transform 160ms ease, opacity 160ms ease',
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

// Picture-in-picture icon — большой прямоугольник + маленький в углу.
// Используется для screen-share, чтобы вынести презентацию в плавающее окно.
function PipIcon() {
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
      <rect x="3" y="5" width="18" height="14" rx="2" ry="2" />
      <rect x="13" y="11" width="6" height="5" rx="1" ry="1" fill="currentColor" />
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
  tileId,
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
      // Hysteresis-маппинг: ниже SPEAKING_STOP → 0; выше SPEAKING_START →
      // нормализуем до 0..100; в "серой зоне" между ними — сохраняем prev,
      // не переключаемся (это и есть hysteresis, защита от мерцания).
      setVolumeLevel((prev) => {
        let next: number;
        if (avg < SPEAKING_STOP) {
          next = 0;
        } else if (avg >= SPEAKING_START) {
          next = Math.min(100, (avg - SPEAKING_START) * 2);
        } else {
          // в "серой зоне" — оставляем как есть (на нуле либо на прежнем уровне).
          next = prev;
        }
        return Math.abs(prev - next) < 2 ? prev : next;
      });
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

  // PiP. Полезно только для screen-share — выносит презентацию в плавающее
  // окно поверх других приложений. Для камер мы PiP запрещаем (см.
  // disablePictureInPicture ниже), потому что кнопка PiP в нативных controls
  // выглядит как кнопка-промах рядом со screen-share.
  const handleTogglePip = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const video = videoRef.current as
      | (HTMLVideoElement & {
          requestPictureInPicture?: () => Promise<unknown>;
        })
      | null;
    if (!video) return;
    const doc = document as Document & {
      pictureInPictureElement?: Element | null;
      exitPictureInPicture?: () => Promise<void>;
    };
    if (doc.pictureInPictureElement === video && doc.exitPictureInPicture) {
      void doc.exitPictureInPicture().catch((err: unknown) => {
        console.error('[VideoTile] exitPictureInPicture failed', err);
      });
      return;
    }
    if (typeof video.requestPictureInPicture === 'function') {
      void video.requestPictureInPicture().catch((err: unknown) => {
        console.error('[VideoTile] requestPictureInPicture failed', err);
      });
    }
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

  // PiP-кнопка показывается только на screen-tile'ах (камеры — без PiP).
  const pipBtnStyle: CSSProperties = {
    ...pipBtnBaseStyle,
    opacity: hovered || isFullscreen ? 1 : 0,
    pointerEvents: hovered || isFullscreen ? 'auto' : 'none',
  };

  // Показываем "большую" overlay-кнопку только на REMOTE screen-tile'ах
  // (не на нашем собственном — у себя fullscreen скроет лишь наше же видео).
  // И только пока тайл не в fullscreen.
  const showFullscreenOverlay =
    isScreen && !isLocalScreen && !isFullscreen;

  // Talking visualization — концентрические круги расходящиеся от аватара,
  // как круги на воде. Реализовано через 3 absolute div'а с CSS animation;
  // play-state ставим в paused когда volumeLevel === 0 (тишина).
  const speaking = volumeLevel > 0;

  // data-attribute для screen-tile'ов — Meeting.tsx использует, чтобы найти
  // конкретный DOM-узел при появлении нового remote screen и попытаться
  // вызвать requestFullscreen() (а заодно для дебага/тестов).
  const dataScreenTileId = isScreen && tileId ? tileId : undefined;

  return (
    <div
      ref={containerRef}
      data-screen-tile-id={dataScreenTileId}
      style={{
        ...tileStyle,
        // Когда говорит и камера ON — мягкая зелёная обводка вокруг тайла
        // (вместо ripples, которые видны только на placeholder). При cam-off
        // обводки нет, потому что внутри уже видны ripples вокруг аватара.
        ...(speaking && !camMuted
          ? {
              boxShadow: '0 0 0 2px #22c55e, 0 0 16px 2px rgba(34, 197, 94, 0.4)',
              transition: 'box-shadow 100ms linear',
            }
          : { transition: 'box-shadow 200ms ease-out' }),
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Видео ВСЕГДА в DOM с прикреплённым srcObject. При камере off мы
          просто накладываем placeholder сверху — video продолжает жить и
          мгновенно появляется при включении (без re-attach stream).

          Для камер: disablePictureInPicture + nofullscreen в controlsList,
          чтобы зритель в нативном меню браузера не тыкнул случайно «PiP» или
          «Share this tab» и не стартанул свой screen-share.

          Для screen-share PiP, наоборот, ПОЛЕЗЕН — даёт вынести презентацию
          в плавающее окно поверх других приложений. Поэтому для isScreen=true
          мы НЕ ставим disablePictureInPicture и убираем nopictureinpicture
          из controlsList. */}
      <video
        ref={videoRef}
        style={videoStyle}
        autoPlay
        playsInline
        muted={isLocal || micMuted}
        {...(isScreen ? {} : { disablePictureInPicture: true })}
        disableRemotePlayback
        controlsList={
          isScreen
            ? 'nodownload nofullscreen noremoteplayback noplaybackrate'
            : 'nodownload nofullscreen noremoteplayback noplaybackrate'
        }
      />
      {camMuted && (
        <div style={placeholderStyle} aria-label={`Камера выключена: ${name}`}>
          <div style={placeholderAvatarWrapStyle}>
            {speaking && (
              <>
                <span style={{ ...rippleBaseStyle, animationDelay: '0s' }} aria-hidden="true" />
                <span style={{ ...rippleBaseStyle, animationDelay: '0.5s' }} aria-hidden="true" />
                <span style={{ ...rippleBaseStyle, animationDelay: '1.0s' }} aria-hidden="true" />
              </>
            )}
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

      {isScreen && (
        <button
          type="button"
          style={pipBtnStyle}
          onClick={handleTogglePip}
          title="Картинка в картинке"
          aria-label="Открыть в режиме «картинка в картинке»"
        >
          <PipIcon />
        </button>
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

      {showFullscreenOverlay && (
        // Большая прозрачная кнопка по центру тайла. При клике даёт user-gesture
        // → надёжный requestFullscreen(), который скрывает баннер браузера
        // «Демонстрировать вкладку» и весь chrome.
        // Не перехватывает клик за пределами центральной pill'ы — оставляем
        // верхне-правые управляющие кнопки доступными (они z-index'ом выше
        // не нужны, потому что физически расположены поверх).
        <button
          type="button"
          style={fullscreenOverlayStyle}
          onClick={handleToggleFullscreen}
          aria-label="Открыть на весь экран — скроет баннер браузера"
          title="Открыть на весь экран — скроет баннер браузера"
        >
          <span
            style={{
              ...fullscreenOverlayPillStyle,
              opacity: hovered ? 1 : 0.85,
              transform: hovered ? 'scale(1.04)' : 'scale(1)',
            }}
          >
            <FullscreenEnterIcon />
            <span>Открыть на весь экран — скроет баннер браузера</span>
          </span>
        </button>
      )}
    </div>
  );
}
