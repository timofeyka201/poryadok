// Сжатие видео на телефоне перед загрузкой: аппаратный кодек браузера (WebCodecs) через mediabunny.
// 2–3 минуты видео с телефона (300–500 МБ) превращаются в ~30–50 МБ 720p — загрузка в разы быстрее.
// Если браузер не умеет или что-то пошло не так — отправляем оригинал, отчёт не теряется.

const LIB = '/vendor/mediabunny-1.61.3.min.mjs';
const MIN_SIZE = 25 * 1024 ** 2; // маленькие видео не трогаем — выигрыш небольшой
const TARGET_SHORT_SIDE = 720;

export const canCompressVideo = () => typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function';

/**
 * Возвращает { file, compressed, audioDropped, reason }.
 * onProgress(0..1); signal.cancel() прерывает сжатие — тогда вернётся оригинал.
 */
export async function compressVideo(file, { onProgress, signal, minSize = MIN_SIZE, codecs = ['avc', 'hevc'] } = {}) {
  if (!canCompressVideo()) return { file, compressed: false, reason: 'unsupported' };
  if (file.size < minSize) return { file, compressed: false, reason: 'small' };

  let conversion;
  if (signal) signal.cancel = () => { signal.cancelled = true; };
  try {
    const mb = await import(LIB);
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { file, compressed: false, reason: 'no-video' };

    // уменьшаем до 720 по короткой стороне, ориентацию (портрет/альбом) сохраняем
    const w = track.displayWidth;
    const hgt = track.displayHeight;
    const scale = Math.min(1, TARGET_SHORT_SIDE / Math.min(w, hgt));
    const even = (x) => Math.max(2, Math.round(x / 2) * 2); // кодеки требуют чётные размеры
    const size = { width: even(w * scale), height: even(hgt * scale), fit: 'fill' };

    // H.264 играет везде (iPhone, Android, компьютер); HEVC — запасной вариант
    const videoCodec = await mb.getFirstEncodableVideoCodec(codecs, { width: size.width, height: size.height });
    if (!videoCodec) return { file, compressed: false, reason: 'unsupported' };
    const audioCodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus']);

    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
    conversion = await mb.Conversion.init({
      input,
      output,
      video: { ...size, codec: videoCodec, quality: mb.QUALITY_MEDIUM, frameRate: 30, forceTranscode: true },
      audio: audioCodec ? { codec: audioCodec, quality: mb.QUALITY_LOW } : { discard: true },
    });
    if (!conversion.isValid) return { file, compressed: false, reason: 'invalid' };
    if (signal?.cancelled) return { file, compressed: false, reason: 'cancelled' };
    if (signal) signal.cancel = () => { signal.cancelled = true; return conversion.cancel(); };
    conversion.onProgress = (p) => onProgress?.(p);
    await conversion.execute();
    if (signal?.cancelled) return { file, compressed: false, reason: 'cancelled' };

    const buffer = output.target.buffer;
    // если сжатие почти ничего не дало — оставляем оригинал
    if (!buffer || buffer.byteLength > file.size * 0.85) return { file, compressed: false, reason: 'no-gain' };
    const name = (file.name || 'video').replace(/\.\w+$/, '') + '.mp4';
    const audioDropped = !audioCodec || conversion.discardedTracks.some((d) => d.track.type === 'audio');
    return { file: new File([buffer], name, { type: 'video/mp4' }), compressed: true, audioDropped, originalSize: file.size };
  } catch (e) {
    if (signal?.cancelled) return { file, compressed: false, reason: 'cancelled' };
    console.warn('Сжатие видео не удалось, отправляю оригинал', e);
    return { file, compressed: false, reason: 'error' };
  }
}

/** Не даём экрану погаснуть, пока идёт сжатие и загрузка (иначе браузер приостановит работу). */
export async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    return () => lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
