// Лендинг: ввод имени, создание новой комнаты или вход в существующую по ID.
import {
  useEffect,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { navigate } from '../App';
import type { RoomCreateResp } from '../types';

const NAME_KEY = 'zubrameet.name';

// Crockford base32 без I/L/O/U — совпадает с server-side internal/room.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// 16 символов Crockford base32 = 80 бит энтропии, 32^16 ≈ 1.2×10^24 комбинаций.
// Защищает от brute-force через Nostr-relays (там видно roomId активных комнат).
const ROOM_ID_LEN = 16;

// 22 символа Crockford base32 = 110 бит — равноценно UUIDv4. Передаётся в URL hash.
const PASSWORD_LEN = 22;

// Сэмплер crypto-рандомных Crockford-символов с rejection sampling, чтобы
// распределение было строго равномерным (256 % 32 == 0, поэтому достаточно
// просто бит-маски 0x1F — но на всякий случай делаем явно).
function generateCrockford(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    // 0x1F = 31 — старшие 3 бита отбрасываем; нижние 5 бит идеально мапятся в алфавит из 32.
    out += CROCKFORD_ALPHABET[bytes[i]! & 0x1f];
  }
  return out;
}

function generateRoomId(): string {
  return generateCrockford(ROOM_ID_LEN);
}

function generatePassword(): string {
  return generateCrockford(PASSWORD_LEN);
}

const pageStyle: CSSProperties = {
  minHeight: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px 16px',
  gap: 16,
};

const containerStyle: CSSProperties = {
  width: '100%',
  maxWidth: 400,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(36px, 6vw, 56px)',
  fontWeight: 700,
  letterSpacing: -0.5,
  textAlign: 'center',
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  color: 'var(--muted)',
  fontSize: 16,
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  color: 'var(--muted)',
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--fg)',
  fontSize: 15,
  outline: 'none',
};

// Стиль для выбора режима — две карточки (CF / P2P) рядом друг с другом.
// На узких экранах схлопывается в колонку через flex-wrap.
const modeCardsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
};

const modeCardBaseStyle: CSSProperties = {
  flex: '1 1 160px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '14px 14px 12px',
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  textAlign: 'left',
  cursor: 'pointer',
  color: 'var(--fg)',
  fontFamily: 'inherit',
  transition: 'border-color 120ms, background 120ms',
};

const modeCardTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: 0.2,
};

const modeCardDescStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  color: 'var(--muted)',
};

const modeCardBadgeStyle: CSSProperties = {
  // marginTop: 'auto' прижимает badge к низу карточки независимо от того,
  // насколько длинное описание выше. Без этого CF-карта с 4 строками
  // описания и P2P-карта с 5 строками показывали бы badges на разной
  // высоте — выглядело криво.
  marginTop: 'auto',
  paddingTop: 8,
  alignSelf: 'flex-start',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--muted)',
};

// Внутренний span бэйджа — отдельная подложка с padding'ом и border-radius,
// чтобы paddingTop у самого badge'а не влиял на размер цветной плашки.
const modeCardBadgePillStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.06)',
};

const secondaryBtnStyle: CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  background: 'var(--panel)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 500,
  cursor: 'pointer',
};

const dividerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  color: 'var(--muted)',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const dividerLineStyle: CSSProperties = {
  flex: 1,
  height: 1,
  background: 'var(--border)',
};

const errorStyle: CSSProperties = {
  padding: '8px 12px',
  background: 'rgba(239, 68, 68, 0.1)',
  border: '1px solid rgba(239, 68, 68, 0.4)',
  color: 'var(--danger)',
  borderRadius: 8,
  fontSize: 13,
};

const footerStyle: CSSProperties = {
  marginTop: 24,
  fontSize: 11,
  color: 'var(--muted)',
  textAlign: 'center',
};

const settingsLinkStyle: CSSProperties = {
  position: 'fixed',
  top: 12,
  right: 16,
  fontSize: 12,
  color: 'var(--muted)',
  textDecoration: 'none',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: 4,
};

function disabledOverride(disabled: boolean): CSSProperties {
  if (!disabled) return {};
  return { opacity: 0.5, cursor: 'not-allowed' };
}

