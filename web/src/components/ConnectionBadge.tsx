import type { CSSProperties } from 'react';
import type { ConnectionStats } from '../types';

interface Props {
  stats: ConnectionStats | null;
}

type Quality = 'good' | 'mid' | 'bad';

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 999,
  color: 'var(--fg)',
  fontSize: 12,
  lineHeight: 1,
  userSelect: 'none',
};

const dotBaseStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
  display: 'inline-block',
};

function dotColor(q: Quality | null): string {
  if (q === 'good') return 'var(--accent)';
  if (q === 'mid') return '#f59e0b';
  if (q === 'bad') return 'var(--danger)';
  return 'var(--muted)';
}

function classify(s: ConnectionStats): Quality {
  if (s.outboundBitrateKbps > 1000 && s.rttMs < 100 && s.packetLossPct < 1) {
    return 'good';
  }
  if (s.outboundBitrateKbps < 200 || s.rttMs > 300 || s.packetLossPct > 5) {
    return 'bad';
  }
  return 'mid';
}

function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export default function ConnectionBadge({ stats }: Props) {
  if (!stats) {
    return (
      <span
        style={badgeStyle}
        title="Нет данных о соединении"
        aria-label="Качество соединения: нет данных"
      >
        <span
          style={{ ...dotBaseStyle, background: dotColor(null) }}
          aria-hidden="true"
        />
        <span style={{ color: 'var(--muted)' }}>—</span>
      </span>
    );
  }

  const q = classify(stats);
  const label = q === 'good' ? 'Хорошо' : q === 'bad' ? 'Плохо' : 'Средне';

  const title =
    `↑ ${fmt(stats.outboundBitrateKbps)} kbps · ` +
    `↓ ${fmt(stats.inboundBitrateKbps)} kbps · ` +
    `RTT ${fmt(stats.rttMs)} ms · ` +
    `loss ${fmt(stats.packetLossPct, 2)}%`;

  return (
    <span
      style={badgeStyle}
      title={title}
      aria-label={`Качество соединения: ${label}. ${title}`}
    >
      <span
        style={{ ...dotBaseStyle, background: dotColor(q) }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
}
