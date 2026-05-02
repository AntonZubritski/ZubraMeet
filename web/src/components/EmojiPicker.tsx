// Лёгкий emoji/GIF-picker без внешних зависимостей.
//
// Tabs:
//   [Эмодзи]  — статичная сетка 8×5 популярных emoji, инлайн (без сети).
//   [GIFs]    — поиск через Klipy API (см. lib/klipy.ts). Дебаунс 300ms.
//               При пустом query — показывает trending. Каждый клик —
//               broadcast одной гифки; picker НЕ закрывается (юзер может
//               кидать ещё). Для emoji — picker закрывается сразу.
//
// Lifecycle: clickoutside/Escape закрывает popover (родитель управляет
// open-state через onClose).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { searchGifs, trendingGifs, type KlipyGif } from '../lib/klipy';

interface Props {
  onSelectEmoji(emoji: string): void;
  // Если undefined — GIF-tab не показывается (back-compat / возможность
  // отключить в SFU-режиме при необходимости).
  onSelectGif?(url: string, width: number, height: number): void;
  // Стабильный per-user идентификатор для Klipy (требование их API). Должен
  // быть передан если onSelectGif задан; иначе игнорируется.
  customerId?: string;
  onClose(): void;
}

const EMOJIS: string[] = [
  '😀', '😂', '❤️', '👍', '👏', '🎉', '🔥', '💯', '🙏', '😍',
  '😎', '😭', '🤔', '😅', '🥺', '😴', '🤯', '🥳', '😱', '🙄',
  '🤣', '😉', '😋', '🤤', '😡', '🤬', '🥶', '🤡', '💩', '🚀',
  '✨', '⭐', '🎊', '🎁', '🍕', '☕', '🌹', '🦄', '🐶', '🐱',
];

type Tab = 'emoji' | 'gif';

const popoverStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  // Центрируем относительно кнопки (которая width:48). Picker шире — сдвигаем
  // влево чтобы не вылезал за правый край bar'а; right:0 удобнее левого
  // позиционирования, потому что smile-кнопка — не первая в bar'е.
  right: 0,
  width: 320,
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

const tabsRowStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: 2,
  background: 'rgba(255, 255, 255, 0.04)',
  borderRadius: 8,
};

function tabBtnStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '6px 8px',
    borderRadius: 6,
    border: 'none',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#0a0a0a' : 'var(--fg)',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    transition: 'background-color 100ms ease, color 100ms ease',
  };
}

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

const searchInputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'rgba(255, 255, 255, 0.04)',
  color: 'var(--fg)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const gifGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 4,
  // Жёсткий cap — иначе при 24 крупных гифках picker «уезжает» за viewport.
  maxHeight: 320,
  overflowY: 'auto',
  // Для тонкого скролла (без всех нативных артефактов).
  scrollbarWidth: 'thin',
};

const gifCellBtnStyle: CSSProperties = {
  border: 'none',
  background: 'rgba(255, 255, 255, 0.04)',
  borderRadius: 6,
  padding: 0,
  cursor: 'pointer',
  overflow: 'hidden',
  aspectRatio: '1 / 1',
  display: 'block',
  // Чтобы клик по картинке стрелял по button, а не по img.
  position: 'relative',
};

const gifThumbStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  pointerEvents: 'none',
};

const stateRowStyle: CSSProperties = {
  padding: '20px 8px',
  textAlign: 'center',
  fontSize: 12,
  color: 'var(--muted)',
};

const klipyAttrStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--muted)',
  textAlign: 'right',
  padding: '0 4px',
  opacity: 0.7,
};

