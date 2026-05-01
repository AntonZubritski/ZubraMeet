import { useEffect, useRef, type CSSProperties } from 'react';

interface Props {
  stream: MediaStream;
  name: string;
  isLocal?: boolean;
  micMuted?: boolean;
  camMuted?: boolean;
}

const tileStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '16 / 9',
  background: '#000',
  border: '1px solid var(--border)',
  borderRadius: 8,
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const videoStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  background: '#000',
};

const placeholderStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--panel)',
  color: 'var(--fg)',
  fontSize: 'clamp(32px, 6vw, 72px)',
  fontWeight: 600,
  textTransform: 'uppercase',
  userSelect: 'none',
};

const nameOverlayStyle: CSSProperties = {
  position: 'absolute',
  left: 8,
  bottom: 8,
  padding: '4px 8px',
  background: 'rgba(0, 0, 0, 0.55)',
  borderRadius: 4,
  color: 'var(--fg)',
  fontSize: 12,
  lineHeight: 1,
  maxWidth: 'calc(100% - 48px)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

const micOffStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.55)',
  borderRadius: '50%',
  color: 'var(--danger)',
};

function getInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // Берём первый кодпоинт, чтобы корректно работать с эмодзи и не-ASCII.
  const iter = trimmed[Symbol.iterator]();
  const first = iter.next().value as string | undefined;
  return (first ?? '?').toUpperCase();
}

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

export default function VideoTile({
  stream,
  name,
  isLocal = false,
  micMuted = false,
  camMuted = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
  }, [stream]);

  return (
    <div style={tileStyle}>
      {camMuted ? (
        <div style={placeholderStyle} aria-label={`Камера выключена: ${name}`}>
          {getInitial(name)}
        </div>
      ) : (
        <video
          ref={videoRef}
          style={videoStyle}
          autoPlay
          playsInline
          muted={isLocal || micMuted}
        />
      )}

      <div style={nameOverlayStyle} title={name}>
        {name}
        {isLocal ? ' (вы)' : ''}
      </div>

      {micMuted && (
        <div style={micOffStyle} title="Микрофон выключен" aria-label="Микрофон выключен">
          <MicOffIcon />
        </div>
      )}
    </div>
  );
}
