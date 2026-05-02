// Правый чат-sidebar (overlay поверх grid'а). На десктопе — фиксированная
// карточка справа, не перекрывающая header (top:56) и Controls (bottom:100),
// с borderRadius:12 и усиленной тенью. На мобиле — bottom drawer 60vh
// с padding-bottom под Controls.
//
// Mount/unmount по chatOpen в Meeting.tsx; пока открыт — idle-таймер
// chrome'а отключён, так что панель не «уезжает» сама. prop `hidden` снят
// (см. историю — больше не нужен, мы управляем через mount/unmount).
//
// Список сообщений: автоскролл вниз при добавлении нового. URL в тексте
// автоматически превращаются в кликабельные ссылки.
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import Avatar from 'boring-avatars';
import EmojiPicker from './EmojiPicker';
const AVATAR_COLORS = ['#22c55e', '#06b6d4', '#fbbf24', '#ec4899', '#6366f1'];

const MOBILE_BREAKPOINT = 720;

// Локальный shape для UI — без index-signature (та нужна была только для
// Trystero JsonValue в lib/p2p.ts). Здесь её добавление мешало бы добавить
// boolean-поле `local` (TS жалуется на расширение string|number-сигнатуры).
export interface ChatPanelMessage {
  id: string;
  text: string;
  ts: number;
  fromName: string;
  // local=true → сообщение отправлено мной (peerId === 'self' в onChatMessage).
  // Влияет на выравнивание/цвет имени.
  local?: boolean;
}

interface Props {
  messages: ChatPanelMessage[];
  onSend(text: string): void;
  onClose(): void;
  // customerId прокидывается в EmojiPicker (опционально). Не используется
  // для emoji-only mode, но если родитель передал — будет использован
  // только для GIF-tab; здесь, в чат-picker'е, GIF-tab принципиально
  // отключён: чат — только текст и emoji.
  customerId?: string;
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });
  useEffect(() => {
    const onResize = (): void => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  } catch {
    return '';
  }
}

// Простая авто-линковка URL'ов. Регексп закрывает http(s)://, грубо ловит
// большинство ссылок без захвата трейлинговых знаков пунктуации.
const URL_REGEX = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/gi;

