// Orbit Sound — ページ側の処理
// ページ内の <video>/<audio> を見つけて音声エンジンにつなぎ、ポップアップとやりとりする。
(() => {
  'use strict';
  if (globalThis.__orbitSoundLoaded) return;
  globalThis.__orbitSoundLoaded = true;

  const { OrbitEngine, sanitize } = globalThis.OrbitSound;
  const SITE_KEY = 'site:' + location.hostname;

  let settings = sanitize({});
  let ctx = null;
  let engine = null;

  const sources = new Map();       // 要素 → つないだ音声ソース
  const blocked = new Map();       // 要素 → つながない理由（'protected' | 'cors' | 'error'）
  const watched = new WeakSet();   // イベントを登録済みの要素
  const rateTouched = new WeakSet(); // 再生速度を変えた要素

  // ---------- 要素ごとの判定 ----------

  // つなぐと無音になってしまう要素は、つながずに理由を返す
  function blockReason(el) {
    if (el.mediaKeys) return 'protected'; // 著作権保護（DRM）つき
    const src = el.currentSrc || el.src || '';
    if (/^https?:/i.test(src)) {
      try {
        const url = new URL(src, location.href);
        if (url.origin !== location.origin && !el.crossOrigin) return 'cors'; // 別サイトの音声
      } catch (_) { /* 判定できないときはつなぐ */ }
    }
    return null;
  }

  function isPlaying(el) {
    return !el.paused && !el.ended && el.readyState >= 2;
  }

  // ---------- 音声のつなぎ方 ----------

  // ページを一度でも操作したか（クリック・キー操作など）。まだなら、ブラウザは音の処理の開始を止める
  function pageActivated() {
    return !navigator.userActivation || navigator.userActivation.hasBeenActive;
  }

  async function ensureRunningContext() {
    if (!ctx) {
      // まだ操作されていないページで作ると、ブラウザが止めて警告（エラー欄）を出すので、最初の操作まで待つ
      if (!pageActivated()) return false;
      ctx = new AudioContext({ latencyHint: 'playback' });
      engine = new OrbitEngine(ctx);
      engine.output.connect(ctx.destination);
      engine.apply(settings);
    }
    if (ctx.state !== 'running') {
      // ページを一度も操作していないと、ブラウザが音の開始を止めることがある
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 300))
      ]);
    }
    return ctx.state === 'running';
  }

  const routedTo = new WeakMap(); // 音声ソース → いまのつなぎ先

  // つなぎ先が変わるときだけつなぎ直す（毎回つなぎ直すと音が途切れるため）
  function route(el, node) {
    const target = settings.enabled ? engine.input : ctx.destination;
    if (routedTo.get(node) === target) return;
    try { node.disconnect(); } catch (_) {}
    node.connect(target);
    routedTo.set(node, target);
  }

  // 一度つないだ要素は外せない（ブラウザの仕様）。オフのときは加工せず素通しにする。
  function attach(el) {
    if (sources.has(el)) return;
    const reason = blockReason(el);
    if (reason) { blocked.set(el, reason); return; }
    try {
      const node = ctx.createMediaElementSource(el);
      sources.set(el, node);
      blocked.delete(el);
      route(el, node);
    } catch (e) {
      // ページ自身がすでに音声処理につないでいる場合など
      blocked.set(el, 'error');
    }
  }

  function applySpeed(el) {
    if (settings.enabled && settings.speed !== 1) {
      el.preservesPitch = false; // レコードのように、速さと一緒に音の高さも変える
      if (Math.abs(el.playbackRate - settings.speed) > 0.001) el.playbackRate = settings.speed;
      rateTouched.add(el);
    } else if (rateTouched.has(el)) {
      el.preservesPitch = true;
      el.playbackRate = 1;
      rateTouched.delete(el);
    }
  }

  function mediaElements() {
    return Array.from(document.querySelectorAll('video, audio'));
  }

  // 要素ごとにイベントを登録する
  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    const onPlay = () => {
      applySpeed(el);
      if (settings.enabled && ctx && ctx.state === 'running') attach(el);
      updateBeatLoop();
    };
    // 拍の位置が変わるとき（早送り・一時停止・次の動画）は、拍を測り直す
    const restartBeats = () => { if (engine) engine.resetBeats(); updateBeatLoop(); };
    el.addEventListener('playing', onPlay);
    el.addEventListener('loadeddata', () => { applySpeed(el); restartBeats(); }); // 次の動画で速度が戻るのを防ぐ
    el.addEventListener('seeking', restartBeats);
    el.addEventListener('pause', restartBeats);
    el.addEventListener('encrypted', () => {
      // 再生途中で保護つきに変わった場合
      if (!sources.has(el)) blocked.set(el, 'protected');
    });
  }

  // ---------- Beat Sync ----------
  // 拍に合わせるときだけ、10 ミリ秒ごとに音を聞かせる（音が鳴っているタブは、裏にあってもタイマーが遅くならない）
  let beatTimer = null;
  function beatActive() {
    if (!settings.enabled || settings.beat === 'off' || settings.orbitDepth === 0) return false;
    if (!engine || !ctx || ctx.state !== 'running') return false;
    for (const el of sources.keys()) if (el.isConnected && isPlaying(el)) return true;
    return false;
  }
  function updateBeatLoop() {
    const want = beatActive();
    if (want && !beatTimer) {
      beatTimer = setInterval(() => {
        if (!beatActive()) { updateBeatLoop(); return; }
        engine.beatTick();
      }, 10);
    } else if (!want && beatTimer) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
  }

  // ---------- 全体の同期 ----------

  let syncing = Promise.resolve();
  function sync() {
    syncing = syncing.then(doSync, doSync);
    return syncing;
  }

  async function doSync() {
    const els = mediaElements();
    els.forEach(watch);

    if (settings.enabled) {
      const running = await ensureRunningContext();
      if (engine) engine.apply(settings); // まだ操作されていないページでは、engine はまだ無い
      if (running) {
        for (const el of els) {
          if (isPlaying(el) || sources.has(el)) attach(el);
        }
      }
    }

    // 外れた要素の後片付け
    for (const [el, node] of sources) {
      if (!el.isConnected && el.paused) {
        try { node.disconnect(); } catch (_) {}
        sources.delete(el);
      } else if (ctx) {
        route(el, node);
      }
    }
    els.forEach(applySpeed);
    updateBeatLoop();
  }

  function status() {
    if (!settings.enabled) return 'off';
    if (!ctx || ctx.state !== 'running') return 'needs-click';
    for (const el of sources.keys()) if (el.isConnected) return 'active';
    const reasons = new Set();
    for (const [el, r] of blocked) if (el.isConnected) reasons.add(r);
    if (reasons.has('protected')) return 'protected';
    if (reasons.has('cors')) return 'cors';
    if (reasons.has('error')) return 'error';
    return mediaElements().length ? 'waiting' : 'no-media';
  }

  function snapshot() {
    // motion：いまの動きの位相と速さ（ポップアップのアニメーションを実際の音に合わせるため）
    const motion = engine && ctx && ctx.state === 'running' ? engine.motionState() : null;
    return { settings, status: status(), host: location.hostname, motion };
  }

  // ---------- 保存 ----------

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [SITE_KEY]: settings }).catch(() => {});
    }, 300);
  }

  // ---------- ポップアップとのやりとり ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'orbit:get') {
      sendResponse(snapshot());
      return false;
    }
    if (msg.type === 'orbit:set') {
      settings = sanitize(msg.settings);
      save();
      sync().then(() => sendResponse(snapshot()), () => sendResponse(snapshot()));
      return true; // 返事をあとで送る
    }
    if (msg.type === 'orbit:probe') {
      // 左右チェック：動画の音を、左だけ → 右だけ に寄せる。鳴っていないときは理由を返す
      const st = status();
      if (st !== 'active') { sendResponse({ ok: false, reason: st }); return false; }
      const playing = Array.from(sources.keys()).some((el) => el.isConnected && isPlaying(el));
      if (!playing) { sendResponse({ ok: false, reason: 'paused' }); return false; }
      sendResponse({ ok: true, seconds: engine.probe() });
      return false;
    }
    return false;
  });

  // ---------- ページの操作・変化を見張る ----------

  // 「ページを一度クリックしてください」の状態から復帰する
  const onGesture = () => {
    if (settings.enabled && (!ctx || ctx.state !== 'running')) sync();
  };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);

  // YouTube などは画面を作り直すので、新しい <video>/<audio> を見つけたら登録する
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      const fresh = mediaElements().filter((el) => !watched.has(el));
      if (!fresh.length) return;
      fresh.forEach(watch);
      if (settings.enabled) sync();
    }, 500);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- 起動 ----------

  mediaElements().forEach(watch);
  chrome.storage.local.get(SITE_KEY).then((r) => {
    if (r && r[SITE_KEY]) {
      settings = sanitize(r[SITE_KEY]);
      if (settings.enabled) sync();
    }
  }).catch(() => {});

  // テストページ用の入口（拡張機能としての動作には関係しない）
  globalThis.__orbitSoundDebug = { snapshot, sync, get ctx() { return ctx; }, get engine() { return engine; } };
})();
