// Orbit Sound — ポップアップ画面
(() => {
  'use strict';
  const { PRESETS, DEFAULTS, MOTIONS, sanitize, withPreset } = globalThis.OrbitSound;

  // プリセットで変わる項目（手で動かしたら「カスタム」扱いにする）
  const PRESET_KEYS = ['orbitDepth', 'orbitSeconds', 'speed', 'bass', 'clarity', 'reverb', 'roomSize'];
  const SLIDERS = ['orbitDepth', 'orbitSeconds', 'volume', 'speed', 'bass', 'clarity', 'reverb', 'roomSize'];

  const MOTION_DESC = {
    lr: '左右に行き来し、後ろ側でこもります（最初の動き）。',
    circle: '前 → 右 → 後ろ → 左と、頭のまわりを円で回ります。',
    figure8: '顔の前で交差し、右の後ろ・左の後ろへ回り込みます。',
    spiral: '回りながら上下にも動きます（点の大きさ＝高さ）。',
    drift: '速さを変えたり戻ったりしながら、不規則に漂います。'
  };

  const fmt = {
    orbitDepth: (v) => `${Math.round(v * 100)}%`,
    orbitSeconds: (v) => `${v.toFixed(1)} 秒`,
    volume: (v) => `${Math.round(v * 100)}%`,
    speed: (v) => `×${v.toFixed(2)}`,
    bass: (v) => `+${v.toFixed(1)} dB`,
    clarity: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
    reverb: (v) => `${Math.round(v * 100)}%`,
    roomSize: (v) => `${v.toFixed(1)} 秒`
  };

  const STATUS = {
    'off':        ['off',    'オフです。スイッチかプリセットで始められます（🎧 ヘッドホン推奨）。'],
    'active':     ['active', '効果がかかっています。'],
    'waiting':    ['off',    'オンです。再生が始まると効果がかかります。'],
    'no-media':   ['off',    'オンです。このページに再生できる音声が見つかりません。'],
    'needs-click':['warn',   'ページを一度クリックすると効果がかかります（ブラウザの決まりのため）。'],
    'protected':  ['warn',   'このサイトの音声は著作権保護つきのため、加工できません（再生速度だけ変わります）。'],
    'cors':       ['warn',   'この音声は別のサイトから届いているため、加工できません。'],
    'error':      ['warn',   'この音声はほかの仕組みが使っているため、加工できません。']
  };

  const $ = (id) => document.getElementById(id);
  let tabId = null;
  let settings = sanitize({});

  // ---------- プリセット・回転の種類のボタン ----------

  function renderPresets() {
    const box = $('presets');
    for (const [name, p] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.preset = name;
      b.textContent = p.label;
      b.addEventListener('click', () => {
        settings = withPreset({ ...settings, enabled: true }, name);
        render();
        push();
      });
      box.appendChild(b);
    }
  }

  function renderMotions() {
    const box = $('motions');
    for (const [name, m] of Object.entries(MOTIONS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.motion = name;
      b.textContent = m.label;
      if (m.kind === 'hrtf') {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '3D';
        b.appendChild(tag);
      }
      b.addEventListener('click', () => {
        // 深さが 0 だと動きが分からないので、選んだときは 100% にする
        const depth = settings.orbitDepth > 0 ? settings.orbitDepth : 1;
        const preset = depth !== settings.orbitDepth ? 'custom' : settings.preset;
        settings = sanitize({ ...settings, motion: name, orbitDepth: depth, preset, enabled: true });
        render();
        push();
      });
      box.appendChild(b);
    }
  }

  // ---------- 表示 ----------

  function render() {
    $('enabled').checked = settings.enabled;
    document.body.classList.toggle('dim', !settings.enabled);
    for (const b of $('presets').children) {
      b.setAttribute('aria-pressed', String(b.dataset.preset === settings.preset));
    }
    for (const b of $('motions').children) {
      b.setAttribute('aria-checked', String(b.dataset.motion === settings.motion));
    }
    $('motion-desc').textContent = MOTION_DESC[settings.motion] || '';
    for (const key of SLIDERS) {
      $(key).value = settings[key];
      renderValue(key);
    }
  }

  function renderValue(key) {
    const out = $(`${key}-out`);
    out.textContent = fmt[key](settings[key]);
    if (key === 'volume') out.classList.toggle('loud', settings.volume > 1.5);
  }

  function showStatus(code) {
    const [kind, text] = STATUS[code] || STATUS.off;
    const el = $('status');
    el.dataset.kind = kind;
    el.textContent = text;
  }

  // ---------- 動きのアニメーション ----------
  // 拡張機能から届いた「位相（いま1周期のどこか）と速さ」を起点に、その後の経過時間ぶん進めて描く。
  // 音がまだ鳴っていないときは、同じ動きをプレビューとして描く。

  const clock = { phase: 0, freq: 1 / DEFAULTS.orbitSeconds, at: performance.now(), motion: DEFAULTS.motion, live: false };

  function syncClock(motion) {
    const now = performance.now();
    if (motion && motion.running && motion.motion === settings.motion) {
      Object.assign(clock, { phase: motion.phase, freq: motion.freq, at: now, motion: motion.motion, live: true });
    } else {
      // プレビュー：いまの見た目の位置から、設定どおりの速さで続ける
      const freq = 1 / (settings.orbitSeconds * MOTIONS[settings.motion].cycles);
      const phase = currentPhase(now);
      Object.assign(clock, { phase: settings.motion === clock.motion ? phase : 0, freq, at: now, motion: settings.motion, live: false });
    }
  }

  function currentPhase(now) {
    const p = clock.phase + ((now - clock.at) / 1000) * clock.freq;
    return ((p % 1) + 1) % 1;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const canvas = $('viz');
  const g = canvas.getContext('2d');
  const SIZE = 120;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  g.scale(dpr, dpr);

  const pathCache = new Map();
  function pathPoints(name) {
    if (pathCache.has(name)) return pathCache.get(name);
    const pts = [];
    for (let i = 0; i <= 360; i++) pts.push(MOTIONS[name].pos(i / 360));
    pathCache.set(name, pts);
    return pts;
  }

  function draw() {
    const now = performance.now();
    const c = SIZE / 2;
    const R = 44;                                   // 半径 1 の位置が中心から何 px か
    const depth = settings.orbitDepth;
    const scale = R * (0.25 + 0.75 * depth);        // 深さが浅いほど頭の近くを回る
    const on = settings.enabled && depth > 0;
    const accent = cssVar('--accent');
    const muted = cssVar('--muted');
    const line = cssVar('--line');
    const text = cssVar('--text');
    const motion = MOTIONS[clock.motion] ? clock.motion : settings.motion;
    const m = MOTIONS[motion];
    const toXY = (p) => [c + p.x * scale, c + p.z * scale]; // 上が前、右が右

    g.clearRect(0, 0, SIZE, SIZE);

    // 目盛りの円と、前後左右の文字
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.stroke();
    g.fillStyle = muted;
    g.font = '9px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('前', c, 7); g.fillText('後', c, SIZE - 7);
    g.fillText('左', 7, c); g.fillText('右', SIZE - 7, c);

    // 通り道（うすい点線）
    const pts = pathPoints(motion);
    g.save();
    g.setLineDash([2, 3]);
    g.strokeStyle = on ? accent : muted;
    g.globalAlpha = on ? 0.35 : 0.25;
    g.beginPath();
    pts.forEach((p, i) => { const [x, y] = toXY(p); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.restore();

    // 頭（上から見た図。三角が鼻＝前、両側の楕円が耳）
    g.fillStyle = text;
    g.globalAlpha = 0.85;
    g.beginPath(); g.ellipse(c - 13, c, 2.5, 5, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(c + 13, c, 2.5, 5, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(c - 4, c - 11); g.lineTo(c, c - 17); g.lineTo(c + 4, c - 11); g.fill();
    g.beginPath(); g.arc(c, c, 12, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;

    if (on) {
      const phase = currentPhase(now);
      // 軌跡（直前 0.8 秒ぶん）
      const span = Math.min(0.25, clock.freq * 0.8);
      for (let i = 12; i >= 1; i--) {
        const p = m.pos(((phase - (span * i) / 12) % 1 + 1) % 1);
        const [x, y] = toXY(p);
        g.fillStyle = accent;
        g.globalAlpha = 0.5 * (1 - i / 13);
        g.beginPath(); g.arc(x, y, 2 + 2 * (1 - i / 13), 0, Math.PI * 2); g.fill();
      }
      // 音の粒（大きさで高さを表す）
      const p = m.pos(phase);
      const [x, y] = toXY(p);
      const r = 5.5 + 3.5 * p.y;
      g.globalAlpha = 0.25;
      g.fillStyle = accent;
      g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();

      // 高さのメーター（上下に動く種類だけ）
      if (motion === 'spiral' || motion === 'drift') {
        // 右下のすみ（「右」の文字と円にかからない場所）に置く
        const top = 74, bottom = SIZE - 8, mx = SIZE - 6;
        g.strokeStyle = line; g.lineWidth = 3; g.lineCap = 'round';
        g.beginPath(); g.moveTo(mx, top); g.lineTo(mx, bottom); g.stroke();
        const my = (top + bottom) / 2 - p.y * (bottom - top) / 2 / 0.6;
        g.fillStyle = accent;
        g.beginPath(); g.arc(mx, Math.max(top, Math.min(bottom, my)), 3, 0, Math.PI * 2); g.fill();
      }
    }

    const note = $('viz-note');
    if (!settings.enabled) note.textContent = 'オフ';
    else if (depth === 0) note.textContent = '回転の深さ 0%';
    else note.textContent = clock.live ? '' : 'プレビュー';

    requestAnimationFrame(draw);
  }

  // ---------- 拡張機能とのやりとり ----------

  function send(message) {
    return chrome.tabs.sendMessage(tabId, message);
  }

  async function push() {
    syncClock(null);
    try {
      const res = await send({ type: 'orbit:set', settings });
      if (res) { showStatus(res.status); syncClock(res.motion); }
    } catch (_) {
      showUnsupported();
    }
  }

  function showUnsupported() {
    $('controls').hidden = true;
    $('unsupported').hidden = false;
    $('status').hidden = true;
    $('enabled').disabled = true;
    $('enabled').closest('.top-actions').hidden = true;
  }

  function bind() {
    $('enabled').addEventListener('change', (e) => {
      settings = sanitize({ ...settings, enabled: e.target.checked });
      render();
      push();
    });
    for (const key of SLIDERS) {
      $(key).addEventListener('input', (e) => {
        const next = { ...settings, [key]: Number(e.target.value), enabled: true };
        if (PRESET_KEYS.includes(key)) next.preset = 'custom';
        settings = sanitize(next);
        render();
        push();
      });
    }
    $('reset').addEventListener('click', () => {
      settings = sanitize({ ...DEFAULTS, enabled: settings.enabled });
      render();
      push();
    });
    // 「音質」の欄を開いたか閉じたかを覚えておく（この画面だけの便利機能）
    const tone = $('tone');
    try { tone.open = localStorage.getItem('orbit:toneOpen') === '1'; } catch (_) {}
    tone.addEventListener('toggle', () => {
      try { localStorage.setItem('orbit:toneOpen', tone.open ? '1' : '0'); } catch (_) {}
    });
  }

  async function init() {
    renderPresets();
    renderMotions();
    bind();
    render();
    syncClock(null);
    requestAnimationFrame(draw);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return showUnsupported();
      tabId = tab.id;
      const res = await send({ type: 'orbit:get' });
      if (!res) return showUnsupported();
      settings = sanitize(res.settings);
      render();
      showStatus(res.status);
      syncClock(res.motion);
      // 開いている間は状態とアニメーションの位置を見直す
      setInterval(async () => {
        try {
          const r = await send({ type: 'orbit:get' });
          if (r) { showStatus(r.status); syncClock(r.motion); }
        } catch (_) { /* タブが閉じられた等 */ }
      }, 1000);
    } catch (_) {
      showUnsupported();
    }
  }

  init();
})();
