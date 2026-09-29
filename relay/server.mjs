// Local relay: the extension publishes Space state over WebSocket, OBS (or any
// browser) opens the stage page served here and receives it.
//   npm run relay            -> http://127.0.0.1:8787/
//   PORT=9000 npm run relay
//
// Also serves, same-origin for the stage (so it can read pixels):
//   /avatar?u=<https://pbs.twimg.com/...>   X profile photos (proxied, cached)
//   /vendor/tasks-vision/...                MediaPipe face landmarker (from node_modules)
//   /models/face_landmarker.task            face model (downloaded once, cached in relay/.cache)
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE = join(HERE, '..', 'stage');
const VISION = join(HERE, '..', 'node_modules', '@mediapipe', 'tasks-vision');
const CACHE = join(HERE, '.cache');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

async function serveFile(res, base, rel) {
  const file = join(base, normalize(rel));
  if (!file.startsWith(base)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

let modelPromise = null;
async function modelFile() {
  const file = join(CACHE, 'face_landmarker.task');
  try {
    if ((await stat(file)).size > 1e6) return file;
  } catch {
    // not cached yet
  }
  modelPromise ||= (async () => {
    console.log('[relay] downloading face model (one time, ~4 MB)…');
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error(`model download failed: ${r.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    console.log('[relay] face model ready');
    return file;
  })().finally(() => (modelPromise = null));
  return modelPromise;
}

const avatarCache = new Map(); // url -> {type, body}
async function serveAvatar(res, u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return res.writeHead(400).end();
  }
  if (url.protocol !== 'https:' || !/(^|\.)twimg\.com$/.test(url.hostname)) return res.writeHead(403).end();
  let hit = avatarCache.get(url.href);
  if (!hit) {
    try {
      const r = await fetch(url.href);
      if (!r.ok) return res.writeHead(r.status).end();
      hit = { type: r.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
      avatarCache.set(url.href, hit);
      if (avatarCache.size > 300) avatarCache.delete(avatarCache.keys().next().value);
    } catch {
      return res.writeHead(502).end();
    }
  }
  res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'max-age=3600' });
  res.end(hit.body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  if (path === '/avatar') return serveAvatar(res, url.searchParams.get('u') || '');
  if (path === '/models/face_landmarker.task') {
    try {
      return serveFile(res, CACHE, 'face_landmarker.task', await modelFile());
    } catch (e) {
      console.log(`[relay] ${e.message}`);
      return res.writeHead(502).end();
    }
  }
  if (path.startsWith('/vendor/tasks-vision/')) return serveFile(res, VISION, path.slice('/vendor/tasks-vision/'.length));
  return serveFile(res, STAGE, path === '/' ? 'index.html' : path);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const stages = new Set();
let last = null; // last state, so a stage opened later renders immediately
let sources = 0;

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://x').searchParams.get('role');
  if (role === 'source') {
    sources++;
    console.log(`[relay] extension connected (${sources} source(s))`);
    ws.on('message', (data) => {
      last = data.toString();
      for (const s of stages) if (s.readyState === 1 && s.bufferedAmount < 1 << 16) s.send(last);
    });
    ws.on('close', () => {
      sources--;
      console.log(`[relay] extension disconnected (${sources} source(s))`);
    });
  } else {
    stages.add(ws);
    console.log(`[relay] stage connected (${stages.size} stage(s))`);
    if (last) ws.send(last);
    ws.on('close', () => {
      stages.delete(ws);
      console.log(`[relay] stage disconnected (${stages.size} stage(s))`);
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] YouTube (16:9):  http://${HOST}:${PORT}/`);
  console.log(`[relay] TikTok  (9:16):  http://${HOST}:${PORT}/?format=vertical`);
  console.log(`[relay] demo:            http://${HOST}:${PORT}/?demo=1`);
  console.log(`[relay] websocket:       ws://${HOST}:${PORT}/ws`);
  modelFile().catch((e) => console.log(`[relay] face model not available yet (${e.message}); faces will use the simple mouth`));
});
