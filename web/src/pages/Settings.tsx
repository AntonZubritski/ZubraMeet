// Settings — экран конфигурации cloud-провайдера для cloud-relay.
//
// Доступен только хосту (через localhost): сервер отдаст 403 на GET/POST
// /api/cloudconfig для гостей, и в этом случае мы показываем сообщение
// "Settings доступны только на машине хоста".
//
// Логика:
//   - GET /api/cloudconfig → подгружаем текущий конфиг + список providers/regions.
//   - POST /api/cloudconfig → сохраняем. Если apiToken пустой и hasToken=true,
//     сервер сохранит существующий токен (см. handlers.go).
//   - "Test connection" — тот же POST, но без save: т.к. server валидирует токен
//     ДО save, можем эту валидацию использовать как "test". Реально пишем "/api/cloudconfig"
//     с enabled=true и трактуем 200 как успех валидации.
//
// UI: dark theme, в стиле Landing/Meeting (CSS-переменные).
import {
  useEffect,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { navigate } from '../App';
import type {
  CloudConfigResp,
  CloudProviderInfo,
} from '../types';

const pageStyle: CSSProperties = {
  minHeight: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: '32px 16px 64px',
  gap: 16,
};

const containerStyle: CSSProperties = {
  width: '100%',
  maxWidth: 560,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const backBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--muted)',
  padding: '6px 12px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 600,
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  color: 'var(--muted)',
  fontSize: 14,
  lineHeight: 1.5,
};

const cardStyle: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
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
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--fg)',
  fontSize: 14,
  outline: 'none',
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: 'none',
};

const checkboxRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  color: 'var(--fg)',
  cursor: 'pointer',
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
};

