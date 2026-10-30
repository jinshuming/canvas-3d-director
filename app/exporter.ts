import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

import type { StageDoc, StageRenderer, StageView } from '@stage';
import { ASPECTS, shotSpan } from '@stage';

export interface ExportProgress {
  frame: number;
  frames: number;
}

/** Long edge of an export, pixels. */
const LONG_EDGE = 1280;

function exportWidth(aspect: number): number {
  return aspect >= 1 ? LONG_EDGE : Math.round(LONG_EDGE * aspect);
}

/** Look through `shotId` at time `t` and save the frame as a PNG. */
export async function exportFrame(r: StageRenderer, doc: StageDoc, shotId: string, t: number): Promise<Blob> {
  return withShot(r, shotId, async () => {
    r.setTime(t);
    const aspect = ASPECTS[doc.aspect];
    const canvas = await r.capture(aspect, exportWidth(aspect) * 1.5);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed.'))), 'image/png'));
  });
}

/**
 * Render a shot frame by frame - the clock steps exactly 1/fps, so the
 * video is the same however slow the machine - and encode it to H.264 MP4
 * with WebCodecs.
 */
export async function exportShotVideo(
  r: StageRenderer,
  doc: StageDoc,
  shotId: string,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const shot = doc.shots.find((s) => s.id === shotId);
  const span = shot ? shotSpan(shot) : null;
  if (!shot || !span || span[1] <= span[0]) throw new Error('这个镜头至少需要两个不同时间的关键帧。');
  if (typeof VideoEncoder === 'undefined') throw new Error('这个浏览器不支持 WebCodecs 视频编码，请用新版 Chrome / Edge。');

  const aspect = ASPECTS[doc.aspect];
  const width = even(exportWidth(aspect));
  const height = even(width / aspect);
  const fps = doc.fps;
  const frames = Math.max(1, Math.round((span[1] - span[0]) * fps)) + 1;

  const config = await pickConfig(width, height, fps);
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure(config);

  const target = document.createElement('canvas');
  return withShot(r, shotId, async () => {
    r.setOverlaysVisible(false);
    try {
      for (let i = 0; i < frames; i++) {
        if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        if (failure) throw failure;
        r.setTime(span[0] + i / fps);
        // Two frames: one to pose and draw, one for the splat sort to settle.
        await r.frames(2);
        r.cropTo(aspect, width, target);
        const frame = new VideoFrame(target, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        // Back-pressure: do not let the encoder queue run away.
        while (encoder.encodeQueueSize > 4) await new Promise((res) => setTimeout(res, 5));
        onProgress({ frame: i + 1, frames });
      }
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    } finally {
      if (encoder.state !== 'closed') encoder.close();
      r.setOverlaysVisible(true);
    }
  });
}

async function pickConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  const bitrate = Math.round(width * height * fps * 0.15);
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
    if (support?.supported) return config;
  }
  throw new Error('这个浏览器不支持 H.264 编码。');
}

/** Run `fn` looking through a shot, then put the view back. */
async function withShot<T>(r: StageRenderer, shotId: string, fn: () => Promise<T>): Promise<T> {
  const before: StageView = r.getView();
  const time = r.getTime();
  r.setView({ kind: 'shot', shotId });
  try {
    return await fn();
  } finally {
    r.setTime(time);
    r.setView(before);
  }
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
