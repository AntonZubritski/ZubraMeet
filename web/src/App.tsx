// Корневой компонент. Простой ручной роутинг по window.location.pathname.
// `/`              → Landing
// `/settings`      → Settings (cloud-провайдер + relay)
// `/m/<roomId>`    → Meeting (mode='auto' — определяет SFU vs P2P через /api/mode)
// `/p2p/<roomId>`  → Meeting (mode='p2p' — принудительно P2P через Trystero/Nostr)
// иначе            → Landing (404 не нужен)
//
// На GitHub Pages base = "/ZubraMeet/", локально base = "/" (см. vite.config.ts).
// Все роуты ниже работают с относительным путём (БЕЗ base), а navigate() сама
// подставляет base перед history.pushState.
import { useEffect, useState } from 'react';
import Landing from './pages/Landing';
import Meeting from './pages/Meeting';
import Settings from './pages/Settings';

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '') || '';

/**
 * Программная навигация. Меняет history + диспатчит popstate, чтобы App-роутинг
 * подхватил новый путь без перезагрузки.
 *
 * path — относительный путь (`/`, `/m/ABC`, `/p2p/ABC`, `/settings`); base
 * подставляется автоматически.
 */
export function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  const target = path.startsWith('/') ? `${BASE}${path}` : `${BASE}/${path}`;
  window.history.pushState({}, '', target || '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Возвращает path относительно BASE_URL (с ведущим `/`). */
function getPath(): string {
  if (typeof window === 'undefined') return '/';
  let p = window.location.pathname || '/';
  if (BASE && p.startsWith(BASE)) {
    p = p.slice(BASE.length) || '/';
  }
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

interface RouteMatch {
  roomId: string;
  mode: 'auto' | 'p2p';
  // Pre-shared password из URL hash (всё после `#`). Hash в браузерах НЕ
  // отправляется на HTTP-сервер — только клиентский JS его видит. Используется
  // как pre-shared key для Trystero E2EE (signaling SDP/ICE + data-channel).
  password?: string;
}

function readHashPassword(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = window.location.hash.replace(/^#/, '');
  return raw.length > 0 ? raw : undefined;
}

// Нормализация roomId для Crockford base32: uppercase + замена символов
// похожих на цифры (I→1, L→1, O→0, U→V). Это спасает от ручного ввода с
// опечаткой и от случаев когда мессенджер делает auto-correct в URL.
function normalizeRoomId(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

function parseRoute(path: string): RouteMatch | null {
  const password = readHashPassword();
  // /p2p/<roomId> — принудительно P2P. Проверяем ПЕРВЫМ, чтобы не съел /m/.
  const p2p = /^\/p2p\/([^/]+)\/?$/.exec(path);
  if (p2p) {
    return { roomId: normalizeRoomId(p2p[1]!), mode: 'p2p', password };
  }
  // /m/<roomId> — auto-detect. Hash также пробрасываем (на случай если /api/mode
  // вернёт p2p — пароль уже будет под рукой).
  const m = /^\/m\/([^/]+)\/?$/.exec(path);
  if (m) {
    return { roomId: normalizeRoomId(m[1]!), mode: 'auto', password };
  }
  return null;
}

export default function App() {
  const [path, setPath] = useState<string>(() => getPath());

  useEffect(() => {
    const onPop = (): void => {
      setPath(getPath());
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  if (path === '/settings' || path === '/settings/') {
    return <Settings />;
  }
  const route = parseRoute(path);
  if (route) {
    return (
      <Meeting
        roomId={route.roomId}
        mode={route.mode}
        password={route.password}
      />
    );
  }
  return <Landing />;
}