function renderTextWithLinks(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // Reset state — RegExp с флагом g сохраняет lastIndex между вызовами.
  URL_REGEX.lastIndex = 0;
  while ((m = URL_REGEX.exec(text)) !== null) {
    const url = m[0];
    const start = m.index;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }
    parts.push(
      <a
        key={`url-${start}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
      >
        {url}
      </a>,
    );
    lastIndex = start + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

export default function ChatPanel({ messages, onSend, onClose }: Props) {
  const isMobile = useIsMobile();
  const [input, setInput] = useState<string>('');
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll при добавлении нового сообщения. useLayoutEffect — чтобы
  // прокрутка случилась до paint'а (без визуального "прыжка").
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Esc внутри панели → закрыть. Только когда фокус на textarea (ниже
  // в onKeyDown) — здесь global-listener чтобы Esc работал даже если фокус
  // ушёл на body. Если открыт emoji-picker, его внутренний Escape-listener
  // обрабатывает раньше; здесь Esc закроет ВЕСЬ чат, так что pickerOpen
  // тоже сбрасываем сразу.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        if (pickerOpen) {
          setPickerOpen(false);
          return;
        }
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pickerOpen]);

  const handleSubmit = (): void => {
    const text = input.trim();
    if (text.length === 0) return;
    onSend(text);
    setInput('');
    // Возвращаем фокус в textarea для последовательного набора.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const handleKey = (ev: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      handleSubmit();
    }
  };

  // Вставка emoji в позицию каретки в textarea, без закрытия picker'а
  // (юзер может натыкать несколько подряд). После вставки — восстанавливаем
  // позицию каретки за вставленным символом.
  const insertAtCaret = (emoji: string): void => {
    const ta = textareaRef.current;
    if (!ta) {
      setInput((v) => v + emoji);
      return;
    }
    const start = ta.selectionStart ?? input.length;
    const end = ta.selectionEnd ?? input.length;
    const next = input.slice(0, start) + emoji + input.slice(end);
    setInput(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = start + emoji.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const containerStyle: CSSProperties = useMemo(() => {
    const base: CSSProperties = {
      position: 'fixed',
      background: 'var(--panel)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 50,
      transition: 'transform 250ms ease, opacity 250ms ease',
    };
    if (isMobile) {
      // Bottom drawer: 60% высоты, slideUp при открытии. С учётом safe-area
      // нижней (iOS home-indicator) + 80px чтобы не перекрывать Controls.
      return {
        ...base,
        left: 0,
        right: 0,
        bottom: 0,
        height: '60vh',
        maxHeight: '70dvh',
        borderTop: '1px solid var(--border)',
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 80px)',
        boxShadow: '0 -8px 24px rgba(0, 0, 0, 0.4)',
      };
    }
    // Desktop overlay-карточка: вписана между header (top 56) и Controls
    // (bottom ~100). Усиленная тень и скруглённые углы по всему периметру.
    return {
      ...base,
      right: 16,
      top: 56,
      bottom: 100,
      width: 320,
      maxHeight: 'calc(100dvh - 56px - 100px)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5)',
      overflow: 'hidden',
    };
  }, [isMobile]);

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  };

  const titleStyle: CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--fg)',
    flex: 1,
    margin: 0,
  };

  const closeBtnStyle: CSSProperties = {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--fg)',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  };

  const listStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '12px 12px 4px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  };

  const emptyStyle: CSSProperties = {
    textAlign: 'center',
    color: 'var(--muted)',
    fontSize: 12,
    padding: '24px 16px',
    lineHeight: 1.5,
  };

  // position:relative нужен чтобы абсолютно позиционированный picker
  // (bottom: calc(100% + 8px), right: 0) встал ОТНОСИТЕЛЬНО footer'а
  // и оказался прямо над smile-кнопкой.
  const footerStyle: CSSProperties = {
    display: 'flex',
    gap: 8,
    padding: 10,
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
    alignItems: 'flex-end',
    position: 'relative',
  };

  const emojiBtnStyle: CSSProperties = {
    width: 32,
    height: 32,
    flexShrink: 0,
    border: '1px solid var(--border)',
    background: pickerOpen ? 'var(--accent)' : 'var(--bg)',
    color: pickerOpen ? '#0a0a0a' : 'var(--fg)',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'background-color 120ms ease, color 120ms ease',
  };

  const textareaStyle: CSSProperties = {
    flex: 1,
    resize: 'none',
    minHeight: 36,
    maxHeight: 120,
    padding: '8px 10px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--fg)',
    fontSize: 13,
    lineHeight: 1.4,
    fontFamily: 'inherit',
    outline: 'none',
  };

  const sendBtnStyle: CSSProperties = {
    padding: '8px 14px',
    background: input.trim().length > 0 ? 'var(--accent)' : 'var(--panel)',
    border: '1px solid var(--border)',
    borderColor: input.trim().length > 0 ? 'var(--accent)' : 'var(--border)',
    color: input.trim().length > 0 ? '#0a0a0a' : 'var(--muted)',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: input.trim().length > 0 ? 'pointer' : 'not-allowed',
    transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease',
  };

  return (
    <aside
      style={containerStyle}
      role="complementary"
      aria-label="Чат встречи"
    >
      <div style={headerStyle}>
        <h2 style={titleStyle}>Чат</h2>
        <button
          type="button"
          style={closeBtnStyle}
          onClick={onClose}
          aria-label="Закрыть чат"
          title="Закрыть чат"
        >
          ×
        </button>
      </div>

      <div style={listStyle} ref={listRef}>
        {messages.length === 0 ? (
          <div style={emptyStyle}>
            Сообщений пока нет. Напишите что-нибудь, и все участники увидят это
            сразу.
          </div>
        ) : (
          messages.map((m) => {
            const time = formatTime(m.ts);
            const rowStyle: CSSProperties = {
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
            };
            const bubbleStyle: CSSProperties = {
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            };
            const metaStyle: CSSProperties = {
              display: 'flex',
              gap: 6,
              alignItems: 'baseline',
              fontSize: 11,
            };
            const nameStyle: CSSProperties = {
              fontWeight: 600,
              color: m.local ? 'var(--accent)' : 'var(--fg)',
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            };
            const tsStyle: CSSProperties = {
              color: 'var(--muted)',
              fontSize: 10,
            };
            const textStyle: CSSProperties = {
              fontSize: 13,
              lineHeight: 1.45,
              color: 'var(--fg)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            };
            return (
              <div key={m.id} style={rowStyle}>
                <span
                  style={{
                    flexShrink: 0,
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    overflow: 'hidden',
                    display: 'inline-block',
                  }}
                  aria-hidden="true"
                >
                  <Avatar
                    size={28}
                    name={m.fromName || '?'}
                    variant="beam"
                    colors={AVATAR_COLORS}
                  />
                </span>
                <div style={bubbleStyle}>
                  <div style={metaStyle}>
                    <span style={nameStyle} title={m.fromName}>
                      {m.fromName || 'Участник'}
                    </span>
                    <span style={tsStyle}>{time}</span>
                  </div>
                  <div style={textStyle}>{renderTextWithLinks(m.text)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={footerStyle}>
        {/* Emoji-picker над smile-кнопкой. closeOnSelect=false — клик
            по emoji вставляет его в textarea и оставляет picker открытым,
            чтобы можно было настукать несколько подряд. GIF-tab здесь не
            нужен (чат — текст + emoji), поэтому onSelectGif/customerId
            намеренно не прокинуты. */}
        {pickerOpen && (
          <EmojiPicker
            onSelectEmoji={(e) => {
              insertAtCaret(e);
            }}
            onClose={() => setPickerOpen(false)}
            closeOnSelect={false}
          />
        )}
        <button
          type="button"
          style={emojiBtnStyle}
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="Выбрать emoji"
          aria-expanded={pickerOpen}
          title="Эмодзи"
        >
          <span aria-hidden="true">😀</span>
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(ev) => setInput(ev.target.value)}
          onKeyDown={handleKey}
          placeholder="Сообщение… (Enter — отправить, Shift+Enter — новая строка)"
          style={textareaStyle}
          rows={1}
          maxLength={2000}
          aria-label="Текст сообщения"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={input.trim().length === 0}
          style={sendBtnStyle}
        >
          Отправить
        </button>
      </div>
    </aside>
  );
}
