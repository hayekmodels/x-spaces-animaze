// Content script: finds the X Space participant tiles in the page, shows a
// diagnostic panel, and (in OBSERVE mode) records what X changes inside each
// tile so the "is speaking" signal can be discovered empirically.
//
// Nothing here hard-codes X's CSS classes or data-testids. Participants are found
// from content X must render (profile-image URLs, role badge text, @handles);
// the speaking signal is a feature the user picks from OBSERVE-mode candidates.
(() => {
  'use strict';
  const LOG = '[XSA]';
  const VERSION = chrome.runtime.getManifest().version;

  // Injected twice (manifest + executeScript) → keep the running copy. After the
  // extension is reloaded, the old copy stays in the tab with a dead
  // chrome.runtime; replace it so the new version actually runs.
  const prevProbe = globalThis.__XSA_PROBE__;
  if (prevProbe && prevProbe.version === VERSION && prevProbe.alive()) return;
  if (prevProbe && prevProbe.stop) prevProbe.stop();
  const timers = [];

  // Exact (trimmed, case-insensitive) text of a role badge. English UI only —
  // add your UI language's words here if the panel shows no roles.
  const ROLE_TEXT = new Map([
    ['host', 'host'],
    ['co-host', 'cohost'],
    ['cohost', 'cohost'],
    ['speaker', 'speaker'],
    ['listener', 'listener'],
  ]);
  const ROLE_LABEL = { host: 'HOST', cohost: 'CO-HOST', speaker: 'SPEAKER', listener: 'LISTENER', unknown: '?' };
  const HANDLE_RE = /^@([A-Za-z0-9_]{1,15})$/;
  const AVATAR_RE = /\/(?:default_)?profile_images\//;
  const RESERVED_PATHS = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'settings', 'search', 'compose', 'login', 'logout', 'tos', 'privacy', 'hashtag']);
  const SKIP_ATTRS = new Set(['class', 'style', 'src', 'srcset', 'href']);

  // Default speaking signal, found empirically on a live Space (Sep 2026): X paints
  // each open-mic speaker's waveform on a <canvas> next to the role label; it is
  // blank while they are silent and animates while they talk. "*canvas" = the
  // first canvas in the tile. OBSERVE can still pick a different signal.
  const DEFAULT_RULE = '*canvas ~canvas-changing';
  const activeRule = () => settings.rule || DEFAULT_RULE;

  const EVAL_MS = 100;
  const PUBLISH_MS = 50;
  const SAMPLE_MS = 250;
  const DISCOVER_MS = 1000;
  const RENDER_MS = 200;
  const MAX_MUTATIONS = 5000;
  const MAX_TRACKED = 3000;
  const MAX_LEVELS = 14400; // 1h at 250ms
  const MAX_TILE_NODES = 400;
  const MAX_ROWS = 20;

  const settings = { debug: false, rule: null, holdMs: 400, collapsed: false };
  const state = {
    root: null,
    rootSource: 'none', // 'auto' | 'picked' | 'none'
    rootHeld: 0,
    rootOthers: 0,
    labeledTiles: 0,
    spaceIds: [],
    participants: new Map(), // key -> participant
    listenerCount: 0,
    relay: null, // 'connected' | 'offline' | null (not publishing)
    audio: { on: false, level: 0, rms: 0, peak: 0, hz: 0, t: 0, error: null },
    picking: false,
    lastKeys: '',
  };
  const obs = {
    mutations: [],
    mutationTotal: 0,
    tileMutations: 0,
    samples: 0,
    stats: new Map(), // feature -> stats
    prev: new Map(), // participant key -> previous feature Set
    boxes: new Map(), // participant key -> Map<path, relBox>
    levels: [],
    startedAt: null,
  };

  const now = () => performance.now();
  const clock = (t = Date.now()) => new Date(t).toISOString().slice(11, 23);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------------------------------------------------------------- avatars

  function avatarUrl(el) {
    if (el.tagName === 'IMG') return el.currentSrc || el.src || '';
    const bg = el.style && el.style.backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    return m ? m[1] : '';
  }
  const isAvatar = (el) => AVATAR_RE.test(avatarUrl(el));
  const normAvatar = (u) => u.replace(/[?#].*$/, '').replace(/_(normal|bigger|mini|reasonably_small|x\d+|\d+x\d+)(?=\.\w+$)/, '');

  function avatarNodes(scope) {
    const out = [];
    if (scope.nodeType === 1 && isAvatar(scope)) out.push(scope);
    for (const el of scope.querySelectorAll('img, [style*="profile_images"]')) if (isAvatar(el)) out.push(el);
    return out;
  }
  const avatarSet = (scope) => new Set(avatarNodes(scope).map((n) => normAvatar(avatarUrl(n))));

  // ------------------------------------------------------------ role labels

  const roleOfText = (t) => ROLE_TEXT.get(t.trim().toLowerCase()) || null;

  function findRoleLabels(scope) {
    const out = [];
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const v = n.nodeValue;
      if (!v || v.length > 12) continue;
      const role = roleOfText(v);
      if (role && n.parentElement) out.push({ el: n.parentElement, role });
    }
    return out;
  }

  // Smallest ancestor of the badge that holds an avatar, grown while it still
  // describes only that one participant.
  function tileFromLabel(labelEl) {
    let el = labelEl;
    while (el && el !== document.body && avatarNodes(el).length === 0) el = el.parentElement;
    if (!el || el === document.body || avatarSet(el).size !== 1) return null;
    while (el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (avatarSet(p).size !== 1 || findRoleLabels(p).length > 1 || p.getElementsByTagName('*').length > MAX_TILE_NODES / 2) break;
      el = p;
    }
    return el;
  }

  function tileFromAvatar(av, root) {
    let el = av;
    while (el.parentElement && el.parentElement !== root && avatarSet(el.parentElement).size <= 1) el = el.parentElement;
    return el;
  }

  // ------------------------------------------------------------- discovery

  function findSpaceIds() {
    const ids = new Set();
    const m = location.pathname.match(/\/i\/spaces\/([A-Za-z0-9]+)/);
    if (m) ids.add(m[1]);
    for (const a of document.querySelectorAll('a[href*="/i/spaces/"]')) {
      const mm = a.getAttribute('href').match(/\/i\/spaces\/([A-Za-z0-9]+)/);
      if (mm) ids.add(mm[1]);
      if (ids.size >= 5) break;
    }
    return [...ids];
  }

  function autoRoot() {
    const tiles = [];
    const seen = new Set();
    for (const { el, role } of findRoleLabels(document.body)) {
      const t = tileFromLabel(el);
      if (t && !seen.has(t)) {
        seen.add(t);
        tiles.push(t);
      }
    }
    state.labeledTiles = tiles.length;
    if (!tiles.length) return { root: null, held: 0, others: 0 };
    // The page can hold role badges outside the open Space (a Space card in the
    // timeline, "Live on X", ...). Score every ancestor of the labeled tiles by
    // (labeled tiles inside) − (other avatars inside) and take the best, preferring
    // the deeper element on ties. The Space's participant grid is almost nothing
    // but labeled tiles; page-level containers also hold timeline/sidebar avatars.
    const tileAvatars = new Map(tiles.map((t) => [t, [...avatarSet(t)][0]]));
    const cands = new Set();
    for (const t of tiles) {
      for (let a = t.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) cands.add(a);
    }
    let best = null;
    let bestScore = -Infinity;
    let bestHeld = 0;
    let bestOthers = 0;
    for (const a of cands) {
      const inside = tiles.filter((t) => a.contains(t));
      const labeled = new Set(inside.map((t) => tileAvatars.get(t)));
      let others = 0;
      for (const u of avatarSet(a)) if (!labeled.has(u)) others++;
      const score = inside.length - others;
      if (score > bestScore || (score === bestScore && best && best.contains(a))) {
        best = a;
        bestScore = score;
        bestHeld = inside.length;
        bestOthers = others;
      }
    }
    return { root: best, held: bestHeld, others: bestOthers };
  }

  function describeTile(tile) {
    const av = avatarNodes(tile)[0];
    const avatar = av ? avatarUrl(av) : null;
    // The number in /profile_images/<n>/ identifies the uploaded image, not the user.
    const avatarId = avatar ? (avatar.match(/\/profile_images\/(\d+)\//) || [])[1] || null : null;
    const texts = [];
    const w = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.trim();
      if (t) texts.push(t);
    }
    let username = null;
    let usernameSource = null;
    for (const t of texts) {
      const m = t.match(HANDLE_RE);
      if (m) {
        username = m[1];
        usernameSource = 'text';
        break;
      }
    }
    if (!username) {
      for (const a of tile.querySelectorAll('a[href]')) {
        const m = a.getAttribute('href').match(/^(?:https:\/\/(?:x|twitter)\.com)?\/([A-Za-z0-9_]{1,15})\/?$/);
        if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) {
          username = m[1];
          usernameSource = 'link';
          break;
        }
      }
    }
    if (!username) {
      for (const el of [tile, ...tile.querySelectorAll('[aria-label]')]) {
        const m = (el.getAttribute('aria-label') || '').match(/@([A-Za-z0-9_]{1,15})\b/);
        if (m) {
          username = m[1];
          usernameSource = 'aria-label';
          break;
        }
      }
    }
    let role = null;
    let roleSource = null;
    for (const t of texts) {
      const r = t.length <= 12 && roleOfText(t);
      if (r) {
        role = r;
        roleSource = 'text';
        break;
      }
    }
    if (!role) {
      for (const el of [tile, ...tile.querySelectorAll('[aria-label]')]) {
        const m = (el.getAttribute('aria-label') || '').toLowerCase().match(/\b(co-host|cohost|host|speaker|listener)\b/);
        if (m) {
          role = ROLE_TEXT.get(m[1]);
          roleSource = 'aria-label';
          break;
        }
      }
    }
    let displayName = texts.find((t) => t.length <= 50 && !roleOfText(t) && !HANDLE_RE.test(t) && !/^[\d.,]+[KkMm]?$/.test(t)) || null;
    if (!displayName && av && av.alt) displayName = av.alt;
    const key = username ? `@${username}` : avatarId ? `img:${avatarId}` : displayName || null;
    return { key, username, usernameSource, displayName, avatar, avatarId, role: role || 'unknown', roleSource };
  }

  function discover() {
    state.spaceIds = findSpaceIds();
    if (state.rootSource === 'picked' && !(state.root && state.root.isConnected)) state.rootSource = 'none';
    if (state.rootSource !== 'picked') {
      const { root, held, others } = autoRoot();
      state.rootHeld = held;
      state.rootOthers = others;
      setRoot(root, root ? 'auto' : 'none');
    }
    const found = new Map();
    let listeners = 0;
    if (state.root) {
      const tiles = new Set();
      for (const av of avatarNodes(state.root)) tiles.add(tileFromAvatar(av, state.root));
      for (const tile of tiles) {
        const d = describeTile(tile);
        if (!d.key) continue;
        const prev = found.get(d.key);
        if (prev && !(prev.role === 'unknown' && d.role !== 'unknown')) continue;
        d.el = tile;
        found.set(d.key, d);
      }
    }
    // merge, keeping speaking state per key
    for (const [key, p] of state.participants) {
      if (!found.has(key)) {
        if (p.speaking) setSpeaking(p, false, 'tile disappeared');
        state.participants.delete(key);
        obs.prev.delete(key);
        obs.boxes.delete(key);
      }
    }
    for (const [key, d] of found) {
      const p = state.participants.get(key);
      if (p) {
        if (p.el !== d.el) {
          obs.prev.delete(key);
          obs.boxes.delete(key);
          p.memo = {};
        }
        Object.assign(p, d);
      } else {
        state.participants.set(key, { ...d, speaking: false, offSince: null, lastChange: 0 });
      }
    }
    for (const d of found.values()) if (d.role === 'listener') listeners++;
    state.listenerCount = listeners;
    const keys = [...state.participants.keys()].join(',');
    if (keys !== state.lastKeys) {
      state.lastKeys = keys;
      console.info(`${LOG} participants (${state.participants.size}, root=${state.rootSource})`,
        [...state.participants.values()].map((p) => ({ key: p.key, username: p.username, displayName: p.displayName, role: p.role, roleSource: p.roleSource, avatar: p.avatar })));
    }
  }

  // ------------------------------------------------------- mutation observer

  let observer = null;

  function setRoot(root, source) {
    state.rootSource = source;
    if (root === state.root) return;
    state.root = root;
    if (observer) observer.disconnect();
    observer = null;
    if (!root) return;
    observer = new MutationObserver(onMutations);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
    console.info(`${LOG} observing Space root (${source}):`, root);
  }

  function pathFrom(ancestor, el, prefix = 'T') {
    const parts = [];
    for (let e = el; e && e !== ancestor; e = e.parentElement) {
      const p = e.parentElement;
      if (!p) return null;
      parts.push(`${e.tagName.toLowerCase()}:${Array.prototype.indexOf.call(p.children, e)}`);
    }
    return [prefix, ...parts.reverse()].join('>');
  }

  function ownerOf(el) {
    for (const p of state.participants.values()) if (p.el === el || p.el.contains(el)) return p;
    return null;
  }

  const summarizeNode = (n) => (n.nodeType === 1 ? `<${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? ` class="${n.className.slice(0, 80)}"` : ''}>` : n.nodeType === 3 ? `#text "${n.nodeValue.slice(0, 40)}"` : `#${n.nodeName}`);

  function tokenDiff(oldV, newV, split) {
    const a = new Set(split(oldV || ''));
    const b = new Set(split(newV || ''));
    return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) };
  }
  const classTokens = (s) => s.split(/\s+/).filter(Boolean);
  const styleDecls = (s) => s.split(';').map((d) => d.trim()).filter(Boolean);

  let discoverPending = false;
  function onMutations(list) {
    scheduleEval();
    if (!discoverPending && list.some((m) => m.type === 'childList')) {
      discoverPending = true;
      setTimeout(() => {
        discoverPending = false;
        discover();
      }, 150);
    }
    if (!settings.debug) return;
    const lvl = freshLevel();
    for (const m of list) {
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!target) continue;
      const p = ownerOf(target);
      const rec = { t: Date.now(), who: p ? p.key : null, path: p ? pathFrom(p.el, target) : pathFrom(state.root, target, 'R'), type: m.type, lvl };
      if (m.type === 'attributes') {
        const nv = target.getAttribute(m.attributeName);
        if (nv === m.oldValue) continue; // React re-set the same value
        rec.attr = m.attributeName;
        rec.old = m.oldValue;
        rec.new = nv;
        if (m.attributeName === 'class') rec.diff = tokenDiff(m.oldValue, nv, classTokens);
        if (m.attributeName === 'style') rec.diff = tokenDiff(m.oldValue, nv, styleDecls);
      } else if (m.type === 'childList') {
        rec.added = [...m.addedNodes].map(summarizeNode);
        rec.removed = [...m.removedNodes].map(summarizeNode);
      } else {
        rec.old = m.oldValue;
        rec.new = m.target.nodeValue;
      }
      pushMutation(rec);
    }
  }

  function pushMutation(rec) {
    obs.mutationTotal++;
    if (rec.who) obs.tileMutations++;
    obs.mutations.push(rec);
    if (obs.mutations.length > MAX_MUTATIONS) obs.mutations.splice(0, obs.mutations.length - MAX_MUTATIONS);
    if (settings.debug && rec.who) console.debug(LOG, 'mutation', rec);
  }

  // ------------------------------------------------------------- features
  // A "feature" is one observable fact about one element inside a tile, keyed by
  // the element's child-index path from the tile root, e.g.
  //   "T>div:0>div:1 .r-abc123"          class token present
  //   "T>div:0 [aria-label=Speaking]"    attribute value (short values only)
  //   "T>div:0 [data-x]"                 attribute present
  //   "T>div:0>svg:0 style:opacity=1"    inline style declaration
  //   "T>div:0 anim:pulse"               running CSS animation/transition
  //   "T>div:0>div:2"                    element exists

  function elementFeatures(el, path, out) {
    out.add(path);
    if (el.classList) for (const c of el.classList) out.add(`${path} .${c}`);
    for (const a of el.attributes) {
      if (SKIP_ATTRS.has(a.name)) continue;
      out.add(`${path} [${a.name}]`);
      // long values (e.g. an SVG path's d) are hashed so a swapped icon still shows up
      out.add(a.value.length <= 40 ? `${path} [${a.name}=${a.value}]` : `${path} [${a.name}#${hash(a.value)}]`);
    }
    const st = el.style;
    if (st) {
      for (let i = 0; i < st.length; i++) {
        const prop = st[i];
        const v = st.getPropertyValue(prop);
        out.add(`${path} style:${prop}`);
        out.add(v.length <= 40 ? `${path} style:${prop}=${v}` : `${path} style:${prop}#${hash(v)}`);
      }
    }
    if (el.getAnimations) {
      for (const an of el.getAnimations()) {
        out.add(`${path} anim:${an.animationName || an.transitionProperty || an.id || 'waapi'}:${an.playState}`);
      }
    }
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // X draws the speaker waveform next to the role label on a <canvas>, so the
  // animation never shows up as a DOM change. Read its pixels instead:
  //   ink = share of non-transparent pixels (dots "···" → low, tall bars → high)
  //   sig = fingerprint of the frame, to tell whether it is animating
  const INK_LEVELS = [0.05, 0.1, 0.15, 0.2, 0.3];
  const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });

  function canvasStat(cv) {
    const w = Math.min(64, cv.width || 0);
    const h = Math.min(64, cv.height || 0);
    if (!w || !h) return null;
    try {
      scratch.width = w;
      scratch.height = h;
      scratchCtx.clearRect(0, 0, w, h);
      scratchCtx.drawImage(cv, 0, 0, w, h);
      const px = scratchCtx.getImageData(0, 0, w, h).data;
      let ink = 0;
      let sig = 0x811c9dc5;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] > 32) ink++;
        sig = Math.imul(sig ^ (px[i] >> 4), 0x01000193);
      }
      return { ink: ink / (w * h), sig: sig >>> 0 };
    } catch {
      return null; // tainted canvas
    }
  }

  function canvasFeatures(el, path, out, memoMap) {
    const st = canvasStat(el);
    if (!st) return;
    for (const lvl of INK_LEVELS) if (st.ink >= lvl) out.add(`${path} ~ink>=${lvl}`);
    const key = `${path}#px`;
    const prev = memoMap && memoMap.get(key);
    if (memoMap) memoMap.set(key, st.sig);
    if (prev != null && prev !== st.sig) out.add(`${path} ~canvas-changing`);
  }

  // Box of an element relative to its tile, rounded to 0.5px. CSS animations
  // (e.g. waveform bars scaling with the voice) change this without any DOM
  // mutation, so "~moving" = box differs from the previous look.
  function relBox(el, origin) {
    const r = el.getBoundingClientRect();
    const q = (v) => Math.round(v * 2) / 2;
    return `${q(r.left - origin.left)},${q(r.top - origin.top)},${q(r.width)},${q(r.height)}`;
  }

  // prevBoxes/nextBoxes: Map<path, box> for this tile from the last/current look.
  function tileFeatures(tile, prevBoxes, nextBoxes) {
    const out = new Set();
    let count = 0;
    const origin = tile.getBoundingClientRect();
    const walk = (el, path, depth) => {
      if (++count > MAX_TILE_NODES || depth > 16) return;
      elementFeatures(el, path, out);
      if (nextBoxes) {
        const b = relBox(el, origin);
        nextBoxes.set(path, b);
        const pb = prevBoxes && prevBoxes.get(path);
        if (pb && pb !== b) out.add(`${path} ~moving`);
        if (el.tagName === 'CANVAS') {
          const prevSig = prevBoxes && prevBoxes.get(`${path}#px`);
          if (prevSig != null) nextBoxes.set(`${path}#px`, prevSig);
          canvasFeatures(el, path, out, nextBoxes);
        }
      }
      const ch = el.children;
      for (let i = 0; i < ch.length; i++) walk(ch[i], `${path}>${ch[i].tagName.toLowerCase()}:${i}`, depth + 1);
    };
    walk(tile, 'T', 0);
    return out;
  }

  function resolvePath(tile, path) {
    if (path === '*canvas') return tile.querySelector('canvas');
    let el = tile;
    const parts = path.split('>');
    for (let k = 1; k < parts.length; k++) {
      const [tag, idx] = parts[k].split(':');
      const c = el.children[Number(idx)];
      if (!c || c.tagName.toLowerCase() !== tag) return null;
      el = c;
    }
    return el;
  }

  // memo: per-participant object, used by "~moving" to remember the last box.
  function hasFeature(tile, feature, memo) {
    const sp = feature.indexOf(' ');
    const path = sp < 0 ? feature : feature.slice(0, sp);
    const el = resolvePath(tile, path);
    if (!el) {
      if (memo) memo.box = null;
      return false;
    }
    if (feature.endsWith(' ~canvas-changing')) {
      const st = el.tagName === 'CANVAS' && canvasStat(el);
      if (!st) return false;
      if (memo.sig != null && memo.sig !== st.sig) memo.movedAt = now();
      memo.sig = st.sig;
      return memo.movedAt != null && now() - memo.movedAt < 300;
    }
    const inkM = feature.match(/ ~ink>=([\d.]+)$/);
    if (inkM) {
      const st = el.tagName === 'CANVAS' && canvasStat(el);
      return !!st && st.ink >= Number(inkM[1]);
    }
    if (feature.endsWith(' ~moving')) {
      const b = relBox(el, tile.getBoundingClientRect());
      const prev = memo.box;
      memo.box = b;
      if (prev && prev !== b) memo.movedAt = now();
      // an animation frame may repeat a box between two 100ms looks: count
      // it as moving if it moved within the last 250ms
      return memo.movedAt != null && now() - memo.movedAt < 250;
    }
    const set = new Set();
    elementFeatures(el, path, set);
    return set.has(feature);
  }

  // ------------------------------------------------------ observe sampling

  function freshLevel() {
    return state.audio.on && now() - state.audio.t < 500 ? state.audio.level : null;
  }

  function trackToggle(f, key) {
    let s = obs.stats.get(f);
    if (!s) {
      if (obs.stats.size >= MAX_TRACKED) pruneStats();
      if (obs.stats.size >= MAX_TRACKED) return;
      s = { f, toggles: 0, tiles: new Set(), tileSamples: 0, present: 0, sumOn: 0, nOn: 0, sumOff: 0, nOff: 0, last: 0 };
      obs.stats.set(f, s);
    }
    s.toggles++;
    s.tiles.add(key);
    s.last = Date.now();
  }

  function pruneStats() {
    const cutoff = Date.now() - 30000;
    for (const [f, s] of obs.stats) if (s.toggles <= 2 && s.last < cutoff) obs.stats.delete(f);
  }

  function sample() {
    if (!settings.debug) return;
    obs.samples++;
    const lvl = freshLevel();
    if (lvl != null) {
      obs.levels.push([Date.now(), Math.round(lvl * 1000) / 1000]);
      if (obs.levels.length > MAX_LEVELS) obs.levels.splice(0, obs.levels.length - MAX_LEVELS);
    }
    const sets = [];
    for (const p of state.participants.values()) {
      // Listeners can't be the active speaker; their reactions/hand-raise badges are noise.
      if (!p.el.isConnected || p.role === 'listener') continue;
      const boxes = new Map();
      const cur = tileFeatures(p.el, obs.boxes.get(p.key), boxes);
      obs.boxes.set(p.key, boxes);
      sets.push(cur);
      const prev = obs.prev.get(p.key);
      obs.prev.set(p.key, cur);
      if (!prev) continue; // first look at this tile: baseline only
      for (const f of cur) if (!prev.has(f)) trackToggle(f, p.key);
      for (const f of prev) if (!cur.has(f)) trackToggle(f, p.key);
    }
    for (const s of obs.stats.values()) {
      for (const set of sets) {
        const has = set.has(s.f);
        s.tileSamples++;
        if (has) s.present++;
        if (lvl == null) continue;
        if (has) {
          s.sumOn += lvl;
          s.nOn++;
        } else {
          s.sumOff += lvl;
          s.nOff++;
        }
      }
    }
  }

  // Features that turn on and off inside host/speaker tiles, ranked by |audioΔ|:
  // mean tab-audio level over tile-samples where the feature is present minus
  // where it is absent. Positive → "present = speaking" (use); negative →
  // "absent = speaking" (use NOT, e.g. a muted-mic icon). Without audio capture
  // they are ranked by toggle count.
  function candidates(n = 8) {
    const out = [];
    for (const s of obs.stats.values()) {
      if (s.toggles < 2 || !s.tileSamples) continue;
      const presence = s.present / s.tileSamples;
      const onMean = s.nOn ? s.sumOn / s.nOn : null;
      const offMean = s.nOff ? s.sumOff / s.nOff : null;
      const delta = s.nOn >= 4 && s.nOff >= 4 ? onMean - offMean : null;
      out.push({ feature: s.f, toggles: s.toggles, tiles: s.tiles.size, presence, onMean, offMean, delta });
    }
    out.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || b.toggles - a.toggles);
    return out.slice(0, n);
  }

  function resetObserve() {
    obs.mutations = [];
    obs.mutationTotal = 0;
    obs.tileMutations = 0;
    obs.samples = 0;
    obs.stats.clear();
    obs.prev.clear();
    obs.boxes.clear();
    obs.levels = [];
    obs.startedAt = Date.now();
  }

  // ------------------------------------------------------ speaking state

  const labelOf = (p) => (p.username ? `@${p.username}` : p.displayName || p.key);

  function setSpeaking(p, on, why) {
    p.speaking = on;
    p.offSince = null;
    p.lastChange = Date.now();
    console.info(`${LOG} ${on ? 'SPEAKER_STARTED' : 'SPEAKER_STOPPED'} ${labelOf(p)}`);
    if (settings.debug) pushMutation({ t: Date.now(), who: p.key, type: on ? 'SPEAKER_STARTED' : 'SPEAKER_STOPPED', why, lvl: freshLevel() });
  }

  // Live readout for the panel: mic open (a waveform canvas is present) and the
  // canvas' ink / whether it animated in the last 300ms.
  function measureVoice() {
    const t = now();
    for (const p of state.participants.values()) {
      if (p.role === 'listener' || !p.el.isConnected) continue;
      const cv = p.el.querySelector('canvas');
      const st = cv && canvasStat(cv);
      const v = (p.voice ||= { sig: null, changedAt: null });
      v.canvas = !!cv;
      v.ink = st ? st.ink : null;
      if (st && v.sig != null && st.sig !== v.sig) v.changedAt = t;
      v.sig = st ? st.sig : null;
      v.animating = v.changedAt != null && t - v.changedAt < 300;
    }
  }

  function evaluate() {
    measureVoice();
    const rule = activeRule();
    const t = now();
    for (const p of state.participants.values()) {
      const neg = rule.startsWith('!');
      const raw = p.el.isConnected && p.role !== 'listener' && hasFeature(p.el, neg ? rule.slice(1) : rule, (p.memo ||= {})) !== neg;
      if (raw) {
        p.offSince = null;
        if (!p.speaking) setSpeaking(p, true, 'signal on');
      } else if (p.speaking) {
        if (p.offSince == null) p.offSince = t;
        else if (t - p.offSince >= settings.holdMs) setSpeaking(p, false, 'signal off');
      }
    }
  }

  let evalPending = false;
  function scheduleEval() {
    if (evalPending) return;
    evalPending = true;
    setTimeout(() => {
      evalPending = false;
      evaluate();
    }, 0);
  }

  function setRule(feature) {
    for (const p of state.participants.values()) if (p.speaking) setSpeaking(p, false, 'signal changed');
    settings.rule = feature;
    saveSettings();
    console.info(`${LOG} speaking signal = ${JSON.stringify(activeRule())}${feature ? '' : ' (default)'}`);
    evaluate();
  }

  // ------------------------------------------------------------- settings

  function saveSettings() {
    chrome.storage.local.set({ xsaSettings: settings }).catch(() => {});
  }

  // ---------------------------------------------------------------- panel

  const host = document.createElement('div');
  host.id = 'xsa-probe-host';
  host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  .p{font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#e7e9ea;background:rgba(15,20,25,.94);border:1px solid #38444d;border-radius:8px;padding:8px 10px;width:460px;max-height:80vh;overflow:auto;box-shadow:0 4px 18px rgba(0,0,0,.5)}
  .hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
  .hd b{margin-right:auto}
  button{font:inherit;color:#e7e9ea;background:#273340;border:1px solid #38444d;border-radius:4px;padding:1px 6px;cursor:pointer}
  button.on{background:#1d9bf0;border-color:#1d9bf0}
  .big{font-size:14px;font-weight:bold}
  .bar{height:6px;background:#273340;border-radius:3px;margin:3px 0 6px}
  .bar i{display:block;height:100%;width:0;background:#00ba7c;border-radius:3px}
  .dim{color:#8b98a5}
  .err{color:#f4212e}
  pre{margin:6px 0;white-space:pre}
  .sp{color:#00ba7c;font-weight:bold}
  .obs{border-top:1px solid #38444d;margin-top:6px;padding-top:6px}
  .c{display:flex;gap:6px;align-items:baseline;margin:2px 0}
  .c code{word-break:break-all}
  .mut{font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}
  .hide{display:none}
  .ov{position:fixed;inset:0;pointer-events:none}
  .box{position:fixed;border:2px solid #1d9bf0;pointer-events:none;box-sizing:border-box}
  .box.t{border-color:#8b98a5;border-width:1px}
  .box.s{border-color:#00ba7c;border-width:3px}
  .box.pick{border-color:#ffd400;border-width:2px}
</style>
<div class="ov" id="ov"></div>
<div class="p">
  <div class="hd">
    <b>XSA probe v${VERSION}</b>
    <button data-a="debug">OBSERVE: off</button>
    <button data-a="pick">Pick root</button>
    <button data-a="export">Export</button>
    <button data-a="collapse">–</button>
  </div>
  <div id="body">
    <div class="big" id="active"></div>
    <div class="big" id="audio"></div>
    <div class="bar"><i id="fill"></i></div>
    <div id="info" class="dim"></div>
    <pre id="rows"></pre>
    <div id="obs" class="obs hide"></div>
  </div>
</div>`;
  const $ = (id) => shadow.getElementById(id);
  document.querySelectorAll('#xsa-probe-host').forEach((el) => el.remove()); // older copies
  document.documentElement.appendChild(host);

  shadow.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-a]');
    if (!btn || e.button !== 0) return;
    e.preventDefault();
    const a = btn.dataset.a;
    if (a === 'debug') {
      settings.debug = !settings.debug;
      if (settings.debug) resetObserve();
      saveSettings();
      console.info(`${LOG} OBSERVE mode ${settings.debug ? 'ON' : 'OFF'}`);
    } else if (a === 'pick') {
      startPick();
    } else if (a === 'export') {
      exportData();
    } else if (a === 'collapse') {
      settings.collapsed = !settings.collapsed;
      saveSettings();
    } else if (a === 'use') {
      setRule(btn.dataset.f);
    } else if (a === 'clear') {
      setRule(null);
    } else if (a === 'reset') {
      resetObserve();
    } else if (a === 'unpick') {
      state.rootSource = 'none';
      discover();
    }
    render(true);
  });

  let lastObsRender = 0;
  function render(force = false) {
    const collapsed = settings.collapsed;
    $('body').classList.toggle('hide', collapsed);
    shadow.querySelector('[data-a="collapse"]').textContent = collapsed ? '+' : '–';
    const dbgBtn = shadow.querySelector('[data-a="debug"]');
    dbgBtn.textContent = `OBSERVE: ${settings.debug ? 'on' : 'off'}`;
    dbgBtn.classList.toggle('on', settings.debug);
    shadow.querySelector('[data-a="pick"]').classList.toggle('on', state.picking);
    drawOverlay();
    if (collapsed) return;

    const ps = [...state.participants.values()];
    // loudest first (waveform ink), when several talk at once
    const speaking = ps.filter((p) => p.speaking).sort((a, b) => ((b.voice && b.voice.ink) || 0) - ((a.voice && a.voice.ink) || 0));
    $('active').textContent = `ACTIVE SPEAKER: ${speaking.length ? speaking.map(labelOf).join(', ') : '—'}`;

    const au = state.audio;
    const fresh = freshLevel();
    if (au.error) {
      $('audio').innerHTML = `AUDIO LEVEL: <span class="err">${esc(au.error)}</span>`;
    } else if (au.on) {
      $('audio').innerHTML = `AUDIO LEVEL: ${fresh == null ? '(waiting…)' : fresh.toFixed(2)} <span class="dim" style="font-size:11px;font-weight:normal">rms ${au.rms.toFixed(4)} · ${au.hz.toFixed(0)} upd/s</span>`;
    } else {
      $('audio').innerHTML = 'AUDIO LEVEL: — <span class="dim" style="font-size:11px;font-weight:normal">(click the extension icon to capture)</span>';
    }
    $('fill').style.width = `${Math.round((fresh || 0) * 100)}%`;

    const rootTxt = state.root
      ? `${state.rootSource}${state.rootSource === 'auto' ? `, root holds ${state.rootHeld}/${state.labeledTiles} labeled tile(s) + ${state.rootOthers} other avatar(s)` : ''}`
      : 'not found — expand the Space so participants + role badges are visible, or use Pick root';
    $('info').innerHTML =
      `Space: ${state.spaceIds.length ? esc(state.spaceIds.join(', ')) : 'no /i/spaces/ id in URL or links'}<br>` +
      `Root: ${esc(rootTxt)}${state.rootSource === 'picked' ? ' <button data-a="unpick">auto</button>' : ''}<br>` +
      `Stage relay: ${state.relay === 'connected' ? '<span class="sp">connected</span> (OBS stage gets the avatars)' : state.relay === 'offline' ? 'offline — run <code>npm run relay</code>' : '—'}<br>` +
      `Signal: ${activeRule().startsWith('!') ? 'speaking while ABSENT: ' : 'speaking while present: '}<code>${esc(activeRule().replace(/^!/, ''))}</code> ${settings.rule ? '<button data-a="clear">back to default</button>' : '(default: waveform canvas animating)'}`;

    const visible = ps.filter((p) => p.role !== 'listener');
    const w = Math.min(24, Math.max(8, ...visible.map((p) => labelOf(p).length)));
    const lines = visible.slice(0, MAX_ROWS).map((p) => {
      const st = p.speaking ? '<span class="sp">SPEAKING</span>' : 'IDLE';
      const v = p.voice || {};
      const mic = v.canvas ? 'mic:open ' : v.canvas === false ? 'mic:—    ' : '         ';
      const ink = v.ink == null ? '    ' : v.ink.toFixed(2);
      return `${esc(labelOf(p).slice(0, w).padEnd(w))}  ${ROLE_LABEL[p.role].padEnd(8)}  ${mic} ${ink}${v.animating ? '~' : ' '}  ${st}`;
    });
    if (visible.length > MAX_ROWS) lines.push(`… +${visible.length - MAX_ROWS} more`);
    if (state.listenerCount) lines.push(`<span class="dim">(${state.listenerCount} listener tile(s) hidden)</span>`);
    $('rows').innerHTML = lines.join('\n') || '<span class="dim">no participant tiles found</span>';

    const o = $('obs');
    o.classList.toggle('hide', !settings.debug);
    if (!settings.debug || (!force && now() - lastObsRender < 1000)) return;
    lastObsRender = now();
    const cands = candidates(8);
    const recent = obs.mutations.slice(-15).reverse();
    o.innerHTML =
      `<div class="dim">OBSERVE since ${obs.startedAt ? clock(obs.startedAt) : '-'} · samples ${obs.samples} · mutations ${obs.mutationTotal} (in tiles ${obs.tileMutations}) · toggling features ${obs.stats.size} <button data-a="reset">reset</button></div>` +
      `<div style="margin-top:4px"><b>Speaking-signal candidates</b> <span class="dim">(host/speaker tiles only; audioΔ = level while present − while absent; highlighted button = suggested)</span></div>` +
      (cands.length
        ? cands.map((c) => `<div class="c"><button data-a="use" data-f="${esc(c.feature)}"${c.delta > 0 ? ' class="on"' : ''}>use</button><button data-a="use" data-f="!${esc(c.feature)}"${c.delta < 0 ? ' class="on"' : ''}>use NOT</button><span>${c.delta == null ? '  n/a' : (c.delta >= 0 ? '+' : '') + c.delta.toFixed(2)} ${String(c.toggles).padStart(4)}tog ${c.tiles}tile ${(c.presence * 100).toFixed(0)}%on</span><code>${esc(c.feature)}</code></div>`).join('')
        : '<div class="dim">none yet — wait for people to talk (start audio capture for audioΔ)</div>') +
      `<div style="margin-top:4px"><b>Recent mutations</b> <span class="dim">(who = tile; "-" = outside tiles, path from root R)</span></div><div class="mut">${recent.map((m) => esc(fmtMutation(m))).join('\n') || '<span class="dim">none</span>'}</div>`;
  }

  function fmtMutation(m) {
    const lvl = m.lvl == null ? '' : ` lvl=${m.lvl.toFixed(2)}`;
    let what = '';
    if (m.type === 'attributes') what = m.diff ? `${m.attr} +[${m.diff.added.join(' ')}] -[${m.diff.removed.join(' ')}]` : `${m.attr}: ${JSON.stringify(m.old)} → ${JSON.stringify(m.new)}`;
    else if (m.type === 'childList') what = `children +${m.added.length} -${m.removed.length} ${m.added.concat(m.removed).slice(0, 2).join(' ')}`;
    else if (m.type === 'characterData') what = `text ${JSON.stringify(m.old)} → ${JSON.stringify(m.new)}`;
    else what = m.why || '';
    return `${clock(m.t)} ${m.who || '-'} ${m.type === 'attributes' || m.type === 'childList' || m.type === 'characterData' ? m.path : m.type} ${what}${lvl}`;
  }

  // Outlines for the detected root and tiles (OBSERVE mode) and the pick target.
  let pickTarget = null;
  function drawOverlay() {
    const boxes = [];
    if (settings.debug && state.root) {
      boxes.push([state.root, 'box']);
      for (const p of state.participants.values()) boxes.push([p.el, p.speaking ? 'box s' : 'box t']);
    }
    if (state.picking && pickTarget) boxes.push([pickTarget, 'box pick']);
    const ov = $('ov');
    while (ov.children.length < boxes.length) ov.appendChild(document.createElement('div'));
    while (ov.children.length > boxes.length) ov.lastChild.remove();
    boxes.forEach(([el, cls], i) => {
      const r = el.getBoundingClientRect();
      const b = ov.children[i];
      b.className = cls;
      b.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    });
  }

  // ------------------------------------------------------------ pick root

  function pickRootFor(target) {
    let one = null;
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      const n = avatarSet(el).size;
      if (n >= 2) return el;
      if (n === 1 && !one) one = el;
    }
    return one;
  }

  function onPickMove(e) {
    if (host.contains(e.target)) return;
    pickTarget = pickRootFor(e.target);
    drawOverlay();
  }

  function onPickClick(e) {
    if (host.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const root = pickRootFor(e.target);
    endPick();
    if (root) {
      setRoot(root, 'picked');
      discover();
      console.info(`${LOG} root picked manually`, root);
    }
  }

  function onPickKey(e) {
    if (e.key === 'Escape') endPick();
  }

  function startPick() {
    if (state.picking) return endPick();
    state.picking = true;
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
    console.info(`${LOG} pick mode: hover the Space participant list and click (Esc cancels)`);
  }

  function endPick() {
    state.picking = false;
    pickTarget = null;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    render(true);
  }

  // --------------------------------------------------------------- export

  function exportData() {
    const data = {
      tool: 'xsa-probe',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      url: location.href,
      userAgent: navigator.userAgent,
      settings,
      space: { ids: state.spaceIds, rootSource: state.rootSource, rootHeld: state.rootHeld, rootOthers: state.rootOthers, labeledTiles: state.labeledTiles, rootHTMLHead: state.root ? state.root.outerHTML.slice(0, 2000) : null },
      audio: { ...state.audio },
      participants: [...state.participants.values()].map(({ el, ...p }) => ({ ...p, tileHTML: el.outerHTML.slice(0, 30000) })),
      observe: {
        startedAt: obs.startedAt,
        samples: obs.samples,
        candidates: candidates(50),
        featureStats: [...obs.stats.values()].sort((a, b) => b.toggles - a.toggles).slice(0, 1000).map((s) => ({ ...s, tiles: [...s.tiles] })),
        mutationTotal: obs.mutationTotal,
        tileMutations: obs.tileMutations,
        mutations: obs.mutations,
        levels: obs.levels,
      },
    };
    console.info(`${LOG} export`, data);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `xsa-observe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ------------------------------------------------------------- publish
  // Hosts/speakers with speaking state and a 0..1 voice level (waveform ink),
  // sent to background.js, which forwards it to the local relay → OBS stage.

  const bigAvatar = (u) => (u ? u.replace(/_(normal|bigger|mini|reasonably_small|x\d+|\d+x\d+)(?=\.\w+$)/, '_400x400') : null);
  let publishedEmpty = false;

  function publishState() {
    const list = [...state.participants.values()].filter((p) => p.role !== 'listener' && p.el.isConnected);
    if (!list.length) {
      if (publishedEmpty) return;
      publishedEmpty = true;
    } else {
      publishedEmpty = false;
    }
    const st = {
      t: Date.now(),
      spaceId: state.spaceIds[0] || null,
      audioLevel: freshLevel(),
      participants: list.map((p) => {
        const v = p.voice || {};
        const voice = p.speaking && v.ink != null ? Math.min(1, Math.max(0, (v.ink - 0.03) / 0.3)) : 0;
        return { key: p.key, username: p.username, displayName: p.displayName, role: p.role, avatar: bigAvatar(p.avatar), mic: !!v.canvas, speaking: !!p.speaking, voice: Math.round(voice * 1000) / 1000 };
      }),
    };
    try {
      chrome.runtime.sendMessage({ type: 'XSA_STATE', state: st }).then(
        (r) => (state.relay = r && r.relay ? r.relay : 'offline'),
        () => (state.relay = null),
      );
    } catch {
      state.relay = null; // extension reloaded; this copy is stale
    }
  }

  // -------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'XSA_PING') {
      sendResponse({ ok: true });
    } else if (msg.type === 'XSA_LEVEL') {
      Object.assign(state.audio, { on: true, level: msg.level, rms: msg.rms, peak: msg.peak, hz: msg.hz, t: now(), error: null });
    } else if (msg.type === 'XSA_AUDIO_STATE') {
      state.audio.on = !!msg.on;
      state.audio.error = msg.error || null;
      if (!msg.on) state.audio.level = 0;
      console.info(`${LOG} audio capture ${msg.on ? 'ON' : 'OFF'}${msg.error ? `: ${msg.error}` : msg.reason ? ` (${msg.reason})` : ''}`);
    }
  });

  // ------------------------------------------------------------------ boot

  chrome.storage.local.get('xsaSettings').then((v) => {
    Object.assign(settings, v.xsaSettings || {});
    if (settings.debug) resetObserve();
    console.info(`${LOG} probe loaded v${VERSION}; signal=${JSON.stringify(activeRule())}${settings.rule ? '' : ' (default)'}; observe=${settings.debug}`);
    discover();
    render(true);
  });

  timers.push(setInterval(publishState, PUBLISH_MS), setInterval(discover, DISCOVER_MS), setInterval(evaluate, EVAL_MS), setInterval(sample, SAMPLE_MS), setInterval(render, RENDER_MS));

  globalThis.__XSA_PROBE__ = {
    version: VERSION,
    alive: () => {
      try {
        return !!chrome.runtime.id;
      } catch {
        return false;
      }
    },
    stop: () => {
      timers.forEach(clearInterval);
      if (observer) observer.disconnect();
      host.remove();
    },
  };

  // Handy from DevTools (select the extension's context in the console dropdown).
  globalThis.xsa = { state, obs, settings, candidates, setRule, exportData, discover };
})();
