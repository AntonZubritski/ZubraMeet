import { useState, type CSSProperties, type ReactNode } from 'react';

interface Props {
  micOn: boolean;
  camOn: boolean;
  onToggleMic(): void;
  onToggleCam(): void;
  onLeave(): void;
  onCopyInvite(): void;
}

const ICON_SIZE = 20;

const barStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
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
};

type Variant = 'default' | 'off' | 'leave';

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

export default function Controls({
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  onLeave,
  onCopyInvite,
}: Props) {
  return (
    <div style={barStyle} role="toolbar" aria-label="Управление звонком">
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
