// Per-user аудио-настройки. Хранятся в localStorage. Сейчас только AI
// шумоподавление (RNNoise через WebAssembly), позже сюда же лягут selected
// input device и т.д.
//
// Native шумоподавление (echoCancellation/noiseSuppression/autoGainControl)
// в getUserMedia constraints включено всегда — оно дешёвое и работает в
// каждом браузере. AI-вариант — поверх native, для тех у кого фон сложнее
// (печатание, шум вентилятора, голоса в фоне) и кто готов потратить ~5-10%
// CPU на ML-обработку каждого сэмпла.

const KEY_AI_NOISE = 'zubrameet.audio.aiNoiseSuppression';

export function getAiNoiseSuppression(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(KEY_AI_NOISE) === '1';
  } catch {
    return false;
  }
}

export function setAiNoiseSuppression(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.localStorage.setItem(KEY_AI_NOISE, '1');
    } else {
      window.localStorage.removeItem(KEY_AI_NOISE);
    }
  } catch {
    /* ignore — приватный режим, quota и т.п. */
  }
}
