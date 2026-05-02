// Берёт ИСХОДНУЮ иконку из scripts/favicon-source.svg, прогоняет через sharp с
// hue-rotate (зелёный -> жёлто-зелёный), и пишет:
//   public/favicon.svg              - SVG-обёртка с тем же исходным растром
//                                     внутри + SVG-фильтром recolor
//   public/favicon-96x96.png
//   public/favicon.ico              - копия 96px PNG (fallback)
//   public/apple-touch-icon.png     - 180px
//   public/web-app-manifest-192x192.png
//   public/web-app-manifest-512x512.png
//
// HUE_DEG/SAT_MULT/LIGHT_MULT — параметры тонировки. Подкручивай чтобы
// добиться нужного желто-зелёного оттенка.
//
// Запускать после правки исходника:
//   node scripts/gen-icons.mjs

import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const sourceSvgPath = join(here, 'favicon-source.svg');

// Тонировка под фирменные цвета ZubraMeet (#22c55e зелёный, #fbbf24 жёлтый).
// hue 60° сдвигает зелёный в жёлто-зелёный; saturation чуть выше для
// насыщенности; lightness 1 = без изменений яркости.
const HUE_DEG = 60;
const SAT_MULT = 1.4;
const LIGHT_MULT = 1.0;

const sourceSvg = await readFile(sourceSvgPath);

// Sharp читает SVG, рендерит в высоком разрешении (512), потом modulate
// меняет HSL. Дальше уже resize в нужный размер для каждого таргета.
async function recolored(size) {
  return sharp(sourceSvg, { density: 600 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .modulate({ hue: HUE_DEG, saturation: SAT_MULT, lightness: LIGHT_MULT })
    .png()
    .toBuffer();
}

const targets = [
  { name: 'favicon-96x96.png', size: 96 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'web-app-manifest-192x192.png', size: 192 },
  { name: 'web-app-manifest-512x512.png', size: 512 },
];

for (const t of targets) {
  const png = await recolored(t.size);
  await writeFile(join(publicDir, t.name), png);
  console.log(`OK ${t.name} (${png.length} bytes)`);
}

// favicon.ico — большинство браузеров принимают PNG-with-.ico-extension
// (формально это не multi-resolution ICO, но fallback работает).
await writeFile(join(publicDir, 'favicon.ico'), await recolored(96));
console.log('OK favicon.ico (PNG-as-ICO fallback)');

// Для favicon.svg обёртка с filter, чтобы современные браузеры тоже видели
// ту же тонировку без перерасчёта rasterа. feColorMatrix с hueRotate.
const wrapperSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 483 483">
  <defs>
    <filter id="zubrameet-recolor" x="0" y="0" width="100%" height="100%">
      <feColorMatrix type="hueRotate" values="${HUE_DEG}"/>
      <feColorMatrix type="matrix" values="
        ${SAT_MULT} 0 0 0 0
        0 ${SAT_MULT} 0 0 0
        0 0 ${SAT_MULT} 0 0
        0 0 0 1 0"/>
    </filter>
  </defs>
  <g filter="url(#zubrameet-recolor)">
    ${sourceSvg.toString().replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}
  </g>
</svg>
`;
await writeFile(join(publicDir, 'favicon.svg'), wrapperSvg);
console.log('OK favicon.svg (recolor wrapper)');
