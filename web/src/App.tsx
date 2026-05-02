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
}

function parseRoute(path: string): RouteMatch | null {
  // /p2p/<roomId> — принудительно P2P. Проверяем ПЕРВЫМ, чтобы не съел /m/.
  const p2p = /^\/p2p\/([^/]+)\/?$/.exec(path);
  if (p2p) return { roomId: p2p[1]!, mode: 'p2p' };
  // /m/<roomId> — auto-detect.
  const m = /^\/m\/([^/]+)\/?$/.exec(path);
  if (m) return { roomId: m[1]!, mode: 'auto' };
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
    return <Meeting roomId={route.roomId} mode={route.mode} />;
  }
  return <Landing />;
}
