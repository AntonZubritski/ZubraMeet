// AI-шумоподавление через RNNoise (WebAssembly). Применяется к MediaStream'у
// с микрофоном после getUserMedia: source → RnnoiseWorkletNode → destination,
// возвращает новый stream с processed audio + оригинальный video. Отлично
// убирает фоновые шумы которые native browser noise suppression не берёт:
// печатание клавиатуры, вентилятор, бытовой шум, голоса в фоне.
//
// Цена — ~5-10% CPU на 1 voice channel + ~500 KB к bundle'у (RNNoise WASM).
// Включается опционально через settings (localStorage), по умолчанию off.
//
// Vite-specific: импорты с `?url` дают URL ассета в production-build'е,
// чтобы worklet и WASM действительно лежали отдельными файлами и подгружались
// из dist/. Без этого они инлайнились бы в bundle и worklet.addModule() не
// смог бы их прочитать (worklet требует отдельный URL).

import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
// SIMD-версия WASM не подключается отдельно: vite tree-shake'ит `?url` импорты
// которые передаются в loadRnnoise как параметр (он не видит прямого fetch'а),
// и SIMD-binary не попадает в bundle. На современных CPU SIMD дала бы ~+5-10%
// perf, но non-SIMD RNNoise всё равно справляется в realtime — лучше так,
// чем ловить 404 на отсутствующий simdUrl. Если когда-нибудь понадобится —
// добавим vite-plugin-static-copy чтобы гарантированно копировать оба .wasm.
const rnnoiseSimdWasmPath = rnnoiseWasmPath;

export interface NoiseSuppressionHandle {
  /** Stream с processed audio + оригинальные video tracks. Передаётся в conn.start(). */
  processedStream: MediaStream;
  /** Закрыть AudioContext, отключить worklet. Вызывать при leave/recoverMedia. */
  dispose(): void;
}

// Кэш WASM binary — он одинаковый между сессиями, скачивать каждый раз
// ~500KB лишнее. Хранится на module-уровне, живёт пока вкладка открыта.
let wasmBinaryCache: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryCache) {
    wasmBinaryCache = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath,
    });
  }
  return wasmBinaryCache;
}

/**
 * Применяет RNNoise к audio-track'у входного stream'а. Возвращает новый
 * MediaStream с processed audio + теми же video tracks. Caller передаёт
 * processedStream в свой WebRTC pipeline; original stream продолжает жить
 * (он источник для AudioContext) и НЕ должен быть остановлен пока активен
 * processedStream. Caller вызывает dispose() при leave для cleanup.
 *
 * Если у входного stream'а нет audio track — возвращает stream без обработки
 * (RNNoise бессмысленно применять к пустому аудио, и AudioContext не любит
 * graph без source).
 */
export async function applyRnnoise(
  inputStream: MediaStream,
): Promise<NoiseSuppressionHandle> {
  if (inputStream.getAudioTracks().length === 0) {
    return {
      processedStream: inputStream,
      dispose() { /* no-op */ },
    };
  }

  const ctx = new AudioContext();
  const wasmBinary = await getWasmBinary();
  await ctx.audioWorklet.addModule(rnnoiseWorkletPath);

  const source = ctx.createMediaStreamSource(inputStream);
  const rnnoise = new RnnoiseWorkletNode(ctx, {
    wasmBinary,
    // 1 — mono. WebRTC mic-track'и всегда mono после AUDIO_CONSTRAINTS.
    // RNNoise обучен на mono, stereo обрабатывает покомпонентно — для нашего
    // use-case'а 1 достаточно и снижает CPU.
    maxChannels: 1,
  });
  const destination = ctx.createMediaStreamDestination();

  source.connect(rnnoise);
  rnnoise.connect(destination);

  // Собираем новый stream: processed audio + оригинальный video.
  const processedStream = new MediaStream();
  for (const t of destination.stream.getAudioTracks()) {
    processedStream.addTrack(t);
  }
  for (const t of inputStream.getVideoTracks()) {
    processedStream.addTrack(t);
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try { source.disconnect(); } catch { /* ignore */ }
    try { rnnoise.disconnect(); } catch { /* ignore */ }
    try { void ctx.close(); } catch { /* ignore */ }
    // Останавливаем оригинальные mic-track'и которые служили source'ом для
    // AudioContext. В processedStream их нет (там processed audio из
    // destination), и Meeting.tsx их не остановит сам. Без этого микрофон
    // останется «открытым» — браузер покажет индикатор записи даже после
    // выхода из мита. Видео tracks НЕ трогаем — они шерятся в processedStream
    // и будут остановлены caller'ом через ls.getTracks() в общем cleanup.
    for (const t of inputStream.getAudioTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
  };

  return { processedStream, dispose };
}
