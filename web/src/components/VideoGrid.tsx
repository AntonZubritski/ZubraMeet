import type { CSSProperties } from 'react';
import VideoTile from './VideoTile';

interface Tile {
  id: string;
  stream: MediaStream;
  name: string;
  isLocal?: boolean;
  micMuted?: boolean;
  camMuted?: boolean;
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
  overflow: 'auto',
  alignContent: 'start',
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

function getLayout(count: number): CSSProperties {
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

export default function VideoGrid({ tiles }: Props) {
  if (tiles.length === 0) {
    return <div style={emptyStyle}>Нет участников</div>;
  }

  const style: CSSProperties = { ...baseGridStyle, ...getLayout(tiles.length) };

  return (
    <div style={style}>
      {tiles.map((t) => (
        <VideoTile
          key={t.id}
          stream={t.stream}
          name={t.name}
          isLocal={t.isLocal}
          micMuted={t.micMuted}
          camMuted={t.camMuted}
        />
      ))}
    </div>
  );
}
