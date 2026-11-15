/**
 * Keyframes of a video for the layout agent to read the place from: `count`
 * frames spread over the clip (skipping the first and last few percent, where
 * phones shake), each the sharpest of a small window around its slot,
 * downscaled to `width`. ffmpeg only, like the panorama resize.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.split('\n').filter(Boolean).slice(-2).join(' | ')}`))));
  });
}

export async function videoDuration(video: string): Promise<number> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video]);
  const d = Number(out.trim());
  if (!(d > 0)) throw new Error('Could not read the video length.');
  return d;
}

/** Writes keyframe-<i>.jpg into `dir`; returns their file names and times. */
export async function extractKeyframes(video: string, dir: string, opts: { count?: number; width?: number } = {}): Promise<Array<{ file: string; time: number }>> {
  const count = Math.max(1, Math.min(12, opts.count ?? 6));
  const width = opts.width ?? 1024;
  await mkdir(dir, { recursive: true });
  const duration = await videoDuration(video);
  const start = duration * 0.04, span = duration * 0.92;
  const out: Array<{ file: string; time: number }> = [];
  for (let i = 0; i < count; i++) {
    const t = start + (count === 1 ? span / 2 : (span * i) / (count - 1));
    const file = `keyframe-${i}.jpg`;
    // `thumbnail` picks the most representative (least blurred-looking) of the next 12 frames.
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(2), '-i', video, '-vf', `thumbnail=12,scale=${width}:-2`, '-frames:v', '1', '-q:v', '3', join(dir, file)]);
    out.push({ file, time: Math.round(t * 100) / 100 });
  }
  return out;
}

export async function readKeyframe(dir: string, file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(dir, file)));
}
