// Stage: the X Space as an animated talk show. Every host/speaker is a
// "bobblehead" character — their X profile photo as the head (with a puppet jaw
// that opens with their voice) on a cartoon body whose arms gesture while they
// talk — sitting behind a studio desk. Fed by the relay (ws://<host>/ws?role=stage).
//
// Query params:
//   ?format=vertical        1080×1920 for TikTok/Shorts (default 1920×1080)
//   ?title=Mi%20Space       title shown in the header
//   ?demo=1                 fake speakers with drawn faces (no extension needed)
//   ?bg=transparent         transparent background (for your own OBS scene)
//   ?mouth=0.3              fallback jaw line (fraction of head radius below centre) for photos with no detectable face
//   ?body=0                 heads only (no cartoon bodies)
//   ?lang=en                English labels (default Spanish)
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo') === '1';
  const VERTICAL = params.get('format') === 'vertical';
  const TRANSPARENT = params.get('bg') === 'transparent';
  const W = VERTICAL ? 1080 : 1920;
  const H = VERTICAL ? 1920 : 1080;
  const MOUTH = Number(params.get('mouth')) || 0.3;
  const EN = params.get('lang') === 'en';
  const BODY = params.get('body') !== '0';
  const TXT = EN
    ? { live: 'LIVE', speaking: 'SPEAKING', waiting: 'Waiting for the X Space…', listeners: 'listening', more: 'more', roles: { host: 'HOST', cohost: 'CO-HOST', speaker: 'SPEAKER' } }
    : { live: 'EN VIVO', speaking: 'HABLANDO', waiting: 'Esperando el Space de X…', listeners: 'escuchando', more: 'más', roles: { host: 'ANFITRIÓN', cohost: 'CO-ANFITRIÓN', speaker: 'SPEAKER' } };
  const ACCENT = '#1d9bf0';
  const HOT = '#f91880';
  const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

  if (TRANSPARENT) document.body.classList.add('transparent');
  const canvas = document.getElementById('scene');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  function fit() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = `${W * s}px`;
    canvas.style.height = `${H * s}px`;
  }
  window.addEventListener('resize', fit);
  fit();

  // ------------------------------------------------------------ helpers

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967295;
  };
  // smooth pseudo-noise in about [-1, 1]
  const wob = (t, p) => (Math.sin(t * 2.1 + p * 6.28) + Math.sin(t * 3.7 + p * 11.3) * 0.6 + Math.sin(t * 5.3 + p * 17.9) * 0.3) / 1.9;
  const rand = (a, b) => a + Math.random() * (b - a);

  // critically damped spring
  class Spring {
    constructor(x, k = 120) {
      this.x = x;
      this.v = 0;
      this.k = k;
    }
    step(target, dt, k = this.k) {
      const c = 2 * Math.sqrt(k);
      // substeps keep stiff springs stable at low frame rates
      const n = Math.max(1, Math.ceil(dt * c / 0.5));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.v += (k * (target - this.x) - c * this.v) * h;
        this.x += this.v * h;
      }
      return this.x;
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(text, maxW, size, weight = 800) {
    let s = size;
    ctx.font = `${weight} ${s}px ${FONT}`;
    while (s > 10 && ctx.measureText(text).width > maxW) {
      s -= 1;
      ctx.font = `${weight} ${s}px ${FONT}`;
    }
    if (ctx.measureText(text).width > maxW) {
      let t = text;
      while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
      return `${t}…`;
    }
    return text;
  }

  // ------------------------------------------------------------ gestures
  // Hand targets in head-diameter units, relative to the desk point under the
  // character (x right, y up = negative). [left hand, right hand]
  const POSES = {
    rest: [[-0.32, -0.04], [0.32, -0.04]],
    explain: [[-0.46, -0.42], [0.46, -0.38]],
    wide: [[-0.74, -0.55], [0.74, -0.5]],
    point: [[-0.32, -0.04], [0.76, -0.74]],
    pointL: [[-0.76, -0.74], [0.32, -0.04]],
    chest: [[-0.08, -0.48], [0.22, -0.38]],
    up: [[-0.32, -0.04], [0.66, -0.98]],
    shrug: [[-0.64, -0.72], [0.64, -0.72]],
    count: [[-0.16, -0.52], [0.4, -0.72]],
    fists: [[-0.3, -0.42], [0.3, -0.42]],
    chin: [[-0.32, -0.04], [0.14, -0.6]],
    cross: [[0.2, -0.28], [-0.2, -0.28]],
  };
  const TALK_POSES = ['explain', 'wide', 'point', 'pointL', 'chest', 'up', 'shrug', 'count', 'fists', 'explain', 'chest'];
  const IDLE_POSES = ['rest', 'rest', 'rest', 'rest', 'chin', 'cross'];

  // ------------------------------------------------------------ characters

  const chars = new Map(); // key -> character
  let seenCounter = 0;
  let listenerCount = null;
  let lastMsgAt = 0;
  let audioLevel = 0;

  function makeChar(p) {
    const phase = hash(p.key);
    const c = {
      key: p.key,
      p,
      phase,
      seen: seenCounter++,
      img: null,
      src: undefined,
      shirt: `hsl(${Math.round(phase * 360)} 55% 42%)`,
      x: new Spring(W / 2, 70),
      y: new Spring(H + 200, 70),
      D: new Spring(10, 70),
      alpha: new Spring(0, 40),
      row: null,
      level: 0,
      talk: new Spring(0, 60),
      jaw: new Spring(0, 900),
      nod: new Spring(0, 140),
      look: new Spring(0, 25),
      hands: [
        { x: new Spring(-0.32, 150), y: new Spring(-0.04, 150) },
        { x: new Spring(0.32, 150), y: new Spring(-0.04, 150) },
      ],
      pose: 'rest',
      poseUntil: 0,
      nextNod: rand(2, 5),
      brow: new Spring(0, 160),
      blinkAt: rand(1, 4),
      blink: 0,
      face: null,
      lastSpoke: 0,
      prevLevel: 0,
    };
    setAvatar(c, p.avatar);
    return c;
  }

  function setAvatar(c, url) {
    if (url === c.src) return;
    c.src = url;
    c.face = null;
    if (!url) {
      c.img = DEMO ? demoFace(c) : initialsFace(c);
      return;
    }
    // same-origin through the relay, so we can read pixels (face detection, colours)
    const img = new Image();
    img.onload = () => {
      if (c.src !== url) return;
      c.img = img;
      const col = shirtFrom(img);
      if (col) c.shirt = col;
      analyzeFace(c, img);
    };
    img.onerror = () => {
      // relay proxy unavailable: load directly (draws fine, no face detection)
      const i2 = new Image();
      i2.referrerPolicy = 'no-referrer';
      i2.onload = () => c.src === url && (c.img = i2);
      i2.onerror = () => c.src === url && (c.img = initialsFace(c));
      i2.src = url;
    };
    img.src = location.host ? `/avatar?u=${encodeURIComponent(url)}` : url;
  }

  // ------------------------------------------------------------ face analysis
  // MediaPipe Face Landmarker (served by the relay) finds the face in each
  // profile photo once; its landmarks drive the mouth, eyelids and brows.

  const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const LIP_IN_UP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
  const LIP_IN_LO = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
  const EYES = [
    [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
    [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
  ];
  const BROWS = [
    [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
    [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  ];

  let landmarkerP = null;
  function getLandmarker() {
    if (!location.host) return Promise.resolve(null);
    landmarkerP ||= (async () => {
      const v = await import('/vendor/tasks-vision/vision_bundle.mjs');
      const files = await v.FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
      return v.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
      });
    })().catch((e) => {
      console.warn('[stage] face landmarker unavailable, using the simple mouth:', e);
      return null;
    });
    return landmarkerP;
  }

  let faceQueue = Promise.resolve();
  function analyzeFace(c, img) {
    faceQueue = faceQueue.then(async () => {
      const lm = await getLandmarker();
      if (!lm || c.img !== img) return;
      let res;
      try {
        res = lm.detect(img);
      } catch (e) {
        console.warn('[stage] face detection failed', e);
        return;
      }
      const L = res && res.faceLandmarks && res.faceLandmarks[0];
      if (L) c.face = buildFace(L, img);
    });
  }

  function buildFace(L, img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const px = L.map((p) => [p.x * iw, p.y * ih]);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of FACE_OVAL) {
      x0 = Math.min(x0, px[i][0]);
      x1 = Math.max(x1, px[i][0]);
      y0 = Math.min(y0, px[i][1]);
      y1 = Math.max(y1, px[i][1]);
    }
    // square crop around the face, a little headroom, clamped inside the photo
    const side = Math.min(Math.max(x1 - x0, y1 - y0) * 1.4, iw, ih);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2 - (y1 - y0) * 0.04;
    const sx = clamp(cx - side / 2, 0, iw - side);
    const sy = clamp(cy - side / 2, 0, ih - side);
    const uv = px.map(([x, y]) => [(x - sx) / side, (y - sy) / side]);
    // points of the face oval below the mouth corners, in oval order (image right → chin → image left)
    const mouthY = (uv[61][1] + uv[291][1]) / 2;
    const below = FACE_OVAL.filter((i) => uv[i][1] > mouthY + 0.01);
    const jaw = [...LIP_IN_LO, 291, ...below, 61];
    // eyelid colour: skin just above each eye
    const skins = EYES.map((eye) => sampleSkin(img, px, eye));
    const mouthW = Math.hypot(uv[291][0] - uv[61][0], uv[291][1] - uv[61][1]);
    return { crop: { x: sx, y: sy, s: side }, uv, jaw, mouthW, skins };
  }

  function sampleSkin(img, px, eye) {
    try {
      const top = eye[4];
      const bx = px[top][0];
      const by = px[top][1] - Math.abs(px[eye[0]][0] - px[eye[8]][0]) * 0.28;
      const t = document.createElement('canvas');
      t.width = t.height = 3;
      const g = t.getContext('2d');
      g.drawImage(img, bx - 3, by - 3, 6, 6, 0, 0, 3, 3);
      const d = g.getImageData(0, 0, 3, 3).data;
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        gg += d[i + 1];
        b += d[i + 2];
      }
      return `rgb(${Math.round(r / 9)},${Math.round(gg / 9)},${Math.round(b / 9)})`;
    } catch {
      return 'rgb(200,160,130)';
    }
  }

  // shirt colour from the photo's dominant hue
  function shirtFrom(img) {
    try {
      const t = document.createElement('canvas');
      t.width = t.height = 12;
      const g = t.getContext('2d');
      g.drawImage(img, 0, 0, 12, 12);
      const d = g.getImageData(0, 0, 12, 12).data;
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        gg += d[i + 1];
        b += d[i + 2];
      }
      const n = d.length / 4;
      r /= n * 255;
      gg /= n * 255;
      b /= n * 255;
      const max = Math.max(r, gg, b);
      const min = Math.min(r, gg, b);
      let h = 0;
      if (max !== min) {
        if (max === r) h = ((gg - b) / (max - min)) % 6;
        else if (max === gg) h = (b - r) / (max - min) + 2;
        else h = (r - gg) / (max - min) + 4;
      }
      h = Math.round(h * 60 + 360) % 360;
      const sat = max === min ? 10 : 55;
      return `hsl(${h} ${sat}% 40%)`;
    } catch {
      return null;
    }
  }

  function initialsFace(c) {
    const t = document.createElement('canvas');
    t.width = t.height = 256;
    const g = t.getContext('2d');
    g.fillStyle = `hsl(${Math.round(c.phase * 360)} 55% 45%)`;
    g.fillRect(0, 0, 256, 256);
    const name = c.p.displayName || c.p.username || '?';
    const ini = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
    g.fillStyle = '#fff';
    g.font = `900 110px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ini, 128, 118);
    return t;
  }

  // drawn cartoon face for ?demo=1 (mouth at the default jaw line)
  function demoFace(c) {
    const t = document.createElement('canvas');
    t.width = t.height = 256;
    const g = t.getContext('2d');
    const hue = Math.round(c.phase * 360);
    const skins = ['#f2c7a5', '#d9a17e', '#b97a56', '#8d5a3b', '#f5d6c1', '#6b4028'];
    const hairs = ['#2b1b10', '#5a3a1c', '#111', '#b5651d', '#e0c068', '#777'];
    const k = Math.floor(c.phase * 6);
    g.fillStyle = `hsl(${hue} 60% 55%)`;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = `hsl(${hue} 45% 30%)`;
    g.beginPath();
    g.ellipse(128, 300, 130, 90, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = skins[k];
    g.beginPath();
    g.ellipse(128, 130, 72, 88, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = hairs[(k + 2) % 6];
    g.beginPath();
    g.ellipse(128, 70, 80, 46, 0, Math.PI, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    for (const x of [100, 156]) {
      g.beginPath();
      g.ellipse(x, 118, 14, 11, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#222';
    for (const x of [102, 158]) {
      g.beginPath();
      g.arc(x, 119, 6, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(128, 128);
    g.lineTo(122, 150);
    g.lineTo(132, 152);
    g.stroke();
    g.strokeStyle = '#7a2a2a';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(128, 166, 20, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
    return t;
  }

  // ------------------------------------------------------------ state in

  function applyState(st) {
    lastMsgAt = performance.now();
    if (typeof st.listenerCount === 'number') listenerCount = st.listenerCount;
    audioLevel = typeof st.audioLevel === 'number' ? st.audioLevel : audioLevel;
    const list = (st.participants || []).filter((p) => p.role !== 'listener');
    const keys = new Set(list.map((p) => p.key));
    for (const [k, c] of chars) if (!keys.has(k)) c.gone = true;
    for (const p of list) {
      let c = chars.get(p.key);
      if (!c) {
        c = makeChar(p);
        chars.set(p.key, c);
      }
      c.gone = false;
      c.p = p;
      setAvatar(c, p.avatar);
    }
  }

  // ------------------------------------------------------------ layout

  const ROLE_RANK = { host: 0, cohost: 1, speaker: 2 };
  let featured = null; // the character in the spotlight (vertical hero / lower third)
  let hiddenCount = 0;

  function layout() {
    const list = [...chars.values()].filter((c) => !c.gone);
    const prio = list.slice().sort((a, b) => (b.p.speaking - a.p.speaking) || (b.level - a.level) || (b.lastSpoke - a.lastSpoke) || (ROLE_RANK[a.p.role] - ROLE_RANK[b.p.role]) || (a.seen - b.seen));
    const bySeen = (a, b) => a.seen - b.seen;
    // keep the spotlight on the last person who spoke until someone else talks
    const speakingNow = prio.find((c) => c.p.speaking);
    if (speakingNow) featured = speakingNow;
    else if (!featured || featured.gone) featured = prio[0] || null;
    const rows = [];
    for (const c of list) c.row = null;
    hiddenCount = 0;

    if (!VERTICAL) {
      const frontN = list.length <= 6 ? list.length : 5;
      const front = new Set(prio.slice(0, frontN));
      if (featured) front.add(featured);
      const frontRow = list.filter((c) => front.has(c)).sort(bySeen);
      const backRow = list.filter((c) => !front.has(c)).sort(bySeen);
      if (backRow.length) rows.push(placeRow(backRow, { deskY: H * 0.46, x0: W * 0.1, x1: W * 0.9, maxD: H * 0.15, grow: 0.3, panel: H * 0.05 }));
      rows.push(placeRow(frontRow, { deskY: H * 0.8, x0: W * 0.03, x1: W * 0.97, maxD: H * 0.3, grow: 0.7, panel: H * 0.2 }));
    } else {
      const hero = featured;
      const others = list.filter((c) => c !== hero).sort((a, b) => (b.lastSpoke - a.lastSpoke) || (ROLE_RANK[a.p.role] - ROLE_RANK[b.p.role]) || bySeen(a, b));
      const shown = others.slice(0, 8).sort(bySeen);
      hiddenCount = others.length - shown.length;
      for (const c of others.slice(8)) {
        c.row = { hidden: true };
      }
      if (hero) rows.push(placeRow([hero], { deskY: H * 0.6, x0: W * 0.05, x1: W * 0.95, maxD: W * 0.44, grow: 0, panel: H * 0.02, hero: true }));
      const r1 = shown.slice(0, 4);
      const r2 = shown.slice(4);
      if (r1.length) rows.push(placeRow(r1, { deskY: H * 0.83, x0: W * 0.03, x1: W * 0.97, maxD: W * 0.13, grow: 0.4, panel: H * 0.035 }));
      if (r2.length) rows.push(placeRow(r2, { deskY: H * 0.968, x0: W * 0.03, x1: W * 0.97, maxD: W * 0.13, grow: 0.4, panel: H * 0.035 }));
    }
    return rows;
  }

  function placeRow(members, o) {
    const weights = members.map((c) => 1 + o.grow * c.talk.x);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = o.x1 - o.x0;
    let x = o.x0;
    const row = { ...o, members };
    members.forEach((c, i) => {
      const w = (span * weights[i]) / total;
      c.row = row;
      c.tx = x + w / 2;
      c.tD = Math.min(o.maxD * (1 + o.grow * 0.35 * c.talk.x), w * 0.6);
      c.slotW = w;
      x += w;
    });
    return row;
  }

  // ------------------------------------------------------------ per-frame update

  function update(t, dt) {
    const active = [...chars.values()].filter((c) => !c.gone && c.p.speaking);
    const focusX = active.length ? active.reduce((a, c) => a + c.x.x, 0) / active.length : null;
    for (const c of chars.values()) {
      const p = c.p;
      const speaking = !c.gone && p.speaking;
      // voice level: fast attack, slow release
      const target = speaking ? Math.max(0.3, p.voice || 0) : 0;
      c.level += (target - c.level) * (target > c.level ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 5));
      if (speaking) c.lastSpoke = t;
      c.talk.step(speaking ? 1 : 0, dt);

      // puppet jaw: syllable-like open/close scaled by the voice level
      // syllables: open/close ~5x per second with varying depth, scaled by the voice
      const syll = Math.pow(Math.abs(Math.sin(t * 8.5 + c.phase * 20 + 0.8 * Math.sin(t * 2.3))), 1.4) * (0.55 + 0.45 * Math.abs(wob(t * 3, c.phase)));
      c.jaw.step(speaking ? clamp(c.level * (0.08 + 0.95 * syll * syll)) : 0, dt);

      // nods: emphasis while talking, "listening" nods while others talk
      if (speaking && c.level - c.prevLevel > 0.22) c.nod.v += 5;
      if (!speaking && active.length && t > c.nextNod) {
        c.nod.v += 3;
        c.nextNod = t + rand(1.8, 4.5);
      }
      // blinks (a quick close/open; sometimes a double blink)
      if (t > c.blinkAt) {
        c.blinkStart = t;
        c.blinkAt = t + (Math.random() < 0.15 ? 0.3 : rand(2.2, 5.5));
      }
      const bt = c.blinkStart != null ? t - c.blinkStart : 9;
      c.blink = bt < 0.07 ? bt / 0.07 : bt < 0.18 ? 1 - (bt - 0.07) / 0.11 : 0;
      // eyebrows: pop up on emphasis, slightly raised while talking
      if (speaking && c.level - c.prevLevel > 0.18) c.brow.v += 6;
      c.brow.step(speaking ? 0.3 * c.level : 0, dt);
      c.prevLevel = c.level;
      c.nod.step(0, dt);

      // look toward whoever is talking
      const lookTarget = speaking ? 0.4 * wob(t * 0.5, c.phase) : focusX == null ? 0.5 * wob(t * 0.2, c.phase + 0.3) : clamp((focusX - c.x.x) / (W * 0.3), -1, 1);
      c.look.step(lookTarget, dt);

      // gestures
      if (t > c.poseUntil) {
        if (speaking) {
          let next;
          do next = TALK_POSES[Math.floor(Math.random() * TALK_POSES.length)];
          while (next === c.pose);
          c.pose = next;
          c.poseUntil = t + rand(0.45, 1.3) / (0.7 + c.level * 0.6);
        } else {
          c.pose = IDLE_POSES[Math.floor(Math.random() * IDLE_POSES.length)];
          c.poseUntil = t + rand(3, 7);
        }
      }
      if (!speaking && TALK_POSES.includes(c.pose) && c.pose !== 'explain') c.poseUntil = Math.min(c.poseUntil, t + 0.4);
      const pose = POSES[c.pose] || POSES.rest;
      const k = speaking ? 170 : 45;
      const beat = speaking ? -c.level * 0.14 * Math.abs(Math.sin(t * 6.5 + c.phase * 9)) : 0;
      c.hands.forEach((h, i) => {
        h.x.step(pose[i][0] + (speaking ? 0.05 * wob(t * 2.3, c.phase + i) : 0), dt, k);
        h.y.step(pose[i][1] + beat + (speaking ? 0.04 * wob(t * 2.9, c.phase + i + 0.5) : 0), dt, k);
      });

      // layout motion
      if (c.row && !c.row.hidden && !c.gone) {
        c.x.step(c.tx, dt);
        c.y.step(c.row.deskY, dt);
        c.D.step(c.tD, dt);
        c.alpha.step(1, dt);
      } else {
        c.alpha.step(0, dt);
        c.y.step(H + 300, dt);
      }
      if (c.gone && c.alpha.x < 0.02) chars.delete(c.key);
    }
  }

  // ------------------------------------------------------------ drawing

  function drawBackground(t) {
    if (TRANSPARENT) {
      ctx.clearRect(0, 0, W, H);
      return;
    }
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a0f24');
    g.addColorStop(0.55, '#141a3a');
    g.addColorStop(1, '#07090f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // soft coloured glows
    for (const [cx, cy, r, col] of [
      [W * 0.2, H * 0.25, W * 0.5, 'rgba(29,155,240,0.16)'],
      [W * 0.85, H * 0.3, W * 0.45, 'rgba(249,24,128,0.12)'],
    ]) {
      const rg = ctx.createRadialGradient(cx + Math.sin(t * 0.2) * 40, cy, 0, cx, cy, r);
      rg.addColorStop(0, col);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }
    // sweeping stage beams
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const bx = W * (0.15 + i * 0.23);
      const ang = Math.sin(t * 0.35 + i * 1.7) * 0.35;
      ctx.save();
      ctx.translate(bx, -20);
      ctx.rotate(ang);
      const bg = ctx.createLinearGradient(0, 0, 0, H * 0.9);
      bg.addColorStop(0, i % 2 ? 'rgba(249,24,128,0.10)' : 'rgba(29,155,240,0.12)');
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(-12, 0);
      ctx.lineTo(12, 0);
      ctx.lineTo(W * 0.12, H * 0.9);
      ctx.lineTo(-W * 0.12, H * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // floating bokeh
    for (let i = 0; i < 28; i++) {
      const ph = i * 0.618;
      const x = ((ph * W * 1.7 + t * 12 * (0.3 + (i % 5) * 0.1)) % (W + 100)) - 50;
      const y = H * (0.1 + ((i * 0.37) % 0.6)) + Math.sin(t * 0.5 + i) * 20;
      const r = 3 + (i % 7) * 2.5;
      ctx.fillStyle = i % 3 ? 'rgba(29,155,240,0.10)' : 'rgba(249,24,128,0.10)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // equaliser wall behind the desk, driven by the tab audio / voices
    const lvl = Math.max(audioLevel || 0, ...[...chars.values()].map((c) => c.level));
    const N = VERTICAL ? 24 : 48;
    const baseY = VERTICAL ? H * 0.46 : H * 0.72;
    const maxH = VERTICAL ? H * 0.1 : H * 0.18;
    ctx.save();
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < N; i++) {
      const bw = W / N;
      const hgt = maxH * (0.08 + lvl * (0.3 + 0.7 * Math.abs(wob(t * 2.5 + i * 0.4, i / N))));
      ctx.fillStyle = i % 2 ? ACCENT : HOT;
      ctx.fillRect(i * bw + bw * 0.2, baseY - hgt, bw * 0.6, hgt);
    }
    ctx.restore();
  }

  function spotlight(c) {
    if (!c || c.alpha.x < 0.05) return;
    const D = c.D.x;
    const x = c.x.x;
    const y = c.y.x - 1.4 * D;
    const s = c.talk.x;
    if (s < 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, D * 2.2);
    g.addColorStop(0, `rgba(255,240,210,${0.22 * s})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - D * 2.5, y - D * 2.5, D * 5, D * 5);
    // cone from above
    const cg = ctx.createLinearGradient(0, 0, 0, c.y.x);
    cg.addColorStop(0, `rgba(255,245,220,${0.14 * s})`);
    cg.addColorStop(1, 'rgba(255,245,220,0)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.moveTo(x - D * 0.25, 0);
    ctx.lineTo(x + D * 0.25, 0);
    ctx.lineTo(x + D * 1.4, c.y.x);
    ctx.lineTo(x - D * 1.4, c.y.x);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function shade(col, dl) {
    const m = col.match(/hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/);
    if (!m) return col;
    return `hsl(${m[1]} ${m[2]}% ${clamp(Number(m[3]) + dl, 0, 100)}%)`;
  }

  function ik(sx, sy, hx, hy, a, b, side) {
    let dx = hx - sx;
    let dy = hy - sy;
    let d = Math.hypot(dx, dy);
    const maxD = a + b - 0.001;
    if (d > maxD) {
      hx = sx + (dx / d) * maxD;
      hy = sy + (dy / d) * maxD;
      dx = hx - sx;
      dy = hy - sy;
      d = maxD;
    }
    d = Math.max(d, Math.abs(a - b) + 0.001);
    const th = Math.atan2(dy, dx);
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const ang = th - side * Math.acos(cosA);
    return { ex: sx + Math.cos(ang) * a, ey: sy + Math.sin(ang) * a, hx, hy };
  }

  // Character geometry, in units of the head diameter D, origin at the desk
  // point under the character, y up = negative.
  const SHOULDER_Y = -0.62;

  function drawChar(c, t) {
    const D = c.D.x;
    if (D < 6 || c.alpha.x < 0.02) return;
    const s = c.talk.x;
    ctx.save();
    ctx.globalAlpha = clamp(c.alpha.x);
    ctx.translate(c.x.x, c.y.x);
    // whole body: breathing + lean toward the mic while talking + sway
    const breathe = Math.sin(t * 1.7 + c.phase * 10) * 0.012;
    const sway = 0.02 * wob(t * 0.6, c.phase) + s * 0.05 * wob(t * 2.2, c.phase + 0.3);
    ctx.translate(0, D * 0.03 * s);
    ctx.rotate(sway);
    ctx.scale(1 + s * 0.03, 1 + breathe + s * 0.03);

    const shoulderY = SHOULDER_Y * D;
    const shirt = c.shirt;
    if (BODY) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = D * 0.15;
      const tg = ctx.createLinearGradient(0, shoulderY, 0, D * 0.3);
      tg.addColorStop(0, shade(shirt, 10));
      tg.addColorStop(1, shade(shirt, -12));
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.moveTo(-0.4 * D, D * 0.3);
      ctx.lineTo(-0.45 * D, shoulderY + 0.2 * D);
      ctx.quadraticCurveTo(-0.45 * D, shoulderY, -0.22 * D, shoulderY - 0.02 * D);
      ctx.lineTo(0.22 * D, shoulderY - 0.02 * D);
      ctx.quadraticCurveTo(0.45 * D, shoulderY, 0.45 * D, shoulderY + 0.2 * D);
      ctx.lineTo(0.4 * D, D * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // collar
      ctx.fillStyle = shade(shirt, -22);
      ctx.beginPath();
      ctx.moveTo(-0.14 * D, shoulderY - 0.01 * D);
      ctx.lineTo(0, shoulderY + 0.16 * D);
      ctx.lineTo(0.14 * D, shoulderY - 0.01 * D);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(-0.14 * D, shoulderY - 0.01 * D);
      ctx.lineTo(-0.04 * D, shoulderY + 0.12 * D);
      ctx.lineTo(-0.07 * D, shoulderY - 0.01 * D);
      ctx.moveTo(0.14 * D, shoulderY - 0.01 * D);
      ctx.lineTo(0.04 * D, shoulderY + 0.12 * D);
      ctx.lineTo(0.07 * D, shoulderY - 0.01 * D);
      ctx.fill();
    }
    drawHead(c, t, D, shoulderY);
    if (BODY) drawArms(c, D, shoulderY, shirt);
    ctx.restore();
  }

  function drawHead(c, t, D, shoulderY) {
    const s = c.talk.x;
    const L = c.level;
    const R = D * 0.5;
    const bob = -s * L * 0.07 * D * Math.abs(Math.sin(t * 7 + c.phase * 5));
    const hx = c.look.x * 0.07 * D;
    const hy = shoulderY - R * 0.9 + bob + c.nod.x * 0.05 * D;
    const tilt = c.look.x * 0.1 + s * L * 0.16 * wob(t * 1.9, c.phase) + c.nod.x * 0.04;
    if (BODY) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(-0.1 * D, shoulderY - 0.16 * D, 0.2 * D, 0.2 * D, 0.05 * D);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(tilt);
    // bobblehead squash & stretch
    const sq = s * L * 0.05 * Math.sin(t * 14 + c.phase * 3);
    ctx.scale(1 - sq, 1 + sq);
    // rim / glow
    ctx.save();
    if (s > 0.02) {
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = D * (0.25 + 0.35 * L) * s;
    }
    ctx.fillStyle = s > 0.5 ? '#ffffff' : 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(0, 0, R + D * 0.03, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (s > 0.02) {
      ctx.strokeStyle = `rgba(29,155,240,${s})`;
      ctx.lineWidth = D * 0.025;
      ctx.beginPath();
      ctx.arc(0, 0, R + D * 0.055 + L * D * 0.03, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#273340';
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
    if (c.img && c.face) drawAnimatedFace(c, R);
    else if (c.img) drawPuppetFace(c, R);
    ctx.restore(); // clip
    ctx.restore(); // head transform
  }

  // Photo with a detected face: the lower lip + chin drop along the real lip
  // line, the eyelids close on blinks, the brows lift on emphasis.
  function drawAnimatedFace(c, R) {
    const f = c.face;
    const S = 2 * R;
    const img = c.img;
    const P = (i, dy = 0) => [-R + f.uv[i][0] * S, -R + f.uv[i][1] * S + dy];
    const photo = (dx = 0, dy = 0) => ctx.drawImage(img, f.crop.x, f.crop.y, f.crop.s, f.crop.s, -R + dx, -R + dy, S, S);
    const poly = (idx, dy = 0) => {
      ctx.beginPath();
      idx.forEach((i, k) => {
        const [x, y] = P(i, dy);
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    };
    photo();

    // brows
    const rise = c.brow.x * f.mouthW * S * 0.22;
    if (rise > 0.4) {
      for (const brow of BROWS) {
        const pts = brow.map((i) => P(i));
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const bx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const by = (Math.min(...ys) + Math.max(...ys)) / 2;
        const rx = (Math.max(...xs) - Math.min(...xs)) * 0.62;
        const ry = (Math.max(...ys) - Math.min(...ys)) * 0.5 + rise * 2.5 + R * 0.04;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2);
        ctx.clip();
        photo(0, -rise);
        ctx.restore();
      }
    }

    // mouth: open the jaw along the inner lip line
    const j = c.jaw.x * f.mouthW * S * 0.42;
    if (j > 0.5) {
      // mouth cavity between the upper lip and the dropped lower lip
      ctx.beginPath();
      LIP_IN_UP.forEach((i, k) => {
        const [x, y] = P(i);
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      for (let k = LIP_IN_LO.length - 1; k >= 0; k--) {
        const [x, y] = P(LIP_IN_LO[k], j);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = '#2a0710';
      ctx.fill();
      ctx.save();
      ctx.clip();
      // upper teeth and tongue
      const [lx] = P(61);
      const [rx] = P(291);
      const [, uy] = P(13);
      const [, ly] = P(14, j);
      ctx.fillStyle = '#efeae0';
      ctx.fillRect(lx, uy - 2, rx - lx, Math.min(j * 0.32, f.mouthW * S * 0.09) + 2);
      ctx.fillStyle = '#b8323f';
      ctx.beginPath();
      ctx.ellipse((lx + rx) / 2, ly, (rx - lx) * 0.3, Math.max(1, j * 0.3), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // lower lip + chin, moved down
      ctx.save();
      poly(f.jaw, j);
      ctx.clip();
      photo(0, j);
      ctx.restore();
    }

    // blinks: eyelids in the skin colour just above each eye
    if (c.blink > 0.02) {
      EYES.forEach((eye, e) => {
        const pts = eye.map((i) => P(i));
        const ys = pts.map((p) => p[1]);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        const pad = (bottom - top) * 0.6 + 1;
        const lid = top - pad + (bottom - top + pad * 2) * c.blink;
        ctx.save();
        poly(eye);
        ctx.lineWidth = pad * 1.6;
        ctx.strokeStyle = f.skins[e];
        ctx.fillStyle = f.skins[e];
        ctx.beginPath();
        const xs = pts.map((p) => p[0]);
        const x0 = Math.min(...xs) - pad;
        const x1 = Math.max(...xs) + pad;
        ctx.ellipse((x0 + x1) / 2, (top + bottom) / 2, (x1 - x0) / 2, (bottom - top) / 2 + pad, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillRect(x0, top - pad, x1 - x0, lid - (top - pad));
        ctx.strokeStyle = 'rgba(40,20,15,0.8)';
        ctx.lineWidth = Math.max(1, (bottom - top) * 0.18);
        ctx.beginPath();
        ctx.moveTo(x0 + pad * 0.5, lid);
        ctx.quadraticCurveTo((x0 + x1) / 2, lid + (bottom - top) * 0.25 * c.blink, x1 - pad * 0.5, lid);
        ctx.stroke();
        ctx.restore();
      });
    }
  }

  // Photo without a detectable face (logo, landscape, cartoon…): a puppet
  // mouth at a fixed line below the centre.
  function drawPuppetFace(c, R) {
    drawCover(c.img, -R, -R, 2 * R, 2 * R);
    const jaw = c.jaw.x * R * 0.34;
    if (jaw <= 0.5) return;
    const my = MOUTH * R;
    const jawPath = () => {
      ctx.beginPath();
      ctx.ellipse(0, my + 0.3 * R, 0.52 * R, 0.5 * R, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.beginPath();
      ctx.rect(-R, my, 2 * R, 2 * R);
      ctx.clip();
    };
    ctx.save();
    jawPath();
    ctx.fillStyle = '#2a0710';
    ctx.fillRect(-R, my, 2 * R, 2 * R);
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(-0.4 * R, my, 0.8 * R, Math.min(jaw * 0.35, R * 0.07));
    ctx.fillStyle = '#c2334a';
    ctx.beginPath();
    ctx.ellipse(0, my + jaw * 0.95, 0.28 * R, jaw * 0.35 + 1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(0, jaw);
    jawPath();
    drawCover(c.img, -R, -R - jaw, 2 * R, 2 * R);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-R, my, 2 * R, R * 0.03);
    ctx.restore();
  }

  // draw an image cropped to cover the box
  function drawCover(img, x, y, w, h) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const sc = Math.max(w / iw, h / ih);
    const sw = w / sc;
    const sh = h / sc;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }

  function drawArms(c, D, shoulderY, shirt) {
    const a = 0.38 * D;
    const b = 0.38 * D;
    [-1, 1].forEach((side, i) => {
      const sx = side * 0.36 * D;
      const sy = shoulderY + 0.1 * D;
      const h = c.hands[i];
      const k = ik(sx, sy, h.x.x * D, h.y.x * D, a, b, side);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 0.16 * D;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(k.ex, k.ey);
      ctx.lineTo(k.hx, k.hy);
      ctx.stroke();
      ctx.strokeStyle = shade(shirt, 4);
      ctx.lineWidth = 0.125 * D;
      ctx.stroke();
      // glove
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 0.018 * D;
      ctx.beginPath();
      ctx.arc(k.hx, k.hy, 0.085 * D, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(k.hx + side * 0.065 * D, k.hy - 0.045 * D, 0.035 * D, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = shade(shirt, -15);
      ctx.fillRect(k.hx - 0.07 * D, k.hy + 0.06 * D, 0.14 * D, 0.035 * D);
    });
  }

  function drawMic(c, t) {
    const D = c.D.x;
    if (!BODY || D < 6 || c.alpha.x < 0.02) return;
    const x = c.x.x + 0.5 * D;
    const y = c.y.x;
    const s = c.talk.x;
    ctx.save();
    ctx.globalAlpha = clamp(c.alpha.x);
    ctx.strokeStyle = '#2b2f3a';
    ctx.lineWidth = 0.05 * D;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 0.3 * D);
    ctx.lineTo(x - 0.12 * D, y - 0.5 * D);
    ctx.stroke();
    ctx.fillStyle = '#1b1e26';
    ctx.beginPath();
    ctx.ellipse(x, y, 0.16 * D, 0.04 * D, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(x - 0.16 * D, y - 0.58 * D);
    ctx.rotate(-0.6);
    if (s > 0.05) {
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = D * 0.3 * s;
    }
    const mg = ctx.createLinearGradient(-0.09 * D, 0, 0.09 * D, 0);
    mg.addColorStop(0, '#3a3f4d');
    mg.addColorStop(0.5, '#8a93a8');
    mg.addColorStop(1, '#3a3f4d');
    ctx.fillStyle = mg;
    roundRect(-0.09 * D, -0.14 * D, 0.18 * D, 0.28 * D, 0.09 * D);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.01 * D;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.08 * D, i * 0.04 * D);
      ctx.lineTo(0.08 * D, i * 0.04 * D);
      ctx.stroke();
    }
    ctx.restore();
    // sound waves
    if (s > 0.05) {
      ctx.strokeStyle = `rgba(29,155,240,${0.7 * s})`;
      ctx.lineWidth = 0.025 * D;
      for (let i = 0; i < 3; i++) {
        const ph = (t * 1.6 + i / 3) % 1;
        ctx.globalAlpha = clamp(c.alpha.x) * (1 - ph) * s * (0.4 + c.level);
        ctx.beginPath();
        ctx.arc(x - 0.16 * D, y - 0.58 * D, 0.18 * D + ph * 0.45 * D, -0.9, 0.5);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawDesk(row, t) {
    const members = row.members.filter((c) => c.alpha.x > 0.02);
    if (!members.length) return;
    const D = Math.max(...members.map((c) => c.D.x));
    const x0 = Math.min(...members.map((c) => c.x.x - c.slotW / 2)) - D * 0.1;
    const x1 = Math.max(...members.map((c) => c.x.x + c.slotW / 2)) + D * 0.1;
    const y = row.deskY;
    const top = D * 0.09;
    const panel = row.panel;
    // top surface
    const sg = ctx.createLinearGradient(0, y - top * 0.3, 0, y + top);
    sg.addColorStop(0, '#3a4262');
    sg.addColorStop(1, '#1d2238');
    ctx.fillStyle = sg;
    roundRect(x0, y - top * 0.3, x1 - x0, top * 1.3, top * 0.4);
    ctx.fill();
    // front panel
    const fg = ctx.createLinearGradient(0, y + top, 0, y + top + panel);
    fg.addColorStop(0, '#161a2e');
    fg.addColorStop(1, '#0b0d18');
    ctx.fillStyle = fg;
    ctx.fillRect(x0 + top * 0.3, y + top, x1 - x0 - top * 0.6, panel);
    // LED strip
    const pulse = 0.5 + 0.5 * Math.max(audioLevel || 0, ...members.map((c) => c.level));
    const lg = ctx.createLinearGradient(x0, 0, x1, 0);
    lg.addColorStop(0, `rgba(29,155,240,${0.4 + 0.5 * pulse})`);
    lg.addColorStop(0.5, `rgba(249,24,128,${0.4 + 0.5 * pulse})`);
    lg.addColorStop(1, `rgba(29,155,240,${0.4 + 0.5 * pulse})`);
    ctx.fillStyle = lg;
    ctx.save();
    ctx.shadowColor = HOT;
    ctx.shadowBlur = 12 * pulse;
    ctx.fillRect(x0 + top * 0.3, y + top, x1 - x0 - top * 0.6, Math.max(2, top * 0.18));
    ctx.restore();
  }

  function drawNameplate(c, row) {
    const D = c.D.x;
    if (row.hero || D < 6 || c.alpha.x < 0.05) return; // the hero gets the lower third
    const p = c.p;
    const s = c.talk.x;
    const top = D * 0.09;
    const w = Math.min(c.slotW * 0.9, D * 1.9);
    const h = Math.max(22, Math.min(row.panel * 0.62, D * 0.42));
    const x = c.x.x - w / 2;
    const y = row.deskY + top + Math.min(row.panel * 0.18, D * 0.08) + 4;
    ctx.save();
    ctx.globalAlpha = clamp(c.alpha.x);
    ctx.fillStyle = s > 0.3 ? `rgba(29,155,240,${0.25 + 0.5 * s})` : 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = s > 0.3 ? ACCENT : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    roundRect(x, y, w, h, h * 0.25);
    ctx.fill();
    ctx.stroke();
    const name = p.displayName || (p.username ? `@${p.username}` : '');
    const muted = p.mic === false;
    const pad = h * 0.18;
    let tx = c.x.x;
    if (muted) {
      const r = h * 0.2;
      ctx.fillStyle = '#f4212e';
      ctx.beginPath();
      ctx.arc(x + pad + r, y + h / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1.5, r * 0.18);
      ctx.beginPath();
      ctx.moveTo(x + pad + r * 0.45, y + h / 2 - r * 0.55);
      ctx.lineTo(x + pad + r * 1.55, y + h / 2 + r * 0.55);
      ctx.stroke();
      tx += r;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const twoLines = h > 34;
    const nameSize = twoLines ? h * 0.36 : h * 0.55;
    ctx.fillText(fitText(name, w - pad * 2 - (muted ? h * 0.45 : 0), nameSize, 800), tx, twoLines ? y + h * 0.36 : y + h / 2);
    if (twoLines) {
      const role = TXT.roles[p.role] || '';
      const sub = `${p.username ? `@${p.username}` : ''}${role ? `  ·  ${role}` : ''}`;
      ctx.fillStyle = 'rgba(231,233,234,0.75)';
      ctx.fillText(fitText(sub, w - pad * 2, h * 0.24, 600), tx, y + h * 0.72);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ overlays

  const lowerThird = { x: new Spring(-1, 60), who: null };

  function drawOverlays(t) {
    const pad = VERTICAL ? 40 : 36;
    // LIVE badge
    const bh = VERTICAL ? 64 : 52;
    ctx.save();
    ctx.font = `900 ${bh * 0.46}px ${FONT}`;
    const liveW = ctx.measureText(TXT.live).width + bh * 1.1;
    const bx = VERTICAL ? W / 2 - liveW / 2 : pad;
    const by = VERTICAL ? 70 : pad;
    ctx.fillStyle = '#f4212e';
    roundRect(bx, by, liveW, bh, bh * 0.22);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(t * 2.5));
    ctx.beginPath();
    ctx.arc(bx + bh * 0.42, by + bh / 2, bh * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(TXT.live, bx + bh * 0.72, by + bh / 2 + 1);
    // title + listeners
    const title = params.get('title') || 'X Space';
    ctx.textAlign = VERTICAL ? 'center' : 'left';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;
    const tx = VERTICAL ? W / 2 : bx + liveW + 22;
    const ty = VERTICAL ? by + bh + 58 : by + bh / 2;
    ctx.fillText(fitText(title, VERTICAL ? W - 80 : W * 0.6, VERTICAL ? 56 : 40, 900), tx, ty);
    if (listenerCount != null) {
      ctx.font = `600 ${VERTICAL ? 30 : 24}px ${FONT}`;
      ctx.fillStyle = 'rgba(231,233,234,0.8)';
      ctx.textAlign = VERTICAL ? 'center' : 'right';
      ctx.fillText(`${listenerCount} ${TXT.listeners}`, VERTICAL ? W / 2 : W - pad, VERTICAL ? ty + 50 : by + bh / 2);
    }
    ctx.restore();

    // lower third: who is talking
    const who = featured && featured.talk.x > 0.3 ? featured : null;
    if (who) lowerThird.who = who;
    const lx = lowerThird.x.step(who ? 0 : -1, 1 / 60);
    const c = lowerThird.who;
    if (c && lx > -0.99) {
      const p = c.p;
      const w = VERTICAL ? W * 0.84 : W * 0.34;
      const h = VERTICAL ? 150 : 118;
      const x = (VERTICAL ? (W - w) / 2 : pad) + lx * (w + pad * 2);
      const y = VERTICAL ? H * 0.628 : 110;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 24;
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, 'rgba(15,20,40,0.94)');
      g.addColorStop(1, 'rgba(15,20,40,0.78)');
      ctx.fillStyle = g;
      roundRect(x, y, w, h, 18);
      ctx.fill();
      ctx.shadowBlur = 0;
      const ag = ctx.createLinearGradient(0, y, 0, y + h);
      ag.addColorStop(0, ACCENT);
      ag.addColorStop(1, HOT);
      ctx.fillStyle = ag;
      roundRect(x, y, 12, h, 6);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ACCENT;
      ctx.font = `900 ${h * 0.17}px ${FONT}`;
      const tag = `🎙 ${TXT.speaking}  ·  ${TXT.roles[p.role] || ''}`;
      ctx.fillText(tag, x + 36, y + h * 0.24);
      ctx.fillStyle = '#fff';
      ctx.fillText(fitText(p.displayName || `@${p.username}`, w - 200, h * 0.36, 900), x + 36, y + h * 0.54);
      ctx.fillStyle = 'rgba(231,233,234,0.75)';
      ctx.font = `600 ${h * 0.17}px ${FONT}`;
      ctx.fillText(p.username ? `@${p.username}` : '', x + 36, y + h * 0.82);
      // mini equaliser
      for (let i = 0; i < 7; i++) {
        const bhh = h * 0.12 + h * 0.5 * c.level * Math.abs(wob(t * 4 + i * 0.7, c.phase));
        ctx.fillStyle = i % 2 ? ACCENT : HOT;
        roundRect(x + w - 150 + i * 18, y + h / 2 - bhh / 2, 10, bhh, 5);
        ctx.fill();
      }
      ctx.restore();
    }

    if (VERTICAL && hiddenCount > 0) {
      ctx.save();
      ctx.font = `700 28px ${FONT}`;
      ctx.fillStyle = 'rgba(231,233,234,0.7)';
      ctx.textAlign = 'right';
      ctx.fillText(`+${hiddenCount} ${TXT.more}`, W - 30, H * 0.715);
      ctx.restore();
    }

    if (!DEMO && performance.now() - lastMsgAt > 3000) {
      ctx.save();
      ctx.font = `700 ${VERTICAL ? 40 : 32}px ${FONT}`;
      ctx.fillStyle = 'rgba(231,233,234,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText(TXT.waiting, W / 2, H / 2);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ loop

  let prevT = performance.now();
  function frame(now) {
    const dt = Math.min(1 / 30, (now - prevT) / 1000);
    prevT = now;
    const t = now / 1000;
    const rows = layout();
    update(t, dt);
    drawBackground(t);
    spotlight(featured);
    for (const row of rows) {
      const members = row.members.slice().sort((a, b) => a.talk.x - b.talk.x); // talker on top
      for (const c of members) drawChar(c, t);
      drawDesk(row, t);
      for (const c of members) drawMic(c, t);
      for (const c of members) drawNameplate(c, row);
    }
    // characters on their way out
    for (const c of chars.values()) if (!c.row || c.row.hidden) drawChar(c, t);
    drawOverlays(t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------ data sources

  function connect() {
    if (!location.host) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=stage`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state' && msg.state) applyState(msg.state);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => setTimeout(connect, 1000);
  }

  function demo() {
    const people = [
      ['Ana Torres', 'ana_torres', 'host'],
      ['Bruno Díaz', 'brunod', 'cohost'],
      ['Carla Ruiz', 'carlaruiz', 'speaker'],
      ['Diego Paz', 'diegopaz', 'speaker'],
      ['Elena Soto', 'elenas', 'speaker'],
      ['Fede Gómez', 'fedeg', 'speaker'],
      ['Gabi Luna', 'gabiluna', 'speaker'],
    ];
    const n = Number(params.get('n')) || people.length;
    let turn = 0;
    setInterval(() => (turn = (turn + 1 + Math.floor(Math.random() * 2)) % n), 4200);
    setInterval(() => {
      const t = performance.now() / 1000;
      applyState({
        listenerCount: 1234,
        participants: people.slice(0, n).map(([displayName, username, role], i) => {
          const speaking = i === turn && Math.sin(t * 1.3) > -0.75;
          return { key: `@${username}`, username, displayName, role, avatar: null, mic: i === turn || i % 3 === 0, speaking, voice: speaking ? 0.3 + 0.7 * Math.abs(wob(t * 5, i / 7)) : 0 };
        }),
      });
    }, 50);
  }

  window.__stage = { chars }; // for automated tests
  if (DEMO) demo();
  else connect();
})();
