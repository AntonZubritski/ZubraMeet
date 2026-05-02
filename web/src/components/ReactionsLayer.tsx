// Floating-emoji/GIF слой поверх всего mit'а. Получает массив активных реакций
// (id+emoji|url+sway) от родителя — родитель сам отвечает за добавление и
// удаление (через setTimeout 5s после прихода). Этот компонент чисто визуальный.
//
// Position: fixed inset:0, pointer-events: none — не блокирует клики на видео-
// тайлах и Controls. z-index 100 = выше gridContainer, ниже модалок (200).
import type { CSSProperties } from 'react';

// Максимальная ширина GIF на экране. На мобильных меньше viewport'а; на
// десктопе — выбираем чтобы не перекрывать пол-экрана крупным мемом.
const GIF_MAX_WIDTH = 160;

// Discriminated union — emoji vs gif. id всегда уникален (родитель генерирует
// uuid) — используется как React-key.
export type FloatingReaction =
  | {
      kind?: 'emoji';
      id: string;
      emoji: string;
      // Random horizontal start position, 10-90% (избегаем края, чтобы emoji не
      // обрезался viewport'ом).
      leftPct: number;
      // Random horizontal sway за время полёта (±50px). Прокидывается как CSS-var
      // в keyframe, чтобы каждый emoji сдвигался по-своему.
      swayPx: number;
    }
  | {
      kind: 'gif';
      id: string;
      url: string;
      // Натуральные размеры из API — нужны чтобы вычислить корректный
      // height при cap'е по width (сохранить aspect ratio).
      width: number;
      height: number;
      leftPct: number;
      swayPx: number;
    };

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

const emojiBaseStyle: CSSProperties = {
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

const gifBaseStyle: CSSProperties = {
  position: 'absolute',
  top: -120,
  willChange: 'transform, opacity',
  animation: 'zubrameet-reaction-fall 5s linear forwards',
  filter: 'drop-shadow(0 4px 12px rgba(0, 0, 0, 0.55))',
  userSelect: 'none',
  borderRadius: 8,
  // Защита от drag-n-drop на десктопе.
  pointerEvents: 'none',
  display: 'block',
};

export default function ReactionsLayer({ reactions }: Props) {
  return (
    <div style={layerStyle} aria-hidden="true">
      {reactions.map((r) => {
        // Discriminator: явный 'gif' → GIF; иначе emoji (включая legacy записи
        // без kind, которые гарантированно emoji потому что в state такие
        // создавались до миграции).
        if (r.kind === 'gif') {
          // Cap по width, height пропорционально. Если натуральная ширина
          // меньше cap'а — берём натуральную (не растягиваем мелкие гифки).
          const w = Math.min(GIF_MAX_WIDTH, r.width || GIF_MAX_WIDTH);
          const aspect = r.width > 0 && r.height > 0 ? r.height / r.width : 0.75;
          const h = Math.round(w * aspect);
          const style: CSSProperties = {
            ...gifBaseStyle,
            left: `${r.leftPct}%`,
            width: w,
            height: h,
            ['--sway' as string]: `${r.swayPx}px`,
          } as CSSProperties;
          return (
            <img
              key={r.id}
              src={r.url}
              style={style}
              alt=""
              decoding="async"
              loading="eager"
              draggable={false}
            />
          );
        }
        const style: CSSProperties = {
          ...emojiBaseStyle,
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
