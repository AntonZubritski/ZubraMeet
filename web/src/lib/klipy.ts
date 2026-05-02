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

interface KlipyVariant {
  url?: unknown;
  width?: unknown;
  height?: unknown;
}

interface KlipyFile {
  gif?: {
    hd?: KlipyVariant;
    sd?: KlipyVariant;
    xs?: KlipyVariant;
  };
}

interface KlipyItem {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  preview?: unknown;
  file?: KlipyFile;
}

interface KlipyResponse {
  result?: unknown;
  data?: {
    data?: unknown;
    has_next?: unknown;
  };
}

function variantUrl(v: KlipyVariant | undefined): string {
  if (!v || typeof v.url !== 'string') return '';
  // Минимальная защита: только https. fetch вернёт fail позже, но лучше
  // отфильтровать сразу — особенно для broadcast (URL ходит через mesh
  // и попадает в <img src> у других участников).
  if (!v.url.startsWith('https://')) return '';
  return v.url;
}

function variantNumber(v: KlipyVariant | undefined, key: 'width' | 'height'): number {
  if (!v) return 0;
  const raw = v[key];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function mapItem(item: KlipyItem): KlipyGif | null {
  const idRaw = item.id ?? item.slug;
  const id = typeof idRaw === 'string' || typeof idRaw === 'number' ? String(idRaw) : '';
  if (id.length === 0) return null;

  const gif = item.file?.gif;
  // Preview: предпочитаем item.preview, иначе xs.url, иначе sd.url.
  let preview =
    typeof item.preview === 'string' && item.preview.startsWith('https://')
      ? item.preview
      : '';
  if (preview.length === 0) preview = variantUrl(gif?.xs);
  if (preview.length === 0) preview = variantUrl(gif?.sd);

  // Full: предпочитаем sd (компромисс качество/вес), fallback hd, fallback xs.
  let full = variantUrl(gif?.sd);
  if (full.length === 0) full = variantUrl(gif?.hd);
  if (full.length === 0) full = variantUrl(gif?.xs);

  if (preview.length === 0 || full.length === 0) return null;

  // Размеры берём из того же variant'а что и full.
  const sized = gif?.sd && variantUrl(gif.sd) === full ? gif.sd
    : gif?.hd && variantUrl(gif.hd) === full ? gif.hd
    : gif?.xs;
  const width = variantNumber(sized, 'width') || 320;
  const height = variantNumber(sized, 'height') || 240;

  const title = typeof item.title === 'string' ? item.title : '';

  return { id, title, preview, full, width, height };
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
  const r = json as KlipyResponse;
  if (r.result !== true) return [];
  const arr = r.data?.data;
  if (!Array.isArray(arr)) return [];
  const out: KlipyGif[] = [];
  for (const raw of arr) {
    const mapped = mapItem(raw as KlipyItem);
    if (mapped) out.push(mapped);
  }
  return out;
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
