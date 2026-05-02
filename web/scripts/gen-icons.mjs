// Регенерирует растровые иконки (PNG) из public/favicon.svg.
// Запускать вручную после изменения favicon.svg:
//   node scripts/gen-icons.mjs
//
// favicon.ico оставляем старый — браузеры умеют свежий favicon.svg, а
// fallback на ico всё равно остаётся работоспособным.

import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

const svgBuf = await readFile(join(publicDir, 'favicon.svg'));

const tasks = [
  { name: 'favicon-96x96.png', size: 96 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'web-app-manifest-192x192.png', size: 192 },
  { name: 'web-app-manifest-512x512.png', size: 512 },
];

for (const t of tasks) {
  const png = await sharp(svgBuf).resize(t.size, t.size).png().toBuffer();
  await writeFile(join(publicDir, t.name), png);
  console.log(`✓ ${t.name} (${png.length} bytes)`);
}

console.log('Готово. Не забудь обновить favicon.ico вручную (https://realfavicongenerator.net) если важен fallback в старых браузерах.');
