import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import mime from 'mime-types';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const clientDist = path.join(rootDir, 'client', 'dist');
const dataDir = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(os.tmpdir(), 'turbo-compressor-data'));
const jobsRoot = path.join(dataDir, 'jobs');
const retentionMs = 1000 * 60 * 60 * 24;

await fsp.mkdir(jobsRoot, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1 }
});

if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, {
    root: clientDist,
    prefix: '/'
  });
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.bmp']);
const IMAGE_OUTPUTS = new Set(['png', 'webp']);
const VIDEO_PRESETS = new Set(['medium', 'slow', 'slower', 'veryslow']);
const VIDEO_TUNES = new Set(['film', 'animation', 'grain', 'fastdecode', 'zerolatency']);
const jobs = new Map();

function safeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sanitizeSettings(settings = {}) {
  return {
    videoHeight: clamp(safeNumber(settings.videoHeight, 1080), 144, 2160),
    videoFps: clamp(safeNumber(settings.videoFps, 60), 1, 60),
    keepOriginalFps: Boolean(settings.keepOriginalFps),
    crf: clamp(safeNumber(settings.crf, 22), 16, 36),
    preset: VIDEO_PRESETS.has(settings.preset) ? settings.preset : 'slow',
    tune: VIDEO_TUNES.has(settings.tune) ? settings.tune : 'film',
    audioBitrateK: clamp(safeNumber(settings.audioBitrateK, 128), 32, 320),
    targetSizeMB: clamp(safeNumber(settings.targetSizeMB, 200), 0, 50000),
    outputFormat: ['mp4', 'mkv', 'png', 'webp'].includes(settings.outputFormat) ? settings.outputFormat : 'mp4',
    imageQuality: clamp(safeNumber(settings.imageQuality, 82), 40, 95),
    enableHaptics: settings.enableHaptics !== false,
    autoDownload: settings.autoDownload !== false
  };
}

function jobFile(jobDir) {
  return path.join(jobDir, 'job.json');
}

