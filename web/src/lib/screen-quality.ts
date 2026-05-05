// Quality presets для screen-share. Применяются в getDisplayMedia() (как ideal
// width/height/frameRate constraints) и в RTCRtpSender.setParameters()
// (maxBitrate). Всё в пределах 1080p — это разумный потолок для нашего CF SFU
// free tier (1 TB/мес egress) и для большинства пользовательских мониторов.
//
// 60 fps на обоих пресетах — для плавных скроллов кода/документов и для
// видео/анимаций. Bitrate подобран под 60fps (~2× от 30fps равного качества):
// при 30fps те же значения дали бы заметно более «жирную» картинку, что
// нам не нужно — экономит трафик у CF.
//
// maxBitrate в bps. encoding[0].maxBitrate ставится на sender; реальный
// битрейт adaptive bandwidth estimation браузера может опустить ниже.

export type ScreenQuality = 'sd' | 'hd';

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
    label: 'HD 720p @ 60fps',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 3_000_000,
  },
  hd: {
    id: 'hd',
    label: 'FullHD 1080p @ 60fps',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 6_000_000,
  },
};

export const DEFAULT_SCREEN_QUALITY: ScreenQuality = 'hd';

export function getScreenQualityPreset(q: ScreenQuality): ScreenQualityPreset {
  return SCREEN_QUALITY_PRESETS[q] ?? SCREEN_QUALITY_PRESETS[DEFAULT_SCREEN_QUALITY];
}
