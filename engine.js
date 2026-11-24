// Orbit Sound — 音声処理エンジン
// chrome の API を使わない部分だけをまとめている（テストページ・ポップアップからもそのまま読み込める）。
//
// 音の流れ：
//   入力 → 低音 → クリアさ → 8D 回転 → 原音 / リバーブ を混ぜる → 音量（最大300%）
//        → リミッター（音割れ防止）→ 出力
//
// 8D 回転には2つの方式がある：
//   ・左右（stereo）…… 左右の位置を sin、後ろでのこもり具合を cos で動かす（最初の版の動き）
//   ・HRTF 3D ……………… 頭や耳の形による聞こえ方を再現する部品（PannerNode の HRTF）で、
//                        前後・上下まで含めた位置に音を置く。円・8の字・らせん・ゆらぎ。
// どちらにも「耳に届く時間の差」「前後の距離感」を足し、回っているときは動かない部屋の響きを少し混ぜる。
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  // ---------- 動きの種類 ----------
  // pos(p) は、p（1周期を 0〜1 とした位置）での音の場所を返す。
  //   x：右が＋　y：上が＋　z：後ろが＋（前は −）。半径はおよそ 1。
  // cycles は「1周期のあいだに頭のまわりを何周するか」。1周の秒数 × cycles が1周期の長さ。
  // ポップアップのアニメーションも同じ pos を使うので、音と絵がずれない。
  const MOTIONS = Object.freeze({
    lr: {
      label: '左右', kind: 'stereo', cycles: 1,
      // 実際の音は左右の移動＋後ろでこもる。絵では横長の楕円で表す
      pos: (p) => ({ x: Math.sin(TAU * p), y: 0, z: -0.35 * Math.cos(TAU * p) })
    },
    circle: {
      label: '円', kind: 'hrtf', cycles: 1,
      pos: (p) => ({ x: Math.sin(TAU * p), y: 0, z: -Math.cos(TAU * p) })
    },
    figure8: {
      label: '8の字', kind: 'hrtf', cycles: 1,
      // 顔の前で交差し、右の後ろ → 左の後ろ と大きく回り込む
      pos: (p) => {
        const t = TAU * p;
        return { x: Math.sin(t), y: 0, z: -0.2 - 0.6 * Math.cos(2 * t) + 0.6 * Math.sin(2 * t) };
      }
    },
    spiral: {
      label: 'らせん', kind: 'hrtf', cycles: 3,
      // 3周するあいだに、上がって下がる
      pos: (p) => {
        const y = 0.6 * Math.sin(TAU * p);
        const r = Math.sqrt(1 - y * y);
        const a = TAU * 3 * p;
        return { x: r * Math.sin(a), y, z: -r * Math.cos(a) };
      }
    },
    drift: {
      label: 'ゆらぎ', kind: 'hrtf', cycles: 3,
      // 回る速さが変わったり、ときどき戻ったりしながら漂う
      pos: (p) => {
        const t = TAU * p;
        const a = 3 * t + 1.4 * Math.sin(2 * t) + 0.9 * Math.sin(5 * t + 1);
        const y = 0.35 * Math.sin(2 * t + 0.5);
        const r = Math.sqrt(1 - y * y);
        return { x: r * Math.sin(a), y, z: -r * Math.cos(a) };
      }
    }
  });

  // 初期値
  const DEFAULTS = Object.freeze({
    enabled: false,
    preset: 'flat',
    motion: 'lr',      // 8D 回転の種類（MOTIONS のどれか）
    orbitDepth: 0,     // 8D 回転の深さ 0〜1
    orbitSeconds: 8,   // 頭のまわりを1周する秒数
    spatial: 0.85,     // 立体感の強さ 0〜1（3D の動きに足す、左右の振れの大きさ）
    volume: 1,         // 0〜3（=300%）
    speed: 1,          // 再生速度 0.5〜1.5（ピッチも一緒に変わる）
    bass: 0,           // 低音の持ち上げ（dB）
    clarity: 0,        // 高音の持ち上げ（dB）
    reverb: 0,         // リバーブ量 0〜1
    roomSize: 2.5,     // 残響の長さ（秒）
    beat: 'off',       // Beat Sync：'off'｜'sync'（テンポに合わせて回る）｜'bounce'（拍ごとに跳ねて進む）
    beatsPerTurn: 8    // Beat Sync のとき、何拍で頭のまわりを1周するか（BEAT_TURNS のどれか）
  });

  const BEAT_MODES = ['off', 'sync', 'bounce'];
  const BEAT_TURNS = [1, 2, 4, 8, 16];

  // 値の範囲（範囲外の値は丸めて使う）
  const LIMITS = Object.freeze({
    orbitDepth: [0, 1],
    orbitSeconds: [2, 20],
    spatial: [0, 1],
    volume: [0, 3],
    speed: [0.5, 1.5],
    bass: [0, 12],
    clarity: [-6, 10],
    reverb: [0, 1],
    roomSize: [0.5, 6]
  });

  // プリセット（音量・回転の種類はユーザーの設定を残すため含めない）
  const PRESETS = Object.freeze({
    orbit8d: { label: '8D回転',          orbitDepth: 1,    orbitSeconds: 8,  speed: 1,    bass: 2, clarity: 1,  reverb: 0.25, roomSize: 2.5 },
    slowed:  { label: 'Slowed + Reverb', orbitDepth: 0,    orbitSeconds: 8,  speed: 0.85, bass: 3, clarity: -2, reverb: 0.55, roomSize: 4 },
    spedup:  { label: 'Sped Up',         orbitDepth: 0,    orbitSeconds: 8,  speed: 1.25, bass: 1, clarity: 2,  reverb: 0.1,  roomSize: 1.5 },
    bass:    { label: '重低音',          orbitDepth: 0,    orbitSeconds: 8,  speed: 1,    bass: 9, clarity: 0,  reverb: 0.05, roomSize: 1.5 },
    hall:    { label: 'ホール',          orbitDepth: 0.35, orbitSeconds: 16, speed: 1,    bass: 2, clarity: 1,  reverb: 0.5,  roomSize: 3.5 },
    flat:    { label: 'フラット',        orbitDepth: 0,    orbitSeconds: 8,  speed: 1,    bass: 0, clarity: 0,  reverb: 0,    roomSize: 2.5 }
  });

  function clamp(v, [lo, hi], fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  // 保存値やメッセージから来た設定を、安全な値にそろえる
  function sanitize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = { ...DEFAULTS };
    out.enabled = src.enabled === true;
    out.preset = (typeof src.preset === 'string' && (PRESETS[src.preset] || src.preset === 'custom')) ? src.preset : DEFAULTS.preset;
    out.motion = (typeof src.motion === 'string' && Object.prototype.hasOwnProperty.call(MOTIONS, src.motion)) ? src.motion : DEFAULTS.motion;
    for (const key of Object.keys(LIMITS)) {
      out[key] = clamp(src[key] ?? DEFAULTS[key], LIMITS[key], DEFAULTS[key]);
    }
    out.beat = BEAT_MODES.includes(src.beat) ? src.beat : DEFAULTS.beat;
    out.beatsPerTurn = BEAT_TURNS.includes(src.beatsPerTurn) ? src.beatsPerTurn : DEFAULTS.beatsPerTurn;
    return out;
  }

  // プリセットを当てた設定を返す（音量・回転の種類・オン/オフはそのまま）
  function withPreset(settings, name) {
    const p = PRESETS[name];
    if (!p) return sanitize(settings);
    const { label, ...values } = p;
    return sanitize({ ...settings, ...values, preset: name });
  }

  // ---------- 動きを周波数成分に分ける ----------
  // 1周期ぶんの位置を細かく取り、cos / sin の成分に分ける（フーリエ級数）。
  // 揺れの部品（OscillatorNode）にこの成分を渡すと、同じ形をなぞって動く。
  const HARMONICS = 48;
  const SAMPLES = 1024;
  const seriesCache = new Map();

  function motionSeries(name) {
    if (seriesCache.has(name)) return seriesCache.get(name);
    const pos = MOTIONS[name].pos;
    const out = {};
    for (const axis of ['x', 'y', 'z']) {
      const vals = new Float64Array(SAMPLES);
      for (let n = 0; n < SAMPLES; n++) vals[n] = pos(n / SAMPLES)[axis];
      const real = new Float32Array(HARMONICS + 1); // cos の成分
      const imag = new Float32Array(HARMONICS + 1); // sin の成分
      let dc = 0;
      for (let n = 0; n < SAMPLES; n++) dc += vals[n];
      dc /= SAMPLES;
      for (let k = 1; k <= HARMONICS; k++) {
        let a = 0, b = 0;
        for (let n = 0; n < SAMPLES; n++) {
          const ang = TAU * k * n / SAMPLES;
          a += vals[n] * Math.cos(ang);
          b += vals[n] * Math.sin(ang);
        }
        real[k] = (2 / SAMPLES) * a;
        imag[k] = (2 / SAMPLES) * b;
      }
      out[axis] = { dc, real, imag };
    }
    seriesCache.set(name, out);
    return out;
  }

  // 成分から位置を計算し直す（テストで「元の形とずれていないか」を確かめるため）
  function seriesValue(s, p) {
    let v = s.dc;
    for (let k = 1; k <= HARMONICS; k++) v += s.real[k] * Math.cos(TAU * k * p) + s.imag[k] * Math.sin(TAU * k * p);
    return v;
  }

  // 後ろ側でこもらせるローパスの基準と振れ幅（Hz）
  const LP_BASE = 11000;
  const LP_SWING = 7000;        // 左右モード
  const LP_SWING_HRTF = 6000;   // HRTF モード（後ろ側で 5000Hz まで下げ、後ろだと分かりやすくする）
  const HRTF_GAIN = 1.0;        // HRTF を通したときの音量の合わせ（テストで調整）
  const SMOOTH = 0.06;          // 値を変えるときのなめらかさ（秒）

  // 方向をはっきりさせる手がかり（0.4.0 で追加）
  // ・耳に届く時間の差：右から来る音は、左耳に少し遅れて届く（人の頭で最大約0.65ミリ秒）。
  //   音量の差（パン）だけより、方向を強く感じる。
  const ITD_BASE = 0.0008;      // どの道も、この分だけ遅らせてそろえる（秒）。ずれると音がにじむため
  const ITD_STEREO = 0.00065;   // 左右モード：真横での時間差
  const ITD_HRTF = 0.0003;      // HRTF モード：HRTF 自体にも時間差があるので、足すのは控えめ
  // ・距離感：前で少し大きく（1 + 値 倍）、後ろで少し小さく（1 − 値 倍）。平均の音量は変えない
  const DIST_STEREO = 0.12;     // 左右モード（前後の差 約2dB）
  const DIST_HRTF = 0.18;       // HRTF モード（立体感 100% で前後の差 約3dB）
  // ・部屋の響き：回っているときだけ、うっすら残響を足す。響きは動かさないので、音だけが動いて聞こえる
  // （多すぎると両耳に同じ響きが入り、左右の差が小さくなる。0.08 で真横の左右差は約23dB）
  const AMBIENCE = 0.08;

  // ---------- 拍の検出（Beat Sync） ----------
  // 曲の「音の立ち上がりの強さ」（周波数ごとの大きさが、前の瞬間よりどれだけ増えたか）を1秒に100回記録し、
  // それが何秒ごとにくり返すか（テンポ）と、最後の拍がいつだったか（拍の位置）を求める。
  //
  // 音は、ページ側のタイマーで「新しく届いた波形」を受け取り、つなぎ合わせてから、ちょうど 10 ミリ秒ごとに区切って調べる。
  // （タイマーの間隔はばらつくので、受け取るたびに調べると、そのばらつき自体が「くり返し」に見えてしまう）
  const FRAME = 1024;                 // 一度に調べる長さ（サンプル数）

  // 周波数ごとの大きさを求める（高速フーリエ変換）。大きさだけ使う
  function makeFft(n) {
    const bits = Math.log2(n), rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(TAU * k / n); sin[k] = Math.sin(TAU * k / n); }
    return (re, im) => {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0; j < half; j++) {
            const c = cos[j * step], s = sin[j * step], a = i + j, b = a + half;
            const tr = c * re[b] + s * im[b], ti = c * im[b] - s * re[b];
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }
  const fft1024 = makeFft(FRAME);
  const HANN = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(TAU * i / FRAME));

  const ENV_RATE = 100;               // 立ち上がりの強さを記録する回数（1秒あたり）
  const ENV_KEEP = 8;                 // 何秒ぶんを見てテンポを決めるか
  const BPM_MIN = 60, BPM_MAX = 200;  // 探すテンポの範囲
  const BEAT_CONF_MIN = 0.15;         // 1拍ずらしたときの似かたがこれより小さいときは、テンポを決めない（雑音は約0.05）
  const ONSET_LAG = 0.01;             // 記録の遅れ（測る間隔の半分と、解析の窓の分）
  // 跳ねる動き：1拍のうち、どの区間をどれだけの速さで進むか。合計がちょうど1拍ぶんの移動になる
  // （最初の 35% ですばやく進み、残りは止まる → 「ぽん、ぽん」と段々に動く）
  const BOUNCE = Object.freeze([[0, 0.05, 2], [0.05, 0.2, 4], [0.2, 0.35, 2], [0.35, 1, 0]]);

  class BeatDetector {
    constructor() {
      this.bpm = 0;
      this.hintBpm = 0;
      this.anchor = 0;
      this.confidence = 0;
      this.reset();
    }

    // 記録を捨てる（一時停止・早送り・次の曲）。テンポは次の手がかりとして覚えておく
    reset() {
      this.env = new Float32Array(ENV_RATE * ENV_KEEP);
      this.last = -1;     // 最後に記録した番号（時刻 × ENV_RATE）
      this.filled = 0;    // たまった数
      this.prev = null;   // 前の瞬間の、周波数ごとの大きさ
      if (this.bpm) this.hintBpm = this.bpm;
      this.bpm = 0;
      this.pending = 0;
      this.pendingCount = 0;
    }

    // 新しく届いた波形（モノラル）を受け取る。data の最後の count 個が新しい分で、最後の1つが endTime 秒の音
    addSamples(endTime, data, count, sampleRate) {
      if (this.sr !== sampleRate) {
        this.sr = sampleRate;
        this.hop = Math.round(sampleRate / ENV_RATE);
        this.ring = new Float32Array(FRAME);
        this.ringPos = 0;
        this.re = new Float32Array(FRAME);
        this.im = new Float32Array(FRAME);
        this.maxBin = Math.min(FRAME / 2, Math.round(8000 / (sampleRate / FRAME))); // 8kHz まで
        this.prev = null;
      }
      count = Math.max(0, Math.min(count, data.length));
      const endIndex = Math.round(endTime * sampleRate); // 最後の1つの通し番号
      for (let i = data.length - count; i < data.length; i++) {
        this.ring[this.ringPos] = data[i];
        this.ringPos = (this.ringPos + 1) % FRAME;
        const abs = endIndex - (data.length - 1 - i);
        if (abs % this.hop === 0) this.analyzeFrame(abs);
      }
    }

    // 直前の FRAME 個の音から、立ち上がりの強さを1つ求める
    analyzeFrame(abs) {
      const { re, im, ring } = this;
      for (let i = 0; i < FRAME; i++) { re[i] = ring[(this.ringPos + i) % FRAME] * HANN[i]; im[i] = 0; }
      fft1024(re, im);
      const n = this.maxBin;
      if (!this.prev) this.prev = new Float32Array(n);
      let flux = 0;
      for (let k = 1; k < n; k++) {
        const v = Math.log1p(100 * Math.hypot(re[k], im[k]));
        const d = v - this.prev[k];
        if (d > 0) flux += d;
        this.prev[k] = v;
      }
      this.addOnset(abs / this.sr - ONSET_LAG, flux / n);
    }

    addOnset(time, value) {
      const env = this.env, len = env.length;
      const i = Math.floor(time * ENV_RATE);
      // 0.5 秒以上とぎれた（一時停止・タブが止まった）ときは、拍の位置が変わっているので記録を捨てる
      if (this.last >= 0 && i - this.last > ENV_RATE / 2) this.reset();
      if (this.last < 0) {
        env.fill(0);
        env[i % len] = value;
        this.last = i;
        this.filled = 1;
        return;
      }
      // 測る間隔はばらつく（タイマーのずれ）。同じ枠に2回入ったら足し、枠を飛ばしたら飛ばした枠に等分する。
      // こうしないと、間隔のばらつき自体が「くり返し」に見えて、拍のない音でもテンポが出てしまう
      if (i <= this.last) {
        env[this.last % len] += value;
        return;
      }
      const share = value / (i - this.last);
      for (let k = this.last + 1; k <= i; k++) env[k % len] = share;
      this.filled = Math.min(len, this.filled + (i - this.last));
      this.last = i;
    }

    // テンポと拍の位置を求める。決まらないときは、前の結果（なければ null）を返す
    estimate() {
      const need = (this.hintBpm ? 3 : 5) * ENV_RATE;
      if (this.filled < need) return this.grid();
      const N = this.filled, len = this.env.length;
      const raw = new Float32Array(N);
      for (let n = 0; n < N; n++) raw[n] = this.env[(this.last - N + 1 + n) % len];

      // ならす：まわり ±0.15 秒の平均を引き、マイナスは 0 にする（とがったところだけ残す）
      const W = 15, sum = new Float64Array(N + 1);
      for (let n = 0; n < N; n++) sum[n + 1] = sum[n] + raw[n];
      const e = new Float32Array(N);
      let total = 0;
      for (let n = 0; n < N; n++) {
        const a = Math.max(0, n - W), b = Math.min(N, n + W + 1);
        const v = raw[n] - (sum[b] - sum[a]) / (b - a);
        e[n] = v > 0 ? v : 0;
        total += e[n];
      }
      if (total <= 1e-9) return this.grid(); // 無音
      // 平均を引いたもの（ec）で似かたを測る。こうすると、拍のない音では 0 に近く、はっきりした拍ほど 1 に近い
      const mean0 = total / N, ec = new Float32Array(N);
      let vr = 0;
      for (let n = 0; n < N; n++) { ec[n] = e[n] - mean0; vr += ec[n] * ec[n]; }
      vr /= N;
      if (vr <= 1e-12) return this.grid();

      // 少しずらして重ねたときの似かた（自己相関、−1〜1）。lag は小数でもよい
      const at = (arr, x) => { const j = Math.floor(x), f = x - j; return arr[j] * (1 - f) + (j + 1 < arr.length ? arr[j + 1] * f : 0); };
      const acf = (lag) => {
        const i0 = Math.ceil(lag);
        if (i0 >= N - ENV_RATE) return 0;
        let s = 0;
        for (let n = i0; n < N; n++) s += ec[n] * at(ec, n - lag);
        return s / (N - i0) / vr;
      };

      // テンポの候補を 0.5 BPM きざみで調べる。120 BPM 前後を少しだけ優先し、半分・倍の取り違えを減らす
      const ref = this.bpm || this.hintBpm;
      const cands = [], raws = [];
      for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm += 0.5) {
        const P = (60 * ENV_RATE) / bpm;
        const r = (acf(P) + 0.5 * acf(2 * P)) / 1.5;
        let sc = Math.max(0, r) * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
        if (ref && Math.abs(bpm / ref - 1) < 0.04) sc *= 1.25; // いまのテンポを続けやすく
        cands.push(sc);
        raws.push(r);
      }
      let bi = 0;
      for (let i = 0; i < cands.length; i++) if (cands[i] > cands[bi]) bi = i;
      const conf = raws[bi]; // 1拍ずらしたときの似かた（拍がはっきりしているほど大きい）
      if (conf < BEAT_CONF_MIN) return this.grid();
      // となりの候補との形から、山の頂上を細かく求める
      let off = 0;
      if (bi > 0 && bi < cands.length - 1) {
        const a = cands[bi - 1], b = cands[bi], c = cands[bi + 1], d = a - 2 * b + c;
        if (d < 0) off = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
      }
      const found = BPM_MIN + (bi + off) * 0.5;

      // テンポの更新：近ければなめらかに寄せ、大きく違うときは2回続けて同じ結果が出てから切り替える
      if (!this.bpm || Math.abs(found / this.bpm - 1) < 0.03) {
        this.bpm = this.bpm ? this.bpm * 0.7 + found * 0.3 : found;
        this.pendingCount = 0;
      } else if (this.pendingCount && Math.abs(found / this.pending - 1) < 0.03) {
        if (++this.pendingCount >= 3) { this.bpm = found; this.pendingCount = 0; }
      } else {
        this.pending = found;
        this.pendingCount = 1;
      }

      // 拍の位置：決めたテンポの間隔で、いちばん立ち上がりがそろう位置を探す（新しい拍ほど重く見る）
      const P = (60 * ENV_RATE) / this.bpm;
      const sm = new Float32Array(N);
      for (let n = 0; n < N; n++) sm[n] = 0.5 * e[n] + 0.25 * ((n ? e[n - 1] : 0) + (n + 1 < N ? e[n + 1] : 0));
      let bestPh = 0, bestS = -1;
      for (let ph = 0; ph < P; ph += 0.5) {
        let s = 0, w = 1;
        for (let x = N - 1 - ph; x >= 0; x -= P) { s += w * at(sm, x); w *= 0.85; }
        if (s > bestS) { bestS = s; bestPh = ph; }
      }
      this.anchor = (this.last - bestPh) / ENV_RATE;
      this.confidence = conf;
      return this.grid();
    }

    // 拍の並び：period 秒ごと、anchor 秒に1つ拍がある
    grid() {
      return this.bpm ? { bpm: this.bpm, period: 60 / this.bpm, anchor: this.anchor, confidence: this.confidence } : null;
    }
  }

  class OrbitEngine {
    constructor(ctx) {
      this.ctx = ctx;
      this.currentRoom = null;
      this.motion = null;

      this.input = ctx.createGain();

      this.bassFilter = ctx.createBiquadFilter();
      this.bassFilter.type = 'lowshelf';
      this.bassFilter.frequency.value = 110;
      this.bassFilter.gain.value = 0;

      this.clarityFilter = ctx.createBiquadFilter();
      this.clarityFilter.type = 'highshelf';
      this.clarityFilter.frequency.value = 3500;
      this.clarityFilter.gain.value = 0;

      this.input.connect(this.bassFilter).connect(this.clarityFilter);

      // 8D の出口（左右・HRTF・中央 の3本の道がここで合流する）
      this.motionOut = ctx.createGain();

      const f0 = 1 / DEFAULTS.orbitSeconds;
      const start = ctx.currentTime + 0.01;

      // --- 道1：左右（sin で左右、cos で前後のこもり） ---
      this.stereoGain = ctx.createGain();
      this.panner = ctx.createStereoPanner();
      this.depthFilter = ctx.createBiquadFilter();
      this.depthFilter.type = 'lowpass';
      this.depthFilter.Q.value = 0.5;
      this.depthFilter.frequency.value = LP_BASE;
      this.stItd = this.makeItd();
      this.stDist = ctx.createGain();
      this.clarityFilter.connect(this.stereoGain).connect(this.panner).connect(this.depthFilter).connect(this.stItd.input);
      this.stItd.output.connect(this.stDist).connect(this.motionOut);

      this.lfoSin = ctx.createOscillator();
      this.lfoSin.type = 'sine';
      this.lfoCos = ctx.createOscillator();
      this.lfoCos.setPeriodicWave(ctx.createPeriodicWave(
        new Float32Array([0, 1]), new Float32Array([0, 0]), { disableNormalization: true }
      ));
      // 揺れの初期の速さ（初期値の 440Hz のままだと、起動直後に一瞬だけ高速で揺れるため）
      this.lfoSin.frequency.value = f0;
      this.lfoCos.frequency.value = f0;
      this.panAmount = ctx.createGain();
      this.panAmount.gain.value = 0;
      this.lpAmount = ctx.createGain();
      this.lpAmount.gain.value = 0;
      this.lfoSin.connect(this.panAmount).connect(this.panner.pan);
      this.lfoCos.connect(this.lpAmount).connect(this.depthFilter.frequency);
      // sin（左右の位置）→ 耳の時間差、cos（前後）→ 距離感
      this.lfoSin.connect(this.stItd.amtL);
      this.lfoSin.connect(this.stItd.amtR);
      this.stDistAmount = ctx.createGain();
      this.stDistAmount.gain.value = 0;
      this.lfoCos.connect(this.stDistAmount).connect(this.stDist.gain);

      // --- 道2：HRTF 3D（モノラルにまとめてから、頭のまわりの位置に置く） ---
      this.hrtfGain = ctx.createGain();
      this.hrtfGain.gain.value = 0;
      this.mono = ctx.createGain();
      this.mono.channelCount = 1;
      this.mono.channelCountMode = 'explicit';
      this.mono.channelInterpretation = 'speakers';
      this.hrtf = ctx.createPanner();
      this.hrtf.panningModel = 'HRTF';
      this.hrtf.distanceModel = 'inverse';
      this.hrtf.refDistance = 1;
      this.hrtf.rolloffFactor = 0; // 距離で音量を変えない（方向だけを使う）
      this.hrtf.positionX.value = 0;
      this.hrtf.positionY.value = 0;
      this.hrtf.positionZ.value = -1;
      this.hrtfFilter = ctx.createBiquadFilter();
      this.hrtfFilter.type = 'lowpass';
      this.hrtfFilter.Q.value = 0.5;
      this.hrtfFilter.frequency.value = LP_BASE;
      // HRTF だけだと、音楽では左右の差が小さく（約5〜11dB）動きが分かりにくい。
      // そこで HRTF のあとに左右の振れ（x 座標に合わせたパン）を足して、立体感を強める
      this.hrtfPan = ctx.createStereoPanner();
      this.hrtfPan.pan.value = 0;
      this.hrtfItd = this.makeItd();
      this.hrtfDist = ctx.createGain();
      this.clarityFilter.connect(this.mono).connect(this.hrtf).connect(this.hrtfFilter).connect(this.hrtfPan).connect(this.hrtfItd.input);
      this.hrtfItd.output.connect(this.hrtfDist).connect(this.hrtfGain).connect(this.motionOut);

      this.oscX = ctx.createOscillator();
      this.oscY = ctx.createOscillator();
      this.oscZ = ctx.createOscillator();
      this.hrtfZAmount = ctx.createGain(); // z（前後）→ こもり具合
      this.hrtfZAmount.gain.value = 0;
      for (const o of [this.oscX, this.oscY, this.oscZ]) o.frequency.value = f0;
      this.oscX.connect(this.hrtf.positionX);
      this.oscY.connect(this.hrtf.positionY);
      this.oscZ.connect(this.hrtf.positionZ);
      this.oscZ.connect(this.hrtfZAmount).connect(this.hrtfFilter.frequency);
      this.hrtfXAmount = ctx.createGain(); // x（左右）→ 左右の振れ
      this.hrtfXAmount.gain.value = 0;
      this.oscX.connect(this.hrtfXAmount).connect(this.hrtfPan.pan);
      this.oscX.connect(this.hrtfItd.amtL);
      this.oscX.connect(this.hrtfItd.amtR);
      this.hrtfDistAmount = ctx.createGain(); // z（前後）→ 距離感
      this.hrtfDistAmount.gain.value = 0;
      this.oscZ.connect(this.hrtfDistAmount).connect(this.hrtfDist.gain);

      // --- 道3：中央（HRTF の深さが 100% 未満のとき、元の音を混ぜる） ---
      this.centerGain = ctx.createGain();
      this.centerGain.gain.value = 1;
      this.centerDelay = ctx.createDelay(0.01); // ほかの道と同じだけ遅らせる
      this.centerDelay.delayTime.value = ITD_BASE;
      this.clarityFilter.connect(this.centerDelay).connect(this.centerGain).connect(this.motionOut);
      this.stereoGain.gain.value = 0;

      // リバーブ（原音と残響を混ぜる）
      // 残響は動かす前の音から作る：部屋の響きは止まったまま、音だけが頭のまわりを動いて聞こえる
      this.dry = ctx.createGain();
      this.wet = ctx.createGain();
      this.wet.gain.value = 0;
      this.convolver = ctx.createConvolver();
      this.mix = ctx.createGain();
      this.motionOut.connect(this.dry).connect(this.mix);
      this.clarityFilter.connect(this.convolver).connect(this.wet).connect(this.mix);

      // 左右チェック用（ふだんは真ん中のまま、何もしない）
      this.probePan = ctx.createStereoPanner();
      this.probePan.pan.value = 0;
      this.mix.connect(this.probePan);

      this.volume = ctx.createGain();

      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;

      // リミッターは自動で音を持ち上げる（makeup gain）。その分を打ち消して、
      // 「フラットなら元の音量のまま」「最大でも 1.0 を超えない」ようにする。
      // 持ち上げ量 = (1 / 0dB 入力時の出力)^0.6 （Web Audio の仕様の計算式）
      const outAt0dB = Math.pow(10, (this.limiter.threshold.value * (1 - 1 / this.limiter.ratio.value)) / 20);
      const makeup = Math.pow(1 / outAt0dB, 0.6);
      this.trim = ctx.createGain();
      this.trim.gain.value = 1 / makeup;

      this.probePan.connect(this.volume).connect(this.limiter).connect(this.trim);
      this.output = this.trim;

      // 揺れの部品はすべて同じ時刻に始めて、位相（いま何周目のどこか）をそろえる
      for (const o of [this.lfoSin, this.lfoCos, this.oscX, this.oscY, this.oscZ]) o.start(start);

      // 位相の記録（ポップアップのアニメーションを音に合わせるため）
      this.stereoClock = this.makeClock([this.lfoSin, this.lfoCos], start, f0);
      this.hrtfClock = this.makeClock([this.oscX, this.oscY, this.oscZ], start, f0);

      // Beat Sync：動かす前の音を聞いて、拍を探す
      // 波形を受け取るだけに使う（約 85 ミリ秒ぶん持てるので、タイマーが少し遅れても取りこぼさない）
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.clarityFilter.connect(this.analyser);
      this.wave = new Float32Array(this.analyser.fftSize);
      this.lastPoll = -1;
      this.detector = new BeatDetector();
      this.beatGrid = null;
      this.lastEstimate = -1;
      this.settings = sanitize({});

      this.setRoom(DEFAULTS.roomSize);
      this.setMotion(DEFAULTS.motion);
    }

    // 耳の時間差をつける部品：左右の耳それぞれを、少しだけ遅らせる。
    // amtL / amtR に位置（右が＋）をつなぐと、右に来たとき左耳が遅れ、右耳が早まる。
    makeItd() {
      const ctx = this.ctx;
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const dL = ctx.createDelay(0.01), dR = ctx.createDelay(0.01);
      dL.delayTime.value = ITD_BASE;
      dR.delayTime.value = ITD_BASE;
      split.connect(dL, 0).connect(merge, 0, 0);
      split.connect(dR, 1).connect(merge, 0, 1);
      const amtL = ctx.createGain(), amtR = ctx.createGain();
      amtL.gain.value = 0;
      amtR.gain.value = 0;
      amtL.connect(dL.delayTime);
      amtR.connect(dR.delayTime);
      return { input: split, output: merge, dL, dR, amtL, amtR };
    }

    // 左右チェック：動画の音を、左だけ → 右だけ と寄せてから真ん中に戻す。かかる秒数を返す
    probe(seconds = 1.2) {
      const t = this.ctx.currentTime;
      const p = this.probePan.pan;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(-1, t + 0.05);
      p.setValueAtTime(-1, t + seconds);
      p.linearRampToValueAtTime(1, t + seconds + 0.08);
      p.setValueAtTime(1, t + seconds * 2);
      p.linearRampToValueAtTime(0, t + seconds * 2 + 0.08);
      return seconds * 2 + 0.08;
    }

    // 残響の型（インパルス応答）をノイズから作る
    makeImpulse(seconds) {
      const rate = this.ctx.sampleRate;
      const length = Math.max(1, Math.floor(rate * seconds));
      const preDelay = Math.floor(rate * 0.02);
      const buffer = this.ctx.createBuffer(2, length, rate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = preDelay; i < length; i++) {
          const decay = Math.pow(1 - (i - preDelay) / (length - preDelay), 3);
          data[i] = (Math.random() * 2 - 1) * decay;
        }
      }
      return buffer;
    }

    setRoom(seconds) {
      if (this.currentRoom !== null && Math.abs(this.currentRoom - seconds) < 0.05) return;
      this.currentRoom = seconds;
      this.convolver.buffer = this.makeImpulse(seconds);
    }

    // HRTF の動きの形を差し替える
    setMotion(name) {
      if (this.motion === name) return;
      this.motion = name;
      const m = MOTIONS[name];
      if (m.kind !== 'hrtf') return;
      const s = motionSeries(name);
      const t = this.ctx.currentTime;
      const pairs = [[this.oscX, this.hrtf.positionX, s.x], [this.oscY, this.hrtf.positionY, s.y], [this.oscZ, this.hrtf.positionZ, s.z]];
      for (const [osc, param, series] of pairs) {
        osc.setPeriodicWave(this.ctx.createPeriodicWave(series.real, series.imag, { disableNormalization: true }));
        param.cancelScheduledValues(t);
        param.setValueAtTime(series.dc, t); // 平均の位置（揺れの部品は平均 0 の揺れしか出せないため）
      }
      this.zDc = s.z.dc;
      this.xDc = s.x.dc;
    }

    // ---------- 揺れの速さと位相の記録 ----------
    // 速さの変わり目を pts に並べて持つ（先の時刻の予約も含む）。
    //   f：実際の速さ（跳ねるときは拍の中で速くなったり止まったりする）
    //   fb：ならした速さ（ポップアップのアニメーション用。拍の区切りでは f と同じ位置になる）
    makeClock(oscs, time, freq) {
      return { oscs, pts: [{ t: time, f: freq, fb: freq }], ph: 0, phb: 0, beatUntil: 0 };
    }

    // 時刻 t の位相（何周期目のどこか）。key が 'fb' なら、ならした速さで数える
    clockPhase(c, t, key = 'f') {
      let ph = key === 'fb' ? c.phb : c.ph;
      for (let i = 0; i < c.pts.length; i++) {
        const p = c.pts[i];
        if (t <= p.t) break;
        const end = i + 1 < c.pts.length ? Math.min(t, c.pts[i + 1].t) : t;
        ph += (end - p.t) * p[key];
      }
      return ph;
    }

    // t より前に終わった変わり目を、位相の合計にまとめて捨てる
    clockFold(c, t) {
      while (c.pts.length > 1 && c.pts[1].t <= t) {
        const p = c.pts[0], q = c.pts[1];
        c.ph += (q.t - p.t) * p.f;
        c.phb += (q.t - p.t) * p.fb;
        c.pts.shift();
      }
    }

    // 時刻 t から速さを変える。t 以降の予約はすべて取り消す
    clockSet(c, t, f, fb) {
      this.clockFold(c, Math.min(t, this.ctx.currentTime)); // いまより先の変わり目はまとめない（いまの位相が数えられなくなる）
      c.pts = c.pts.filter((p, i) => i === 0 || p.t < t);
      if (c.pts[0].t >= t) {
        // 先頭の変わり目と同じ時刻：位相はそのままで、速さだけ置き換える
        c.pts[0] = { t: c.pts[0].t, f, fb };
      } else {
        c.pts.push({ t, f, fb });
      }
      for (const o of c.oscs) {
        o.frequency.cancelScheduledValues(t);
        o.frequency.setValueAtTime(f, t);
      }
    }

    // ふつうの回転：一定の速さにする（Beat Sync の予約が残っていれば取り消す）
    setClock(c, freq) {
      const now = this.ctx.currentTime;
      this.clockFold(c, now);
      const last = c.pts[c.pts.length - 1];
      const settled = c.pts.length === 1 && c.beatUntil <= now;
      if (settled && Math.abs(last.f - freq) < 1e-9 && Math.abs(last.fb - freq) < 1e-9) return;
      c.beatUntil = 0;
      this.clockSet(c, now, freq, freq);
    }

    // ---------- Beat Sync ----------
    // ページ側から 10 ミリ秒ごとに呼ぶ：音を聞いて拍を探し、少し先までの回転を拍に合わせて予約する
    beatTick() {
      const s = this.settings;
      if (s.beat === 'off' || s.orbitDepth === 0) return;
      const now = this.ctx.currentTime;
      // 前回から新しく届いた分だけを渡す（初回は1回ぶんの長さ）
      const sr = this.ctx.sampleRate;
      const count = this.lastPoll < 0 ? FRAME : Math.round((now - this.lastPoll) * sr);
      this.lastPoll = now;
      if (count > 0) {
        this.analyser.getFloatTimeDomainData(this.wave);
        this.detector.addSamples(now - 1 / sr, this.wave, count, sr);
      }
      if (now - this.lastEstimate >= 0.5) {
        this.lastEstimate = now;
        // 決まらないときは前の並びのまま（見失っても回転の速さは急に変えない）
        const g = this.detector.estimate();
        if (g) this.beatGrid = g;
      }
      if (this.beatGrid) this.scheduleBeats(now, 1.0);
    }

    // 早送り・次の曲・一時停止のあとに呼ぶ（拍の位置が変わるので測り直す）
    resetBeats() {
      this.detector.reset();
      this.lastEstimate = -1;
      this.lastPoll = -1;
    }

    // いまの動きの「1周期あたりの拍の数」
    beatsPerPeriod() {
      const m = MOTIONS[this.motion];
      return this.settings.beatsPerTurn * (m.kind === 'stereo' ? 1 : m.cycles);
    }

    // now から horizon 秒先までの拍を、1拍ずつ予約する。
    // 拍の瞬間に、音が「1周を拍の数で割った位置」（4拍で1周なら 前・右・後ろ・左）に来るよう、
    // ずれの半分ずつを次の1拍で取り戻す。
    scheduleBeats(now, horizon) {
      const grid = this.beatGrid;
      const c = MOTIONS[this.motion].kind === 'stereo' ? this.stereoClock : this.hrtfClock;
      const B = this.beatsPerPeriod();
      const L = grid.period;
      const bounce = this.settings.beat === 'bounce';
      const from = Math.max(now + 0.03, c.beatUntil);
      let tb = grid.anchor + Math.ceil((from - grid.anchor) / L - 1e-6) * L;
      while (tb < now + horizon) {
        const x = this.clockPhase(c, tb) * B;
        const err = x - Math.round(x);
        const advance = 1 - Math.max(-0.2, Math.min(0.2, err * 0.5)); // この1拍で進む量（拍の単位）
        const fb = advance / (B * L);
        if (bounce) {
          for (const [a, , mult] of BOUNCE) this.clockSet(c, tb + a * L, fb * mult, fb);
          this.clockSet(c, tb + L, fb, fb); // 予約が途切れても、ならした速さで回り続ける
        } else {
          this.clockSet(c, tb, fb, fb);
        }
        c.beatUntil = tb + L * 0.5;
        tb += L;
      }
    }

    // 設定を音に反映する（急に変わって「プツッ」とならないよう、少しずつ動かす）
    apply(rawSettings) {
      const s = sanitize(rawSettings);
      const t = this.ctx.currentTime;
      const to = (param, value) => param.setTargetAtTime(value, t, SMOOTH);

      to(this.bassFilter.gain, s.bass);
      to(this.clarityFilter.gain, s.clarity);

      this.setMotion(s.motion);
      const m = MOTIONS[s.motion];
      const d = s.orbitDepth;

      const prev = this.settings;
      this.settings = s;
      if (s.beat === 'off') {
        this.beatGrid = null;
        this.detector.reset();
        // 左右モードの揺れ（1周の秒数で1周）
        this.setClock(this.stereoClock, 1 / s.orbitSeconds);
        // HRTF モードの揺れ（1周期で cycles 周するので、その分ゆっくり）
        this.setClock(this.hrtfClock, 1 / (s.orbitSeconds * m.cycles));
      } else if (prev.beat !== s.beat || prev.beatsPerTurn !== s.beatsPerTurn || prev.motion !== s.motion) {
        // 拍の数や動きを変えたら、先の予約を作り直す（拍が見つかるまでは、いまの速さで回る）
        for (const c of [this.stereoClock, this.hrtfClock]) c.beatUntil = 0;
      }

      if (m.kind === 'stereo') {
        to(this.stereoGain.gain, 1);
        to(this.hrtfGain.gain, 0);
        to(this.centerGain.gain, 0);
        to(this.panAmount.gain, d);
        to(this.lpAmount.gain, LP_SWING * d);
        // 耳の時間差（右に来たら左耳を遅らせる）と距離感（後ろで小さく）
        to(this.stItd.amtL.gain, ITD_STEREO * d);
        to(this.stItd.amtR.gain, -ITD_STEREO * d);
        to(this.stDist.gain, 1);
        to(this.stDistAmount.gain, DIST_STEREO * d); // cos が 1（前）で大きく、−1（後ろ）で小さく
      } else {
        to(this.stereoGain.gain, 0);
        to(this.hrtfGain.gain, HRTF_GAIN * d);
        to(this.centerGain.gain, 1 - d);
        to(this.panAmount.gain, 0);
        to(this.lpAmount.gain, 0);
        // z が後ろ（＋）ほど、こもらせる
        const zGain = -LP_SWING_HRTF;
        to(this.hrtfZAmount.gain, zGain);
        to(this.hrtfFilter.frequency, LP_BASE - LP_SWING_HRTF * (this.zDc || 0));
        // 左右の振れ：立体感 100% で、真横に来たときに片耳だけから聞こえる
        const k = s.spatial;
        to(this.hrtfXAmount.gain, k);
        to(this.hrtfPan.pan, k * (this.xDc || 0));
        // 耳の時間差（立体感の強さに合わせる）。平均の位置（xDc）の分は、遅れの基準に足す
        const xDc = this.xDc || 0, zDc = this.zDc || 0;
        to(this.hrtfItd.amtL.gain, ITD_HRTF * k);
        to(this.hrtfItd.amtR.gain, -ITD_HRTF * k);
        to(this.hrtfItd.dL.delayTime, ITD_BASE + ITD_HRTF * k * xDc);
        to(this.hrtfItd.dR.delayTime, ITD_BASE - ITD_HRTF * k * xDc);
        // 距離感：z が後ろ（＋）ほど小さく。前（z = −1）で 1 + a、後ろ（z = +1）で 1 − a
        const a = DIST_HRTF * k;
        to(this.hrtfDist.gain, 1 - a * zDc);
        to(this.hrtfDistAmount.gain, -a);
      }

      // 回っているときは、うっすら部屋の響きを足す（リバーブ量が多いときは、その分少なく）
      const wetLevel = Math.min(1, s.reverb + AMBIENCE * d * (1 - s.reverb));
      to(this.dry.gain, 1 - 0.35 * wetLevel);
      to(this.wet.gain, wetLevel);
      this.setRoom(s.roomSize);

      to(this.volume.gain, s.volume);
      return s;
    }

    // いまの動きの状態（ポップアップのアニメーション用）
    // phase・freq はならした速さで数える。跳ねるときは、ポップアップが beat の情報で段々の動きに直して描く
    motionState() {
      const m = MOTIONS[this.motion];
      const c = m.kind === 'stereo' ? this.stereoClock : this.hrtfClock;
      const t = this.ctx.currentTime;
      const raw = this.clockPhase(c, t, 'fb');
      let freq = c.pts[0].fb;
      for (const p of c.pts) if (p.t <= t) freq = p.fb;
      const s = this.settings;
      const locked = s.beat !== 'off' && !!this.beatGrid;
      const beat = s.beat === 'off' ? null : {
        mode: s.beat,
        bpm: locked ? Math.round(this.beatGrid.bpm) : 0,
        perPeriod: this.beatsPerPeriod()
      };
      return { motion: this.motion, phase: ((raw % 1) + 1) % 1, freq, running: this.ctx.state === 'running', beat };
    }
  }

  global.OrbitSound = Object.freeze({
    OrbitEngine, BeatDetector, DEFAULTS, LIMITS, PRESETS, MOTIONS, BEAT_TURNS, BOUNCE, sanitize, withPreset, motionSeries, seriesValue
  });
})(globalThis);
