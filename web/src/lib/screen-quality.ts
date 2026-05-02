// Quality presets для screen-share. Применяются в getDisplayMedia() (как ideal
// width/height/frameRate constraints) и в RTCRtpSender.setParameters()
// (maxBitrate). Подобраны эмпирически:
//
// - SD 720p / 1.5 Mbps — для слабых каналов (3G/EDGE) или когда показываешь
//   простой UI без мелкого текста.
// - HD 1080p / 3 Mbps — default, разумный компромисс для типичной демонстрации
//   приложений / IDE / документов.
// - QHD 1440p / 6 Mbps — для retina-моноблоков, дизайнерских макетов в Figma и
//   подобного, где 1080p размывает.
// - UHD 2160p / 12 Mbps — родной 4K-monitor share, хороший канал требуется.
// - UHD 4K @60fps / 20 Mbps — 4K с двойной частотой кадров для плавного
//   видео/анимаций (демо игр, гладкая прокрутка). Просит много CPU+канала.
//
// frameRate: 30 для всех «офисных» пресетов — для текста/UI 30fps достаточно,
// и encoder может тратить bitrate на резкость, а не на временной luma. Только
// топовый preset 'uhd' идёт 60fps.
//
// maxBitrate в bps. Используется для encoding[0].maxBitrate. Реальный битрейт
// adaptive bandwidth estimation браузера может опустить ниже.

export type ScreenQuality = 'sd' | 'hd' | 'fhd' | 'qhd' | 'uhd';

export interface ScreenQualityPreset {
  id: ScreenQuality;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
}

export const SCREEN_QUALITY_PRESETS: Record<ScreenQuality, ScreenQualityPreset> = {
  sd: {
    id: 'sd',
    label: 'SD 720p',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 1_500_000,
  },
  hd: {
    id: 'hd',
    label: 'HD 1080p',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 3_000_000,
  },
  fhd: {
    id: 'fhd',
    label: 'QHD 1440p (2K)',
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 6_000_000,
  },
  qhd: {
    id: 'qhd',
    label: 'UHD 2160p (4K)',
    width: 3840,
    height: 2160,
    frameRate: 30,
    maxBitrate: 12_000_000,
  },
  uhd: {
    id: 'uhd',
    label: 'UHD 4K @ 60fps',
    width: 3840,
    height: 2160,
    frameRate: 60,
    maxBitrate: 20_000_000,
  },
};

export const DEFAULT_SCREEN_QUALITY: ScreenQuality = 'hd';

export function getScreenQualityPreset(q: ScreenQuality): ScreenQualityPreset {
  return SCREEN_QUALITY_PRESETS[q] ?? SCREEN_QUALITY_PRESETS[DEFAULT_SCREEN_QUALITY];
}
