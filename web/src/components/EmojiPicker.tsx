// Лёгкий emoji-picker без внешних зависимостей. Сетка из ~40 популярных
// emoji + placeholder-строка про GIF (Tenor API будет позже). Закрывается по
// клику вне или Escape — обрабатывается родителем (см. Controls.tsx),
// потому что popover часто живёт внутри собственного позиционирующего
// контейнера, и вешать там document-listener двойственно.
import { useEffect, useRef, type CSSProperties } from 'react';

interface Props {
  onPick(emoji: string): void;
  onClose(): void;
}

const EMOJIS: string[] = [
  '😀', '😂', '❤️', '👍', '👏', '🎉', '🔥', '💯', '🙏', '😍',
  '😎', '😭', '🤔', '😅', '🥺', '😴', '🤯', '🥳', '😱', '🙄',
  '🤣', '😉', '😋', '🤤', '😡', '🤬', '🥶', '🤡', '💩', '🚀',
  '✨', '⭐', '🎊', '🎁', '🍕', '☕', '🌹', '🦄', '🐶', '🐱',
];

const popoverStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  // Центрируем относительно кнопки (которая width:48). Picker шире — сдвигаем
  // влево чтобы не вылезал за правый край bar'а; right:0 удобнее левого
  // позиционирования, потому что smile-кнопка — не первая в bar'е.
  right: 0,
  width: 280,
  background: 'rgba(20, 20, 20, 0.97)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  zIndex: 110,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
};

const headerStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--muted)',
  padding: '2px 4px',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(8, 1fr)',
  gap: 2,
};

const emojiBtnStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '1 / 1',
  border: 'none',
  background: 'transparent',
  fontSize: 22,
  cursor: 'pointer',
  borderRadius: 6,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background-color 100ms ease',
};

const gifPlaceholderStyle: CSSProperties = {
  marginTop: 4,
  padding: '8px 10px',
  background: 'rgba(255, 255, 255, 0.04)',
  border: '1px dashed var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--muted)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

export default function EmojiPicker({ onPick, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (ev: MouseEvent | TouchEvent): void => {
      const root = containerRef.current;
      if (!root) return;
      const target = ev.target as Node | null;
      if (target && root.contains(target)) return;
      onClose();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={containerRef} style={popoverStyle} role="dialog" aria-label="Выбрать emoji">
      <div style={headerStyle}>Реакция</div>
      <div style={gridStyle}>
        {EMOJIS.map((e) => (
          <button
            key={e}
            type="button"
            style={emojiBtnStyle}
            onClick={() => onPick(e)}
            onMouseEnter={(ev) => {
              (ev.currentTarget as HTMLButtonElement).style.background =
                'rgba(255, 255, 255, 0.08)';
            }}
            onMouseLeave={(ev) => {
              (ev.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
            aria-label={`Реакция ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
      <div style={gifPlaceholderStyle} aria-hidden="true">
        <span>🎞</span>
        <span>Гифки скоро через Tenor API</span>
      </div>
    </div>
  );
}
