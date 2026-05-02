import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  SCREEN_QUALITY_PRESETS,
  type ScreenQuality,
} from '../lib/screen-quality';
import EmojiPicker from './EmojiPicker';

interface Props {
  micOn: boolean;
  camOn: boolean;
  screenSharing: boolean;
  // Текущий выбранный preset качества screen-share. Используется только когда
  // screenSharing === false — открыв dropdown, пользователь увидит активную опцию.
  // Во время активной трансляции качество не меняется (нужно остановить и
  // перезапустить).
  screenQuality: ScreenQuality;
  onToggleMic(): void;
  onToggleCam(): void;
  onToggleScreenShare(): void;
  onChangeScreenQuality(q: ScreenQuality): void;
  onLeave(): void;
  onCopyInvite(): void;
  // Emoji-реакция: при клике на smile-кнопку открывается popover с emoji-grid.
  // Выбор emoji вызывает onSendReaction(emoji) — родитель прокидывает в
  // P2PMeetConnection.sendReaction.
  onSendReaction(emoji: string): void;
  // Чат-sidebar: toggle открытия. unreadChat — счётчик непрочитанных
  // сообщений (рендерится бейджем над кнопкой). Когда чат уже открыт,
  // unreadChat должен быть 0 (родитель сбрасывает на open).
  chatOpen: boolean;
  unreadChat: number;
  onToggleChat(): void;
  // Auto-hide chrome: когда true — bar уезжает вниз (translateY(100%)),
  // opacity 0, pointer-events: none. Любой tap/mousemove на странице снова
  // покажет (логика в Meeting.tsx через idle-timer). Optional, default = false.
  hidden?: boolean;
}

// getDisplayMedia не поддерживается в большинстве мобильных браузеров
// (iOS Safari, Android Chrome не дают screen capture API). Если его нет —
// прячем кнопку screen-share, чтобы юзер не видел loud error.
function isScreenShareSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  const md = navigator.mediaDevices as MediaDevices | undefined;
  return !!md && typeof md.getDisplayMedia === 'function';
}

const ICON_SIZE = 20;

const barStyle: CSSProperties = {
  position: 'fixed',
  // Учитываем safe-area-inset-bottom (iOS home-indicator) — фиксированный bar
  // не должен залезать под индикатор. На устройствах без safe-area env() = 0,
  // и bottom = 16px как раньше.
  bottom: 'calc(16px + env(safe-area-inset-bottom))',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 12,
  padding: '8px 12px',
  background: 'rgba(20, 20, 20, 0.85)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  border: '1px solid var(--border)',
  borderRadius: 999,
  zIndex: 100,
  transition: 'transform 250ms ease, opacity 250ms ease',
  opacity: 1,
};

// Стиль когда bar скрыт (idle 5с): уезжает вниз за пределы viewport
// и игнорирует pointer events (тап показывает chrome через listener
// в Meeting.tsx, но НЕ нажимает кнопку случайно).
const barHiddenStyle: CSSProperties = {
  // Сохраняем translateX(-50%) для горизонтального центрирования и
  // добавляем translateY(calc(100% + ...)) чтобы bar полностью ушёл вниз
  // вместе с safe-area отступом.
  transform: 'translateX(-50%) translateY(calc(100% + 32px))',
  opacity: 0,
  pointerEvents: 'none',
};

type Variant = 'default' | 'off' | 'leave' | 'active';

function buttonStyle(variant: Variant, hovered: boolean): CSSProperties {
  const base: CSSProperties = {
    width: 48,
    height: 48,
    borderRadius: '50%',
    border: '1px solid var(--border)',
    background: 'var(--panel)',
    color: 'var(--fg)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
  };

  if (variant === 'leave') {
    return {
      ...base,
      background: hovered ? '#dc2626' : 'var(--danger)',
      borderColor: hovered ? '#dc2626' : 'var(--danger)',
      color: '#fff',
    };
  }

  if (variant === 'off') {
    return {
      ...base,
      color: 'var(--danger)',
      borderColor: 'rgba(239, 68, 68, 0.45)',
      background: hovered ? 'rgba(239, 68, 68, 0.12)' : 'var(--panel)',
    };
  }

  if (variant === 'active') {
    return {
      ...base,
      background: 'var(--accent)',
      borderColor: 'var(--accent)',
      color: '#0a0a0a',
    };
  }

  return {
    ...base,
    background: hovered ? '#1f1f1f' : 'var(--panel)',
    borderColor: hovered ? '#333' : 'var(--border)',
  };
}