export default function Landing() {
  const [name, setName] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return window.localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [roomId, setRoomId] = useState<string>('');
  const [creating, setCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  // serverless = страница хостится без своего ZubraMeet-бэка (например, GitHub Pages).
  // В этом режиме все миты идут через P2P (/p2p/<id>), без /api/rooms.
  const [serverless, setServerless] = useState<boolean | null>(null);

  // Подгружаем версию из /api/health и заодно детектим serverless-mode.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/health');
        if (cancelled) return;
        if (!resp.ok) {
          setServerless(true);
          return;
        }
        setServerless(false);
        const data = (await resp.json()) as { ok?: boolean; version?: string };
        if (typeof data.version === 'string') {
          setVersion(data.version);
        }
      } catch {
        if (!cancelled) setServerless(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onNameChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const v = e.target.value;
    setName(v);
    try {
      window.localStorage.setItem(NAME_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const onRoomChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setRoomId(e.target.value.toUpperCase());
  };

  const trimmedName = name.trim();
  const trimmedRoom = roomId.trim();

  const createDisabled = creating || trimmedName.length === 0;
  // По ТЗ: "disabled если roomId пустой и name пустой" — но для входа имя тоже нужно.
  // Трактуем как: блокируем, если хоть одно поле пустое.
  const joinDisabled = trimmedRoom.length === 0 || trimmedName.length === 0;

  // Помечаем roomId как «свежесозданный нами» чтобы Meeting сразу присоединил
  // без pre-join screen. Pre-join нужен только гостям по invite-ссылке.
  const markAutoJoin = (id: string): void => {
    try {
      window.sessionStorage.setItem('zubrameet.autojoin', id);
    } catch {
      /* sessionStorage может быть отключён — не критично */
    }
  };

  // Создаёт CF SFU мит. CF Realtime SFU работает в любых сетях (cross-country,
  // CGNAT), но требует доступа к Cloudflare — там где CF блокируется на сетевом
  // уровне (РФ, Иран), мит не поднимется. Используется по умолчанию — это
  // надёжный вариант для большинства гостей.
  const handleCreateCF = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (createDisabled) return;
    setError(null);
    setCreating(true);
    try {
      // Serverless (GitHub Pages) — без своего бэка, генерим roomId локально.
      // CF Realtime sessions сам создаст браузер прямо у CF API при start'е мита.
      if (serverless) {
        const id = generateRoomId();
        markAutoJoin(id);
        navigate(`/m/${id}`);
        return;
      }
      const resp = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: trimmedName }),
      });
      if (!resp.ok) {
        // /api/rooms может быть отключён даже на «серверном» билде — генерим локально.
        if (resp.status === 405 || resp.status === 404) {
          const id = generateRoomId();
          markAutoJoin(id);
          navigate(`/m/${id}`);
          return;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as RoomCreateResp;
      if (!data || typeof data.id !== 'string' || data.id.length === 0) {
        throw new Error('Некорректный ответ сервера');
      }
      markAutoJoin(data.id);
      navigate(`/m/${data.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Не удалось создать мит: ${msg}`);
    } finally {
      setCreating(false);
    }
  };

  // Создаёт P2P мит через Trystero/MQTT. Прямые соединения между браузерами,
  // никакого Cloudflare. Работает там где CF заблокирован, бесплатно навсегда —
  // НО только если NAT'ы пробиваются: внутри одной страны почти всегда ОК,
  // cross-country часто не пробивается (нужен TURN-сервер которого у нас в
  // P2P-режиме нет).
  const handleCreateP2P = (e: FormEvent): void => {
    e.preventDefault();
    if (createDisabled) return;
    setError(null);
    const id = generateRoomId();
    const pw = generatePassword();
    markAutoJoin(id);
    navigate(`/p2p/${id}#${pw}`);
  };

  const handleJoin = (e: FormEvent): void => {
    e.preventDefault();
    if (joinDisabled) return;
    // Без password в hash — для зашифрованного мита нужно открывать invite-ссылку
    // целиком (там пароль в #). Ручной ввод roomId = legacy unencrypted mode.
    navigate(serverless ? `/p2p/${trimmedRoom}` : `/m/${trimmedRoom}`);
  };

  return (
    <div style={pageStyle}>
      <button
        type="button"
        style={settingsLinkStyle}
        onClick={() => navigate('/settings')}
        title="Настройки cloud-провайдера"
      >
        ⚙ Настройки
      </button>
      <div style={containerStyle}>
        <h1 style={titleStyle}>ZubraMeet</h1>
        <p style={subtitleStyle}>Видеоконференции, где ты сам сервер</p>

        {error && <div style={errorStyle} role="alert">{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={labelStyle}>
            Ваше имя
            <input
              type="text"
              value={name}
              onChange={onNameChange}
              placeholder="Как вас представить"
              autoComplete="nickname"
              style={inputStyle}
              maxLength={64}
            />
          </label>

          <div style={modeCardsStyle}>
            <button
              type="button"
              disabled={createDisabled}
              onClick={(e) => void handleCreateCF(e)}
              style={{
                ...modeCardBaseStyle,
                borderColor: 'var(--accent)',
                ...disabledOverride(createDisabled),
              }}
              title="Cloudflare Realtime SFU — медиа через CF edge"
            >
              <span style={modeCardTitleStyle}>Создать через CF</span>
              <span style={modeCardDescStyle}>
                Через Cloudflare. Работает в любой сети, в т.ч. cross-country и за CGNAT. Не работает где CF заблокирован.
              </span>
              <span style={modeCardBadgeStyle}>
                <span style={modeCardBadgePillStyle}>
                  {creating ? 'Создаём…' : 'По умолчанию'}
                </span>
              </span>
            </button>

            <button
              type="button"
              disabled={createDisabled}
              onClick={(e) => handleCreateP2P(e)}
              style={{ ...modeCardBaseStyle, ...disabledOverride(createDisabled) }}
              title="Прямые соединения между браузерами, без Cloudflare"
            >
              <span style={modeCardTitleStyle}>Создать через P2P</span>
              <span style={modeCardDescStyle}>
                Прямое соединение между браузерами. Бесплатно, без CF. Только если NAT пробивается — обычно внутри одной страны.
              </span>
              <span style={modeCardBadgeStyle}>
                <span style={modeCardBadgePillStyle}>E2EE</span>
              </span>
            </button>
          </div>
        </div>

        <div style={dividerStyle}>
          <span style={dividerLineStyle} aria-hidden="true" />
          <span>или</span>
          <span style={dividerLineStyle} aria-hidden="true" />
        </div>

        <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={labelStyle}>
            ID мита
            <input
              type="text"
              value={roomId}
              onChange={onRoomChange}
              placeholder="ABC12XYZ"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              style={{ ...inputStyle, textTransform: 'uppercase', letterSpacing: 1 }}
              maxLength={32}
            />
          </label>

          <button
            type="submit"
            disabled={joinDisabled}
            style={{ ...secondaryBtnStyle, ...disabledOverride(joinDisabled) }}
          >
            Войти
          </button>
        </form>

        <button
          type="button"
          onClick={() => navigate('/settings')}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--muted)',
            padding: '10px 12px',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 13,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Настройки
        </button>
      </div>

      <div style={footerStyle}>
        {version ? `v${version}` : ''}
      </div>
    </div>
  );
}