function publicJob(job) {
  if (!job) return null;
  const reduction = Number.isFinite(job.originalBytes) && Number.isFinite(job.compressedBytes) && job.originalBytes > 0
    ? 100 - (job.compressedBytes / job.originalBytes) * 100
    : null;

  return {
    id: job.id,
    fileName: job.fileName,
    outputName: job.outputName,
    status: job.status,
    stage: job.stage,
    progress: clamp(Math.round(safeNumber(job.progress, 0)), 0, 100),
    kind: job.kind,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    error: job.error || null,
    originalBytes: job.originalBytes ?? null,
    compressedBytes: job.compressedBytes ?? null,
    reduction,
    originalSha256: job.originalSha256 || null,
    compressedSha256: job.compressedSha256 || null,
    downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/download` : null,
    settings: job.settings
  };
}

async function persistJob(job) {
  await fsp.writeFile(jobFile(job.jobDir), JSON.stringify(job, null, 2), 'utf8');
}

function getJob(id) {
  return jobs.get(id) || null;
}

async function putJob(job) {
  jobs.set(job.id, job);
  await persistJob(job);
  return job;
}

async function patchJob(id, patch) {
  const current = getJob(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: nowIso() };
  jobs.set(id, next);
  await persistJob(next);
  return next;
}

async function loadJobs() {
  const entries = await fsp.readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(jobsRoot, entry.name);
    const json = await fsp.readFile(jobFile(dir), 'utf8').catch(() => null);
    if (!json) continue;
    const job = parseJson(json, null);
    if (!job?.id) continue;
    jobs.set(job.id, job);
  }
}

async function cleanupExpiredJobs() {
  const cutoff = Date.now() - retentionMs;
  for (const job of jobs.values()) {
    const updated = Date.parse(job.updatedAt || job.createdAt || 0);
    if (!Number.isFinite(updated) || updated > cutoff) continue;
    jobs.delete(job.id);
    await fsp.rm(job.jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

function determineKind(filename, mimetype) {
  const ext = path.extname(filename).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext) || (mimetype || '').startsWith('video/')) return 'video';
  if (AUDIO_EXTENSIONS.has(ext) || (mimetype || '').startsWith('audio/')) return 'audio';
  if (IMAGE_EXTENSIONS.has(ext) || (mimetype || '').startsWith('image/')) return 'image';
  return 'generic';
}

function parseFrameRate(rate) {
  if (!rate || typeof rate !== 'string' || !rate.includes('/')) return null;
  const [a, b] = rate.split('/').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function ffprobeJson(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate',
    '-of', 'json',
    filePath
  ], { captureStdout: true });
  return parseJson(stdout, {});
}

function parseProgressLine(line, state) {
  if (!line || !line.includes('=')) return state;
  const [key, rawValue] = line.split('=');
  const value = rawValue?.trim();
  if (key === 'out_time_ms' || key === 'out_time_us') {
    const timeValue = Number(value);
    if (Number.isFinite(timeValue)) {
      state.outTimeUs = timeValue;
    }
  }
  if (key === 'progress') state.progress = value;
  return state;
}

function runProcess(cmd, args, { captureStdout = false, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const flush = (chunk, target) => {
      const combined = target === 'stdout' ? stdoutBuffer + chunk : stderrBuffer + chunk;
      const lines = combined.split(/\r?\n/);
      const carry = lines.pop() || '';
      for (const line of lines) onLine?.(line, target);
      if (target === 'stdout') stdoutBuffer = carry;
      else stderrBuffer = carry;
    };

    child.stdout?.on('data', (d) => {
      const text = d.toString();
      if (captureStdout) stdout += text;
      flush(text, 'stdout');
    });

    child.stderr?.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      flush(text, 'stderr');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (stdoutBuffer) onLine?.(stdoutBuffer, 'stdout');
      if (stderrBuffer) onLine?.(stderrBuffer, 'stderr');
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function runFfmpegWithProgress({ args, durationSeconds = 0, onProgress, baseProgress = 0, spanProgress = 100, stage }) {
  const tracker = { outTimeUs: 0, progress: 'continue' };

  await runProcess('ffmpeg', ['-y', '-progress', 'pipe:1', '-nostats', ...args], {
    onLine: (line, source) => {
      if (source !== 'stdout') return;
      parseProgressLine(line, tracker);
      if (!durationSeconds || durationSeconds <= 0) return;
      const ratio = clamp(tracker.outTimeUs / (durationSeconds * 1000000), 0, 1);
      const progress = clamp(baseProgress + ratio * spanProgress, 0, 100);
      onProgress?.(progress, stage);
    }
  });

  onProgress?.(baseProgress + spanProgress, stage);
}

async function compressVideo({ inputPath, outputPath, settings, probe, onProgress }) {
  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  const sourceWidth = safeNumber(videoStream?.width, 1920);
  const sourceHeight = safeNumber(videoStream?.height, 1080);
  const sourceFps = parseFrameRate(videoStream?.avg_frame_rate) || parseFrameRate(videoStream?.r_frame_rate) || 30;
  const targetHeight = clamp(safeNumber(settings.videoHeight, Math.min(sourceHeight, 1080)), 144, 2160);
  const targetFps = settings.keepOriginalFps ? Math.min(sourceFps, 60) : clamp(safeNumber(settings.videoFps, Math.min(sourceFps, 60)), 1, 60);
  const maxWidth = Math.max(2, Math.round((sourceWidth / Math.max(sourceHeight, 1)) * targetHeight));
  const crf = clamp(safeNumber(settings.crf, 22), 16, 36);
  const audioBitrateK = clamp(safeNumber(settings.audioBitrateK, 128), 32, 320);
  const preset = VIDEO_PRESETS.has(settings.preset) ? settings.preset : 'slow';
  const tune = VIDEO_TUNES.has(settings.tune) ? settings.tune : null;
  const format = settings.outputFormat === 'mkv' ? 'matroska' : 'mp4';
  const duration = safeNumber(probe?.format?.duration, 0);

  const commonArgs = [
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-map_metadata', '0',
    '-c:v', 'libx264',
    '-preset', preset,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-vf', `scale='min(${maxWidth},iw)':'min(${targetHeight},ih)':force_original_aspect_ratio=decrease,fps=${targetFps}`,
    '-c:a', 'aac',
    '-b:a', `${audioBitrateK}k`,
    '-ac', '2'
  ];

  if (tune) commonArgs.push('-tune', tune);

  const targetSizeMB = safeNumber(settings.targetSizeMB, 0);
  if (targetSizeMB > 0 && duration > 0) {
    const totalBits = targetSizeMB * 1024 * 1024 * 8;
    const audioBits = audioBitrateK * 1000;
    const videoBits = Math.max(250000, Math.floor(totalBits / duration - audioBits));
    const passlog = path.join(path.dirname(outputPath), `pass-${crypto.randomUUID()}`);
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

    await runFfmpegWithProgress({
      args: [...commonArgs, '-b:v', String(videoBits), '-pass', '1', '-passlogfile', passlog, '-an', '-f', format, nullDevice],
      durationSeconds: duration,
      baseProgress: 8,
      spanProgress: 42,
      stage: 'Encoding pass 1 of 2',
      onProgress
    });

    await runFfmpegWithProgress({
      args: [...commonArgs, '-b:v', String(videoBits), '-pass', '2', '-passlogfile', passlog, outputPath],
      durationSeconds: duration,
      baseProgress: 50,
      spanProgress: 42,
      stage: 'Encoding pass 2 of 2',
      onProgress
    });

    for (const suffix of ['-0.log', '-0.log.mbtree']) {
      const maybe = `${passlog}${suffix}`;
      if (fs.existsSync(maybe)) await fsp.unlink(maybe).catch(() => {});
    }
    return;
  }

  await runFfmpegWithProgress({
    args: [...commonArgs, '-crf', String(crf), outputPath],
    durationSeconds: duration,
    baseProgress: 8,
    spanProgress: 84,
    stage: 'Encoding video',
    onProgress
  });
}

async function compressAudio({ inputPath, outputPath, settings, probe, onProgress }) {
  const bitrate = clamp(safeNumber(settings.audioBitrateK, 128), 32, 320);
  const duration = safeNumber(probe?.format?.duration, 0);
  await runFfmpegWithProgress({
    args: ['-i', inputPath, '-map_metadata', '0', '-c:a', 'aac', '-b:a', `${bitrate}k`, outputPath],
    durationSeconds: duration,
    baseProgress: 10,
    spanProgress: 82,
    stage: 'Encoding audio',
    onProgress
  });
}

async function compressImage({ inputPath, outputPath, settings, onProgress }) {
  const quality = clamp(safeNumber(settings.imageQuality, 82), 40, 95);
  const format = IMAGE_OUTPUTS.has(settings.outputFormat) ? settings.outputFormat : 'webp';
  onProgress?.(20, 'Preparing image');
  if (format === 'png') {
    await runProcess('ffmpeg', ['-y', '-i', inputPath, '-compression_level', '9', outputPath]);
  } else {
    await runProcess('ffmpeg', ['-y', '-i', inputPath, '-c:v', 'libwebp', '-quality', String(quality), outputPath]);
  }
  onProgress?.(92, 'Finalizing image');
}

async function losslessDeflateCopy(inputPath, outputPath, onProgress) {
  const zlib = await import('node:zlib');
  const source = fs.createReadStream(inputPath);
  const target = fs.createWriteStream(outputPath);
  onProgress?.(15, 'Packing file');
  await pipeline(source, zlib.createGzip({ level: 9 }), target);
  onProgress?.(92, 'Finalizing archive');
}

function downloadHeaders(job) {
  return {
    'Content-Type': mime.lookup(job.outputName) || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${job.outputName}"`,
    'X-Compression-Kind': job.kind,
    'X-Original-Bytes': String(job.originalBytes),
    'X-Compressed-Bytes': String(job.compressedBytes),
    'X-Original-SHA256': job.originalSha256,
    'X-Compressed-SHA256': job.compressedSha256
  };
}