const primaryBtnStyle: CSSProperties = {
  padding: '10px 18px',
  background: 'var(--accent)',
  color: '#0a0a0a',
  border: 'none',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryBtnStyle: CSSProperties = {
  padding: '10px 18px',
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};

const helperLinkStyle: CSSProperties = {
  color: 'var(--accent)',
  fontSize: 12,
  textDecoration: 'underline',
};

const messageStyle = (kind: 'ok' | 'err' | 'info'): CSSProperties => {
  const palette =
    kind === 'ok'
      ? { bg: 'rgba(34, 197, 94, 0.1)', border: 'rgba(34, 197, 94, 0.4)', color: 'var(--accent)' }
      : kind === 'err'
        ? { bg: 'rgba(239, 68, 68, 0.1)', border: 'rgba(239, 68, 68, 0.4)', color: 'var(--danger)' }
        : { bg: 'rgba(255, 200, 0, 0.08)', border: 'rgba(255, 200, 0, 0.3)', color: '#fbbf24' };
  return {
    padding: '10px 12px',
    background: palette.bg,
    border: `1px solid ${palette.border}`,
    color: palette.color,
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.5,
  };
};

function disabledOverride(disabled: boolean): CSSProperties {
  if (!disabled) return {};
  return { opacity: 0.5, cursor: 'not-allowed' };
}

interface UrlParams {
  prefilledProvider: string | null;
}

function readUrlParams(): UrlParams {
  if (typeof window === 'undefined') return { prefilledProvider: null };
  try {
    const url = new URL(window.location.href);
    return {
      prefilledProvider: url.searchParams.get('provider'),
    };
  } catch {
    return { prefilledProvider: null };
  }
}

export default function Settings() {
  const [loading, setLoading] = useState<boolean>(true);
  const [forbidden, setForbidden] = useState<boolean>(false);
  const [providers, setProviders] = useState<CloudProviderInfo[]>([]);
  const [provider, setProvider] = useState<string>('');
  const [region, setRegion] = useState<string>('');
  const [apiToken, setApiToken] = useState<string>('');
  const [hasSavedToken, setHasSavedToken] = useState<boolean>(false);
  const [enabled, setEnabled] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(
    null,
  );

  // Загрузка текущего конфига.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/cloudconfig');
        if (resp.status === 403) {
          if (!cancelled) setForbidden(true);
          return;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as CloudConfigResp;
        if (cancelled) return;
        setProviders(data.providers);
        setEnabled(data.enabled);
        setHasSavedToken(data.hasToken);
        // Предзаполняем provider: серверный → URL-параметр → первый из списка.
        const urlParams = readUrlParams();
        const initialProvider =
          data.provider ||
          urlParams.prefilledProvider ||
          (data.providers[0]?.id ?? '');
        setProvider(initialProvider);
        // Регион: серверный → первый из списка для выбранного провайдера.
        const initialRegions =
          data.providers.find((p) => p.id === initialProvider)?.regions ?? [];
        setRegion(data.region || initialRegions[0]?.code || '');
      } catch (err) {
        if (cancelled) return;
        const text = err instanceof Error ? err.message : String(err);
        setMessage({ kind: 'err', text: `Не удалось загрузить настройки: ${text}` });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentProviderInfo: CloudProviderInfo | undefined = providers.find(
    (p) => p.id === provider,
  );

  const handleProviderChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    const newId = e.target.value;
    setProvider(newId);
    // Сбрасываем регион на первый из нового провайдера.
    const next = providers.find((p) => p.id === newId);
    if (next && next.regions.length > 0) {
      setRegion(next.regions[0]!.code);
    }
  };

  const handleSubmit = async (e: FormEvent, withSave: boolean): Promise<void> => {
    e.preventDefault();
    if (saving || testing) return;
    setMessage(null);
    if (withSave) setSaving(true);
    else setTesting(true);

    // Если enabled=true, провайдер обязателен. Если нет — никаких требований.
    if (enabled && !provider) {
      setMessage({ kind: 'err', text: 'Выберите провайдера' });
      if (withSave) setSaving(false);
      else setTesting(false);
      return;
    }
    if (enabled && provider === 'hetzner' && !apiToken && !hasSavedToken) {
      setMessage({ kind: 'err', text: 'Введите API token' });
      if (withSave) setSaving(false);
      else setTesting(false);
      return;
    }

    try {
      const resp = await fetch('/api/cloudconfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiToken,
          region,
          enabled,
        }),
      });
      if (resp.status === 403) {
        setForbidden(true);
        return;
      }
      const data = (await resp.json()) as { error?: string; hasToken?: boolean };
      if (!resp.ok) {
        const text = data.error ?? `HTTP ${resp.status}`;
        setMessage({ kind: 'err', text });
        return;
      }
      // Успех. Если был передан apiToken — он теперь сохранён.
      if (typeof data.hasToken === 'boolean') {
        setHasSavedToken(data.hasToken);
      } else if (apiToken) {
        setHasSavedToken(true);
      }
      // Чистим input — токен уже сохранён, держать в DOM незачем.
      setApiToken('');
      setMessage({
        kind: 'ok',
        text: withSave ? 'Сохранено' : 'Подключение успешно',
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setMessage({ kind: 'err', text });
    } finally {
      if (withSave) setSaving(false);
      else setTesting(false);
    }
  };

  if (forbidden) {
    return (
      <div style={pageStyle}>
        <div style={containerStyle}>
          <h1 style={titleStyle}>Настройки</h1>
          <div style={messageStyle('info')}>
            Эта страница доступна только на машине хоста (через localhost).
          </div>
          <button type="button" style={secondaryBtnStyle} onClick={() => navigate('/')}>
            На главную
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={containerStyle}>
          <h1 style={titleStyle}>Настройки</h1>
          <p style={subtitleStyle}>Загрузка…</p>
        </div>
      </div>
    );
  }

  const tokenPlaceholder = hasSavedToken ? '••••••• (сохранён)' : 'hetzner_xxxx…';
  const isHetzner = provider === 'hetzner';

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <div style={headerRowStyle}>
          <button type="button" style={backBtnStyle} onClick={() => navigate('/')}>
            ← Назад
          </button>
          <h1 style={titleStyle}>Настройки</h1>
        </div>

        <p style={subtitleStyle}>
          Cloud-relay помогает обойти CGNAT провайдера: ZubraMeet поднимает
          временную VM в облаке, которая работает TURN-сервером для гостей из
          интернета. Всё происходит автоматически на твоём аккаунте облачного
          провайдера; счёт идёт напрямую тебе.
        </p>

        <form
          style={cardStyle}
          onSubmit={(e) => {
            void handleSubmit(e, true);
          }}
        >
          <label style={labelStyle}>
            Провайдер
            <select
              value={provider}
              onChange={handleProviderChange}
              style={selectStyle}
            >
              <option value="">— не выбран —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          {isHetzner && currentProviderInfo && (
            <>
              <label style={labelStyle}>
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span>API Token</span>
                  <a
                    href={currentProviderInfo.tokenUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={helperLinkStyle}
                  >
                    Где взять?
                  </a>
                </span>
                <input
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder={tokenPlaceholder}
                  autoComplete="off"
                  style={inputStyle}
                />
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Токен с правом read+write на Servers / SSH Keys / Networks.
                  Хранится в ~/.zubrameet/cloud.json (perm 0600).
                </span>
              </label>

              <label style={labelStyle}>
                Регион
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  style={selectStyle}
                >
                  {currentProviderInfo.regions.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </label>

              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {currentProviderInfo.estimateNote}
              </div>
            </>
          )}

          <label style={checkboxRowStyle}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Включить cloud-relay (можно стартовать VM из мита)
          </label>

          {message && <div style={messageStyle(message.kind)}>{message.text}</div>}

          <div style={buttonRowStyle}>
            <button
              type="submit"
              disabled={saving || testing}
              style={{ ...primaryBtnStyle, ...disabledOverride(saving || testing) }}
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
            {isHetzner && (
              <button
                type="button"
                disabled={saving || testing}
                style={{ ...secondaryBtnStyle, ...disabledOverride(saving || testing) }}
                onClick={(e) => {
                  // "Test connection" — те же поля, та же валидация на сервере.
                  // Поэтому реализуем через тот же POST.
                  void handleSubmit(e, false);
                }}
              >
                {testing ? 'Проверяю…' : 'Test connection'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