export default function EmojiPicker({
  onSelectEmoji,
  onSelectGif,
  customerId,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Default 'emoji' — это исторический первый таб; GIF-таб только если
  // родитель прокинул onSelectGif (значит мы в P2P-режиме с поддержкой).
  const gifEnabled = typeof onSelectGif === 'function' && !!customerId;
  const [tab, setTab] = useState<Tab>('emoji');
  const [query, setQuery] = useState<string>('');
  const [gifs, setGifs] = useState<KlipyGif[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  // Чтобы старые in-flight запросы не перезатирали актуальный список,
  // если пользователь быстро меняет ввод.
  const abortRef = useRef<AbortController | null>(null);

  // clickoutside / Escape — единый listener для всего popover'а.
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

  // GIF-loading с дебаунсом 300ms. Срабатывает только когда tab === 'gif'.
  // На пустой query → trending; иначе → search. AbortController отменяет
  // предыдущий in-flight, чтобы поздний ответ старого запроса не перезатёр
  // свежий.
  useEffect(() => {
    if (tab !== 'gif' || !gifEnabled || !customerId) return;
    const q = query.trim();
    setLoading(true);
    const handle = window.setTimeout(() => {
      // Отменяем предыдущий запрос если ещё в полёте.
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          /* ignore */
        }
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const promise =
        q.length === 0
          ? trendingGifs(customerId, ctrl.signal)
          : searchGifs(q, customerId, ctrl.signal);
      void promise.then((list) => {
        // Если controller был abort'нут — игнорируем (новый запрос уже в полёте).
        if (ctrl.signal.aborted) return;
        setGifs(list);
        setLoading(false);
      });
    }, 300);
    return () => {
      window.clearTimeout(handle);
    };
  }, [tab, query, gifEnabled, customerId]);

  // При закрытии — abort остатков, не текут лишние fetch'и в фон.
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          /* ignore */
        }
        abortRef.current = null;
      }
    };
  }, []);

  const showGifTab = gifEnabled;
  const showAttribution = useMemo(() => tab === 'gif', [tab]);

  return (
    <div ref={containerRef} style={popoverStyle} role="dialog" aria-label="Выбрать реакцию">
      {showGifTab && (
        <div style={tabsRowStyle} role="tablist" aria-label="Тип реакции">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'emoji'}
            style={tabBtnStyle(tab === 'emoji')}
            onClick={() => setTab('emoji')}
          >
            <span aria-hidden="true">😀</span>
            <span>Эмодзи</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'gif'}
            style={tabBtnStyle(tab === 'gif')}
            onClick={() => setTab('gif')}
          >
            <span aria-hidden="true">🎬</span>
            <span>GIFs</span>
          </button>
        </div>
      )}

      {tab === 'emoji' && (
        <>
          <div style={headerStyle}>Реакция</div>
          <div style={gridStyle}>
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                style={emojiBtnStyle}
                onClick={() => onSelectEmoji(e)}
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
        </>
      )}

      {tab === 'gif' && showGifTab && (
        <>
          <input
            type="search"
            placeholder="Поиск гифок"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={searchInputStyle}
            aria-label="Поиск гифок"
            autoFocus
          />
          {loading && gifs.length === 0 && (
            <div style={stateRowStyle}>Загрузка…</div>
          )}
          {!loading && gifs.length === 0 && (
            <div style={stateRowStyle}>
              {query.trim().length > 0
                ? 'Ничего не найдено'
                : 'Нет популярных гифок'}
            </div>
          )}
          {gifs.length > 0 && (
            <div style={gifGridStyle}>
              {gifs.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  style={gifCellBtnStyle}
                  onClick={() => {
                    if (onSelectGif) {
                      onSelectGif(g.full, g.width, g.height);
                    }
                    // Намеренно НЕ закрываем picker — пользователь может
                    // отправить несколько гифок подряд. Закрытие — Esc или
                    // клик вне.
                  }}
                  aria-label={g.title.length > 0 ? `Отправить гифку: ${g.title}` : 'Отправить гифку'}
                  title={g.title}
                >
                  <img
                    src={g.preview}
                    alt=""
                    style={gifThumbStyle}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                </button>
              ))}
            </div>
          )}
          {showAttribution && (
            <div style={klipyAttrStyle} aria-hidden="true">
              powered by Klipy
            </div>
          )}
        </>
      )}
    </div>
  );
}
