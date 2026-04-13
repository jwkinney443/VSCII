import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { rgbToFrameMsg } from './ascii';

const execFileAsync = promisify(execFile);

const COLS = 160;
const ROWS = 45;

function send(ws: WebSocket, payload: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function status(ws: WebSocket, message: string) {
  send(ws, { type: 'status', message });
}
async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `vscii-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return { path: dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function probeFps(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const raw = stdout.trim();
  if (raw.includes('/')) {
    const [n, d] = raw.split('/').map(Number);
    return n / d;
  }
  return parseFloat(raw) || 24;
}

async function extractAndSendAudio(ws: WebSocket, videoPath: string, audioPath: string) {
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y', '-i', videoPath, '-vn', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', audioPath,
      ]);
      proc.on('close', (code) => (code === 0 ? resolve() : reject()));
      proc.on('error', reject);
    });
    const data = await fs.readFile(audioPath);
    send(ws, { type: 'audio', data: data.toString('base64'), mimeType: 'audio/webm' });
  } catch {
    // audio is optional
  }
}

async function* frames(videoPath: string) {
  const frameSize = COLS * ROWS * 3;
  const proc = spawn('ffmpeg', [
    '-i', videoPath,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-vf', `scale=${COLS}:${ROWS}`,
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  let buf = Buffer.alloc(0);
  for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= frameSize) {
      yield buf.subarray(0, frameSize);
      buf = buf.subarray(frameSize);
    }
  }
}

async function runPipeline(ws: WebSocket, videoPath: string): Promise<void> {
  const tmp = await makeTempDir();
  try {
    status(ws, 'Reading metadata…');
    const fps = await probeFps(videoPath);

    status(ws, 'Extracting audio…');
    await extractAndSendAudio(ws, videoPath, path.join(tmp.path, 'audio.webm'));

    send(ws, { type: 'meta', fps, cols: COLS, rows: ROWS });

    status(ws, 'Streaming…');
    for await (const raw of frames(videoPath)) {
      if (ws.readyState !== WebSocket.OPEN) break;
      ws.send(rgbToFrameMsg(raw, COLS, ROWS));
    }

    send(ws, { type: 'done' });
  } finally {
    tmp.cleanup().catch(() => {});
  }
}

export async function pipelineFromBuffer(ws: WebSocket, buffer: Buffer, filename: string): Promise<void> {
  const tmp = await makeTempDir();
  try {
    const ext       = path.extname(filename) || '.mp4';
    const videoPath = path.join(tmp.path, `video${ext}`);
    status(ws, 'Saving file…');
    await fs.writeFile(videoPath, buffer);
    await runPipeline(ws, videoPath);
  } finally {
    tmp.cleanup().catch(() => {});
  }
}