async function processJob(id) {
  const job = getJob(id);
  if (!job) return;

  try {
    await patchJob(id, {
      status: 'processing',
      stage: 'Analyzing input',
      progress: 5,
      startedAt: nowIso(),
      error: null
    });

    const probe = ['video', 'audio'].includes(job.kind) ? await ffprobeJson(job.inputPath).catch(() => null) : null;

    const pushProgress = async (progress, stage) => {
      await patchJob(id, { progress, stage });
    };

    if (job.kind === 'video') {
      await compressVideo({ inputPath: job.inputPath, outputPath: job.outputPath, settings: job.settings, probe: probe || {}, onProgress: pushProgress });
      await pushProgress(95, 'Verifying video');
      await ffprobeJson(job.outputPath);
    } else if (job.kind === 'audio') {
      await compressAudio({ inputPath: job.inputPath, outputPath: job.outputPath, settings: job.settings, probe: probe || {}, onProgress: pushProgress });
      await pushProgress(95, 'Verifying audio');
      await ffprobeJson(job.outputPath);
    } else if (job.kind === 'image') {
      await compressImage({ inputPath: job.inputPath, outputPath: job.outputPath, settings: job.settings, onProgress: pushProgress });
    } else {
      await losslessDeflateCopy(job.inputPath, job.outputPath, pushProgress);
    }

    const [inputStat, outputStat] = await Promise.all([fsp.stat(job.inputPath), fsp.stat(job.outputPath)]);
    await patchJob(id, { progress: 97, stage: 'Hashing output' });
    const [originalSha, compressedSha] = await Promise.all([sha256(job.inputPath), sha256(job.outputPath)]);

    await patchJob(id, {
      status: 'done',
      stage: 'Ready to download',
      progress: 100,
      completedAt: nowIso(),
      originalBytes: inputStat.size,
      compressedBytes: outputStat.size,
      originalSha256: originalSha,
      compressedSha256: compressedSha
    });
  } catch (error) {
    app.log.error(error);
    await patchJob(id, {
      status: 'error',
      stage: 'Failed',
      progress: 100,
      error: error.message || 'Compression failed.'
    });
  }
}

