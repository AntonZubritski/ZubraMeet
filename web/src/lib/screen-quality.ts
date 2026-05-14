// Quality presets для screen-share. Применяются в getDisplayMedia() (как ideal
// width/height/frameRate constraints) и в RTCRtpSender.setParameters()
// (maxBitrate). Всё в пределах 1080p — это разумный потолок для нашего CF SFU
// free tier (1 TB/мес egress) и для большинства пользовательских мониторов.
//
// Четыре пресета — две комбинации resolution × frameRate:
//   - 720p / 1080p — выбор разрешения под пропускную способность канала
//   - 30fps / 60fps — 30 экономит трафик (документы/IDE), 60 для плавных
//                     скроллов, видео и анимаций
//
// maxBitrate подобран эмпирически: 60fps версия примерно 2× от 30fps той же
// resolution — чтобы encoder имел headroom и не размывал картинку при
// удвоении кадров. encoding[0].maxBitrate ставится на sender; реальный битрейт
// adaptive bandwidth estimation браузера может опустить ниже.

export type ScreenQuality = 'sd30' | 'sd60' | 'hd30' | 'hd60';

export interface ScreenQualityPreset {
  id: ScreenQuality;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
}

export const SCREEN_QUALITY_PRESETS: Record<ScreenQuality, ScreenQualityPreset> = {
  sd30: {
    id: 'sd30',
    label: 'HD 720p @ 30fps',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 1_500_000,
  },
  sd60: {
    id: 'sd60',
    label: 'HD 720p @ 60fps',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 3_000_000,
  },
  hd30: {
    id: 'hd30',
    label: 'FullHD 1080p @ 30fps',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 3_000_000,
  },
  hd60: {
    id: 'hd60',
    label: 'FullHD 1080p @ 60fps',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 6_000_000,
  },
};

// 1080p30 — sweet spot для большинства железа и контента (доки, IDE,
// презентации). 60fps требует ~2× CPU на VP9 encode и часто не влезает в
// бюджет 16.6ms/кадр на типичных машинах → фризы и drop frames. Если юзер
// хочет 60 — выбирает в dropdown'е (видит «60fps» лейбл рядом с пресетом).
export const DEFAULT_SCREEN_QUALITY: ScreenQuality = 'hd30';

export function getScreenQualityPreset(q: ScreenQuality): ScreenQualityPreset {
  return SCREEN_QUALITY_PRESETS[q] ?? SCREEN_QUALITY_PRESETS[DEFAULT_SCREEN_QUALITY];
}