interface CircleButtonProps {
  variant: Variant;
  onClick(): void;
  ariaLabel: string;
  pressed?: boolean;
  children: ReactNode;
}

function CircleButton({
  variant,
  onClick,
  ariaLabel,
  pressed,
  children,
}: CircleButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      style={buttonStyle(variant, hovered)}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      aria-label={ariaLabel}
      title={ariaLabel}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
    >
      {children}
    </button>
  );
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <line x1="2" y1="2" x2="22" y2="22" />
          <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </>
      ) : (
        <>
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </>
      )}
    </svg>
  );
}

function CamIcon({ off }: { off: boolean }) {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <line x1="2" y1="2" x2="22" y2="22" />
          <path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
          <path d="M10 6h4a2 2 0 0 1 2 2v3l5-3v10" />
        </>
      ) : (
        <>
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </>
      )}
    </svg>
  );
}

function ScreenShareIcon({ active }: { active: boolean }) {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      {active ? (
        // галочка внутри монитора, когда активен
        <polyline points="7 10 11 13 17 7" />
      ) : (
        // стрелка вверх — "транслировать"
        <>
          <line x1="12" y1="13" x2="12" y2="7" />
          <polyline points="9 10 12 7 15 10" />
        </>
      )}
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 15 12 9 18 15" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function SmileIcon() {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function PhoneDownIcon() {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"
        transform="rotate(135 12 12)"
      />
    </svg>
  );
}

// Композитная кнопка screen-share: левая половина — основная кнопка
// (старт/стоп трансляции), правая — стрелка-toggle dropdown'а с выбором
// качества. Когда screen-share активен, dropdown скрыт (качество не меняется
// на лету). Закрывается по клику вне.
interface ScreenShareControlProps {
  active: boolean;
  quality: ScreenQuality;
  onToggle(): void;
  onChangeQuality(q: ScreenQuality): void;
}

