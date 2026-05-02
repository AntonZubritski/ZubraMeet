// Klipy — публичный GIF-провайдер (https://klipy.com), аналог Tenor/GIPHY,
// но с более либеральной политикой. API-ключ public по дизайну (rate-limit
// идёт по IP клиента, не по ключу). Override через VITE_KLIPY_API_KEY если
// форкаете проект.
//
// Endpoints (документация: https://docs.klipy.com / partner.klipy.com/api-keys):
//   GET https://api.klipy.com/api/v1/<KEY>/gifs/search?q=<q>&customer_id=<id>&per_page=24&page=1
//   GET https://api.klipy.com/api/v1/<KEY>/gifs/trending?customer_id=<id>&per_page=24&page=1
//
// customer_id — стабильный per-user идентификатор, нужен Klipy для analytics
// и персонализации (формальное требование API). В нашем случае генерируем
// uuid и держим в localStorage.
//
// Парсер ниже намеренно ТОЛЕРАНТНЫЙ: пробуем несколько типичных shape'ов
// (Klipy, Tenor v2, Giphy), потому что точная форма ответа Klipy менялась
// и местами не очевидна из их доков. Для дебага оставлен `console.debug`
// с первыми 500 символами JSON — поможет если структура снова изменится.

const DEFAULT_KEY = 'HxXRXNF0S8aMrKVqgooD4BGpkER9E7XQtWjQBZnySARNFEhEklavGu6ATiuWcvxo';
const ENV_KEY = (import.meta.env.VITE_KLIPY_API_KEY as string | undefined) ?? '';
const API_KEY = ENV_KEY.length > 0 ? ENV_KEY : DEFAULT_KEY;
const BASE = `https://api.klipy.com/api/v1/${API_KEY}/gifs`;

const PER_PAGE = 24;

// Нормализованный наш формат — ровно то что нужно UI/broadcast'у.
export interface KlipyGif {
  id: string;
  title: string;
  // URL для маленького thumbnail в picker'е (xs/sd).
  preview: string;
  // URL для broadcast'а: показывается в анимации fall-down. Берём sd для
  // компромисса между качеством и весом (~200-500 KB вместо 2-5 MB у HD).
  full: string;
  width: number;
  height: number;
}

// Ищем массив с гифками в типичных shape'ах ответа разных GIF-API.
// Klipy исторически клал в data.data; некоторые версии — просто data;
// Tenor v2 — results; Giphy — data (массив).
function extractItems(json: unknown): unknown[] {
  if (json === null || typeof json !== 'object') return [];
  const j = json as Record<string, unknown>;
  // 1) Klipy: { result: true, data: { data: [...] } }
  const dataObj = j.data;
  if (dataObj !== null && typeof dataObj === 'object') {
    const d = dataObj as Record<string, unknown>;
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.results)) return d.results;
  }
  // 2) Klipy alt / Giphy: { data: [...] }
  if (Array.isArray(j.data)) return j.data;
  // 3) Tenor v2: { results: [...] }
  if (Array.isArray(j.results)) return j.results;
  // 4) Bare массив на верхнем уровне.
  if (Array.isArray(j)) return j as unknown[];
  return [];
}

// Безопасное чтение свойства из произвольного значения.
function pick(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

// Берём число из пары кандидатов (возможно строки от API). Возвращает 0
// если ни один не валиден.
function firstPositiveNumber(candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return Math.round(c);
    if (typeof c === 'string') {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
  }
  return 0;
}

// Берём первый https-URL из кандидатов.
function firstHttpsUrl(candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('https://')) return c;
  }
  return '';
}

