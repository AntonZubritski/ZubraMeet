// Floating-emoji слой поверх всего mit'а. Получает массив активных реакций
// (id+emoji+sway) от родителя — родитель сам отвечает за добавление и удаление
// (через setTimeout 5s после прихода). Этот компонент чисто визуальный.
//
// Position: fixed inset:0, pointer-events: none — не блокирует клики на видео-
// тайлах и Controls. z-index 100 = выше gridContainer, ниже модалок (200).
import type { CSSProperties } from 'react';

export interface FloatingReaction {
  id: string;
  emoji: string;
  // Random horizontal start position, 10-90% (избегаем края, чтобы emoji не
  // обрезался viewport'ом).
  leftPct: number;
  // Random horizontal sway за время полёта (±50px). Прокидываем как CSS-var
  // в keyframe, чтобы каждый emoji сдвигался по-своему.
  swayPx: number;
}

interface Props {
  reactions: FloatingReaction[];
}

const layerStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  overflow: 'hidden',
  zIndex: 100,
};

const itemBaseStyle: CSSProperties = {
  position: 'absolute',
  top: -60,
  fontSize: 48,
  lineHeight: 1,
  willChange: 'transform, opacity',
  // 5s — соответствует zubrameet-reaction-fall в styles.css.
  animation: 'zubrameet-reaction-fall 5s linear forwards',
  // Лёгкая тень — чтобы emoji читался и на светлых video-кадрах.
  filter: 'drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45))',
  userSelect: 'none',
};

export default function ReactionsLayer({ reactions }: Props) {
  return (
    <div style={layerStyle} aria-hidden="true">
      {reactions.map((r) => {
        const style: CSSProperties = {
          ...itemBaseStyle,
          left: `${r.leftPct}%`,
          // CSS-var потребляется в keyframe: translateX(var(--sway)).
          // TS не знает про '--sway' в CSSProperties, поэтому индексим через
          // any-cast — стандартный приём для custom-properties.
          ['--sway' as string]: `${r.swayPx}px`,
        } as CSSProperties;
        return (
          <span key={r.id} style={style}>
            {r.emoji}
          </span>
        );
      })}
    </div>
  );
}
