// Берёт исходную иконку из scripts/favicon-source.svg и генерит adaptive
// набор:
//   public/favicon.svg              - SVG с встроенным @media prefers-color-scheme:
//                                     тёмная иконка на светлом фоне ОС, белая
//                                     иконка на тёмном фоне ОС.
//   public/favicon-light.png        - чёрный силуэт (для светлой темы ОС)
//   public/favicon-dark.png         - белый силуэт (для тёмной темы ОС)
//   public/favicon.ico              - копия light PNG (fallback)
//   public/apple-touch-icon.png     - 180px белый (iOS обычно использует на тёмной home-screen)
//   public/web-app-manifest-192x192.png  - белый (PWA на тёмном theme-color #0a0a0a)
//   public/web-app-manifest-512x512.png  - белый
//
// index.html подключает favicon.svg + два PNG с media-query:
//   <link rel="icon" type="image/svg+xml" href="favicon.svg">
//   <link rel="icon" type="image/png" sizes="96x96" href="favicon-light.png" media="(prefers-color-scheme: light)">
//   <link rel="icon" type="image/png" sizes="96x96" href="favicon-dark.png" media="(prefers-color-scheme: dark)">
//
// Запускать после правки favicon-source.svg:
//   node scripts/gen-icons.mjs

import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const sourceSvgPath = join(here, 'favicon-source.svg');

const sourceSvg = await readFile(sourceSvgPath);

// Превращаем растровое изображение из source в монохромный силуэт нужного
// цвета. Через feColorMatrix: RGB заменяем на константу r/g/b, A берём из
// исходника. Sharp умеет применять linear (для grayscale->color),
// но проще через recolor pipeline: extract alpha, multiply by tint.
//
// monochrome = 1 (белый) или 0 (чёрный) или конкретный цвет.
async function monochrome(size, color) {
  // 1. Рендерим SVG в RGBA-raster нужного размера (alpha уже там — фон
  //    исходника прозрачный, см. метаданные ZuTeem source).
  const rendered = await sharp(sourceSvg, { density: 600 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer();

  // 2. Извлекаем alpha как 1-канальное grayscale изображение (raw),
  //    которое потом приложим к solid-color rectangle через dest-in.
  const alphaRaw = await sharp(rendered)
    .extractChannel('alpha')
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 3. Создаём solid-RGB прямоугольник (без alpha-канала).
  //    joinChannel добавит наш alpha-канал → получится RGBA силуэт.
  const tinted = await sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: color.r, g: color.g, b: color.b },
    },
  })
    .joinChannel(alphaRaw.data, {
      raw: {
        width: alphaRaw.info.width,
        height: alphaRaw.info.height,
        channels: 1,
      },
    })
    .png()
    .toBuffer();

  return tinted;
}

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

// Раздельные light/dark PNG-наборы.
const lightPng96 = await monochrome(96, BLACK);
await writeFile(join(publicDir, 'favicon-light.png'), lightPng96);
console.log('OK favicon-light.png');

const darkPng96 = await monochrome(96, WHITE);
await writeFile(join(publicDir, 'favicon-dark.png'), darkPng96);
console.log('OK favicon-dark.png');

// favicon.ico — fallback. Берём light (чёрная иконка) — большинство юзеров
// в ОС светлая тема + .ico всё равно перетирается современным svg на
// браузерах поддерживающих SVG.
await writeFile(join(publicDir, 'favicon.ico'), lightPng96);
console.log('OK favicon.ico (light fallback)');

// apple-touch-icon: iOS показывает на home-screen, обычно с цветным фоном
// (theme_color из manifest = #0a0a0a). Используем БЕЛУЮ иконку.
const apple = await monochrome(180, WHITE);
await writeFile(join(publicDir, 'apple-touch-icon.png'), apple);
console.log('OK apple-touch-icon.png');

// web-app-manifest: PWA на dark background. БЕЛАЯ иконка.
for (const size of [192, 512]) {
  const png = await monochrome(size, WHITE);
  await writeFile(join(publicDir, `web-app-manifest-${size}x${size}.png`), png);
  console.log(`OK web-app-manifest-${size}x${size}.png`);
}

// favicon.svg — БЕЛЫЙ по умолчанию.
//
// Почему не adaptive внутри SVG: Brave/Chrome кешируют первый рендер SVG
// favicon и не применяют CSS @media prefers-color-scheme при смене темы.
// На dark вкладках Brave наш чёрный SVG выглядел тёмно-серым.
//
// Делаем железно: SVG = белый (хорошо виден на dark вкладках). На light
// темах браузер подхватит favicon-light.png через media-query в <link>
// (см. index.html).
const inner = sourceSvg.toString();
const m = inner.match(/(data:image\/png;base64,[A-Za-z0-9+/=]+)/);
if (!m) {
  throw new Error('Не нашёл base64 PNG в favicon-source.svg');
}
const dataUri = m[1];

const whiteSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 483 483">
  <defs>
    <mask id="silhouette" maskContentUnits="userSpaceOnUse" maskUnits="userSpaceOnUse">
      <image x="0" y="0" width="483" height="483" href="${dataUri}"/>
    </mask>
  </defs>
  <rect width="483" height="483" fill="#ffffff" mask="url(#silhouette)"/>
</svg>
`;
await writeFile(join(publicDir, 'favicon.svg'), whiteSvg);
console.log('OK favicon.svg (white default)');
