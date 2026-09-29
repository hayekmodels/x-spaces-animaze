// Stage: every host/speaker of the X Space as a 2D avatar (their X profile
// photo) that gestures with their own voice level. Fed by the relay
// (ws://<host>/ws?role=stage). Query params:
//   ?bg=transparent | ?bg=%23112233   background
//   ?demo=1                           fake participants, no extension needed
//   ?names=0                          hide names
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo') === '1';
  const bg = params.get('bg');
  if (bg === 'transparent') document.body.classList.add('transparent');
  else if (bg) document.body.style.background = bg;
  if (params.get('names') === '0') document.body.classList.add('hide-names');

  const stageEl = document.getElementById('stage');
  const statusEl = document.getElementById('status');
  const ROLE = { host: 'HOST', cohost: 'CO-HOST', speaker: 'SPEAKER' };
  const MUTE_SVG = '<svg viewBox="0 0 24 24"><path d="M20.28 1.293l-3.718 3.718C15.791 3.246 14.046 2 12 2 9.243 2 7 4.243 7 7v4c0 1.014.308 1.956.829 2.745L6.38 15.194c-.971-1.225-1.397-2.409-1.431-2.51l-1.897.633c.303.908.951 2.129 1.922 3.283l-2.693 2.693 1.414 1.414 17.999-18-1.414-1.414zM9 11V7c0-1.654 1.346-3 3-3 1.522 0 2.768 1.143 2.961 2.612l-5.664 5.664C9.112 11.887 9 11.458 9 10.999zm5.056 2.174c.04-.038.079-.077.117-.117L17 10.23v.771c0 2.757-2.243 5-5 5-.24 0-.469-.038-.7-.071l2.756-2.756zm4.996-.492l1.896.635c-.721 2.162-3.271 6.127-7.949 6.631v2.053h-2v-2.053c-1.073-.116-2.029-.419-2.882-.836l1.517-1.517c.697.249 1.478.406 2.365.406 5.187 0 6.979-5.102 7.052-5.318z"/></svg>';

  let state = { participants: [] };
  let lastMsgAt = 0;
  const avatars = new Map(); // key -> avatar
  let tileSize = 200;

  // ------------------------------------------------------------ helpers

  const hashNum = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967295;
  };
  // smooth pseudo-noise in [-1, 1]
  const wobble = (t, p) => (Math.sin(t * 2.1 + p * 6.28) + Math.sin(t * 3.7 + p * 11.3) * 0.6 + Math.sin(t * 5.3 + p * 17.9) * 0.3) / 1.9;

  // ------------------------------------------------------------ layout

  // Tile = TILE_W·s wide, TILE_H·s tall for an avatar of diameter s. The extra
  // room holds the active-speaker enlargement, bounce and equaliser ring.
  const TILE_W = 1.75;
  const TILE_H = 2.05;

  // Largest avatar size s so n tiles fit the viewport.
  function computeTileSize(n) {
    const W = window.innerWidth * 0.96;
    const H = window.innerHeight * 0.94;
    let best = 0;
    for (let cols = 1; cols <= Math.max(1, n); cols++) {
      const rows = Math.ceil(n / cols);
      best = Math.max(best, Math.min(W / cols / TILE_W, H / rows / TILE_H));
    }
    return Math.max(50, Math.min(best, 300));
  }

  function makeAvatar(p) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = `
      <div class="body">
        <canvas class="fx"></canvas>
        <div class="av"><img alt="" referrerpolicy="no-referrer"></div><div class="mute">${MUTE_SVG}</div>
      </div>
      <div class="label"><div class="name"></div><div class="meta"><span class="handle"></span><span class="badge"></span></div></div>`;
    const a = {
      key: p.key,
      tile,
      body: tile.querySelector('.body'),
      fx: tile.querySelector('.fx'),
      av: tile.querySelector('.av'),
      img: tile.querySelector('img'),
      phase: hashNum(p.key),
      level: 0,
      target: 0,
      active: 0, // eased 0..1 "is the main speaker" factor
      src: null,
      p,
    };
    a.img.addEventListener('error', () => showInitials(a));
    stageEl.appendChild(tile);
    return a;
  }

  function showInitials(a) {
    if (a.av.querySelector('.initials')) return;
    a.img.style.display = 'none';
    const d = document.createElement('div');
    d.className = 'initials';
    const name = a.p.displayName || a.p.username || '?';
    d.textContent = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
    d.style.background = `hsl(${Math.round(a.phase * 360)} 55% 40%)`;
    a.av.insertBefore(d, a.av.firstChild);
  }

  function applyState(next) {
    state = next;
    const list = (next.participants || []).filter((p) => p.role !== 'listener');
    const keys = new Set(list.map((p) => p.key));
    for (const [k, a] of avatars) {
      if (!keys.has(k)) {
        a.tile.remove();
        avatars.delete(k);
      }
    }
    list.forEach((p, i) => {
      let a = avatars.get(p.key);
      if (!a) {
        a = makeAvatar(p);
        avatars.set(p.key, a);
      }
      a.p = p;
      a.order = i;
      a.target = p.speaking ? Math.max(0.25, p.voice || 0) : 0;
      if (p.avatar && p.avatar !== a.src) {
        a.src = p.avatar;
        a.img.style.display = '';
        a.av.querySelector('.initials')?.remove();
        a.img.src = p.avatar;
      } else if (!p.avatar && !a.src) {
        showInitials(a);
      }
      a.tile.querySelector('.name').textContent = p.displayName || (p.username ? `@${p.username}` : p.key);
      a.tile.querySelector('.handle').textContent = p.username ? `@${p.username}` : '';
      a.tile.querySelector('.badge').textContent = ROLE[p.role] || '';
      a.tile.classList.toggle('muted', p.mic === false);
      a.tile.style.order = String(i);
    });
    const s = computeTileSize(list.length);
    if (Math.abs(s - tileSize) > 1 || !stageEl.dataset.sized) {
      tileSize = s;
      stageEl.dataset.sized = '1';
      for (const a of avatars.values()) sizeAvatar(a);
    } else {
      for (const a of avatars.values()) if (!a.sized) sizeAvatar(a);
    }
  }

  function sizeAvatar(a) {
    const s = tileSize;
    a.sized = true;
    a.tile.style.width = `${s * TILE_W}px`;
    a.tile.style.height = `${s * TILE_H}px`;
    a.tile.style.fontSize = `${Math.max(12, s * 0.11)}px`;
    a.tile.querySelector('.label').style.marginTop = `${s * 0.3}px`;
    a.tile.querySelector('.label').style.maxWidth = `${s * TILE_W * 0.95}px`;
    a.av.style.width = a.av.style.height = `${s}px`;
    const fx = Math.round(s * 1.7);
    const dpr = window.devicePixelRatio || 1;
    a.fx.width = a.fx.height = Math.round(fx * dpr);
    a.fx.style.width = a.fx.style.height = `${fx}px`;
  }

  // ------------------------------------------------------------ animation

  function drawFx(a, t) {
    const c = a.fx;
    const ctx = c.getContext('2d');
    const W = c.width;
    const dpr = W / parseFloat(c.style.width || W);
    ctx.clearRect(0, 0, W, W);
    const L = a.level;
    const R = (tileSize / 2) * dpr;
    const cx = W / 2;
    if (L < 0.01 && a.active < 0.01) return;
    // glow ring
    ctx.save();
    ctx.shadowColor = 'rgba(29,155,240,0.9)';
    ctx.shadowBlur = (10 + 30 * L) * dpr;
    ctx.strokeStyle = `rgba(29,155,240,${0.35 + 0.65 * Math.max(L, a.active * 0.5)})`;
    ctx.lineWidth = (2 + 7 * L) * dpr;
    ctx.beginPath();
    ctx.arc(cx, cx, R + (4 + 3 * L) * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // equaliser bars around the circle
    if (L > 0.02) {
      const N = 56;
      ctx.strokeStyle = `rgba(142,205,248,${0.25 + 0.6 * L})`;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, R * 0.035);
      for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
        const n = 0.35 + 0.65 * Math.abs(wobble(t * 3 + i * 0.37, a.phase + i * 0.013));
        const len = R * 0.22 * L * n;
        const r0 = R + (10 + 4 * L) * dpr;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * r0, cx + Math.sin(ang) * r0);
        ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cx + Math.sin(ang) * (r0 + len));
        ctx.stroke();
      }
    }
  }

  let prevT = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - prevT) / 1000);
    prevT = now;
    const t = now / 1000;
    // the main speaker = the loudest one talking
    let main = null;
    for (const a of avatars.values()) if (a.target > 0 && (!main || a.target > main.target)) main = a;
    const anyone = !!main;
    for (const a of avatars.values()) {
      // fast attack, slow release
      const k = a.target > a.level ? 1 - Math.exp(-dt * 25) : 1 - Math.exp(-dt * 6);
      a.level += (a.target - a.level) * k;
      const wantActive = a === main ? 1 : 0;
      a.active += (wantActive - a.active) * (1 - Math.exp(-dt * 5));

      const L = a.level;
      const ph = a.phase * 10;
      const breathe = 1 + 0.012 * Math.sin(t * 1.6 + ph);
      const bounce = 1 + 0.07 * L + 0.035 * L * Math.sin(t * 17 + ph);
      const squash = 0.03 * L * Math.sin(t * 23 + ph);
      const scale = breathe * bounce * (1 + 0.15 * a.active);
      const rot = L * 7 * wobble(t * 1.3, a.phase) + 0.6 * wobble(t * 0.25, a.phase + 0.5);
      const lift = -L * tileSize * 0.05 * Math.abs(Math.sin(t * 8.5 + ph)) + tileSize * 0.012 * wobble(t * 0.3, a.phase + 0.2);
      a.body.style.transform = `translateY(${lift.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${(scale * (1 + squash)).toFixed(4)}, ${(scale * (1 - squash)).toFixed(4)})`;
      a.tile.style.zIndex = String(1 + Math.round(a.active * 10));
      a.tile.classList.toggle('dim', anyone && a !== main && a.target === 0);
      a.tile.classList.toggle('speaking', a.target > 0);
      drawFx(a, t);
    }
    const stale = !DEMO && performance.now() - lastMsgAt > 3000;
    statusEl.textContent = stale ? (avatars.size ? 'waiting for the extension…' : 'waiting for the extension… (open an X Space with the XSA probe)') : '';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------ data

  function connect() {
    if (!location.host) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=stage`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state' && msg.state) {
          lastMsgAt = performance.now();
          applyState(msg.state);
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => setTimeout(connect, 1000);
  }

  function demo() {
    const people = [
      ['Host Demo', 'host_demo', 'host'],
      ['Ana Speaker', 'ana', 'cohost'],
      ['Bruno', 'bruno', 'speaker'],
      ['Carla', 'carla', 'speaker'],
      ['Diego', 'diego', 'speaker'],
      ['Elena', 'elena', 'speaker'],
    ];
    let turn = 0;
    setInterval(() => (turn = (turn + 1) % people.length), 3500);
    setInterval(() => {
      const t = performance.now() / 1000;
      lastMsgAt = performance.now();
      applyState({
        participants: people.map(([displayName, username, role], i) => {
          const speaking = i === turn && Math.sin(t * 2.3) > -0.6;
          return { key: `@${username}`, username, displayName, role, avatar: null, mic: i === turn || i % 3 === 0, speaking, voice: speaking ? 0.35 + 0.6 * Math.abs(wobble(t * 4, i / 7)) : 0 };
        }),
      });
    }, 50);
  }

  window.addEventListener('resize', () => {
    tileSize = computeTileSize(avatars.size);
    for (const a of avatars.values()) sizeAvatar(a);
  });

  if (DEMO) demo();
  else connect();
})();