// Извлекаем preview/full/width/height из произвольного item'а,
// перебирая все типовые формы (Klipy file.gif.{xs,sm,sd,md,hd}, Tenor
// media_formats, Giphy images).
function extractGifUrl(
  item: unknown,
): { preview: string; full: string; width: number; height: number } | null {
  // Klipy: item.file.gif.{xs,sm,sd,md,hd}.{url,width,height}
  const file = pick(item, 'file');
  const gif = pick(file, 'gif');
  const xs = pick(gif, 'xs');
  const sm = pick(gif, 'sm');
  const sd = pick(gif, 'sd');
  const md = pick(gif, 'md');
  const hd = pick(gif, 'hd');
  const previewKlipy = pick(gif, 'preview');

  // Tenor v2: item.media_formats.{tinygif,nanogif,gif,mediumgif}
  const mf = pick(item, 'media_formats');
  const tfTiny = pick(mf, 'tinygif');
  const tfNano = pick(mf, 'nanogif');
  const tfGif = pick(mf, 'gif');
  const tfMed = pick(mf, 'mediumgif');

  // Tenor v1: item.media[0].{gif,tinygif,nanogif}.url + dims
  const mediaArr = pick(item, 'media');
  const m0 = Array.isArray(mediaArr) && mediaArr.length > 0 ? mediaArr[0] : undefined;
  const m0Tiny = pick(m0, 'tinygif');
  const m0Nano = pick(m0, 'nanogif');
  const m0Gif = pick(m0, 'gif');

  // Giphy: item.images.{fixed_height_small,preview_gif,fixed_height,original}
  const images = pick(item, 'images');
  const imgFixSmall = pick(images, 'fixed_height_small');
  const imgPrevGif = pick(images, 'preview_gif');
  const imgFix = pick(images, 'fixed_height');
  const imgOrig = pick(images, 'original');

  const previewCandidates: unknown[] = [
    pick(xs, 'url'),
    pick(sm, 'url'),
    pick(previewKlipy, 'url'),
    typeof previewKlipy === 'string' ? previewKlipy : undefined,
    typeof pick(item, 'preview') === 'string' ? pick(item, 'preview') : undefined,
    pick(tfTiny, 'url'),
    pick(tfNano, 'url'),
    pick(m0Tiny, 'url'),
    pick(m0Nano, 'url'),
    pick(imgFixSmall, 'url'),
    pick(imgPrevGif, 'url'),
  ];
  const fullCandidates: unknown[] = [
    pick(sd, 'url'),
    pick(md, 'url'),
    pick(hd, 'url'),
    pick(tfGif, 'url'),
    pick(tfMed, 'url'),
    pick(m0Gif, 'url'),
    pick(imgFix, 'url'),
    pick(imgOrig, 'url'),
    pick(xs, 'url'),
  ];

  // Tenor dims: media_formats.gif.dims = [w, h]
  const tfGifDims = pick(tfGif, 'dims');
  const m0GifDims = pick(m0Gif, 'dims');
  const tfDimsW = Array.isArray(tfGifDims) ? tfGifDims[0] : undefined;
  const tfDimsH = Array.isArray(tfGifDims) ? tfGifDims[1] : undefined;
  const m0DimsW = Array.isArray(m0GifDims) ? m0GifDims[0] : undefined;
  const m0DimsH = Array.isArray(m0GifDims) ? m0GifDims[1] : undefined;

  const widthCandidates: unknown[] = [
    pick(sd, 'width'),
    pick(md, 'width'),
    pick(hd, 'width'),
    pick(xs, 'width'),
    tfDimsW,
    pick(tfGif, 'width'),
    m0DimsW,
    pick(imgFix, 'width'),
    pick(imgOrig, 'width'),
  ];
  const heightCandidates: unknown[] = [
    pick(sd, 'height'),
    pick(md, 'height'),
    pick(hd, 'height'),
    pick(xs, 'height'),
    tfDimsH,
    pick(tfGif, 'height'),
    m0DimsH,
    pick(imgFix, 'height'),
    pick(imgOrig, 'height'),
  ];

  const preview = firstHttpsUrl(previewCandidates);
  const fullPicked = firstHttpsUrl(fullCandidates);
  const full = fullPicked.length > 0 ? fullPicked : preview;
  const width = firstPositiveNumber(widthCandidates) || 320;
  const height = firstPositiveNumber(heightCandidates) || 240;

  if (preview.length === 0 || full.length === 0) return null;
  return { preview, full, width, height };
}

async function fetchKlipy(url: string, signal?: AbortSignal): Promise<KlipyGif[]> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal });
  } catch {
    // AbortError или сеть — silent fail.
    return [];
  }
  if (!resp.ok) return [];
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return [];
  }
  // Diag: помогает быстро понять реальный shape ответа если что-то поломалось
  // на стороне API. 500 символов хватает для верхнего уровня.
  try {
    console.debug('[klipy] response shape:', JSON.stringify(json).slice(0, 500));
  } catch {
    /* circular / non-serializable — ignore */
  }
  const items = extractItems(json);
  return items
    .map((item, i): KlipyGif | null => {
      const u = extractGifUrl(item);
      if (!u) return null;
      const idRaw = pick(item, 'id') ?? pick(item, 'slug');
      const id =
        typeof idRaw === 'string' || typeof idRaw === 'number'
          ? String(idRaw)
          : `gif-${i}`;
      const titleRaw = pick(item, 'title') ?? pick(item, 'slug');
      const title = typeof titleRaw === 'string' ? titleRaw : '';
      return { id, title, ...u };
    })
    .filter((g): g is KlipyGif => g !== null);
}

export async function searchGifs(
  query: string,
  customerId: string,
  signal?: AbortSignal,
): Promise<KlipyGif[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const url =
    `${BASE}/search` +
    `?q=${encodeURIComponent(q)}` +
    `&customer_id=${encodeURIComponent(customerId)}` +
    `&per_page=${PER_PAGE}` +
    `&page=1`;
  return fetchKlipy(url, signal);
}

export async function trendingGifs(
  customerId: string,
  signal?: AbortSignal,
): Promise<KlipyGif[]> {
  const url =
    `${BASE}/trending` +
    `?customer_id=${encodeURIComponent(customerId)}` +
    `&per_page=${PER_PAGE}` +
    `&page=1`;
  return fetchKlipy(url, signal);
}