function ScreenShareControl({
  active,
  quality,
  onToggle,
  onChangeQuality,
}: ScreenShareControlProps) {
  const [hovered, setHovered] = useState(false);
  const [chevHovered, setChevHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Закрытие по клику вне.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent | TouchEvent): void => {
      const root = containerRef.current;
      if (!root) return;
      const target = ev.target as Node | null;
      if (target && root.contains(target)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Когда трансляция активна — закрываем dropdown (на всякий случай).
  useEffect(() => {
    if (active) setOpen(false);
  }, [active]);

  const variant: Variant = active ? 'active' : 'default';

  // Пилюля из двух частей: main (круг 48×48) + chevron-tab (узкий справа).
  // Объединяем в общий border-radius 999px без зазора.
  const wrapperStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
  };

  const mainBase: CSSProperties = {
    width: 48,
    height: 48,
    borderTopLeftRadius: 999,
    borderBottomLeftRadius: 999,
    borderTopRightRadius: active ? 999 : 0,
    borderBottomRightRadius: active ? 999 : 0,
    border: '1px solid var(--border)',
    borderRight: active ? '1px solid var(--border)' : 'none',
    background: 'var(--panel)',
    color: 'var(--fg)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
  };

  let mainStyle: CSSProperties = mainBase;
  if (variant === 'active') {
    mainStyle = {
      ...mainBase,
      // Когда трансляция активна — закругляем правую сторону тоже, потому что
      // chevron-tab превратится в неактивную (см. ниже) и визуально лучше,
      // если он смотрится как отдельная "пилюля", а не приклеен к main.
      borderTopRightRadius: 999,
      borderBottomRightRadius: 999,
      borderRight: '1px solid var(--accent)',
      background: 'var(--accent)',
      borderColor: 'var(--accent)',
      color: '#0a0a0a',
    };
  } else {
    mainStyle = {
      ...mainBase,
      background: hovered ? '#1f1f1f' : 'var(--panel)',
      borderColor: hovered ? '#333' : 'var(--border)',
    };
  }

  // Chevron-tab. Когда screen-share АКТИВЕН — рисуем disabled-вариант
  // (видимый, но неактивный) с tooltip-подсказкой, что качество поменять
  // нельзя на лету. Так пользователь не теряет визуальный контекст
  // ("куда делась стрелка?") и понимает, что нужно сначала остановить.
  const chevDisabled = active;
  const chevStyle: CSSProperties = {
    width: 22,
    height: 48,
    marginLeft: chevDisabled ? 4 : 0,
    borderRadius: chevDisabled ? 999 : 0,
    borderTopRightRadius: 999,
    borderBottomRightRadius: 999,
    border: '1px solid var(--border)',
    borderLeft: chevDisabled ? '1px solid var(--border)' : 'none',
    background: chevDisabled
      ? 'var(--panel)'
      : chevHovered
        ? '#1f1f1f'
        : 'var(--panel)',
    color: chevDisabled ? 'var(--muted)' : 'var(--fg)',
    opacity: chevDisabled ? 0.55 : 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: chevDisabled ? 'not-allowed' : 'pointer',
    padding: 0,
    transition: 'background-color 120ms ease, border-color 120ms ease, opacity 120ms ease',
  };

  const dropdownStyle: CSSProperties = {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    right: 0,
    minWidth: 200,
    background: 'rgba(20, 20, 20, 0.97)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    zIndex: 110,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
  };

  const itemStyle = (selected: boolean): CSSProperties => ({
    padding: '8px 10px',
    borderRadius: 6,
    fontSize: 13,
    color: selected ? '#0a0a0a' : 'var(--fg)',
    background: selected ? 'var(--accent)' : 'transparent',
    border: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    fontWeight: selected ? 600 : 400,
    transition: 'background-color 100ms ease',
  });

  const headerStyle: CSSProperties = {
    fontSize: 11,
    color: 'var(--muted)',
    padding: '6px 10px 4px',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  };

  const handleQualityClick = (q: ScreenQuality): void => {
    onChangeQuality(q);
    setOpen(false);
    // Сразу запускаем демонстрацию выбранного качества — чтобы пользователю
    // не пришлось делать второй клик. Если уже активна — ничего не делаем
    // (dropdown в этом режиме всё равно скрыт useEffect выше).
    if (!active) {
      onToggle();
    }
  };

  const ariaLabel = active ? 'Остановить трансляцию' : 'Транслировать экран';

  return (
    <div style={wrapperStyle} ref={containerRef}>
      <button
        type="button"
        style={mainStyle}
        onClick={onToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-label={ariaLabel}
        aria-pressed={active}
        title={ariaLabel}
      >
        <ScreenShareIcon active={active} />
      </button>

      <button
        type="button"
        style={chevStyle}
        onClick={() => {
          if (chevDisabled) return;
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setChevHovered(true)}
        onMouseLeave={() => setChevHovered(false)}
        onFocus={() => setChevHovered(true)}
        onBlur={() => setChevHovered(false)}
        aria-label={
          chevDisabled
            ? 'Качество нельзя менять во время трансляции — остановите её сначала'
            : 'Выбрать качество трансляции'
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={chevDisabled}
        title={
          chevDisabled
            ? 'Сначала остановите текущую трансляцию, чтобы сменить качество'
            : 'Выбрать качество'
        }
      >
        <ChevronUpIcon />
      </button>

      {open && !active && (
        <div role="listbox" aria-label="Качество трансляции экрана" style={dropdownStyle}>
          <div style={headerStyle}>Качество</div>
          {(Object.keys(SCREEN_QUALITY_PRESETS) as ScreenQuality[]).map((q) => {
            const preset = SCREEN_QUALITY_PRESETS[q];
            const selected = q === quality;
            return (
              <button
                key={q}
                type="button"
                role="option"
                aria-selected={selected}
                style={itemStyle(selected)}
                onClick={() => handleQualityClick(q)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Smile-кнопка с popover. Popover EmojiPicker сам слушает clickoutside/Esc.
// Здесь — только круглая кнопка + ref-обёртка для абсолютного позиционирования.
interface SmileButtonProps {
  onPick(emoji: string): void;
}
function SmileButton({ onPick }: SmileButtonProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handlePick = (emoji: string): void => {
    onPick(emoji);
    setOpen(false);
  };

  const wrapperStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
  };

  return (
    <div style={wrapperStyle}>
      <button
        type="button"
        style={buttonStyle('default', hovered)}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-label="Отправить реакцию"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={open}
        title="Отправить реакцию"
      >
        <SmileIcon />
      </button>
      {open && <EmojiPicker onPick={handlePick} onClose={() => setOpen(false)} />}
    </div>
  );
}

// Chat-кнопка с unread-бейджем. Бейдж — маленький круг с числом в правом
// верхнем углу. Когда чат уже открыт — бейдж не рендерится (родитель и так
// сбрасывает unreadChat в 0 при открытии, но дополнительная защита от мигания).
interface ChatButtonProps {
  open: boolean;
  unread: number;
  onClick(): void;
}
function ChatButton({ open, unread, onClick }: ChatButtonProps) {
  const [hovered, setHovered] = useState(false);
  const variant: Variant = open ? 'active' : 'default';
  const showBadge = !open && unread > 0;
  const badgeText = unread > 99 ? '99+' : String(unread);

  const wrapperStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
  };

  const badgeStyle: CSSProperties = {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    padding: '0 5px',
    borderRadius: 999,
    background: 'var(--danger)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid rgba(20, 20, 20, 0.85)',
    pointerEvents: 'none',
    boxSizing: 'content-box',
    lineHeight: 1,
  };

  return (
    <div style={wrapperStyle}>
      <button
        type="button"
        style={buttonStyle(variant, hovered)}
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-label={open ? 'Закрыть чат' : 'Открыть чат'}
        aria-pressed={open}
        title={open ? 'Закрыть чат' : 'Открыть чат'}
      >
        <ChatIcon />
      </button>
      {showBadge && (
        <span style={badgeStyle} aria-label={`Непрочитанных: ${unread}`}>
          {badgeText}
        </span>
      )}
    </div>
  );
}

export default function Controls({
  micOn,
  camOn,
  screenSharing,
  screenQuality,
  onToggleMic,
  onToggleCam,
  onToggleScreenShare,
  onChangeScreenQuality,
  onLeave,
  onCopyInvite,
  onSendReaction,
  chatOpen,
  unreadChat,
  onToggleChat,
  hidden = false,
}: Props) {
  const style: CSSProperties = hidden ? { ...barStyle, ...barHiddenStyle } : barStyle;
  return (
    <div style={style} role="toolbar" aria-label="Управление звонком" aria-hidden={hidden}>
      <CircleButton
        variant={micOn ? 'default' : 'off'}
        onClick={onToggleMic}
        pressed={!micOn}
        ariaLabel={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
      >
        <MicIcon off={!micOn} />
      </CircleButton>

      <CircleButton
        variant={camOn ? 'default' : 'off'}
        onClick={onToggleCam}
        pressed={!camOn}
        ariaLabel={camOn ? 'Выключить камеру' : 'Включить камеру'}
      >
        <CamIcon off={!camOn} />
      </CircleButton>

      {isScreenShareSupported() && (
        <ScreenShareControl
          active={screenSharing}
          quality={screenQuality}
          onToggle={onToggleScreenShare}
          onChangeQuality={onChangeScreenQuality}
        />
      )}

      <SmileButton onPick={onSendReaction} />

      <ChatButton open={chatOpen} unread={unreadChat} onClick={onToggleChat} />

      <CircleButton
        variant="default"
        onClick={onCopyInvite}
        ariaLabel="Скопировать ссылку-приглашение"
      >
        <CopyIcon />
      </CircleButton>

      <CircleButton
        variant="leave"
        onClick={onLeave}
        ariaLabel="Покинуть встречу"
      >
        <PhoneDownIcon />
      </CircleButton>
    </div>
  );
}
