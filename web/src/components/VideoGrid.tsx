import { useEffect, useState, type CSSProperties } from 'react';
import VideoTile from './VideoTile';

interface Tile {
  id: string;
  stream: MediaStream;
  name: string;
  isLocal?: boolean;
  micMuted?: boolean;
  camMuted?: boolean;
  isScreen?: boolean;
  isLocalScreen?: boolean;
}

interface Props {
  tiles: Tile[];
}

const baseGridStyle: CSSProperties = {
  display: 'grid',
  width: '100%',
  height: '100%',
  gap: 8,
  padding: 8,
  overflow: 'hidden',
  boxSizing: 'border-box',
};

const emptyStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
  color: 'var(--muted)',
  fontSize: 14,
};

// «Узкий» viewport — на мобильных телефон в портретной ориентации:
// миниатюры идут полосой снизу, а не справа.
const NARROW_BREAKPOINT_PX = 720;

// Размеры миниатюр в speaker-mode.
const THUMB_W = 180;
const THUMB_H = 100;

// Равная сетка для «обычного» режима (без screen-share).
function getEqualLayout(count: number): CSSProperties {
  if (count <= 1) {
    return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  }
  if (count === 2) {
    return { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: '1fr' };
  }
  if (count <= 4) {
    return {
      gridTemplateColumns: 'repeat(2, 1fr)',
      gridTemplateRows: 'repeat(2, 1fr)',
    };
  }
  if (count <= 9) {
    return {
      gridTemplateColumns: 'repeat(3, 1fr)',
      gridAutoRows: '1fr',
    };
  }
  return {
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gridAutoRows: 'minmax(160px, 1fr)',
  };
}

// Tile занимает всю ячейку грида целиком. Никакого aspectRatio тут — пусть
// видео внутри (object-fit: contain) масштабируется под доступное место.
// Это убирает скроллы при 1920×1080 камере на узком/коротком вьюпорте.
const equalCellStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
};

// useViewportNarrow — следит за window.innerWidth.
function useViewportNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < NARROW_BREAKPOINT_PX;
  });
  useEffect(() => {
    const onResize = (): void => {
      setNarrow(window.innerWidth < NARROW_BREAKPOINT_PX);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return narrow;
}

interface TileProps {
  tile: Tile;
}

function Tile({ tile }: TileProps) {
  return (
    <VideoTile
      stream={tile.stream}
      name={tile.name}
      isLocal={tile.isLocal}
      micMuted={tile.micMuted}
      camMuted={tile.camMuted}
      isScreen={tile.isScreen}
      isLocalScreen={tile.isLocalScreen}
      tileId={tile.id}
    />
  );
}

export default function VideoGrid({ tiles }: Props) {
  const narrow = useViewportNarrow();

  if (tiles.length === 0) {
    return <div style={emptyStyle}>Нет участников</div>;
  }

  const screenTiles = tiles.filter((t) => t.isScreen);
  const otherTiles = tiles.filter((t) => !t.isScreen);

  // === Обычный режим: равная сетка ===
  if (screenTiles.length === 0) {
    const style: CSSProperties = { ...baseGridStyle, ...getEqualLayout(tiles.length) };
    return (
      <div style={style}>
        {tiles.map((t) => (
          <div key={t.id} style={equalCellStyle}>
            <Tile tile={t} />
          </div>
        ))}
      </div>
    );
  }

  // === Speaker-режим: screen-share главный, остальные миниатюрами ===

  // Для основной зоны: горизонтальный flex со screen-tiles. Если их несколько —
  // делим равную ширину; aspectRatio 16:9 не задаём (контейнер расстягивается).
  const mainZoneStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'row',
    gap: 8,
    overflow: 'hidden',
  };

  // Каждый screen-tile во main-zone занимает свою долю.
  const screenTileWrapStyle: CSSProperties = {
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
  };

  // Боковая полоса миниатюр.
  const sidebarStyle: CSSProperties = narrow
    ? {
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'row',
        gap: 8,
        overflowX: 'auto',
        overflowY: 'hidden',
        padding: '4px 0',
      }
    : {
        flex: '0 0 auto',
        width: THUMB_W + 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '0 4px',
      };

  // Один thumb — 180×100 fixed, чтобы все одинаковые.
  const thumbStyle: CSSProperties = {
    flex: '0 0 auto',
    width: narrow ? THUMB_W : '100%',
    height: THUMB_H,
    position: 'relative',
  };

  // Корневой контейнер: main + sidebar (column на narrow, row на широких).
  const rootStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: narrow ? 'column' : 'row',
    gap: 8,
    padding: 8,
    overflow: 'hidden',
  };

  return (
    <div style={rootStyle}>
      <div style={mainZoneStyle}>
        {screenTiles.map((t) => (
          <div key={t.id} style={screenTileWrapStyle}>
            <Tile tile={t} />
          </div>
        ))}
      </div>
      {otherTiles.length > 0 && (
        <div style={sidebarStyle}>
          {otherTiles.map((t) => (
            <div key={t.id} style={thumbStyle}>
              <Tile tile={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