await loadJobs();
await cleanupExpiredJobs();
setInterval(() => {
  cleanupExpiredJobs().catch((error) => app.log.error(error));
}, 1000 * 60 * 30).unref();

app.get('/api/health', async () => ({ ok: true }));

app.post('/api/jobs', async (request, reply) => {
  const part = await request.file();
  if (!part) return reply.code(400).send({ error: 'No file uploaded.' });

  const settings = sanitizeSettings(parseJson(part.fields.settings?.value || '{}', {}));
  const fileName = part.filename || 'file.bin';
  const inputExt = path.extname(fileName) || '';
  const jobId = crypto.randomUUID();
  const jobDir = path.join(jobsRoot, jobId);
  await fsp.mkdir(jobDir, { recursive: true });

  const inputPath = path.join(jobDir, `input${inputExt}`);
  await pipeline(part.file, fs.createWriteStream(inputPath));

  const kind = determineKind(fileName, part.mimetype);
  const baseName = path.basename(fileName, inputExt);
  let outputExt = '.gz';
  if (kind === 'video') outputExt = settings.outputFormat === 'mkv' ? '.mkv' : '.mp4';
  else if (kind === 'audio') outputExt = '.m4a';
  else if (kind === 'image') outputExt = settings.outputFormat === 'png' ? '.png' : '.webp';

  const outputName = `${baseName}-compressed${kind === 'generic' ? `${inputExt}.gz` : outputExt}`;
  const outputPath = path.join(jobDir, `output${kind === 'generic' ? `${inputExt}.gz` : outputExt}`);
  const originalStat = await fsp.stat(inputPath);

  const job = {
    id: jobId,
    jobDir,
    fileName,
    inputPath,
    outputPath,
    outputName,
    kind,
    status: 'queued',
    stage: 'Queued',
    progress: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    originalBytes: originalStat.size,
    compressedBytes: null,
    originalSha256: null,
    compressedSha256: null,
    settings,
    error: null
  };

  await putJob(job);
  processJob(jobId).catch((error) => app.log.error(error));
  return reply.send(publicJob(job));
});

app.get('/api/jobs/:id', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found.' });
  return reply.send(publicJob(job));
});

app.get('/api/jobs/:id/download', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found.' });
  if (job.status !== 'done') return reply.code(409).send({ error: 'Job is not ready yet.' });
  if (!fs.existsSync(job.outputPath)) return reply.code(410).send({ error: 'Compressed file expired.' });

  const headers = downloadHeaders(job);
  for (const [key, value] of Object.entries(headers)) reply.header(key, value);
  return reply.send(fs.createReadStream(job.outputPath));
});

app.get('/api/jobs/:id/meta', async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'Job not found.' });
  return reply.send({
    ...publicJob(job),
    headers: job.status === 'done' ? downloadHeaders(job) : null
  });
});

if (fs.existsSync(clientDist)) {
  app.get('/*', async (request, reply) => {
    return reply.sendFile('index.html');
  });
}

const port = Number(process.env.PORT || 3000);
await app.listen({ port, host: '0.0.0.0' });
