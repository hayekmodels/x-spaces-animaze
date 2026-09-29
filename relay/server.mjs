// Local relay: the extension publishes Space state over WebSocket, OBS (or any
// browser) opens the stage page served here and receives it.
//   npm run relay            -> http://127.0.0.1:8787/
//   PORT=9000 npm run relay
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1';
const STAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'stage');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = join(STAGE, rel);
  if (!file.startsWith(STAGE)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
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
  console.log(`[relay] stage:     http://${HOST}:${PORT}/`);
  console.log(`[relay] demo:      http://${HOST}:${PORT}/?demo=1`);
  console.log(`[relay] websocket: ws://${HOST}:${PORT}/ws`);
});
