// Корневой компонент. Простой ручной роутинг по window.location.pathname.
// `/`            → Landing
// `/m/<roomId>`  → Meeting
// иначе          → Landing (404 не нужен)
import { useEffect, useState } from 'react';
import Landing from './pages/Landing';
import Meeting from './pages/Meeting';

/**
 * Программная навигация. Меняет history + диспатчит popstate, чтобы App-роутинг
 * подхватил новый путь без перезагрузки.
 */
export function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function getPath(): string {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname || '/';
}

function parseRoomId(path: string): string | null {
  // /m/<roomId>; допускаем хвостовой слэш.
  const m = /^\/m\/([^/]+)\/?$/.exec(path);
  return m ? m[1]! : null;
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

  const roomId = parseRoomId(path);
  if (roomId) {
    return <Meeting roomId={roomId} />;
  }
  return <Landing />;
}
