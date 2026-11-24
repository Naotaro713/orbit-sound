// Orbit Sound — ポップアップ画面（A. ステージ × 淡いパステル）
(() => {
  'use strict';
  const { PRESETS, DEFAULTS, MOTIONS, BOUNCE, sanitize } = globalThis.OrbitSound;

  // 確認用ページ（tests/popup-preview.html）から開かれたときは、偽物の拡張機能につなぐ。
  // 本物のポップアップでは window.parent === window なので、常に chrome.tabs を使う。
  // （ファイルとして直接開いた場合は、外側のページにさわれず例外になるので、そのときは使わない）
  let stub = null;
  try { if (window.parent !== window) stub = window.parent.__orbitPopupStub || null; } catch (_) { stub = null; }
  const tabsApi = stub || (globalThis.chrome && chrome.tabs) || null;


  // ---------- 動き・音色の定義 ----------
  const MOTION_ORDER = ['none', 'lr', 'circle', 'figure8', 'spiral', 'drift'];
  const MOTION_LABEL = { none: 'なし', lr: '左右', circle: '円', figure8: '8の字', spiral: 'らせん', drift: 'ゆらぎ' };
  const MOTION_SUB = { none: '回転なし', lr: '左右に行き来する', circle: '頭のまわりを円で回る', figure8: '前で交差して回り込む', spiral: '回りながら上下にも動く', drift: '速さを変えて漂う' };

  // 音色＝プリセットのうち「音」に関わる値だけ（回転の深さ・速さは動き側で決める）
  const TONE_ORDER = ['flat', 'slowed', 'spedup', 'bass', 'hall'];
  const TONE_LABEL = { flat: 'そのまま', slowed: 'Slowed', spedup: 'Sped Up', bass: '重低音', hall: 'ホール', custom: 'カスタム' };
  const TONE_TITLE = { flat: 'そのまま', slowed: 'Slowed + Reverb', spedup: 'Sped Up', bass: '重低音', hall: 'ホール', custom: 'カスタム' };
  const TONE_KEYS = ['speed', 'bass', 'clarity', 'reverb', 'roomSize'];

  // Beat Sync：オフ／テンポに合わせて回る／拍ごとに跳ねて進む
  const BEAT_ORDER = ['off', 'sync', 'bounce'];
  const BEAT_LABEL = { off: 'オフ', sync: '合わせる', bounce: '跳ねる' };
  const BEAT_TITLE = { off: '拍に関係なく回る', sync: '曲のテンポに合わせて回る（拍の瞬間に 前・右・後ろ・左 などに来る）', bounce: '拍ごとに「ぽん」と進んで止まる' };
  // 拍に合わせるとき、回転の速さのスライダーは「何拍で1周」を選ぶ。右ほど速い（少ない拍で1周）
  const TURN_ORDER = [16, 8, 4, 2, 1];

  const STATUS = {
    'off':         ['off',    'オフ',               ''],
    'active':      ['active', '効いています',        ''],
    'waiting':     ['off',    '再生を待っています',  ''],
    'no-media':    ['off',    '音声が見つかりません', 'このページには、再生できる動画や音声がありません。'],
    'needs-click': ['warn',   'ページを一度クリック', 'ブラウザの決まりで、ページを一度クリックするまで音を加工できません。'],
    'protected':   ['warn',   '加工できない音声',    '著作権保護つきの音声のため加工できません。再生速度だけ変わります。'],
    'cors':        ['warn',   '加工できない音声',    '別のサイトから届く音声のため加工できません。'],
    'error':       ['warn',   '加工できない音声',    'ほかの仕組みが使っている音声のため加工できません。']
  };

  const $ = (id) => document.getElementById(id);
  let tabId = null;
  let settings = sanitize({});
  let lastDepth = 1; // 「なし」から戻したときの回転の深さ
  let status = 'off';
  let accent = '#6E8FD6'; // いまの音色の色（粒・線・ヘッドホン）

  // 回転の速さ（0〜100）⇔ 1周の秒数（20秒〜2秒）。右へ動かすほど速くなる
  const rateToSeconds = (v) => 20 * Math.pow(0.1, v / 100);
  const secondsToRate = (s) => Math.round((Math.log(s / 20) / Math.log(0.1)) * 100);

  const fmt = {
    volume: (v) => `${Math.round(v * 100)}%`,
    orbitRate: () => (settings.beat === 'off' ? `${settings.orbitSeconds.toFixed(1)}秒/周` : `${settings.beatsPerTurn}拍/周`),
    orbitDepth: (v) => `${Math.round(v * 100)}%`,
    spatial: (v) => `${Math.round(v * 100)}%`,
    speed: (v) => `×${v.toFixed(2)}`,
    bass: (v) => `+${v.toFixed(1)} dB`,
    clarity: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
    reverb: (v) => `${Math.round(v * 100)}%`,
    roomSize: (v) => `${v.toFixed(1)} 秒`
  };
  const SHEET_SLIDERS = ['orbitDepth', 'spatial', 'speed', 'bass', 'clarity', 'reverb', 'roomSize'];

  const toneOf = (s) => (TONE_ORDER.includes(s.preset) ? s.preset : 'custom');
  const motionOf = (s) => (s.orbitDepth === 0 ? 'none' : s.motion);

  // ---------- 動きのアイコン（線の絵。色は文字色に合わせて変わる） ----------
  // 28×28 の中で、通り道・動く向きの矢印・頭（中心の丸）を描く。
  const TAU = Math.PI * 2;
  const ICONS = {
    lr:      { path: (t) => ({ x: 4 + 20 * t, y: 14 }), arrows: [[0.02, -1], [0.98, 1]], head: true, gap: true },
    circle:  { path: (t) => ({ x: 14 + 9.5 * Math.sin(TAU * t), y: 14 - 9.5 * Math.cos(TAU * t) }), arrows: [[0.17, 1]], head: true },
    figure8: { path: (t) => { const a = TAU * t, d = 1 + Math.sin(a) ** 2; return { x: 14 + 11 * Math.cos(a) / d, y: 14 + 13 * Math.sin(a) * Math.cos(a) / d }; }, arrows: [[0.1, 1]] },
    spiral:  { path: (t) => { const a = TAU * 2.25 * t; return { x: 14 + 8 * Math.sin(a), y: 4.5 + 19 * t - 2.4 * Math.cos(a) }; }, arrows: [[0.985, 1]] },
    drift:   { path: (t) => { const a = TAU * t, r = 9 + 1.5 * Math.sin(3 * a + .6) + .8 * Math.sin(5 * a); return { x: 14 + r * Math.sin(a), y: 14 - r * Math.cos(a) }; }, arrows: [[0.2, 1]], head: true }
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  function iconSvg(name) {
    const svg = svgEl('svg', { viewBox: '0 0 28 28', 'aria-hidden': 'true' });
    if (name === 'none') {
      // 回らない：うすい円に斜線、中心に頭
      svg.appendChild(svgEl('circle', { cx: 14, cy: 14, r: 9.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, opacity: .45 }));
      svg.appendChild(gapMask(name));
      const slash = svgEl('line', { class: 'ic-slash', x1: 7.3, y1: 20.7, x2: 20.7, y2: 7.3, stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', mask: `url(#ic-gap-${name})` });
      svg.appendChild(slash);
      svg.appendChild(svgEl('circle', { cx: 14, cy: 14, r: 3, fill: 'currentColor' }));
      return svg;
    }
    const ic = ICONS[name];
    const N = 120;
    let d = '';
    for (let i = 0; i <= N; i++) { const p = ic.path(i / N); d += `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`; }
    if (name !== 'lr' && name !== 'spiral') d += 'Z';
    // 通り道と矢印はひとまとまり（マウスを乗せたとき、まとめて回すため）
    const turn = svgEl('g', { class: 'ic-turn' });
    if (ic.gap) { svg.appendChild(gapMask(name)); turn.setAttribute('mask', `url(#ic-gap-${name})`); }
    turn.appendChild(svgEl('path', { class: 'ic-path', d, pathLength: 100, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    // 動く向きの矢印（その位置での進む向きに三角を置く）
    ic.arrows.forEach(([t, dir], i) => {
      const p = ic.path(t), q = ic.path(Math.min(1, Math.max(0, t + 0.01 * dir)));
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      const s = 3.4;
      const pts = [[s, 0], [-s * .7, s * .75], [-s * .7, -s * .75]]
        .map(([x, y]) => `${(p.x + x * Math.cos(ang) - y * Math.sin(ang)).toFixed(2)},${(p.y + x * Math.sin(ang) + y * Math.cos(ang)).toFixed(2)}`).join(' ');
      turn.appendChild(svgEl('polygon', { class: `ic-arrow ic-arrow-${i}`, points: pts, fill: 'currentColor', 'stroke-linejoin': 'round' }));
    });
    svg.appendChild(turn);
    if (ic.head) svg.appendChild(svgEl('circle', { cx: 14, cy: 14, r: 3, fill: 'currentColor' }));
    return svg;
  }

  // 頭のまわりだけ線を切り抜く型（ガラスの上でも、頭と線のあいだにすき間ができる）
  function gapMask(name) {
    const defs = svgEl('defs', {});
    const mask = svgEl('mask', { id: `ic-gap-${name}`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 28, height: 28 });
    mask.appendChild(svgEl('rect', { x: -4, y: -4, width: 36, height: 36, fill: '#fff' }));
    mask.appendChild(svgEl('circle', { cx: 14, cy: 14, r: 5.2, fill: '#000' }));
    defs.appendChild(mask);
    return defs;
  }

  // ---------- ボタンを作る ----------
  // 選んだボタンの下で、白いつまみが滑って移動する（iPhone の切り替えボタンと同じ動き）
  function addThumb(box) {
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    thumb.setAttribute('aria-hidden', 'true');
    box.appendChild(thumb);
  }
  function moveThumb(box) {
    const thumb = box.querySelector('.thumb');
    const sel = box.querySelector('button[aria-checked="true"]');
    if (!thumb) return;
    if (!sel || !sel.offsetWidth) { thumb.style.opacity = '0'; return; }
    thumb.style.opacity = '1';
    thumb.style.width = `${sel.offsetWidth}px`;
    thumb.style.height = `${sel.offsetHeight}px`;
    thumb.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop}px)`;
  }
  function moveThumbs() { moveThumb($('motions')); moveThumb($('tones')); moveThumb($('beats')); }
  // 開いた直後は滑らせずに置き、設定を読み込んだあとの操作から滑らせる
  function enableSlide() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const id of ['motions', 'tones', 'beats']) $(id).classList.add('slide-ready');
    }));
  }

  function buildMotions() {
    const box = $('motions');
    addThumb(box);
    for (const name of MOTION_ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.motion = name;
      b.title = `${MOTION_LABEL[name]}：${MOTION_SUB[name]}`; // 名前は、押す前に出る説明で分かる
      b.setAttribute('aria-label', MOTION_LABEL[name]);
      b.appendChild(iconSvg(name));
      b.addEventListener('click', () => pickMotion(name));
      box.appendChild(b);
    }
  }
  function buildTones() {
    const box = $('tones');
    addThumb(box);
    for (const name of TONE_ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.tone = name;
      b.title = TONE_TITLE[name];
      b.textContent = TONE_LABEL[name];
      b.addEventListener('click', () => pickTone(name));
      box.appendChild(b);
    }
  }
  function buildBeats() {
    const box = $('beats');
    addThumb(box);
    for (const name of BEAT_ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.beat = name;
      b.title = BEAT_TITLE[name];
      b.textContent = BEAT_LABEL[name];
      b.addEventListener('click', () => pickBeat(name));
      box.appendChild(b);
    }
  }

  // ---------- 操作 ----------
  function update(next) {
    settings = sanitize(next);
    render();
    push();
  }
  function pickMotion(name) {
    if (name === 'none') {
      if (settings.orbitDepth > 0) lastDepth = settings.orbitDepth;
      update({ ...settings, orbitDepth: 0, enabled: true });
    } else {
      const depth = settings.orbitDepth > 0 ? settings.orbitDepth : lastDepth;
      update({ ...settings, motion: name, orbitDepth: depth, enabled: true });
    }
  }
  function pickBeat(name) {
    const next = { ...settings, beat: name, enabled: true };
    if (name !== 'off' && next.orbitDepth === 0) next.orbitDepth = lastDepth; // 拍に合わせるなら回す
    update(next);
  }
  function pickTone(name) {
    const values = {};
    for (const k of TONE_KEYS) values[k] = PRESETS[name][k];
    update({ ...settings, ...values, preset: name, enabled: true });
  }

  // ---------- 表示 ----------
  function render() {
    const on = settings.enabled;
    const tone = toneOf(settings);
    const motion = motionOf(settings);

    // 音色の色は body に付けて、面・ボタン・スライダーをまとめて変える
    document.body.dataset.tone = tone;
    document.body.classList.toggle('off', !on);
    accent = getComputedStyle(document.body).getPropertyValue('--tone-accent').trim() || '#6E8FD6';
    $('power').setAttribute('aria-pressed', String(on));
    $('power').setAttribute('aria-label', on ? '効果をオフにする' : '効果をオンにする');
    $('tone-name').textContent = TONE_TITLE[tone];
    $('stage-sub').hidden = on; // 説明はオフのときの「頭をタップで始める」だけ

    for (const b of $('motions').querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.motion === motion));
    }
    for (const b of $('tones').querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.tone === tone));
    }
    for (const b of $('beats').querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.beat === settings.beat));
    }
    moveThumbs();

    $('volume').value = settings.volume;
    $('volume-out').textContent = fmt.volume(settings.volume);
    $('volume-out').classList.toggle('loud', settings.volume > 1.5);
    // 拍に合わせるときは、スライダーが「何拍で1周」（5段）に変わる
    const rate = $('orbitRate');
    if (settings.beat === 'off') {
      rate.max = '100';
      rate.value = secondsToRate(settings.orbitSeconds);
      rate.setAttribute('aria-valuetext', fmt.orbitRate());
    } else {
      rate.max = String(TURN_ORDER.length - 1);
      rate.value = TURN_ORDER.indexOf(settings.beatsPerTurn);
      rate.setAttribute('aria-valuetext', `${settings.beatsPerTurn}拍で1周`);
    }
    $('orbitRate-out').textContent = fmt.orbitRate();
    showBeat();
    for (const key of SHEET_SLIDERS) {
      $(key).value = settings[key];
      $(`${key}-out`).textContent = fmt[key](settings[key]);
    }
    // スライダーの塗る割合（popup.css の --pct）
    for (const input of document.querySelectorAll('input[type="range"]')) {
      const pct = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
      input.style.setProperty('--pct', `${pct}%`);
    }
    showStatus(status);
  }

  function showStatus(code) {
    status = code;
    const [kind, text, long] = STATUS[settings.enabled ? code : 'off'] || STATUS.off;
    const chip = $('chip');
    chip.dataset.kind = kind;
    $('chip-text').textContent = text;
    $('notice').hidden = !long;
    $('notice').textContent = long;
  }

  // 拍の欄の右側：測っている間は「測定中」、決まったらテンポ（BPM）
  function showBeat() {
    const out = $('bpm-out');
    const b = clock.live ? clock.beat : null;
    const locked = settings.enabled && settings.beat !== 'off' && b && b.bpm > 0;
    out.classList.toggle('locked', !!locked);
    if (!settings.enabled || settings.beat === 'off') out.textContent = '';
    else if (locked) out.textContent = `♩${b.bpm}`;
    else out.textContent = status === 'active' ? '測定中' : '';
    out.title = locked ? `いまの曲のテンポ：${b.bpm} BPM（1分あたりの拍の数）` : '曲を数秒聞いて、テンポを測っています';
  }

  // ---------- 動きのアニメーション ----------
  // 拡張機能から届いた「位相（いま1周期のどこか）と速さ」を起点に、経過時間ぶん進めて描く。
  const clock = { phase: 0, freq: 1 / DEFAULTS.orbitSeconds, at: performance.now(), motion: DEFAULTS.motion, live: false, beat: null };
  function currentPhase(now) {
    const p = clock.phase + ((now - clock.at) / 1000) * clock.freq;
    const ph = ((p % 1) + 1) % 1;
    // 跳ねるとき：1拍の中で、最初にすばやく進んで残りは止まる（音と同じ BOUNCE の形）
    const b = clock.live ? clock.beat : null;
    if (b && b.mode === 'bounce' && b.bpm > 0) {
      const x = ph * b.perPeriod, k = Math.floor(x), g = x - k;
      let done = 0;
      for (const [a, z, mult] of BOUNCE) done += Math.max(0, Math.min(g, z) - a) * mult;
      return ((k + Math.min(1, done)) / b.perPeriod) % 1;
    }
    return ph;
  }
  function syncClock(motion) {
    const now = performance.now();
    if (motion && motion.running && motion.motion === settings.motion) {
      Object.assign(clock, { phase: motion.phase, freq: motion.freq, at: now, motion: motion.motion, live: true, beat: motion.beat || null });
    } else {
      const freq = 1 / (settings.orbitSeconds * MOTIONS[settings.motion].cycles);
      const phase = settings.motion === clock.motion ? currentPhase(now) : 0;
      Object.assign(clock, { phase, freq, at: now, motion: settings.motion, live: false, beat: null });
    }
    showBeat();
  }

  // 頭の中心は面の上から 122px（頭のボタンと同じ位置）。キャンバスは面の上から 4px ずれている
  const W = 332, H = 252, CX = W / 2, CY = 118, R = 84;
  const canvas = $('viz');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const pathCache = new Map();
  function pathPoints(name) {
    if (!pathCache.has(name)) pathCache.set(name, Array.from({ length: 721 }, (_, i) => MOTIONS[name].pos(i / 720)));
    return pathCache.get(name);
  }

  // 上から見た人：肩・頭（髪と顔）・鼻・ヘッドホン。上が顔の向き（前）
  // すりガラスの画面に合わせ、白〜淡い灰色のつややかな丸みで描く（濃い色は使わない）
  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }
  function drawPerson(alpha) {
    g.save();
    g.globalAlpha = alpha;
    const HX = CX, HY = CY - 1, HRX = 13, HRY = 15; // 頭の中心と半径

    // 床に落ちる、ぼんやりした影
    g.save();
    g.filter = 'blur(6px)';
    g.fillStyle = 'rgba(30,35,60,.10)';
    g.beginPath(); g.ellipse(CX, CY + 12, 32, 12, 0, 0, TAU); g.fill();
    g.restore();

    // 肩：すりガラスのような半透明の丸い板
    const sh = g.createLinearGradient(0, CY - 4, 0, CY + 20);
    sh.addColorStop(0, 'rgba(255,255,255,.95)');
    sh.addColorStop(1, 'rgba(255,255,255,.55)');
    g.fillStyle = sh;
    g.beginPath(); g.ellipse(CX, CY + 8, 30, 12, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 1;
    g.stroke();

    // 鼻（顔の前の小さなふくらみ）
    const nose = g.createRadialGradient(HX - 1, HY - 16.5, .5, HX, HY - 15.5, 3.2);
    nose.addColorStop(0, '#FDF1EA'); nose.addColorStop(1, '#EFD6C8');
    g.fillStyle = nose;
    g.beginPath(); g.ellipse(HX, HY - 15.2, 2.6, 2.4, 0, 0, TAU); g.fill();

    // 頭：つやのある球（前は顔、うしろは淡い灰色の髪）
    g.save();
    g.beginPath(); g.ellipse(HX, HY, HRX, HRY, 0, 0, TAU); g.clip();
    const face = g.createRadialGradient(HX - 4, HY - 9, 1, HX, HY, 18);
    face.addColorStop(0, '#FFF6F1'); face.addColorStop(1, '#F0D9CC');
    g.fillStyle = face; g.fillRect(HX - 16, HY - 18, 32, 36);
    const hair = g.createLinearGradient(0, HY - 8, 0, HY + 15);
    hair.addColorStop(0, '#C9CBD3'); hair.addColorStop(1, '#9EA2AE');
    g.fillStyle = hair;
    g.beginPath();
    g.moveTo(HX - 16, HY);
    g.bezierCurveTo(HX - 8, HY - 9.5, HX + 8, HY - 9.5, HX + 16, HY); // 生えぎわ（前の3分の1は顔）
    g.lineTo(HX + 16, HY + 18); g.lineTo(HX - 16, HY + 18); g.closePath(); g.fill();
    // 頭のてっぺんの光
    const shine = g.createRadialGradient(HX - 4, HY - 2, 0, HX - 4, HY - 2, 9);
    shine.addColorStop(0, 'rgba(255,255,255,.55)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = shine; g.fillRect(HX - 16, HY - 18, 32, 36);
    // 目（ごく控えめに）
    g.fillStyle = 'rgba(110,110,120,.75)';
    g.beginPath(); g.arc(HX - 4.3, HY - 10.3, 1, 0, TAU); g.fill();
    g.beginPath(); g.arc(HX + 4.3, HY - 10.3, 1, 0, TAU); g.fill();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1;
    g.beginPath(); g.ellipse(HX, HY, HRX, HRY, 0, 0, TAU); g.stroke();

    // ヘッドホン：音色の色に、上から光が当たったつや
    g.strokeStyle = accent; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(HX - 13, HY + 2); g.quadraticCurveTo(HX, HY + 5.5, HX + 13, HY + 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(HX - 10, HY + 1.6); g.quadraticCurveTo(HX, HY + 4.4, HX + 10, HY + 1.6); g.stroke();
    for (const x of [HX - 19.5, HX + 12.5]) {
      g.fillStyle = accent;
      roundRect(x, HY - 5.5, 7, 14, 3.5); g.fill();
      const gloss = g.createLinearGradient(x, HY - 5.5, x + 7, HY + 8.5);
      gloss.addColorStop(0, 'rgba(255,255,255,.6)'); gloss.addColorStop(.6, 'rgba(255,255,255,0)');
      g.fillStyle = gloss;
      roundRect(x, HY - 5.5, 7, 14, 3.5); g.fill();
    }

    g.restore();
  }

  function draw(now) {
    const on = settings.enabled;
    const depth = settings.orbitDepth;
    const moving = on && depth > 0;
    const name = MOTIONS[clock.motion] ? clock.motion : settings.motion;
    const m = MOTIONS[name];
    const scale = R * (0.3 + 0.7 * (depth || 1));
    const XY = (p) => [CX + p.x * scale, CY + p.z * scale];

    g.clearRect(0, 0, W, H);

    // 通り道：淡く太い帯の上に、細い実線（点線は重なると雑に見えるため使わない）
    const route = new Path2D();
    pathPoints(name).forEach((p, i) => { const [x, y] = XY(p); i ? route.lineTo(x, y) : route.moveTo(x, y); });
    g.save();
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = accent;
    g.globalAlpha = moving ? 0.13 : 0.07;
    g.lineWidth = 8;
    g.stroke(route);
    g.lineWidth = 1.2;
    if (m.cycles > 1 && moving) {
      // 何周もする形は、細い線を「粒がいま回っている1周ぶん」だけにして、両端を薄く消す（線が重ならない）
      const ph = reduceMotion ? 0.12 : currentPhase(now);
      const span = 1 / m.cycles, N = 96;
      for (let i = 0; i < N; i++) {
        const u0 = i / N - 0.5, u1 = (i + 1) / N - 0.5;
        const [x0, y0] = XY(m.pos((((ph + u0 * span) % 1) + 1) % 1));
        const [x1, y1] = XY(m.pos((((ph + u1 * span) % 1) + 1) % 1));
        g.globalAlpha = 0.55 * Math.pow(1 - Math.abs((u0 + u1) / 2) * 2, 0.8);
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
    } else {
      g.globalAlpha = moving ? 0.5 : 0.22;
      g.stroke(route);
    }
    g.restore();

    // オフのとき：頭のまわりに、ゆっくり広がる輪（「ここを押す」の合図）
    if (!on && !reduceMotion) {
      const t = (now / 1800) % 1;
      g.strokeStyle = `rgba(42,45,56,${0.22 * (1 - t)})`;
      g.lineWidth = 2;
      g.beginPath(); g.arc(CX, CY, 34 + t * 22, 0, Math.PI * 2); g.stroke();
    }

    drawPerson(on ? 1 : 0.8);

    if (moving) {
      const phase = reduceMotion ? 0.12 : currentPhase(now);
      const p = m.pos(phase);
      const [x, y] = XY(p);
      const r = 8 + 4 * p.y; // 大きさで高さを表す
      // 音の粒：白い縁と、音色の色だけ
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(x, y, r + 2.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = accent;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    requestAnimationFrame(draw);
  }

  // ---------- 詳しい調整（せり上がる板） ----------
  function openSheet() {
    const sheet = $('sheet'), scrim = $('scrim');
    sheet.hidden = false; scrim.hidden = false;
    requestAnimationFrame(() => { sheet.classList.add('show'); scrim.classList.add('show'); });
    $('open-sheet').setAttribute('aria-expanded', 'true');
    $('close-sheet').focus({ preventScroll: true });
  }
  function closeSheet() {
    const sheet = $('sheet'), scrim = $('scrim');
    sheet.classList.remove('show'); scrim.classList.remove('show');
    const done = () => { sheet.hidden = true; scrim.hidden = true; };
    if (reduceMotion) done(); else setTimeout(done, 250);
    $('open-sheet').setAttribute('aria-expanded', 'false');
    $('open-sheet').focus({ preventScroll: true });
  }

  // ---------- 拡張機能とのやりとり ----------
  function send(message) { return tabsApi.sendMessage(tabId, message); }

  async function push() {
    syncClock(null);
    try {
      const res = await send({ type: 'orbit:set', settings });
      if (res) { showStatus(res.status); syncClock(res.motion); }
    } catch (_) {
      showUnsupported();
    }
  }

  // ---------- 左右チェック ----------
  let checking = false;
  function checkMsg(text, side) {
    const el = $('check-msg');
    el.textContent = text;
    el.classList.toggle('side', !!side);
  }
  // 左 → 右 の表示を、音に合わせて切り替える
  function runCheck(btn, half, doneText) {
    checking = true;
    for (const b of [$('check-beep'), $('check-page')]) b.disabled = b !== btn;
    btn.setAttribute('aria-pressed', 'true');
    checkMsg('◀ 左耳から聞こえますか', true);
    setTimeout(() => checkMsg('右耳から聞こえますか ▶', true), half * 1000);
    setTimeout(() => {
      checking = false;
      for (const b of [$('check-beep'), $('check-page')]) b.disabled = false;
      btn.setAttribute('aria-pressed', 'false');
      checkMsg(doneText);
    }, half * 2000 + 150);
  }

  // ピッ音で：ポップアップ自身が鳴らす（ページや拡張機能の処理を通らない）
  function beepCheck() {
    if (checking) return;
    let ac;
    try { ac = new AudioContext(); } catch (_) { checkMsg('この画面では音を鳴らせませんでした'); return; }
    const t0 = ac.currentTime + 0.05, half = 1.2;
    const beep = (t, pan) => {
      const o = ac.createOscillator();
      o.frequency.value = 880;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.01);
      g.gain.setValueAtTime(0.16, t + 0.13);
      g.gain.linearRampToValueAtTime(0, t + 0.16);
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      o.connect(g).connect(p).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.17);
    };
    for (let i = 0; i < 3; i++) beep(t0 + i * 0.3, -1);
    for (let i = 0; i < 3; i++) beep(t0 + half + i * 0.3, 1);
    runCheck($('check-beep'), half, '左→右と聞こえたら、機器は正常です');
    setTimeout(() => ac.close().catch(() => {}), half * 2000 + 300);
  }

  // 動画の音で：再生中の動画の音を、左だけ → 右だけ に寄せてもらう
  const PROBE_REASON = {
    off: 'オンにしてから試してください',
    paused: '動画を再生しながら押してください',
    waiting: '動画を再生しながら押してください',
    'no-media': '動画を再生しながら押してください',
    'needs-click': 'ページを一度クリックしてから試してください',
    protected: '保護つきの音声なので、試せません',
    cors: 'この音声は加工できないので、試せません',
    error: 'この音声は加工できないので、試せません'
  };
  async function pageCheck() {
    if (checking) return;
    try {
      const res = await send({ type: 'orbit:probe' });
      if (!res || !res.ok) { checkMsg(PROBE_REASON[res && res.reason] || '試せませんでした。ページを再読み込みしてください'); return; }
      runCheck($('check-page'), res.seconds / 2, '左→右と聞こえたら、拡張機能は正常です');
    } catch (_) {
      checkMsg('試せませんでした。ページを再読み込みしてください');
    }
  }

  function showUnsupported() {
    $('controls').hidden = true;
    $('unsupported').hidden = false;
  }

  function bind() {
    $('power').addEventListener('click', () => update({ ...settings, enabled: !settings.enabled }));
    $('volume').addEventListener('input', (e) => update({ ...settings, volume: Number(e.target.value), enabled: true }));
    $('orbitRate').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      const next = settings.beat === 'off'
        ? { ...settings, orbitSeconds: Math.round(rateToSeconds(v) * 10) / 10, enabled: true }
        : { ...settings, beatsPerTurn: TURN_ORDER[Math.max(0, Math.min(TURN_ORDER.length - 1, Math.round(v)))], enabled: true };
      if (next.orbitDepth === 0) next.orbitDepth = lastDepth; // 速さを触ったら回す
      update(next);
    });
    for (const key of SHEET_SLIDERS) {
      $(key).addEventListener('input', (e) => {
        const next = { ...settings, [key]: Number(e.target.value), enabled: true };
        if (TONE_KEYS.includes(key)) next.preset = 'custom';
        if (key === 'orbitDepth' && next.orbitDepth > 0) lastDepth = next.orbitDepth;
        update(next);
      });
    }
    $('reset').addEventListener('click', () => update({ ...DEFAULTS, enabled: settings.enabled }));
    $('check-beep').addEventListener('click', beepCheck);
    $('check-page').addEventListener('click', pageCheck);
    $('open-sheet').addEventListener('click', openSheet);
    $('close-sheet').addEventListener('click', closeSheet);
    $('scrim').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) { e.preventDefault(); closeSheet(); } });
  }

  async function init() {
    buildMotions();
    buildTones();
    buildBeats();
    bind();
    render();
    syncClock(null);
    requestAnimationFrame(draw);
    if (!tabsApi) return showUnsupported(); // 拡張機能の外で開かれた
    try {
      const [tab] = await tabsApi.query({ active: true, currentWindow: true });
      if (!tab) return showUnsupported();
      tabId = tab.id;
      const res = await send({ type: 'orbit:get' });
      if (!res) return showUnsupported();
      settings = sanitize(res.settings);
      if (settings.orbitDepth > 0) lastDepth = settings.orbitDepth;
      status = res.status;
      render();
      syncClock(res.motion);
      // 文字の書体が読み込まれると幅が変わるので、つまみの位置を測り直す
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveThumbs);
      enableSlide();
      // 開いている間は、状態とアニメーションの位置を見直す
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
