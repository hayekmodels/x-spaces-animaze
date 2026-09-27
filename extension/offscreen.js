// Offscreen document: turns the tabCapture stream id into a MediaStream, keeps the
// tab audible (capturing a tab mutes it otherwise) and reports a 0..1 level.

const SEND_MS = 50; // ~20 updates/s
const FLOOR_DB = -60; // level 0 at -60 dBFS RMS, level 1 at 0 dBFS

let ctx = null;
let stream = null;
let timer = null;

function send(msg) {
  chrome.runtime.sendMessage({ source: 'offscreen', ...msg }).catch(() => {});
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (ctx) ctx.close().catch(() => {});
  ctx = null;
}

async function start(streamId) {
  stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  ctx = new AudioContext();
  await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);

  // Preserve normal playback: route the captured audio back to the speakers.
  source.connect(ctx.destination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => {
    send({ type: 'XSA_ENDED' });
    stop();
  }));

  const buf = new Float32Array(analyser.fftSize);
  let sent = 0;
  let windowStart = performance.now();
  let hz = 0;
  timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const level = Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));

    sent++;
    const t = performance.now();
    if (t - windowStart >= 1000) {
      hz = (sent * 1000) / (t - windowStart);
      sent = 0;
      windowStart = t;
    }
    send({ type: 'XSA_LEVEL', level, rms, peak, hz });
  }, SEND_MS);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'XSA_START') {
    start(msg.streamId).then(
      () => sendResponse({ ok: true }),
      (e) => {
        stop();
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      },
    );
    return true; // async response
  }
  if (msg.type === 'XSA_STOP') {
    stop();
    sendResponse({ ok: true });
  }
});
