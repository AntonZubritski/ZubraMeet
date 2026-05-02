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

const primaryBtnStyle: CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  background: 'var(--accent)',
  color: '#0a0a0a',
  border: 'none',
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
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

  // Подгружаем версию из /api/health.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/health');
        if (!resp.ok) return;
        const data = (await resp.json()) as { ok?: boolean; version?: string };
        if (!cancelled && typeof data.version === 'string') {
          setVersion(data.version);
        }
      } catch {
        /* молча игнорируем */
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

  const handleCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (createDisabled) return;
    setError(null);
    setCreating(true);
    try {
      const resp = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: trimmedName }),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as RoomCreateResp;
      if (!data || typeof data.id !== 'string' || data.id.length === 0) {
        throw new Error('Некорректный ответ сервера');
      }
      navigate(`/m/${data.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Не удалось создать мит: ${msg}`);
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = (e: FormEvent): void => {
    e.preventDefault();
    if (joinDisabled) return;
    navigate(`/m/${trimmedRoom}`);
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

        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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

          <button
            type="submit"
            disabled={createDisabled}
            style={{ ...primaryBtnStyle, ...disabledOverride(createDisabled) }}
          >
            {creating ? 'Создаём…' : 'Создать мит'}
          </button>
        </form>

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
      </div>

      <div style={footerStyle}>
        {version ? `v${version}` : ''}
      </div>
    </div>
  );
}
