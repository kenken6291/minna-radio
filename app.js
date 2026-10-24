/**
 * NEON WAVE RADIO - app.js  v1.5.0
 * 認証 / プレイヤー / AI DJ（Gemini TTS）/ ラジオエフェクト / ライブルーム
 * v1.1.0：音声ファイル書き出し / 台本の掛け合い / AIとの対話（声変換）/ パーソナリティ管理
 * v1.2.0：楽曲ライブラリ（20セット）/ 台本の保存（50セット）と曲間の放送順
 * v1.3.0：番組表（曲No・掛け合いNoの順番で放送）/ 台本一覧
 * v1.3.1：ライブラリ内の曲の並べ替え（一番上・1つ上・1つ下・一番下・番号を指定）
 * v1.4.0：使い方ガイド / ポッドキャストのエピソード並べ替え（全員共通）/ 聞く順の設定（自分用）
 * v1.5.0：ポッドキャスト再生リスト（20セット×100話・選択と順番指定）/ まとめて登録（最大100件）
 */
'use strict';
(() => {
  /* =========================================================
   *  共通ユーティリティ
   * ========================================================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function hashNum(str) {
    let h = 0;
    for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h;
  }
  const hue = (str) => hashNum(str) % 360;
  const colorOf = (str) => `hsl(${hue(str)} 85% 65%)`;
  const coverBg = (str) => {
    const h = hue(str);
    return `radial-gradient(circle, #0d0a1f 0 8%, hsl(${h} 85% 62%) 9% 34%, #111 35%), repeating-radial-gradient(circle, #111 0 2px, #1c1c1c 2px 3px)`;
  };
  const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
  const avatarHtml = (name, extra = '') =>
    `<span class="avatar ${extra}" style="background:${colorOf(name)}" aria-hidden="true">${esc(initial(name))}</span>`;

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = () => rej(new Error('ファイルを読み込めませんでした'));
      r.readAsDataURL(blob);
    });
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), isError ? 4200 : 2600);
  }

  /* =========================================================
   *  状態
   * ========================================================= */
  const state = {
    token: null,
    user: null,
    appStarted: false,
    tracks: [],
    songFilter: 'all',
    reorder: false,
    showOrders: {},          // 番組ごとのエピソード並び順（全員共通）
    listenOrders: {},        // 番組ごとの聞く順（自分用）
    podSort: null,           // 並べ替え中の番組キー
    podQueue: false,         // ポッドキャストを聞く順で再生中（DJトーク・シャッフルを挟まない）
    podlists: [], plId: '', plMax: 20, plMaxItems: 100, plExpand: false,   // ポッドキャスト再生リスト
    queue: [],
    idx: -1,
    playing: false,
    shuffle: false,
    loop: 'off',            // off | all | one
    plannedNext: null,
    playedCount: 0,
    loadToken: 0,
    currentSource: null,    // drive | url | youtube
    seeking: false,
    persona: 'midnight',
    between: { mode: 'ai', every: CONFIG.DJ_EVERY_N_TRACKS },   // mode: ai | script | mix | off
    fx: { lofi: true, echo: 0.15, reverb: 0.25 },
    volume: 0.8,
    djBusy: false,
    segPrefetch: null,
    lastSegment: null,
    room: null,
    personas: [],
    voices: [],
    script: { id: '', title: '', text: '', cast: {}, blocks: [] },   // 編集中の台本
    scripts: [], scriptsMax: 50, scriptId: '', rundown: [], seqNext: 0, legacyScript: null,
    libraries: [], libMax: 20, libId: '',
    program: [], progMode: false, progPos: -1, progSongIdx: [], progRun: 0,
    convo: { me: '', ai: '', theme: '', silence: CONFIG.CONVO_SILENCE_SEC, convert: true, continuous: true, turns: [], busy: false },
    exportPrefs: Object.assign({}, CONFIG.EXPORT_DEFAULT),
    view: 'radio',
    studioTab: 'talk'
  };

  const musicEl = $('#musicEl');
  const rawEl = $('#rawEl');

  /* ---------- 設定の保存 ---------- */
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(CONFIG.PREFS_KEY) || '{}');
      if (p.persona) state.persona = String(p.persona);
      if (typeof p.autoDj === 'boolean' && !p.autoDj) state.between.mode = 'off';   // v1.0 からの引き継ぎ
      if (p.between) {
        if (['ai', 'script', 'mix', 'off'].includes(p.between.mode)) state.between.mode = p.between.mode;
        if ([1, 2, 3, 5].includes(Number(p.between.every))) state.between.every = Number(p.between.every);
      }
      if (p.script && p.script.text) state.legacyScript = { text: String(p.script.text), cast: p.script.cast || {} };  // v1.1 からの引き継ぎ
      if (typeof p.libId === 'string') state.libId = p.libId;
      if (typeof p.plId === 'string') state.plId = p.plId;
      if (typeof p.scriptId === 'string') state.scriptId = p.scriptId;
      if (Array.isArray(p.rundown)) {
        state.rundown = p.rundown.filter((x) => x && typeof x.sid === 'string')
          .map((x) => ({ sid: x.sid, b: Number.isInteger(x.b) ? x.b : -1 })).slice(0, 200);
      }
      if (p.convo) {
        ['me', 'ai', 'theme'].forEach((k) => { if (typeof p.convo[k] === 'string') state.convo[k] = p.convo[k]; });
        if (typeof p.convo.convert === 'boolean') state.convo.convert = p.convo.convert;
        if (typeof p.convo.continuous === 'boolean') state.convo.continuous = p.convo.continuous;
        const sl = Number(p.convo.silence);
        if (sl >= 1 && sl <= 5) state.convo.silence = sl;
      }
      if (p.exportPrefs && NWRExport.FORMATS[p.exportPrefs.format]) state.exportPrefs = Object.assign(state.exportPrefs, p.exportPrefs);
      if (p.fx) state.fx = Object.assign(state.fx, p.fx);
      if (typeof p.volume === 'number') state.volume = p.volume;
      if (typeof p.shuffle === 'boolean') state.shuffle = p.shuffle;
      if (['off', 'all', 'one'].includes(p.loop)) state.loop = p.loop;
    } catch (e) { /* 初回 */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(CONFIG.PREFS_KEY, JSON.stringify({
        persona: state.persona, between: state.between, fx: state.fx,
        volume: state.volume, shuffle: state.shuffle, loop: state.loop,
        libId: state.libId, plId: state.plId, scriptId: state.scriptId, rundown: state.rundown,
        convo: {
          me: state.convo.me, ai: state.convo.ai, theme: state.convo.theme, silence: state.convo.silence,
          convert: state.convo.convert, continuous: state.convo.continuous
        },
        exportPrefs: state.exportPrefs
      }));
    } catch (e) { /* noop */ }
  }

  /* =========================================================
   *  API
   * ========================================================= */
  async function api(action, payload = {}) {
    if (!CONFIG.GAS_URL || CONFIG.GAS_URL.includes('XXXX')) {
      throw new Error('config.js の GAS_URL を設定してください');
    }
    let res;
    try {
      res = await fetch(CONFIG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: state.token, ...payload })
      });
    } catch (e) {
      throw new Error('サーバーに接続できませんでした。通信環境を確認してください');
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('サーバーの応答を読み取れませんでした'); }
    if (!data.ok) {
      const err = new Error(data.error || 'エラーが発生しました');
      err.code = data.code;
      if (data.code === 'AUTH') forceLogout(data.error);
      if (data.code === 'MUST_CHANGE') openChangePw(true);
      throw err;
    }
    return data;
  }

  /* =========================================================
   *  セッション・認証
   * ========================================================= */
  function saveSession() {
    localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({ token: state.token, user: state.user }));
  }
  function clearSession() {
    localStorage.removeItem(CONFIG.SESSION_KEY);
    state.token = null;
    state.user = null;
  }

  function setAuthMsg(html, type = '') {
    const el = $('#authMsg');
    el.innerHTML = html;
    el.className = 'auth-msg' + (type ? ' is-' + type : '');
  }

  function showAuthTab(tab) {
    $$('[data-auth-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.authTab === tab));
    $$('[data-auth-panel]').forEach((p) => (p.hidden = p.dataset.authPanel !== tab));
    setAuthMsg('');
  }

  function showAuthScreen(msg) {
    $('#app').hidden = true;
    $('#authScreen').hidden = false;
    showAuthTab('login');
    if (msg) setAuthMsg(esc(msg), 'error');
  }

  async function withBusy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  }

  function bindAuth() {
    $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => showAuthTab(b.dataset.authTab)));

    // パスワード表示切替（全フォーム共通）
    document.addEventListener('click', (e) => {
      const eye = e.target.closest('.pw-eye');
      if (!eye) return;
      const input = eye.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.classList.toggle('is-on', show);
      eye.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    });

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      unlockMedia();
      await withBusy(f.querySelector('button[type=submit]'), 'ログイン中…', async () => {
        try {
          const d = await api('login', { email: f.email.value, password: f.password.value });
          state.token = d.token;
          state.user = d.user;
          saveSession();
          f.password.value = '';
          setAuthMsg('');
          if (d.user.mustChange) openChangePw(true);
          else enterApp();
        } catch (err) { setAuthMsg(esc(err.message), 'error'); }
      });
    });

    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      await withBusy(f.querySelector('button[type=submit]'), '送信中…', async () => {
        try {
          const d = await api('register', { email: f.email.value, nickname: f.nickname.value });
          const email = f.email.value;
          f.reset();
          showAuthTab('login');
          $('#loginForm').email.value = email;
          setAuthMsg(esc(d.message) + (d.tempPassword ? `<br>仮パスワード：<code>${esc(d.tempPassword)}</code>` : '<br>メールに届いた仮パスワードでログインしてください'), 'ok');
        } catch (err) { setAuthMsg(esc(err.message), 'error'); }
      });
    });

    $('#resetForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      await withBusy(f.querySelector('button[type=submit]'), '送信中…', async () => {
        try {
          const d = await api('resetPassword', { email: f.email.value });
          const email = f.email.value;
          f.reset();
          showAuthTab('login');
          $('#loginForm').email.value = email;
          setAuthMsg(esc(d.message) + (d.tempPassword ? `<br>仮パスワード：<code>${esc(d.tempPassword)}</code>` : ''), 'ok');
        } catch (err) { setAuthMsg(esc(err.message), 'error'); }
      });
    });

    $('#changePwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.newPassword.value !== f.confirmPassword.value) { toast('確認用のパスワードが一致しません', true); return; }
      await withBusy(f.querySelector('button[type=submit]'), '変更中…', async () => {
        try {
          const d = await api('changePassword', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
          state.user = d.user;
          saveSession();
          f.reset();
          $$('.pw-eye', f).forEach((b) => { b.classList.remove('is-on'); b.parentElement.querySelector('input').type = 'password'; });
          const modal = $('#modalChangePw');
          modal.dataset.locked = '';
          closeModal('modalChangePw');
          toast(d.message);
          enterApp();
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  function openChangePw(forced) {
    const modal = $('#modalChangePw');
    modal.dataset.locked = forced ? '1' : '';
    $('#cpCancel').hidden = !!forced;
    $('#cpLead').textContent = forced
      ? '初回ログインです。メールで届いた仮パスワードと、新しいパスワードを入力してください。'
      : '現在のパスワードと、新しいパスワードを入力してください。';
    if (forced) {
      $('#authScreen').hidden = true;
      $('#app').hidden = true;
    }
    openModal('modalChangePw');
  }

  function forceLogout(msg) {
    micStop('cancel');
    stopAll();
    setPlaying(false);
    if (state.room) exitRoomLocal();
    clearSession();
    state.appStarted = false;
    $$('.modal').forEach((m) => { m.dataset.locked = ''; m.hidden = true; });
    showAuthScreen(msg);
  }

  async function logout() {
    try { await api('logout'); } catch (e) { /* 失効済みでもOK */ }
    if (state.room) sendLeaveBeacon();
    forceLogout('');
    setAuthMsg('ログアウトしました', 'ok');
  }

  function renderUser() {
    const u = state.user;
    if (!u) return;
    $('#userName').textContent = u.nickname;
    const av = $('#userAvatar');
    av.textContent = initial(u.nickname);
    av.style.background = colorOf(u.nickname);
  }

  function enterApp() {
    $('#authScreen').hidden = true;
    $('#app').hidden = false;
    renderUser();
    if (state.appStarted) return;
    state.appStarted = true;
    loadPersonas();
    loadTracks();
    loadLibraries();
    loadPodlists();
    loadScripts().then(loadProgram);
    const hash = location.hash.replace('#', '');
    showView(VIEWS.includes(hash) ? hash : 'radio');
    try {
      if (!localStorage.getItem(HELP_SEEN_KEY)) {
        localStorage.setItem(HELP_SEEN_KEY, '1');
        setTimeout(() => openHelp('start'), 600);
      }
    } catch (e) { /* noop */ }
  }

  /* =========================================================
   *  使い方
   * ========================================================= */
  const HELP_SEEN_KEY = 'nwr_help_seen';
  function openHelp(tab) {
    showHelpTab(tab || ({ radio: 'radio', podcast: 'podcast', rooms: 'rooms', studio: 'studio' }[state.view]) || 'start');
    openModal('modalHelp');
  }
  function showHelpTab(tab) {
    $$('[data-help-tab]').forEach((b) => {
      const on = b.dataset.helpTab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('[data-help-panel]').forEach((p) => (p.hidden = p.dataset.helpPanel !== tab));
    const body = $('#helpBody');
    if (body) body.scrollTop = 0;
  }
  function bindHelp() {
    $('#btnHelp').addEventListener('click', () => openHelp());
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-help]');
      if (b) openHelp(b.dataset.help);
    });
    $$('[data-help-tab]').forEach((b) => b.addEventListener('click', () => showHelpTab(b.dataset.helpTab)));
  }

  /* =========================================================
   *  オーディオエンジン（Web Audio API）
   * ========================================================= */
  const audio = { ctx: null, duckLevel: 1, activeVoices: new Set(), silentUrl: null };

  function makeImpulse(ctx, seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function distCurve(k) {
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  function makeCrackle(ctx) {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * 0.08;
      if (Math.random() < 0.0006) d[i] = (Math.random() * 2 - 1) * 0.9;
    }
    return buf;
  }

  function ensureAudio() {
    if (audio.ctx) {
      if (audio.ctx.state === 'suspended') audio.ctx.resume();
      return audio.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    audio.ctx = ctx;

    audio.master = ctx.createGain();
    audio.analyser = ctx.createAnalyser();
    audio.analyser.fftSize = 256;
    audio.analyser.smoothingTimeConstant = 0.8;
    audio.master.connect(audio.analyser);
    audio.analyser.connect(ctx.destination);

    // 楽曲（Drive からの Blob 再生）
    audio.musicGain = ctx.createGain();
    audio.musicGain.connect(audio.master);
    audio.musicSrc = ctx.createMediaElementSource(musicEl);
    audio.musicSrc.connect(audio.musicGain);

    // 声（AI DJ・ルーム音声）→ ラジオエフェクト
    audio.voiceIn = ctx.createGain();
    audio.hp = ctx.createBiquadFilter(); audio.hp.type = 'highpass';
    audio.lp = ctx.createBiquadFilter(); audio.lp.type = 'lowpass';
    audio.shaper = ctx.createWaveShaper();
    audio.voiceOut = ctx.createGain(); audio.voiceOut.gain.value = 1.15;
    audio.voiceIn.connect(audio.hp).connect(audio.lp).connect(audio.shaper).connect(audio.voiceOut);
    audio.voiceOut.connect(audio.master);

    audio.delay = ctx.createDelay(1);
    audio.delay.delayTime.value = 0.24;
    audio.feedback = ctx.createGain(); audio.feedback.gain.value = 0.32;
    audio.echoGain = ctx.createGain();
    audio.shaper.connect(audio.delay);
    audio.delay.connect(audio.feedback).connect(audio.delay);
    audio.delay.connect(audio.echoGain).connect(audio.voiceOut);

    audio.convolver = ctx.createConvolver();
    audio.convolver.buffer = makeImpulse(ctx, 2.2, 2.6);
    audio.reverbGain = ctx.createGain();
    audio.shaper.connect(audio.convolver).connect(audio.reverbGain).connect(audio.voiceOut);

    // レコードノイズ
    audio.crackleGain = ctx.createGain();
    audio.crackleGain.gain.value = 0;
    audio.crackleGain.connect(audio.master);
    const cr = ctx.createBufferSource();
    cr.buffer = makeCrackle(ctx);
    cr.loop = true;
    cr.connect(audio.crackleGain);
    cr.start();

    audio.distCurve = distCurve(8);
    applyFx();
    applyVolume();
    return ctx;
  }

  function applyFx() {
    if (!audio.ctx) return;
    const t = audio.ctx.currentTime;
    const { lofi, echo, reverb } = state.fx;
    audio.hp.frequency.setTargetAtTime(lofi ? 320 : 20, t, 0.05);
    audio.lp.frequency.setTargetAtTime(lofi ? 3400 : 20000, t, 0.05);
    audio.shaper.curve = lofi ? audio.distCurve : null;
    audio.echoGain.gain.setTargetAtTime(Number(echo), t, 0.05);
    audio.reverbGain.gain.setTargetAtTime(Number(reverb), t, 0.05);
  }

  function applyVolume() {
    const d = audio.duckLevel;
    if (audio.ctx) {
      const t = audio.ctx.currentTime;
      audio.master.gain.setTargetAtTime(state.volume, t, 0.05);
      audio.musicGain.gain.setTargetAtTime(d, t, 0.2);
    }
    rawEl.volume = Math.min(1, state.volume * d);
    if (yt && yt.setVolume) yt.setVolume(Math.round(state.volume * d * 100));
  }

  function duck(on) {
    audio.duckLevel = on ? 0.22 : 1;
    applyVolume();
  }

  function silentUrl() {
    if (audio.silentUrl) return audio.silentUrl;
    const sr = 8000, n = 400, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * 2, true);
    audio.silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    return audio.silentUrl;
  }

  /** スマホの自動再生制限を解除（ユーザー操作の中で呼ぶ） */
  function unlockMedia() {
    ensureAudio();
    if (audio.unlocked) return;
    audio.unlocked = true;
    const u = silentUrl();
    [musicEl, rawEl].forEach((el) => {
      if (el.getAttribute('src')) return;
      el.src = u;
      el.play().then(() => el.pause()).catch(() => {});
    });
  }

  function decodeAudio(arrayBuffer) {
    const ctx = ensureAudio();
    return new Promise((res, rej) => ctx.decodeAudioData(arrayBuffer, res, rej));
  }

  /** GAS から返る音声（PCM または WAV 等）を AudioBuffer に */
  async function audioToBuffer(a) {
    const ctx = ensureAudio();
    const bytes = b64ToBytes(a.base64);
    if (/L16|pcm/i.test(a.mimeType || '')) {
      const n = Math.floor(bytes.length / 2);
      const rate = a.sampleRate || 24000;
      const buf = ctx.createBuffer(1, n, rate);
      const ch = buf.getChannelData(0);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
      for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
      return buf;
    }
    return decodeAudio(bytes.buffer);
  }

  function playVoiceBuffer(buf) {
    const ctx = ensureAudio();
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(audio.voiceIn);
      audio.activeVoices.add(src);
      if (state.fx.lofi) audio.crackleGain.gain.setTargetAtTime(0.35, ctx.currentTime, 0.1);
      src.onended = () => {
        audio.activeVoices.delete(src);
        if (!audio.activeVoices.size) audio.crackleGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
        resolve();
      };
      src.start();
    });
  }

  function playJingle() {
    const ctx = ensureAudio();
    const t0 = ctx.currentTime + 0.05;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = i % 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const s = t0 + i * 0.11;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.22, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.7);
      o.connect(g).connect(audio.voiceIn);
      o.start(s);
      o.stop(s + 0.75);
    });
    return sleep(1150);
  }

  /* ---------- ビジュアライザー ---------- */
  function startVisualizer() {
    const cv = $('#visualizer');
    const g = cv.getContext('2d');
    const data = new Uint8Array(128);
    const N = 48;
    const smooth = new Float32Array(N);
    let t = 0;
    const resize = () => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(1, Math.round(r.width * devicePixelRatio));
      cv.height = Math.max(1, Math.round(r.height * devicePixelRatio));
    };
    new ResizeObserver(resize).observe(cv);
    resize();
    const draw = () => {
      requestAnimationFrame(draw);
      t += 0.04;
      const W = cv.width, H = cv.height;
      g.clearRect(0, 0, W, H);
      if (audio.analyser) audio.analyser.getByteFrequencyData(data);
      const simulate = state.playing && (state.currentSource === 'youtube' || state.currentSource === 'url');
      const grad = g.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, '#3fe6ff');
      grad.addColorStop(1, '#ff4fb4');
      g.fillStyle = grad;
      const gap = W / N;
      for (let i = 0; i < N; i++) {
        let v = audio.analyser ? data[Math.floor((i * data.length * 0.72) / N)] / 255 : 0;
        if (simulate) {
          const s = 0.38 + 0.28 * Math.sin(t * 2.1 + i * 0.45) * Math.sin(t * 0.6 + i * 0.17) + 0.18 * Math.sin(t * 5.3 + i);
          v = Math.max(v, s * (1 - (i / N) * 0.45));
        }
        smooth[i] += (Math.max(v, 0.03) - smooth[i]) * 0.25;
        const h = smooth[i] * H * 0.95;
        const w = gap * 0.58;
        g.globalAlpha = 0.9;
        g.fillRect(i * gap + (gap - w) / 2, H - h, w, h);
      }
    };
    draw();
  }

  /* =========================================================
   *  プレイヤー
   * ========================================================= */
  let yt = null;
  let ytReadyPromise = null;

  function loadYT() {
    if (ytReadyPromise) return ytReadyPromise;
    ytReadyPromise = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => {
        yt = new YT.Player('ytHost', {
          width: '100%', height: '100%',
          playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, modestbranding: 1 },
          events: {
            onReady: () => { applyVolume(); resolve(yt); },
            onStateChange: onYtState,
            onError: onYtError
          }
        });
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytReadyPromise = null; reject(new Error('YouTube プレイヤーを読み込めませんでした')); };
      document.head.appendChild(s);
    });
    return ytReadyPromise;
  }

  function onYtState(e) {
    if (state.currentSource !== 'youtube') return;
    if (e.data === YT.PlayerState.PLAYING) setPlaying(true);
    else if (e.data === YT.PlayerState.PAUSED) setPlaying(false);
    else if (e.data === YT.PlayerState.ENDED) onTrackEnded();
  }

  function onYtError() {
    if (state.currentSource !== 'youtube') return;
    toast('この動画は埋め込み再生が許可されていません。次の曲へ進みます', true);
    setTimeout(() => nextTrack(true), 1200);
  }

  const activeEl = () => (state.currentSource === 'drive' ? musicEl : state.currentSource === 'url' ? rawEl : null);

  function bindMediaEl(el) {
    const isActive = () => el === activeEl() && el.currentSrc !== audio.silentUrl;
    el.addEventListener('play', () => isActive() && setPlaying(true));
    el.addEventListener('pause', () => isActive() && setPlaying(false));
    el.addEventListener('ended', () => isActive() && onTrackEnded());
    ['timeupdate', 'loadedmetadata', 'durationchange'].forEach((ev) => el.addEventListener(ev, () => isActive() && updateSeek()));
    el.addEventListener('error', () => {
      if (!isActive() || !el.getAttribute('src')) return;
      toast('音声を再生できませんでした。次の曲へ進みます', true);
      setTimeout(() => nextTrack(true), 1200);
    });
  }

  function stopAll() {
    [musicEl, rawEl].forEach((el) => {
      el.pause();
      if (el.getAttribute('src')) { el.removeAttribute('src'); el.load(); }
    });
    if (yt && yt.stopVideo) { try { yt.stopVideo(); } catch (e) { /* noop */ } }
  }

  const urlCache = new Map();
  async function getTrackUrl(fileId) {
    if (urlCache.has(fileId)) {
      const u = urlCache.get(fileId);
      urlCache.delete(fileId);
      urlCache.set(fileId, u);
      return u;
    }
    const d = await api('audio_get', { fileId });
    const url = URL.createObjectURL(new Blob([b64ToBytes(d.base64)], { type: d.mimeType || 'audio/mpeg' }));
    urlCache.set(fileId, url);
    while (urlCache.size > 4) {
      const [k, v] = urlCache.entries().next().value;
      URL.revokeObjectURL(v);
      urlCache.delete(k);
    }
    return url;
  }

  function computeNext() {
    const n = state.queue.length;
    if (!n) return null;
    if (state.shuffle && !state.podQueue && n > 1) {
      let r;
      do { r = Math.floor(Math.random() * n); } while (r === state.idx);
      return r;
    }
    if (state.idx + 1 < n) return state.idx + 1;
    return state.loop === 'all' ? 0 : null;
  }

  function setLoading(on) { $('#pLoading').hidden = !on; }

  async function loadTrack(i, autoplay = true) {
    if (i == null || i < 0 || i >= state.queue.length) return;
    ensureAudio();
    const token = ++state.loadToken;
    stopAll();
    state.idx = i;
    const t = state.queue[i];
    state.currentSource = t.source;
    state.plannedNext = computeNext();
    renderNowPlaying(t);
    renderQueue();
    markCurrentInLists();
    $('#ytWrap').hidden = t.source !== 'youtube';
    $('#turntable').hidden = t.source === 'youtube';
    updateSeek();

    try {
      if (t.source === 'youtube') {
        setLoading(true);
        await loadYT();
        if (token !== state.loadToken) return;
        applyVolume();
        if (autoplay) yt.loadVideoById(t.youtubeId); else yt.cueVideoById(t.youtubeId);
      } else if (t.source === 'url') {
        rawEl.src = t.url;
        applyVolume();
        if (autoplay) await rawEl.play();
      } else {
        setLoading(true);
        const url = await getTrackUrl(t.fileId);
        if (token !== state.loadToken) return;
        musicEl.src = url;
        if (autoplay) await musicEl.play();
      }
    } catch (e) {
      if (token !== state.loadToken) return;
      if (e && e.name === 'NotAllowedError') toast('▶ を押すと再生がはじまります');
      else toast(e.message || '再生できませんでした', true);
      setPlaying(false);
    } finally {
      if (token === state.loadToken) setLoading(false);
    }
    updateMediaSession(t);
    maybePrefetchSegment();
  }

  function playList(list, start = 0, opts = {}) {
    if (!list.length) return;
    unlockMedia();
    stopProgram();
    state.podQueue = !!opts.podcast;
    state.queue = list.slice();
    state.playedCount = 0;
    state.segPrefetch = null;
    loadTrack(start);
  }

  function togglePlay() {
    unlockMedia();
    if (state.idx < 0) { startRadio(); return; }
    if (state.currentSource === 'youtube') {
      if (!yt) return;
      if (yt.getPlayerState() === YT.PlayerState.PLAYING) yt.pauseVideo(); else yt.playVideo();
      return;
    }
    const el = activeEl();
    if (!el) return;
    if (!el.getAttribute('src') || el.currentSrc === audio.silentUrl) { loadTrack(state.idx); return; }
    if (el.paused) el.play().catch(() => toast('再生できませんでした', true));
    else el.pause();
  }

  function nextTrack(auto = false) {
    unlockMedia();
    if (state.progMode) { if (!state.djBusy) progAdvance(); return; }
    const n = state.plannedNext != null ? state.plannedNext : computeNext();
    if (n == null) {
      if (!auto) toast('プレイリストの最後の曲です');
      setPlaying(false);
      return;
    }
    loadTrack(n);
  }

  function prevTrack() {
    unlockMedia();
    const { cur } = getPos();
    if (cur > 3) { seekTo(0); return; }
    if (state.progMode) { if (!state.djBusy) progPrev(); return; }
    let p = state.idx - 1;
    if (p < 0) p = state.loop === 'all' ? state.queue.length - 1 : 0;
    loadTrack(p);
  }

  function replayCurrent() {
    if (state.currentSource === 'youtube' && yt) { yt.seekTo(0, true); yt.playVideo(); return; }
    const el = activeEl();
    if (el) { el.currentTime = 0; el.play().catch(() => {}); }
  }

  async function onTrackEnded() {
    if (state.loop === 'one') { replayCurrent(); return; }
    state.playedCount++;
    if (state.progMode) { progAdvance(); return; }
    const n = state.plannedNext;
    if (n == null) {
      setPlaying(false);
      toast('プレイリストを最後まで再生しました');
      return;
    }
    if (!state.podQueue && state.between.mode !== 'off' && state.playedCount % state.between.every === 0) {
      const plan = pickBetween();
      if (plan) {
        const key = planKey(plan, state.idx, n);
        const pf = state.segPrefetch;
        const promise = pf && pf.key === key ? pf.promise : requestSegment(plan, betweenCtx(state.idx, n));
        state.segPrefetch = null;
        const token = state.loadToken;
        await performSegment(promise, false);
        if (token !== state.loadToken) return; // トーク中に別の曲が選ばれた
      }
    }
    loadTrack(n);
  }

  function getPos() {
    if (state.currentSource === 'youtube' && yt && yt.getCurrentTime) {
      return { cur: yt.getCurrentTime() || 0, dur: yt.getDuration() || 0 };
    }
    const el = activeEl();
    if (!el || el.currentSrc === audio.silentUrl) return { cur: 0, dur: 0 };
    return { cur: el.currentTime || 0, dur: isFinite(el.duration) ? el.duration : 0 };
  }

  function seekTo(sec) {
    if (state.currentSource === 'youtube' && yt) { yt.seekTo(sec, true); return; }
    const el = activeEl();
    if (el && isFinite(el.duration)) el.currentTime = sec;
  }

  function updateSeek() {
    const { cur, dur } = getPos();
    if (!state.seeking) $('#pSeek').value = dur ? Math.round((cur / dur) * 1000) : 0;
    $('#pCur').textContent = fmtTime(cur);
    $('#pDur').textContent = fmtTime(dur);
  }

  function setPlaying(on) {
    state.playing = on;
    const btn = $('#pPlay');
    btn.textContent = on ? '⏸' : '▶';
    btn.setAttribute('aria-label', on ? '一時停止' : '再生');
    $('#vinyl').classList.toggle('is-spinning', on);
    $('#tonearm').classList.toggle('is-on', on);
    $('#playerDisc').classList.toggle('is-spinning', on);
    setOnAir(on || state.djBusy);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  }

  function setOnAir(on) { $('#onAir').classList.toggle('is-on', !!on); }

  function setLcd(text) {
    const el = $('#lcdText');
    el.textContent = text;
    el.classList.toggle('is-scroll', text.length > 16);
  }

  function trackSubtitle(t) {
    if (t.kind === 'podcast') return t.showName || 'ポッドキャスト';
    return t.artist || (t.aiGenerated ? 'AI オリジナル' : 'アーティスト不明');
  }

  function renderNowPlaying(t) {
    $('#nowTitle').textContent = t.title;
    $('#nowArtist').textContent = trackSubtitle(t);
    const badges = [];
    if (t.kind === 'podcast') badges.push('<span class="badge">ポッドキャスト</span>');
    if (t.aiGenerated) badges.push('<span class="badge badge-ai">AI生成</span>');
    if (t.source === 'youtube') badges.push('<span class="badge badge-yt">YouTube</span>');
    $('#nowBadges').innerHTML = badges.join('');
    const c = `hsl(${hue(t.title)} 85% 62%)`;
    $('#vinylLabel').style.background = c;
    $('#playerDisc').style.setProperty('--pc', c);
    $('#pTitle').textContent = t.title;
    $('#pArtist').textContent = trackSubtitle(t);
    setLcd(`${t.title}  /  ${trackSubtitle(t)}`);
    document.title = `${t.title}｜NEON WAVE RADIO`;
  }

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: trackSubtitle(t), album: CONFIG.APP_NAME });
    } catch (e) { /* noop */ }
  }

  function bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) { /* 非対応 */ } };
    set('play', () => togglePlay());
    set('pause', () => togglePlay());
    set('nexttrack', () => nextTrack());
    set('previoustrack', () => prevTrack());
  }

  function renderQueue() {
    const ol = $('#queueList');
    if (!state.queue.length) { ol.innerHTML = '<li class="empty">再生待ちの曲はありません</li>'; return; }
    ol.innerHTML = state.queue.map((t, i) =>
      `<li class="${i === state.idx ? 'is-current' : ''}"><button data-q="${i}"><span class="q-no">${i + 1}</span><span class="q-t">${esc(t.title)}</span></button></li>`
    ).join('');
  }

  function renderShuffleLoop() {
    $('#pShuffle').classList.toggle('is-active', state.shuffle);
    const lp = $('#pLoop');
    lp.classList.toggle('is-active', state.loop !== 'off');
    lp.textContent = state.loop === 'one' ? '🔂' : '🔁';
    const label = { off: 'リピート：オフ', all: 'リピート：全曲', one: 'リピート：1曲' }[state.loop];
    lp.title = label;
    lp.setAttribute('aria-label', label);
  }

  function bindPlayer() {
    bindMediaEl(musicEl);
    bindMediaEl(rawEl);
    $('#pPlay').addEventListener('click', togglePlay);
    $('#pNext').addEventListener('click', () => nextTrack());
    $('#pPrev').addEventListener('click', prevTrack);
    $('#pShuffle').addEventListener('click', () => {
      state.shuffle = !state.shuffle;
      if (state.idx >= 0) state.plannedNext = computeNext();
      state.segPrefetch = null;
      renderShuffleLoop();
      savePrefs();
      toast(state.shuffle ? 'シャッフル：オン' : 'シャッフル：オフ');
    });
    $('#pLoop').addEventListener('click', () => {
      state.loop = { off: 'all', all: 'one', one: 'off' }[state.loop];
      if (state.idx >= 0) state.plannedNext = computeNext();
      renderShuffleLoop();
      savePrefs();
      toast($('#pLoop').title);
    });
    const seek = $('#pSeek');
    seek.addEventListener('input', () => {
      state.seeking = true;
      const { dur } = getPos();
      $('#pCur').textContent = fmtTime((seek.value / 1000) * dur);
    });
    seek.addEventListener('change', () => {
      const { dur } = getPos();
      if (dur) seekTo((seek.value / 1000) * dur);
      state.seeking = false;
    });
    const vol = $('#pVol');
    vol.value = state.volume;
    vol.addEventListener('input', () => { state.volume = Number(vol.value); applyVolume(); });
    vol.addEventListener('change', savePrefs);

    $('#pList').addEventListener('click', () => {
      const d = $('#playlistDrawer');
      d.hidden = !d.hidden;
      if (!d.hidden) renderQueue();
    });
    $('[data-close-drawer]').addEventListener('click', () => ($('#playlistDrawer').hidden = true));
    $('#queueList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      unlockMedia();
      const qi = Number(b.dataset.q);
      if (state.progMode) {
        const pos = state.progSongIdx.indexOf(qi);
        if (pos >= 0) { state.progPos = pos; renderProgram(); }
      }
      loadTrack(qi);
    });

    setInterval(() => { if (state.currentSource === 'youtube' && yt && yt.getCurrentTime) updateSeek(); }, 500);

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.target.closest('input, textarea, select, button')) return;
      if ($$('.modal').some((m) => !m.hidden) || $('#app').hidden) return;
      e.preventDefault();
      togglePlay();
    });
    renderShuffleLoop();
  }

  /* =========================================================
   *  AIパーソナリティ（一覧はサーバーから読み込み）
   * ========================================================= */
  const FALLBACK_PERSONA = { id: '', name: 'AI パーソナリティ', icon: '🎙', color: '#7c6cff', gender: 'other', voice: '', role: '', description: '' };
  const GENDER_LABEL = { male: '男性', female: '女性', other: 'その他' };
  const personaById = (id) => state.personas.find((p) => p.id === id) || Object.assign({}, FALLBACK_PERSONA, { id: id || '' });
  const hasPersona = (id) => state.personas.some((p) => p.id === id);
  const personaOptions = (selected) => state.personas.map((p) =>
    `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.icon)} ${esc(p.name)}（${GENDER_LABEL[p.gender] || 'その他'}）</option>`).join('');

  async function loadPersonas() {
    try {
      const d = await api('personas_list');
      state.personas = d.personas || [];
      state.voices = d.voices || [];
    } catch (e) {
      toast(e.message, true);
    }
    fixPersonaPrefs();
    renderPersonas();
    renderStudioSelects();
    renderPersonaGrid();
    renderCast();
    renderBlocks();
    renderSeats();
  }

  function fixPersonaPrefs() {
    if (!state.personas.length) return;
    const first = state.personas[0].id;
    const pick = (id, fb) => (hasPersona(id) ? id : hasPersona(fb) ? fb : first);
    state.persona = pick(state.persona, 'midnight');
    state.convo.me = pick(state.convo.me, 'cafe');
    state.convo.ai = pick(state.convo.ai, 'sunset');
    if (state.script.blocks.length) syncAutoCast();
  }

  function renderPersonas() {
    const list = state.personas;
    $('#personaList').innerHTML = list.length ? list.map((p) => `
      <button class="persona" role="radio" aria-checked="${p.id === state.persona}" data-persona="${esc(p.id)}" style="--pc:${esc(p.color)}">
        <span class="persona-ico" aria-hidden="true">${esc(p.icon)}</span>
        <span><span class="persona-name">${esc(p.name)}</span><span class="persona-desc">${esc(p.role || GENDER_LABEL[p.gender] || '')}${p.description ? '｜' + esc(p.description) : ''}</span></span>
      </button>`).join('') : '<p class="empty">読み込み中…</p>';
    const opts = personaOptions(state.persona);
    $('#crPersona').innerHTML = opts;
    $('#roomPersona').innerHTML = opts;
    if (state.room && state.room.info) $('#roomPersona').value = state.room.info.persona;
  }

  function showCaption(who, text, loading) {
    const box = $('#djCaption');
    box.hidden = false;
    box.classList.toggle('is-loading', !!loading);
    $('#djCaptionWho').textContent = who;
    $('#djCaptionText').textContent = text;
    $('#btnSegExport').hidden = !!loading || !state.lastSegment;
  }

  /* =========================================================
   *  曲間トーク（AI DJ ／ 台本の掛け合い）
   * ========================================================= */
  const scriptById = (id) => state.scripts.find((x) => x.id === id);
  function blocksOf(sc) {
    if (!sc) return [];
    if (sc._src !== sc.text) { sc._src = sc.text; sc._blocks = parseScript(sc.text); }
    return sc._blocks;
  }

  /** 曲間に流すブロックの並び（放送順。空なら開いている台本を最初から） */
  function betweenSeq() {
    const items = state.rundown.length ? state.rundown : (state.scriptId ? [{ sid: state.scriptId, b: -1 }] : []);
    const out = [];
    items.forEach((it, ri) => {
      const sc = scriptById(it.sid);
      if (!sc) return;
      const bs = blocksOf(sc);
      const add = (bi) => out.push({ sid: sc.id, bi, block: bs[bi], cast: sc.cast || {}, title: sc.title, ri });
      if (it.b < 0) bs.forEach((_, bi) => add(bi));
      else if (bs[it.b]) add(it.b);
    });
    return out;
  }
  function scriptRemaining() { return betweenSeq().length - state.seqNext; }

  /** 次の曲間に何を流すか */
  function pickBetween() {
    const m = state.between.mode;
    if ((m === 'script' || m === 'mix') && scriptRemaining() > 0) return { kind: 'script', pos: state.seqNext };
    if (m === 'ai' || m === 'mix') return { kind: 'ai' };
    return null;
  }
  const planKey = (plan, from, to) => `${plan.kind}:${plan.pos == null ? '' : plan.pos}:${from}:${to}`;

  function betweenCtx(fromIdx, toIdx) {
    const a = state.queue[fromIdx] || {}, b = state.queue[toIdx] || {};
    return {
      mode: 'between',
      prevTitle: a.title, prevArtist: a.kind === 'podcast' ? a.showName : a.artist,
      nextTitle: b.title, nextArtist: b.kind === 'podcast' ? b.showName : b.artist,
      nextAi: !!b.aiGenerated
    };
  }

  async function aiSegment(r) {
    const buffer = await audioToBuffer(r.audio);
    const p = personaById(r.persona);
    return { buffer, who: `${p.icon} ${p.name}`, text: r.text, title: `${p.name}のトーク`, artist: p.name, lcd: `${p.name} ON AIR` };
  }

  async function makeBlockSegment(b, cast, title, seqPos) {
    if (!b) throw new Error('台本のブロックが見つかりません');
    const buffer = await getBlockBuffer(b, cast);
    return {
      buffer, who: `🎙 ${castLabel(b)}`, text: blockText(b),
      title, artist: castLabel(b), lcd: '掛け合いトーク ON AIR', seqPos
    };
  }

  function seqSegment(pos) {
    const e = betweenSeq()[pos];
    if (!e) return Promise.reject(new Error('放送順のブロックが見つかりません'));
    return makeBlockSegment(e.block, e.cast, `${e.title} ${e.bi + 1}`, pos);
  }

  function requestSegment(plan, ctxInfo) {
    const p = plan.kind === 'script'
      ? seqSegment(plan.pos)
      : api('dj_talk', { persona: state.persona, context: ctxInfo }).then(aiSegment);
    p.catch(() => {});
    return p;
  }

  /** 次の曲が終わったときにトークが入る予定なら、音声を先に作っておく */
  function maybePrefetchSegment() {
    if (state.progMode) { prefetchProgram(); return; }
    if (state.podQueue || state.between.mode === 'off' || state.plannedNext == null || state.loop === 'one') return;
    if ((state.playedCount + 1) % state.between.every !== 0) return;
    const plan = pickBetween();
    if (!plan) return;
    const key = planKey(plan, state.idx, state.plannedNext);
    if (state.segPrefetch && state.segPrefetch.key === key) return;
    state.segPrefetch = { key, promise: requestSegment(plan, betweenCtx(state.idx, state.plannedNext)) };
  }

  async function performSegment(promise, overMusic, loadingWho) {
    if (state.djBusy) return;
    state.djBusy = true;
    setOnAir(true);
    showCaption(loadingWho || '🎙 ON AIR', 'トークを準備しています…', true);
    $('#btnCallDj').disabled = true;
    try {
      const seg = await promise;
      state.lastSegment = seg;
      showCaption(seg.who, seg.text, false);
      setLcd(seg.lcd);
      if (seg.seqPos != null) {
        state.seqNext = Math.max(state.seqNext, seg.seqPos + 1);
        renderScriptStatus();
        renderBlocks();
        renderRundown();
      }
      if (overMusic) duck(true);
      await playJingle();
      await playVoiceBuffer(seg.buffer);
      await sleep(350);
    } catch (e) {
      showCaption('🎙 ON AIR', 'トークを用意できませんでした：' + e.message, true);
      toast('トーク：' + e.message, true);
    } finally {
      if (overMusic) duck(false);
      state.djBusy = false;
      $('#btnCallDj').disabled = false;
      setOnAir(state.playing);
      const cur = state.queue[state.idx];
      if (cur) setLcd(`${cur.title}  /  ${trackSubtitle(cur)}`);
    }
  }

  function callDjNow() {
    unlockMedia();
    if (state.djBusy) { toast('トークの最中です'); return; }
    const cur = state.queue[state.idx];
    const ctxInfo = state.playing && cur ? { mode: 'nowplaying', nowTitle: cur.title } : { mode: 'opening' };
    const p = personaById(state.persona);
    performSegment(requestSegment({ kind: 'ai' }, ctxInfo), state.playing, `${p.icon} ${p.name}`);
  }

  async function startRadio() {
    unlockMedia();
    stopProgram();
    const songs = librarySongs();
    if (!songs.length) {
      if (state.libId) { toast('このライブラリにはまだ曲がありません', true); return; }
      toast('まずは曲を登録しましょう');
      openAddTrack('song');
      return;
    }
    const lib = libById(state.libId);
    if (lib) toast(`ライブラリ「${lib.name}」を放送します`);
    const start = state.shuffle ? Math.floor(Math.random() * songs.length) : 0;
    state.podQueue = false;
    state.queue = songs;
    state.playedCount = 0;
    state.segPrefetch = null;
    state.seqNext = 0;
    renderScriptStatus();
    renderBlocks();
    renderRundown();
    if (state.between.mode !== 'off' && !state.djBusy) {
      const plan = pickBetween();
      if (plan) await performSegment(requestSegment(plan, { mode: 'opening' }), false);
    }
    loadTrack(start);
  }

  function renderScriptStatus() {
    const el = $('#scriptStatus');
    if (!el) return;
    if (state.progMode) {
      const it = state.program[state.progPos];
      el.textContent = `番組表で放送中：${state.progPos + 1} / ${state.program.length}${it ? '（' + progLabel(it).no + '）' : ''}`;
      return;
    }
    const seq = betweenSeq();
    const n = seq.length;
    const m = state.between.mode;
    if (m === 'off') { el.textContent = '曲間には何も入れません'; return; }
    if (m === 'ai') { el.textContent = `${personaById(state.persona).name} が${state.between.every === 1 ? '毎曲' : state.between.every + '曲ごとに'}しゃべります`; return; }
    if (!n) { el.textContent = '台本がまだありません。スタジオの「掛け合い台本」で作れます'; return; }
    const rest = n - state.seqNext;
    const e = seq[state.seqNext];
    el.textContent = rest > 0
      ? `放送順 ${n} ブロック中、次は ${state.seqNext + 1} 番目（${e.title} の ${e.bi + 1}）を流します`
      : (m === 'mix' ? '台本はすべて流しました。この先は AI DJ がしゃべります' : '台本はすべて流しました（放送をはじめ直すと最初から）');
  }

  function bindDj() {
    renderPersonas();
    $('#personaList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-persona]');
      if (!b) return;
      state.persona = b.dataset.persona;
      state.segPrefetch = null;
      renderPersonas();
      renderScriptStatus();
      savePrefs();
      maybePrefetchSegment();
    });
    const mode = $('#betweenMode'), every = $('#betweenEvery');
    mode.value = state.between.mode;
    every.value = String(state.between.every);
    mode.addEventListener('change', () => {
      state.between.mode = mode.value;
      state.segPrefetch = null;
      savePrefs();
      renderScriptStatus();
      maybePrefetchSegment();
    });
    every.addEventListener('change', () => {
      state.between.every = Number(every.value);
      state.segPrefetch = null;
      savePrefs();
      renderScriptStatus();
      maybePrefetchSegment();
    });
    renderScriptStatus();

    const lofi = $('#fxLofi'), echo = $('#fxEcho'), rev = $('#fxReverb');
    lofi.checked = state.fx.lofi;
    echo.value = state.fx.echo;
    rev.value = state.fx.reverb;
    lofi.addEventListener('change', () => { state.fx.lofi = lofi.checked; applyFx(); savePrefs(); });
    echo.addEventListener('input', () => { state.fx.echo = Number(echo.value); applyFx(); });
    rev.addEventListener('input', () => { state.fx.reverb = Number(rev.value); applyFx(); });
    [echo, rev].forEach((el) => el.addEventListener('change', savePrefs));

    $('#btnJingle').addEventListener('click', () => { unlockMedia(); playJingle(); });
    $('#btnStartRadio').addEventListener('click', startRadio);
    $('#btnCallDj').addEventListener('click', callDjNow);
    $('#btnSegExport').addEventListener('click', () => {
      const seg = state.lastSegment;
      if (!seg) return;
      openExport({ title: seg.title, artist: seg.artist, mono: true, getBuffer: async () => seg.buffer });
    });
  }

  /* =========================================================
   *  ライブラリ（楽曲・ポッドキャスト）
   * ========================================================= */
  async function loadTracks() {
    try {
      const d = await api('tracks_list');
      state.tracks = d.tracks || [];
      state.showOrders = d.showOrders || {};
      state.listenOrders = d.listenOrders || {};
    } catch (e) {
      toast(e.message, true);
    }
    renderSongs();
    renderPodcasts();
  }

  const canDelete = (t) => state.user && (t.ownerId === state.user.userId || state.user.role === 'admin');

  /**
   * opt.sorting : 並べ替えボタンを出す
   * opt.total   : 並べ替え対象の件数（↓⤓ の無効判定）
   * opt.prefix  : 番号の頭（曲 / EP）
   */
  function trackItemHtml(t, listName, i, no, opt = {}) {
    const isSong = listName === 'songs';
    const sorting = opt.sorting != null ? !!(opt.sorting && no) : (isSong && state.reorder && !!state.libId && !!no);
    const total = opt.total || lists.songs.length;
    const label = (opt.prefix || '曲') + no;
    const sub = t.kind === 'podcast'
      ? `${esc(t.ownerName || '')} さんが登録`
      : `${esc(trackSubtitle(t))}（${esc(t.ownerName || '')} さんが登録）`;
    return `
      <li class="track${sorting ? ' is-sorting' : ''}" data-track-id="${esc(t.id)}">
        <button class="track-cover" style="background:${coverBg(t.title)}" data-play="${listName}" data-i="${i}" aria-label="「${esc(t.title)}」を再生"><span class="play-ico">▶</span></button>
        <div class="track-main">
          <div class="track-title">${no ? (sorting
            ? `<button class="track-no track-no-btn" data-mvto="${esc(t.id)}" title="番号を指定して移動">${label}</button>`
            : `<span class="track-no">${label}</span>`) : ''}${t.source === 'youtube' ? '📺 ' : ''}${esc(t.title)}</div>
          <div class="track-meta">${sub}</div>
          ${t.kind === 'podcast' && t.description ? `<p class="ep-desc">${esc(t.description)}</p>` : ''}
        </div>
        ${sorting ? `<div class="track-actions track-order">
          <button class="icon-btn" data-mv="top" data-id="${esc(t.id)}" title="一番上へ" aria-label="一番上へ"${no === 1 ? ' disabled' : ''}>⤒</button>
          <button class="icon-btn" data-mv="up" data-id="${esc(t.id)}" title="1つ上へ" aria-label="1つ上へ"${no === 1 ? ' disabled' : ''}>↑</button>
          <button class="icon-btn" data-mv="down" data-id="${esc(t.id)}" title="1つ下へ" aria-label="1つ下へ"${no === total ? ' disabled' : ''}>↓</button>
          <button class="icon-btn" data-mv="bottom" data-id="${esc(t.id)}" title="一番下へ" aria-label="一番下へ"${no === total ? ' disabled' : ''}>⤓</button>
        </div>` : `<div class="track-actions">
          <button class="icon-btn" data-next="${esc(t.id)}" title="次に再生" aria-label="次に再生">＋</button>
          ${t.kind === 'podcast' && state.plId ? `<button class="icon-btn pl-pick${plHas(t.id) ? ' is-in' : ''}" data-plpick="${esc(t.id)}" title="${plHas(t.id) ? '再生リストから外す' : '再生リストに入れる'}" aria-label="${plHas(t.id) ? '再生リストから外す' : '再生リストに入れる'}">📃</button>` : ''}
          ${t.kind === 'song' ? `<button class="icon-btn" data-libpick=""${esc(t.id)}" title="ライブラリに入れる・外す" aria-label="ライブラリに入れる・外す">📁</button>` : ''}
          ${t.kind === 'song' && state.libId ? `<button class="icon-btn" data-libout="${esc(t.id)}" title="このライブラリから外す" aria-label="このライブラリから外す">−</button>` : ''}
          ${t.source !== 'youtube' ? `<button class="icon-btn" data-export="${esc(t.id)}" title="音声ファイルに書き出す" aria-label="音声ファイルに書き出す">⬇</button>` : ''}
          ${canDelete(t) ? `<button class="icon-btn" data-del="${esc(t.id)}" title="削除" aria-label="削除">🗑</button>` : ''}
        </div>`}
      </li>`;
  }

  const lists = { songs: [], shows: {}, showKeys: [] };

  /* ---------- 楽曲ライブラリ（セット） ---------- */
  const libById = (id) => state.libraries.find((l) => l.id === id);

  /** 選んでいるライブラリの曲（「すべての曲」なら全曲） */
  function librarySongs() {
    const all = state.tracks.filter((t) => t.kind === 'song');
    const lib = libById(state.libId);
    if (!lib) return all;
    const map = new Map(all.map((t) => [t.id, t]));
    return lib.trackIds.map((id) => map.get(id)).filter(Boolean);
  }

  async function loadLibraries() {
    try {
      const d = await api('libraries_list');
      state.libraries = d.libraries || [];
      state.libMax = d.max || 20;
    } catch (e) { toast(e.message, true); }
    if (state.libId && !libById(state.libId)) state.libId = '';
    renderLibSelect();
    renderSongs();
  }

  function renderLibSelect() {
    const total = state.tracks.filter((t) => t.kind === 'song').length;
    const sel = $('#libSelect');
    sel.innerHTML = `<option value="">すべての曲（${total}）</option>` +
      state.libraries.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}（${l.trackIds.length}）</option>`).join('');
    sel.value = state.libId;
    $('#libCount').textContent = `${state.libraries.length} / ${state.libMax}`;
    $('#btnLibRename').disabled = !state.libId;
    $('#btnLibDelete').disabled = !state.libId;
    const sortBtn = $('#btnLibSort');
    if (!state.libId) state.reorder = false;
    sortBtn.disabled = !state.libId;
    sortBtn.classList.toggle('is-active', state.reorder);
    sortBtn.textContent = state.reorder ? '✓ 並べ替え完了' : '↕ 並べ替え';
    $('#libSortHint').hidden = !state.reorder;
    $('#songFilter').hidden = state.reorder;
  }

  /* ---------- ライブラリ内の曲の並べ替え ---------- */
  let libSaveTimer = null;
  function scheduleLibSave(lib) {
    clearTimeout(libSaveTimer);
    libSaveTimer = setTimeout(async () => {
      try { await saveLibrary(lib); }
      catch (e) { toast('並び順を保存できませんでした：' + e.message, true); loadLibraries(); }
    }, 700);
  }

  /** how: top / up / down / bottom / 数値（移動先の曲No） */
  function moveTrack(id, how) {
    const lib = libById(state.libId);
    if (!lib) return;
    const ids = librarySongs().map((t) => t.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    let to = from;
    if (how === 'top') to = 0;
    else if (how === 'up') to = from - 1;
    else if (how === 'down') to = from + 1;
    else if (how === 'bottom') to = ids.length - 1;
    else if (typeof how === 'number') to = how - 1;
    to = Math.max(0, Math.min(ids.length - 1, to));
    if (to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    lib.trackIds = ids;
    renderSongs();
    const li = $(`#songList [data-track-id="${CSS.escape(id)}"]`);
    if (li) {
      li.classList.remove('is-moved');
      void li.offsetWidth;
      li.classList.add('is-moved');
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    scheduleLibSave(lib);
  }

  async function saveLibrary(lib) {
    const d = await api('library_save', { library: { id: lib.id, name: lib.name, trackIds: lib.trackIds } });
    const i = state.libraries.findIndex((l) => l.id === d.library.id);
    if (i >= 0) state.libraries[i] = d.library; else state.libraries.push(d.library);
    renderLibSelect();
    return d.library;
  }

  async function createLibrary(withTrackId) {
    if (state.libraries.length >= state.libMax) { toast(`ライブラリは ${state.libMax} セットまでです`, true); return null; }
    const name = (prompt('新しいライブラリの名前', `ライブラリ ${state.libraries.length + 1}`) || '').trim();
    if (!name) return null;
    try {
      const lib = await saveLibrary({ name, trackIds: withTrackId ? [withTrackId] : [] });
      toast(`ライブラリ「${lib.name}」を作りました`);
      return lib;
    } catch (e) { toast(e.message, true); return null; }
  }

  async function toggleTrackInLib(lib, trackId, on) {
    const ids = lib.trackIds.filter((x) => x !== trackId);
    if (on) ids.push(trackId);
    const before = lib.trackIds;
    lib.trackIds = ids;
    try { await saveLibrary(lib); } catch (e) { lib.trackIds = before; toast(e.message, true); }
    renderSongs();
  }

  function openLibPick(trackId) {
    const t = state.tracks.find((x) => x.id === trackId);
    if (!t) return;
    $('#lpTrack').textContent = t.title;
    $('#modalLibPick').dataset.track = trackId;
    renderLibPick();
    openModal('modalLibPick');
  }

  function renderLibPick() {
    const tid = $('#modalLibPick').dataset.track;
    $('#lpList').innerHTML = state.libraries.length ? state.libraries.map((l) => `
      <li><label class="lp-item"><input type="checkbox" data-lp="${esc(l.id)}"${l.trackIds.includes(tid) ? ' checked' : ''}>
        <span class="lp-name">${esc(l.name)}</span><span class="lp-count">${l.trackIds.length}曲</span></label></li>`).join('')
      : '<li class="empty">ライブラリはまだありません</li>';
  }

  function bindLibrarySets() {
    $('#btnLibSort').addEventListener('click', () => {
      if (!state.libId) return;
      state.reorder = !state.reorder;
      if (state.reorder && state.songFilter !== 'all') {
        state.songFilter = 'all';
        $$('#songFilter .chip').forEach((x) => x.classList.toggle('is-active', x.dataset.filter === 'all'));
      }
      renderLibSelect();
      renderSongs();
    });
    $('#songList').addEventListener('click', (e) => {
      const mv = e.target.closest('[data-mv]');
      if (mv && !mv.disabled) { moveTrack(mv.dataset.id, mv.dataset.mv); return; }
      const to = e.target.closest('[data-mvto]');
      if (to) {
        const n = librarySongs().length;
        const v = Number(String(prompt(`何番目に移動しますか？（1〜${n}）`) || '').normalize('NFKC').trim());
        if (Number.isInteger(v) && v >= 1) moveTrack(to.dataset.mvto, Math.min(v, n));
      }
    });
    $('#libSelect').addEventListener('change', (e) => {
      state.libId = e.target.value;
      savePrefs();
      renderLibSelect();
      renderSongs();
    });
    $('#btnLibNew').addEventListener('click', async () => {
      const lib = await createLibrary();
      if (lib) { state.libId = lib.id; savePrefs(); renderLibSelect(); renderSongs(); }
    });
    $('#btnLibRename').addEventListener('click', async () => {
      const lib = libById(state.libId);
      if (!lib) return;
      const name = (prompt('ライブラリの名前', lib.name) || '').trim();
      if (!name || name === lib.name) return;
      try { await saveLibrary(Object.assign({}, lib, { name })); toast('名前を変えました'); } catch (e) { toast(e.message, true); }
    });
    $('#btnLibDelete').addEventListener('click', async () => {
      const lib = libById(state.libId);
      if (!lib || !confirm(`ライブラリ「${lib.name}」を削除しますか？（曲そのものは消えません）`)) return;
      try {
        const d = await api('library_delete', { id: lib.id });
        state.libraries = state.libraries.filter((l) => l.id !== lib.id);
        state.libId = '';
        savePrefs();
        renderLibSelect();
        renderSongs();
        toast(d.message);
      } catch (e) { toast(e.message, true); }
    });
    $('#lpList').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-lp]');
      const lib = cb && libById(cb.dataset.lp);
      if (!lib) return;
      toggleTrackInLib(lib, $('#modalLibPick').dataset.track, cb.checked).then(renderLibPick);
    });
    $('#btnLpNew').addEventListener('click', async () => {
      const lib = await createLibrary($('#modalLibPick').dataset.track);
      if (lib) { renderLibPick(); renderSongs(); }
    });
  }

  function renderSongs() {
    let songs = librarySongs();
    const noMap = new Map(songs.map((t, i) => [t.id, i + 1]));
    const f = state.songFilter;
    if (f === 'ai') songs = songs.filter((t) => t.aiGenerated);
    if (f === 'youtube') songs = songs.filter((t) => t.source === 'youtube');
    if (f === 'mine') songs = songs.filter((t) => state.user && t.ownerId === state.user.userId);
    lists.songs = songs;
    $('#songList').innerHTML = songs.length
      ? songs.map((t, i) => trackItemHtml(t, 'songs', i, noMap.get(t.id))).join('')
      : (state.libId
        ? '<li class="empty">このライブラリにはまだ曲がありません。「すべての曲」から 📁 で入れられます</li>'
        : '<li class="empty">まだ曲がありません。「＋ 曲を追加」から登録できます</li>');
    markCurrentInLists();
    if ($('#libSelect')) renderLibSelect();
    renderProgram();
  }

  /* =========================================================
   *  ポッドキャスト：エピソードの並び順（全員共通）と聞く順（自分用）
   * ========================================================= */
  const LISTEN_MODES = [
    { v: 'order', label: '並び順どおり（上から）' },
    { v: 'reverse', label: '逆順（下から）' },
    { v: 'shuffle', label: 'シャッフル' },
    { v: 'custom', label: '自分で決めた順' }
  ];
  const showKeyOf = (t) => String(t.showName || '');
  const showLabel = (k) => k || '番組名なし';

  /** 番組のエピソードを「並び順」で返す（並び順に無いものは登録の古い順で後ろに） */
  function showEpisodes(key) {
    const eps = state.tracks.filter((t) => t.kind === 'podcast' && showKeyOf(t) === key)
      .sort((a, b) => a.createdAt - b.createdAt);
    const pos = new Map((state.showOrders[key] || []).map((id, i) => [id, i]));
    const p = (t) => (pos.has(t.id) ? pos.get(t.id) : 1e9);
    return eps.sort((a, b) => (p(a) - p(b)) || (a.createdAt - b.createdAt));
  }

  function canSortShow(key) {
    if (!state.user) return false;
    if (state.user.role === 'admin') return true;
    return state.tracks.some((t) => t.kind === 'podcast' && showKeyOf(t) === key && t.ownerId === state.user.userId);
  }

  function listenPref(key) {
    const p = state.listenOrders[key];
    return p && LISTEN_MODES.some((m) => m.v === p.mode) ? p : { mode: 'order', trackIds: [] };
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /** 聞く順に並べたエピソード */
  function listenQueue(key) {
    const eps = showEpisodes(key);
    const pref = listenPref(key);
    if (pref.mode === 'reverse') return eps.slice().reverse();
    if (pref.mode === 'shuffle') return shuffled(eps);
    if (pref.mode === 'custom') {
      const map = new Map(eps.map((t) => [t.id, t]));
      const q = pref.trackIds.map((id) => map.get(id)).filter(Boolean);
      return q.length ? q : eps;
    }
    return eps;
  }

  /** 番組を聞く順で再生。startId を指定するとその話から */
  function playShow(key, startId) {
    let q = listenQueue(key);
    if (!q.length) { toast('この番組にはまだエピソードがありません'); return; }
    let start = 0;
    if (startId) {
      start = q.findIndex((t) => t.id === startId);
      if (start < 0) {
        const t = state.tracks.find((x) => x.id === startId);
        if (!t) return;
        toast('この話は「聞く順」に入っていないので、この話だけ再生します');
        playList([t], 0, { podcast: true });
        return;
      }
      if (listenPref(key).mode === 'shuffle') { q = [q[start]].concat(q.filter((_, i) => i !== start)); start = 0; }
    } else {
      toast(`「${showLabel(key)}」を聞く順に再生します（全${q.length}話）`);
    }
    playList(q, start, { podcast: true });
  }

  function listenSummary(key) {
    const eps = showEpisodes(key);
    const no = new Map(eps.map((t, i) => [t.id, i + 1]));
    const pref = listenPref(key);
    if (pref.mode === 'shuffle') return '毎回ちがう順番で再生します';
    const q = listenQueue(key);
    const parts = q.map((t) => 'EP' + no.get(t.id));
    const skipped = eps.length - q.length;
    return parts.join(' → ') + (skipped > 0 ? `（${skipped}話はスキップ）` : '');
  }

  function renderPodcasts() {
    const keys = [];
    state.tracks.forEach((t) => { if (t.kind === 'podcast' && !keys.includes(showKeyOf(t))) keys.push(showKeyOf(t)); });
    if (state.podSort != null && !keys.includes(state.podSort)) state.podSort = null;
    lists.showKeys = keys;
    lists.shows = {};
    $('#podcastShows').innerHTML = keys.length
      ? keys.map((key, si) => {
        const eps = showEpisodes(key);
        lists.shows[key] = eps;
        const sorting = state.podSort === key;
        const pref = listenPref(key);
        const sortable = canSortShow(key);
        return `
        <article class="show${sorting ? ' is-sorting' : ''}" data-show="${si}">
          <div class="show-head">
            <div class="show-art" style="background:hsl(${hue(showLabel(key))} 85% 62%)">${esc(initial(showLabel(key)))}</div>
            <div class="show-info"><h3 class="show-name">${esc(showLabel(key))}</h3><span class="show-count">${eps.length} エピソード</span></div>
          </div>
          <div class="show-tools">
            <button class="btn btn-primary btn-small" data-pod-play="${si}">▶ 聞く順に再生</button>
            <label class="pod-mode"><span>聞く順</span>
              <select data-pod-mode="${si}" aria-label="聞く順">
                ${LISTEN_MODES.map((m) => `<option value="${m.v}"${m.v === pref.mode ? ' selected' : ''}>${m.label}</option>`).join('')}
              </select></label>
            ${pref.mode === 'custom' ? `<button class="btn btn-ghost btn-small" data-pod-edit="${si}">✎ 聞く順を決める</button>` : ''}
            ${sortable ? `<button class="btn btn-ghost btn-small${sorting ? ' is-active' : ''}" data-pod-sort="${si}">${sorting ? '✓ 並べ替え完了' : '↕ 並べ替え'}</button>` : ''}
          </div>
          <p class="pod-listen"><span class="pod-listen-label">聞く順</span>${esc(listenSummary(key))}</p>
          ${sorting ? `<div class="pod-sort-hint">
            <p>⤒ 一番上 ／ ↑ 1つ上 ／ ↓ 1つ下 ／ ⤓ 一番下。「EP番号」を押すと番号を指定して移動できます。並び順は自動で保存され、みんなの画面にも反映されます。</p>
            <button class="btn btn-ghost btn-small" data-pod-autosort="${si}">🔤 タイトル順にそろえる</button>
          </div>` : ''}
          <ul class="track-list">${eps.map((t, i) => trackItemHtml(t, 'show:' + si, i, i + 1, { sorting, total: eps.length, prefix: 'EP' })).join('')}</ul>
        </article>`;
      }).join('')
      : '<p class="empty">ポッドキャストはまだありません。「＋ エピソードを登録」から追加できます</p>';
    renderPodlistPanel();
    markCurrentInLists();
  }

  const showKeyByIndex = (si) => lists.showKeys[Number(si)];

  /* ---------- 並べ替え（全員共通の並び順） ---------- */
  const showSaveTimers = new Map();
  function scheduleShowSave(key) {
    clearTimeout(showSaveTimers.get(key));
    showSaveTimers.set(key, setTimeout(async () => {
      showSaveTimers.delete(key);
      try {
        const d = await api('show_order_save', { showName: key, trackIds: state.showOrders[key] || [] });
        state.showOrders[key] = d.trackIds || state.showOrders[key];
      } catch (e) { toast('並び順を保存できませんでした：' + e.message, true); loadTracks(); }
    }, 700));
  }

  /** how: top / up / down / bottom / 数値（移動先のEP番号） */
  function moveEpisode(key, id, how) {
    const ids = showEpisodes(key).map((t) => t.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    let to = from;
    if (how === 'top') to = 0;
    else if (how === 'up') to = from - 1;
    else if (how === 'down') to = from + 1;
    else if (how === 'bottom') to = ids.length - 1;
    else if (typeof how === 'number') to = how - 1;
    to = Math.max(0, Math.min(ids.length - 1, to));
    if (to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    state.showOrders[key] = ids;
    renderPodcasts();
    const li = $(`#podcastShows [data-track-id="${CSS.escape(id)}"]`);
    if (li) {
      li.classList.remove('is-moved');
      void li.offsetWidth;
      li.classList.add('is-moved');
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    scheduleShowSave(key);
  }

  function autoSortShow(key) {
    const eps = showEpisodes(key).slice()
      .sort((a, b) => a.title.normalize('NFKC').localeCompare(b.title.normalize('NFKC'), 'ja', { numeric: true }));
    state.showOrders[key] = eps.map((t) => t.id);
    renderPodcasts();
    scheduleShowSave(key);
    toast('タイトル順にそろえました');
  }

  /* ---------- 聞く順（自分用） ---------- */
  async function saveListen(key, mode, trackIds) {
    const before = state.listenOrders[key];
    state.listenOrders[key] = { mode, trackIds };
    renderPodcasts();
    try {
      const d = await api('listen_order_save', { showName: key, mode, trackIds });
      state.listenOrders[key] = { mode: d.mode, trackIds: d.trackIds || [] };
      renderPodcasts();
      return true;
    } catch (e) {
      if (before) state.listenOrders[key] = before; else delete state.listenOrders[key];
      renderPodcasts();
      toast('聞く順を保存できませんでした：' + e.message, true);
      return false;
    }
  }

  const loDraft = { key: '', items: [] };   // items: [{ id, on }]

  function openListenEditor(key) {
    const eps = showEpisodes(key);
    const pref = listenPref(key);
    const map = new Map(eps.map((t) => [t.id, t]));
    const picked = pref.trackIds.filter((id) => map.has(id));
    loDraft.key = key;
    loDraft.items = picked.length
      ? picked.map((id) => ({ id, on: true })).concat(eps.filter((t) => !picked.includes(t.id)).map((t) => ({ id: t.id, on: false })))
      : eps.map((t) => ({ id: t.id, on: true }));
    $('#loShow').textContent = showLabel(key);
    renderListenEditor();
    openModal('modalListen');
  }

  function renderListenEditor() {
    const eps = showEpisodes(loDraft.key);
    const map = new Map(eps.map((t, i) => [t.id, { t, no: i + 1 }]));
    loDraft.items = loDraft.items.filter((it) => map.has(it.id));
    let n = 0;
    const last = loDraft.items.length - 1;
    $('#loList').innerHTML = loDraft.items.map((it, i) => {
      const { t, no } = map.get(it.id);
      return `
        <li class="lo-item${it.on ? '' : ' is-off'}">
          <label class="lo-check"><input type="checkbox" data-lo-on="${i}"${it.on ? ' checked' : ''}>
            <span class="lo-no">${it.on ? ++n : '−'}</span></label>
          <span class="lo-title"><span class="track-no">EP${no}</span>${esc(t.title)}</span>
          <span class="lo-move">
            <button type="button" class="icon-btn" data-lo-mv="up" data-i="${i}" aria-label="1つ上へ"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-lo-mv="down" data-i="${i}" aria-label="1つ下へ"${i === last ? ' disabled' : ''}>↓</button>
          </span>
        </li>`;
    }).join('');
    $('#loCount').textContent = `${n} / ${loDraft.items.length} 話を聞く`;
  }

  function bindPodcast() {
    const root = $('#podcastShows');
    root.addEventListener('click', (e) => {
      const showEl = e.target.closest('[data-show]');
      const key = showEl && showKeyByIndex(showEl.dataset.show);
      if (key == null) return;
      if (e.target.closest('[data-pod-play]')) { playShow(key); return; }
      if (e.target.closest('[data-pod-edit]')) { openListenEditor(key); return; }
      if (e.target.closest('[data-pod-sort]')) {
        state.podSort = state.podSort === key ? null : key;
        renderPodcasts();
        return;
      }
      if (e.target.closest('[data-pod-autosort]')) { autoSortShow(key); return; }
      const mv = e.target.closest('[data-mv]');
      if (mv && !mv.disabled) { moveEpisode(key, mv.dataset.id, mv.dataset.mv); return; }
      const to = e.target.closest('[data-mvto]');
      if (to) {
        const n = showEpisodes(key).length;
        const v = Number(String(prompt(`何番目に移動しますか？（1〜${n}）`) || '').normalize('NFKC').trim());
        if (Number.isInteger(v) && v >= 1) moveEpisode(key, to.dataset.mvto, Math.min(v, n));
      }
    });
    root.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-pod-mode]');
      if (!sel) return;
      const key = showKeyByIndex(sel.dataset.podMode);
      if (key == null) return;
      const mode = sel.value;
      if (mode === 'custom') {
        const pref = listenPref(key);
        if (pref.trackIds.length) saveListen(key, 'custom', pref.trackIds);
        else openListenEditor(key);   // 初めては順番を決めてから保存
        if (!pref.trackIds.length) sel.value = pref.mode;
        return;
      }
      saveListen(key, mode, listenPref(key).trackIds);
    });

    $('#loList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lo-mv]');
      if (!b || b.disabled) return;
      const i = Number(b.dataset.i);
      const j = b.dataset.loMv === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= loDraft.items.length) return;
      [loDraft.items[i], loDraft.items[j]] = [loDraft.items[j], loDraft.items[i]];
      renderListenEditor();
    });
    $('#loList').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-lo-on]');
      if (!cb) return;
      loDraft.items[Number(cb.dataset.loOn)].on = cb.checked;
      renderListenEditor();
    });
    $('#loTools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lo]');
      if (!b) return;
      const eps = showEpisodes(loDraft.key);
      const on = new Map(loDraft.items.map((it) => [it.id, it.on]));
      const keep = (t) => ({ id: t.id, on: on.has(t.id) ? on.get(t.id) : true });
      if (b.dataset.lo === 'order') loDraft.items = eps.map(keep);
      if (b.dataset.lo === 'reverse') loDraft.items = eps.slice().reverse().map(keep);
      if (b.dataset.lo === 'all') loDraft.items.forEach((it) => (it.on = true));
      if (b.dataset.lo === 'none') loDraft.items.forEach((it) => (it.on = false));
      renderListenEditor();
    });
    $('#btnLoSave').addEventListener('click', async (e) => {
      const ids = loDraft.items.filter((it) => it.on).map((it) => it.id);
      if (!ids.length) { toast('聞くエピソードを1つ以上チェックしてください', true); return; }
      await withBusy(e.currentTarget, '保存中…', async () => {
        if (await saveListen(loDraft.key, 'custom', ids)) {
          closeModal('modalListen');
          toast('聞く順を保存しました');
        }
      });
    });
  }

  /* =========================================================
   *  ポッドキャスト再生リスト（番組をまたいで選択・順番指定。1人20セット×100話）
   * ========================================================= */
  const PL_PREVIEW = 8;
  const plById = (id) => state.podlists.find((l) => l.id === id);
  const curPl = () => plById(state.plId);
  const plHas = (id) => { const pl = curPl(); return !!pl && pl.trackIds.includes(id); };
  const podById = (id) => state.tracks.find((t) => t.id === id && t.kind === 'podcast');
  const plTracks = (pl) => (pl ? pl.trackIds.map(podById).filter(Boolean) : []);

  async function loadPodlists() {
    try {
      const d = await api('podlists_list');
      state.podlists = d.podlists || [];
      state.plMax = d.max || 20;
      state.plMaxItems = d.maxItems || 100;
    } catch (e) { /* 旧GASでは未対応 */ state.podlists = []; }
    if (state.plId && !curPl()) state.plId = '';
    if (!state.plId && state.podlists.length) state.plId = state.podlists[0].id;
    renderPodcasts();
  }

  function renderPodlistPanel() {
    const panel = $('#podlistPanel');
    if (!panel) return;
    const pl = curPl();
    const sel = $('#plSelect');
    sel.innerHTML = state.podlists.length
      ? state.podlists.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}（${plTracks(l).length}）</option>`).join('')
      : '<option value="">（再生リストはまだありません）</option>';
    sel.value = state.plId;
    $('#plSets').textContent = `${state.podlists.length} / ${state.plMax}`;
    $('#btnPlRename').disabled = !pl;
    $('#btnPlDelete').disabled = !pl;
    const items = plTracks(pl);
    $('#plCount').textContent = pl ? `${items.length} / ${state.plMaxItems} 話` : '';
    $('#btnPlPlay').disabled = !items.length;
    $('#btnPlEdit').textContent = pl ? '✎ 選んで並べる' : '＋ 作って選ぶ';
    const shown = state.plExpand ? items : items.slice(0, PL_PREVIEW);
    $('#plItems').innerHTML = !pl
      ? '<li class="empty">「＋」で再生リストを作ると、番組をまたいで好きな話を好きな順番で流せます（100話まで）</li>'
      : items.length
        ? shown.map((t, i) => `
          <li class="pl-item" data-track-id="${esc(t.id)}">
            <button class="pl-row" data-plplay="${i}" aria-label="「${esc(t.title)}」から再生">
              <span class="pl-no">${i + 1}</span>
              <span class="pl-title">${esc(t.title)}</span>
              <span class="pl-show">${esc(showLabel(showKeyOf(t)))}</span>
            </button>
          </li>`).join('')
        : '<li class="empty">まだ空っぽです。「✎ 選んで並べる」か、各エピソードの 📃 で入れてください</li>';
    const more = $('#btnPlMore');
    more.hidden = items.length <= PL_PREVIEW;
    more.textContent = state.plExpand ? '▲ たたむ' : `▼ すべて表示（${items.length}話）`;
    markCurrentInLists();
  }

  async function savePodlist(pl) {
    const d = await api('podlist_save', { podlist: { id: pl.id, name: pl.name, trackIds: pl.trackIds } });
    const i = state.podlists.findIndex((l) => l.id === d.podlist.id);
    if (i >= 0) state.podlists[i] = d.podlist; else state.podlists.push(d.podlist);
    return d.podlist;
  }

  async function createPodlist() {
    if (state.podlists.length >= state.plMax) { toast(`再生リストは ${state.plMax} セットまでです`, true); return null; }
    const name = (prompt('新しい再生リストの名前', `再生リスト ${state.podlists.length + 1}`) || '').trim();
    if (!name) return null;
    try {
      const pl = await savePodlist({ name, trackIds: [] });
      state.plId = pl.id;
      state.plExpand = false;
      savePrefs();
      renderPodcasts();
      toast(`再生リスト「${pl.name}」を作りました`);
      return pl;
    } catch (e) { toast(e.message, true); return null; }
  }

  function playPodlist(start = 0) {
    const items = plTracks(curPl());
    if (!items.length) { toast('再生リストが空です'); return; }
    if (start === 0) toast(`再生リスト「${curPl().name}」を再生します（全${items.length}話）`);
    playList(items, start, { podcast: true });
  }

  async function togglePlItem(id) {
    const pl = curPl();
    if (!pl) return;
    const before = pl.trackIds;
    const has = before.includes(id);
    if (!has && plTracks(pl).length >= state.plMaxItems) { toast(`1つの再生リストは ${state.plMaxItems} 話までです`, true); return; }
    pl.trackIds = has ? before.filter((x) => x !== id) : before.concat(id);
    renderPodcasts();
    try {
      await savePodlist(pl);
      toast(has ? '再生リストから外しました' : `再生リスト「${pl.name}」の${plTracks(pl).length}番目に入れました`);
    } catch (e) { pl.trackIds = before; renderPodcasts(); toast(e.message, true); }
    renderPodcasts();
  }

  /* ---------- 編集画面 ---------- */
  const ple = { ids: [], q: '' };

  function openPodlistEditor() {
    const pl = curPl();
    if (!pl) return;
    ple.ids = plTracks(pl).map((t) => t.id);
    ple.q = '';
    $('#pleSearch').value = '';
    $('#pleName').textContent = pl.name;
    renderPle();
    openModal('modalPodList');
  }

  function renderPle() {
    const full = ple.ids.length >= state.plMaxItems;
    const pos = new Map(ple.ids.map((id, i) => [id, i + 1]));
    const q = ple.q.normalize('NFKC').toLowerCase();
    const keys = [];
    state.tracks.forEach((t) => { if (t.kind === 'podcast' && !keys.includes(showKeyOf(t))) keys.push(showKeyOf(t)); });
    const groups = keys.map((key) => {
      const eps = showEpisodes(key).filter((t) => !q ||
        (t.title + ' ' + showLabel(key)).normalize('NFKC').toLowerCase().includes(q));
      return { key, eps };
    }).filter((g) => g.eps.length);
    $('#pleSrc').innerHTML = groups.length ? groups.map((g) => {
      const allIn = g.eps.every((t) => pos.has(t.id));
      return `
        <div class="ple-group">
          <div class="ple-group-head">
            <span class="ple-group-name">${esc(showLabel(g.key))}</span>
            <button type="button" class="chip" data-ple-all="${esc(g.key)}" data-on="${allIn ? '0' : '1'}">${allIn ? '全部はずす' : '全部入れる'}</button>
          </div>
          ${g.eps.map((t, i) => {
            const n = pos.get(t.id);
            return `<label class="ple-src-item${n ? ' is-on' : ''}">
              <input type="checkbox" data-ple-pick="${esc(t.id)}"${n ? ' checked' : ''}${!n && full ? ' disabled' : ''}>
              <span class="track-no">EP${i + 1}</span><span class="ple-src-title">${esc(t.title)}</span>
              ${n ? `<span class="ple-badge">${n}</span>` : ''}
            </label>`;
          }).join('')}
        </div>`;
    }).join('') : '<p class="empty">該当するエピソードがありません</p>';

    const last = ple.ids.length;
    $('#pleOrder').innerHTML = ple.ids.length ? ple.ids.map((id, i) => {
      const t = podById(id);
      const no = i + 1;
      return `
        <li class="ple-row">
          <button type="button" class="track-no track-no-btn ple-no" data-ple-to="${i}" title="番号を指定して移動">${no}</button>
          <span class="ple-row-main"><span class="ple-row-title">${esc(t.title)}</span><span class="ple-row-show">${esc(showLabel(showKeyOf(t)))}</span></span>
          <span class="ple-move">
            <button type="button" class="icon-btn" data-ple-mv="top" data-i="${i}" aria-label="一番上へ"${no === 1 ? ' disabled' : ''}>⤒</button>
            <button type="button" class="icon-btn" data-ple-mv="up" data-i="${i}" aria-label="1つ上へ"${no === 1 ? ' disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-ple-mv="down" data-i="${i}" aria-label="1つ下へ"${no === last ? ' disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-ple-mv="bottom" data-i="${i}" aria-label="一番下へ"${no === last ? ' disabled' : ''}>⤓</button>
            <button type="button" class="icon-btn ple-x" data-ple-x="${i}" aria-label="リストから外す">✕</button>
          </span>
        </li>`;
    }).join('') : '<li class="empty">左でチェックを入れた順に、ここに並びます</li>';
    $('#pleSel').textContent = full ? `（上限 ${state.plMaxItems} 話に達しました）` : '';
    $('#pleCount').textContent = `${ple.ids.length} / ${state.plMaxItems} 話`;
  }

  function pleMove(from, to) {
    to = Math.max(0, Math.min(ple.ids.length - 1, to));
    if (to === from) return;
    const [id] = ple.ids.splice(from, 1);
    ple.ids.splice(to, 0, id);
    renderPle();
    const row = $$('#pleOrder .ple-row')[to];
    if (row) { row.classList.add('is-moved'); row.scrollIntoView({ block: 'nearest' }); }
  }

  function bindPodlist() {
    $('#plSelect').addEventListener('change', (e) => {
      state.plId = e.target.value;
      state.plExpand = false;
      savePrefs();
      renderPodcasts();
    });
    $('#btnPlNew').addEventListener('click', createPodlist);
    $('#btnPlRename').addEventListener('click', async () => {
      const pl = curPl();
      if (!pl) return;
      const name = (prompt('再生リストの名前', pl.name) || '').trim();
      if (!name || name === pl.name) return;
      try { await savePodlist(Object.assign({}, pl, { name })); renderPodcasts(); toast('名前を変えました'); } catch (e) { toast(e.message, true); }
    });
    $('#btnPlDelete').addEventListener('click', async () => {
      const pl = curPl();
      if (!pl || !confirm(`再生リスト「${pl.name}」を削除しますか？（エピソードそのものは消えません）`)) return;
      try {
        const d = await api('podlist_delete', { id: pl.id });
        state.podlists = state.podlists.filter((l) => l.id !== pl.id);
        state.plId = state.podlists[0] ? state.podlists[0].id : '';
        savePrefs();
        renderPodcasts();
        toast(d.message);
      } catch (e) { toast(e.message, true); }
    });
    $('#btnPlPlay').addEventListener('click', () => playPodlist(0));
    $('#btnPlEdit').addEventListener('click', async () => {
      if (!curPl() && !(await createPodlist())) return;
      openPodlistEditor();
    });
    $('#btnPlMore').addEventListener('click', () => { state.plExpand = !state.plExpand; renderPodlistPanel(); });
    $('#plItems').addEventListener('click', (e) => {
      const b = e.target.closest('[data-plplay]');
      if (b) playPodlist(Number(b.dataset.plplay));
    });
    $('#podcastShows').addEventListener('click', (e) => {
      const b = e.target.closest('[data-plpick]');
      if (b) togglePlItem(b.dataset.plpick);
    });

    // 編集画面
    $('#pleSearch').addEventListener('input', (e) => { ple.q = e.target.value; renderPle(); });
    $('#pleSrc').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-ple-pick]');
      if (!cb) return;
      const id = cb.dataset.plePick;
      if (cb.checked) {
        if (ple.ids.length >= state.plMaxItems) { cb.checked = false; toast(`${state.plMaxItems} 話までです`, true); return; }
        if (!ple.ids.includes(id)) ple.ids.push(id);
      } else {
        ple.ids = ple.ids.filter((x) => x !== id);
      }
      renderPle();
    });
    $('#pleSrc').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ple-all]');
      if (!b) return;
      const eps = showEpisodes(b.dataset.pleAll);
      if (b.dataset.on === '1') {
        let added = 0;
        for (const t of eps) {
          if (ple.ids.includes(t.id)) continue;
          if (ple.ids.length >= state.plMaxItems) { toast(`${state.plMaxItems} 話までなので、途中までにしました`, true); break; }
          ple.ids.push(t.id);
          added++;
        }
        if (added) toast(`${added}話を入れました`);
      } else {
        const set = new Set(eps.map((t) => t.id));
        ple.ids = ple.ids.filter((id) => !set.has(id));
      }
      renderPle();
    });
    $('#pleOrder').addEventListener('click', (e) => {
      const mv = e.target.closest('[data-ple-mv]');
      if (mv && !mv.disabled) {
        const i = Number(mv.dataset.i);
        const to = { top: 0, up: i - 1, down: i + 1, bottom: ple.ids.length - 1 }[mv.dataset.pleMv];
        pleMove(i, to);
        return;
      }
      const x = e.target.closest('[data-ple-x]');
      if (x) { ple.ids.splice(Number(x.dataset.pleX), 1); renderPle(); return; }
      const to = e.target.closest('[data-ple-to]');
      if (to) {
        const n = ple.ids.length;
        const v = Number(String(prompt(`何番目に移動しますか？（1〜${n}）`) || '').normalize('NFKC').trim());
        if (Number.isInteger(v) && v >= 1) pleMove(Number(to.dataset.pleTo), Math.min(v, n) - 1);
      }
    });
    $('#pleTools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ple]');
      if (!b || !ple.ids.length) return;
      const k = b.dataset.ple;
      if (k === 'clear') { if (confirm('選んだエピソードを全部はずしますか？')) ple.ids = []; }
      else if (k === 'reverse') ple.ids.reverse();
      else if (k === 'shuffle') ple.ids = shuffled(ple.ids);
      else if (k === 'title') {
        ple.ids.sort((a, b2) => podById(a).title.normalize('NFKC').localeCompare(podById(b2).title.normalize('NFKC'), 'ja', { numeric: true }));
      } else if (k === 'show') {
        const rank = new Map();
        let r = 0;
        const keys = [];
        ple.ids.forEach((id) => { const key = showKeyOf(podById(id)); if (!keys.includes(key)) keys.push(key); });
        keys.forEach((key) => showEpisodes(key).forEach((t) => rank.set(t.id, r++)));
        ple.ids.sort((a, b2) => rank.get(a) - rank.get(b2));
      }
      renderPle();
    });
    $('#btnPleSave').addEventListener('click', async (e) => {
      const pl = curPl();
      if (!pl) return;
      await withBusy(e.currentTarget, '保存中…', async () => {
        try {
          await savePodlist(Object.assign({}, pl, { trackIds: ple.ids.slice() }));
          closeModal('modalPodList');
          renderPodcasts();
          toast(`再生リスト「${pl.name}」を保存しました（${ple.ids.length}話）`);
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  function listByName(name) {
    if (name === 'songs') return lists.songs;
    return lists.shows[showKeyByIndex(name.split(':')[1])] || [];
  }

  function markCurrentInLists() {
    const cur = state.queue[state.idx];
    $$('.track, .pl-item').forEach((li) => li.classList.toggle('is-current', !!cur && li.dataset.trackId === cur.id));
  }

  function addNext(id) {
    const t = state.tracks.find((x) => x.id === id);
    if (!t) return;
    if (state.idx < 0) { playList([t], 0); return; }
    state.queue.splice(state.idx + 1, 0, t);
    state.plannedNext = state.idx + 1;
    state.segPrefetch = null;
    renderQueue();
    maybePrefetchSegment();
    toast(`「${t.title}」を次に再生します`);
  }

  async function deleteTrack(id) {
    const t = state.tracks.find((x) => x.id === id);
    if (!t || !confirm(`「${t.title}」を削除しますか？`)) return;
    try {
      const d = await api('track_delete', { id });
      toast(d.message);
      await loadTracks();
    } catch (e) { toast(e.message, true); }
  }

  function bindLibrary() {
    document.addEventListener('click', (e) => {
      const play = e.target.closest('[data-play]');
      if (play) {
        const ln = play.dataset.play;
        if (ln.startsWith('show:')) {
          const li = play.closest('[data-track-id]');
          const key = showKeyByIndex(ln.split(':')[1]);
          if (key != null && li) { playShow(key, li.dataset.trackId); return; }
        }
        playList(listByName(ln), Number(play.dataset.i));
        return;
      }
      const nx = e.target.closest('[data-next]');
      if (nx) { unlockMedia(); addNext(nx.dataset.next); return; }
      const del = e.target.closest('[data-del]');
      if (del) { deleteTrack(del.dataset.del); return; }
      const ex = e.target.closest('[data-export]');
      if (ex) { exportTrack(ex.dataset.export); return; }
      const lp = e.target.closest('[data-libpick]');
      if (lp) { openLibPick(lp.dataset.libpick); return; }
      const lo = e.target.closest('[data-libout]');
      if (lo) { const lib = libById(state.libId); if (lib) toggleTrackInLib(lib, lo.dataset.libout, false); return; }
      const add = e.target.closest('[data-add-kind]');
      if (add) openAddTrack(add.dataset.addKind);
    });
    $('#songFilter').addEventListener('click', (e) => {
      const c = e.target.closest('[data-filter]');
      if (!c) return;
      state.songFilter = c.dataset.filter;
      $$('#songFilter .chip').forEach((x) => x.classList.toggle('is-active', x === c));
      renderSongs();
    });

    // 追加モーダル
    $('#maxMb').textContent = CONFIG.MAX_UPLOAD_MB;
    $('#atKind').addEventListener('click', (e) => {
      const b = e.target.closest('[data-kind]');
      if (b) setAddKind(b.dataset.kind);
    });
    $('#atSource').addEventListener('change', updateAddSource);
    $('#addTrackForm').addEventListener('submit', submitAddTrack);
    $('#modalAddTrack').addEventListener('click', (e) => {
      if (!bulkRunning) return;
      if (e.target === e.currentTarget || e.target.closest('[data-close]')) {
        bulkCancel = true;
        toast('残りの登録を中止します（登録済みの分は残ります）');
      }
    }, true);
    bindLibrarySets();
  }

  let addKind = 'song';
  function setAddKind(kind) {
    addKind = kind;
    $$('#atKind .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.kind === kind));
    $$('[data-kind-only]').forEach((el) => (el.hidden = el.dataset.kindOnly !== kind));
    $('#atTitle').textContent = kind === 'song' ? '曲を追加' : 'エピソードを登録';
  }
  function updateAddSource() {
    const src = $('#atSource').value;
    $('[data-src="upload"]').hidden = src !== 'upload';
    $('[data-src="link"]').hidden = src === 'upload';
    $('#atUrlLabel').textContent = {
      youtube: 'YouTube の URL',
      drivelink: 'Google Drive の共有リンク',
      url: '音声ファイルの URL（https://〜.mp3 など）'
    }[src] || 'URL';
  }
  function openAddTrack(kind) {
    $('#addTrackForm').reset();
    setAddKind(kind || 'song');
    updateAddSource();
    $('#atProgress').hidden = true;
    const pl = curPl();
    $('#atToPlWrap').hidden = (kind || 'song') !== 'podcast' || !pl;
    if (pl) $('#atToPlLabel').textContent = `再生リスト「${pl.name}」にも入れる`;
    openModal('modalAddTrack');
  }

  const MAX_BULK = 100;
  let bulkCancel = false;
  let bulkRunning = false;

  /** URL からタイトルの候補を作る */
  function titleFromUrl(url, src, i) {
    if (src === 'youtube') return `YouTube ${i + 1}`;
    if (src === 'drivelink') return `Drive ${i + 1}`;
    try {
      const seg = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      return seg.replace(/\.[^.]+$/, '') || `エピソード ${i + 1}`;
    } catch (e) { return `エピソード ${i + 1}`; }
  }

  async function submitAddTrack(e) {
    e.preventDefault();
    const f = e.target;
    const src = f.source.value;
    const base = f.title.value.trim();
    const common = {
      kind: addKind,
      artist: f.artist.value.trim(),
      showName: f.showName.value.trim(),
      description: f.description.value.trim(),
      aiGenerated: addKind === 'song' && f.aiGenerated.checked
    };

    // 登録する項目を集める
    let jobs = [];
    const skipped = [];
    if (src === 'upload') {
      const files = [...f.file.files].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
      if (!files.length) { toast('音声ファイルを選んでください', true); return; }
      if (files.length > MAX_BULK) { toast(`一度に登録できるのは ${MAX_BULK} 件までです（${files.length} 件選ばれています）`, true); return; }
      files.forEach((file) => {
        if (!file.type.startsWith('audio/')) { skipped.push(`${file.name}（音声ではありません）`); return; }
        if (file.size > CONFIG.MAX_UPLOAD_MB * 1024 * 1024) { skipped.push(`${file.name}（${CONFIG.MAX_UPLOAD_MB}MB超）`); return; }
        jobs.push({ file, auto: file.name.replace(/\.[^.]+$/, '') });
      });
    } else {
      const urls = f.url.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (!urls.length) { toast('URL を入力してください', true); return; }
      if (urls.length > MAX_BULK) { toast(`一度に登録できるのは ${MAX_BULK} 件までです（${urls.length} 件あります）`, true); return; }
      jobs = urls.map((url, i) => ({ url, auto: titleFromUrl(url, src, i) }));
    }
    if (!jobs.length) { toast('登録できるファイルがありません：' + skipped.join('、'), true); return; }
    const multi = jobs.length > 1;
    jobs.forEach((j, i) => { j.title = (multi ? (base ? `${base} ${i + 1}` : j.auto) : (base || j.auto)).slice(0, 80); });
    if (multi && !confirm(`${jobs.length} 件をまとめて登録します。よろしいですか？${skipped.length ? `\n（登録できない ${skipped.length} 件はとばします）` : ''}`)) return;

    const btn = $('#atSubmit');
    const prog = $('#atProgress');
    const added = [];
    const failed = [];
    bulkCancel = false;
    bulkRunning = true;
    btn.disabled = true;
    const oldLabel = btn.textContent;
    try {
      for (let i = 0; i < jobs.length; i++) {
        if (bulkCancel) break;
        const j = jobs[i];
        btn.textContent = multi ? `登録中 ${i + 1}/${jobs.length}…` : (src === 'upload' ? 'アップロード中…' : '登録中…');
        if (multi) { prog.hidden = false; prog.textContent = `${i + 1} / ${jobs.length}：${j.title}`; }
        const payload = Object.assign({}, common, { title: j.title });
        try {
          if (j.file) {
            payload.source = 'drive';
            payload.mimeType = j.file.type;
            payload.fileName = j.file.name;
            payload.fileBase64 = await blobToBase64(j.file);
          } else {
            payload.source = src === 'drivelink' ? 'drive' : src;
            payload.url = j.url;
          }
          const d = await api('track_add', payload);
          if (d.track) added.push(d.track);
          if (!multi) toast(d.message);
        } catch (err) {
          failed.push(`${j.title}（${err.message}）`);
          if (!multi) toast(err.message, true);
        }
      }
    } finally {
      bulkRunning = false;
      btn.disabled = false;
      btn.textContent = oldLabel;
      prog.hidden = true;
    }
    if (!added.length) { if (multi) toast('登録できませんでした：' + failed.slice(0, 3).join('、'), true); return; }

    // ライブラリ・再生リストにも入れる
    const ids = added.map((t) => t.id);
    let extra = '';
    const lib = libById(state.libId);
    if (lib && addKind === 'song') {
      try { await saveLibrary(Object.assign({}, lib, { trackIds: lib.trackIds.concat(ids) })); extra = `（ライブラリ「${lib.name}」にも追加）`; } catch (e2) { /* 全曲には登録済み */ }
    }
    const pl = curPl();
    if (pl && addKind === 'podcast' && f.toPodlist.checked && !$('#atToPlWrap').hidden) {
      const room = Math.max(0, state.plMaxItems - pl.trackIds.length);
      const put = ids.slice(0, room);
      if (put.length) {
        try { await savePodlist(Object.assign({}, pl, { trackIds: pl.trackIds.concat(put) })); extra = `（再生リスト「${pl.name}」に${put.length}話追加）`; } catch (e2) { /* 登録済み */ }
      }
      if (put.length < ids.length) extra += `／再生リストが ${state.plMaxItems} 話でいっぱいのため ${ids.length - put.length} 話は入れていません`;
    }
    if (multi) {
      const msg = `${added.length} 件を登録しました${extra}` +
        (bulkCancel ? '（途中で中止）' : '') +
        (failed.length ? `／失敗 ${failed.length} 件：${failed.slice(0, 3).join('、')}${failed.length > 3 ? ' ほか' : ''}` : '') +
        (skipped.length ? `／とばした ${skipped.length} 件` : '');
      toast(msg, failed.length > 0);
    } else if (extra) {
      toast(`「${added[0].title}」を登録しました${extra}`);
    }
    if (!bulkCancel) closeModal('modalAddTrack');
    await loadTracks();
  }

  /* =========================================================
   *  ライブルーム
   * ========================================================= */
  async function loadRooms() {
    const ul = $('#roomList');
    try {
      const d = await api('rooms_list');
      const rooms = d.rooms || [];
      ul.innerHTML = rooms.length ? rooms.map((r) => {
        const p = personaById(r.persona);
        return `<li><button class="room-card" data-room="${esc(r.id)}">
          <span class="live-dot">LIVE</span>
          <h3>${esc(r.title)}</h3>
          ${r.topic ? `<p>${esc(r.topic)}</p>` : ''}
          <p>ステージ：${r.speakers.length ? r.speakers.map(esc).join('、') : 'まだ誰もいません'}</p>
          <div class="room-card-foot"><span>${p.icon} ${esc(p.name)}</span><span>${r.activeCount}人が参加中</span></div>
        </button></li>`;
      }).join('') : '<li class="empty">開いているルームはありません。「＋ ルームを開く」で最初のルームをどうぞ</li>';
    } catch (e) {
      ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
    }
  }

  async function enterRoom(id) {
    unlockMedia();
    try {
      await api('room_join', { roomId: id });
    } catch (e) { toast(e.message, true); loadRooms(); return; }
    if (state.room) exitRoomLocal();
    state.room = {
      id, since: 0, msgs: new Map(), members: [], me: null, info: null,
      initial: true, played: new Set(), timer: null,
      voiceQueue: [], voiceBusy: false, speakingId: null, recorder: null
    };
    $('#timeline').innerHTML = '';
    $('#roomLobby').hidden = true;
    $('#roomDetail').hidden = false;
    await pollRoom();
    if (state.room && state.room.info) $('#roomPersona').value = state.room.info.persona;
  }

  function exitRoomLocal() {
    const r = state.room;
    if (!r) return;
    clearTimeout(r.timer);
    if (r.recorder && r.recorder.state === 'recording') { r.discard = true; r.recorder.stop(); }
    state.room = null;
    $('#roomDetail').hidden = true;
    $('#roomLobby').hidden = false;
  }

  function sendLeaveBeacon() {
    if (!state.room || !state.token || !navigator.sendBeacon) return;
    const body = JSON.stringify({ action: 'room_leave', token: state.token, roomId: state.room.id });
    navigator.sendBeacon(CONFIG.GAS_URL, new Blob([body], { type: 'text/plain' }));
  }

  async function pollRoom() {
    const r = state.room;
    if (!r) return;
    clearTimeout(r.timer);
    try {
      const d = await api('room_state', { roomId: r.id, since: r.since });
      if (state.room !== r) return;
      r.info = d.room;
      r.members = d.members;
      r.me = d.me;
      if (d.room.status !== 'open') { toast('ルームは終了しました'); exitRoomLocal(); loadRooms(); return; }
      if (!d.me) { toast('ルームから退出しました'); exitRoomLocal(); loadRooms(); return; }
      const fresh = [];
      d.messages.forEach((m) => {
        r.since = Math.max(r.since, m.createdAt);
        if (!r.msgs.has(m.id)) { r.msgs.set(m.id, m); fresh.push(m); }
      });
      renderRoomHead();
      renderPeople();
      renderControls();
      appendMessages(fresh);
      if (!r.initial && $('#roomAutoplay').checked) {
        fresh
          .filter((m) => (m.type === 'voice' || m.type === 'ai') && m.userId !== state.user.userId && !r.played.has(m.id))
          .forEach((m) => enqueueVoice(m));
      }
      r.initial = false;
    } catch (e) {
      if (state.room !== r) return;
      if (e.code === 'ROOM_CLOSED' || e.code === 'NOT_MEMBER') { toast(e.message); exitRoomLocal(); loadRooms(); return; }
      console.warn(e);
    }
    if (state.room === r) r.timer = setTimeout(pollRoom, CONFIG.ROOM_POLL_INTERVAL_MS);
  }

  const isHost = () => {
    const r = state.room;
    return !!(r && r.info && (r.info.hostId === state.user.userId || state.user.role === 'admin'));
  };

  function renderRoomHead() {
    const r = state.room;
    $('#roomTitle').textContent = r.info.title;
    $('#roomTopic').textContent = r.info.topic || `ホスト：${r.info.hostName}`;
    $('#btnCloseRoom').hidden = !isHost();
  }

  function renderPeople() {
    const r = state.room;
    if (!r) return;
    const host = isHost();
    const stage = r.members.filter((m) => m.role !== 'listener');
    const aud = r.members.filter((m) => m.role === 'listener');
    const p = personaById(r.info.persona);
    const aiItem = `<li class="person ${r.speakingId === 'ai' ? 'is-speaking' : ''}">
        <span class="avatar" style="background:${p.color}" aria-hidden="true">${p.icon}</span>
        <span class="person-name">${esc(p.name)}</span><span class="person-role">AI DJ</span></li>`;
    $('#stageList').innerHTML = aiItem + stage.map((m) => `
      <li class="person ${r.speakingId === m.userId ? 'is-speaking' : ''}">
        ${avatarHtml(m.nickname)}
        <span class="person-name">${esc(m.nickname)}</span>
        <span class="person-role">${m.role === 'host' ? 'ホスト' : 'スピーカー'}</span>
        ${host && m.role === 'speaker' ? `<button class="person-act is-sub" data-demote="${esc(m.userId)}">リスナーへ</button>` : ''}
      </li>`).join('');
    $('#listenerCount').textContent = `${aud.length}人`;
    const sorted = aud.slice().sort((a, b) => Number(b.hand) - Number(a.hand));
    $('#audienceList').innerHTML = sorted.length ? sorted.map((m) => `
      <li class="person">
        ${m.hand ? '<span class="person-hand" aria-label="挙手中">✋</span>' : ''}
        ${avatarHtml(m.nickname)}
        <span class="person-name">${esc(m.nickname)}</span>
        ${host ? `<button class="person-act ${m.hand ? '' : 'is-sub'}" data-invite="${esc(m.userId)}">ステージへ招待</button>` : ''}
      </li>`).join('') : '<li class="empty">リスナーはいません</li>';
  }

  function renderControls() {
    const r = state.room;
    if (!r || !r.me) return;
    const role = r.me.role;
    const onStage = role !== 'listener';
    const hand = $('#btnHand');
    hand.hidden = onStage;
    hand.classList.toggle('is-active', !!r.me.hand);
    hand.querySelector('.ctl-label').textContent = r.me.hand ? '挙手を取り消す' : '手を挙げる';
    const rec = $('#btnRecord');
    rec.hidden = !onStage;
    rec.classList.toggle('is-rec', !!r.recorder);
    if (!r.recorder && !r.uploading) rec.querySelector('.ctl-label').textContent = '録音して話す';
    $('#aiCtl').hidden = !onStage;
    $('#btnStepDown').hidden = role !== 'speaker';
  }

  function msgHtml(m) {
    if (m.type === 'system') return `<li class="msg-system">${esc(m.text)}</li>`;
    const mine = state.user && m.userId === state.user.userId;
    if (m.type === 'ai') {
      const p = personaById(m.persona);
      return `<li class="msg msg-ai" data-msg="${esc(m.id)}">
        <span class="avatar" style="background:${p.color}" aria-hidden="true">${p.icon}</span>
        <div><div class="msg-name">${esc(p.name)}（${esc(m.nickname)} さんが呼びました）</div>
        <div class="msg-body">${esc(m.text)}<br><button class="msg-play" data-playmsg="${esc(m.id)}">▶ 聞く</button></div></div></li>`;
    }
    if (m.type === 'voice') {
      return `<li class="msg msg-voice" data-msg="${esc(m.id)}">${avatarHtml(m.nickname)}
        <div><div class="msg-name">${esc(m.nickname)}${mine ? '（あなた）' : ''}</div>
        <div class="msg-body">🎙 音声メッセージ<br><button class="msg-play" data-playmsg="${esc(m.id)}">▶ 聞く</button></div></div></li>`;
    }
    return `<li class="msg" data-msg="${esc(m.id)}">${avatarHtml(m.nickname)}
      <div><div class="msg-name">${esc(m.nickname)}${mine ? '（あなた）' : ''}</div><div class="msg-body">${esc(m.text)}</div></div></li>`;
  }

  function appendMessages(list) {
    if (!list.length) return;
    const tl = $('#timeline');
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
    tl.insertAdjacentHTML('beforeend', list.map(msgHtml).join(''));
    if (nearBottom || state.room.initial) tl.scrollTop = tl.scrollHeight;
  }

  function addOwnMessage(m) {
    const r = state.room;
    if (!r || r.msgs.has(m.id)) return;
    r.msgs.set(m.id, m);
    appendMessages([m]);
    const tl = $('#timeline');
    tl.scrollTop = tl.scrollHeight;
  }

  const bufferCache = new Map();
  async function getVoiceBuffer(fileId) {
    if (bufferCache.has(fileId)) return bufferCache.get(fileId);
    const d = await api('audio_get', { fileId });
    const buf = await audioToBuffer({ base64: d.base64, mimeType: d.mimeType });
    bufferCache.set(fileId, buf);
    if (bufferCache.size > 30) bufferCache.delete(bufferCache.keys().next().value);
    return buf;
  }

  function enqueueVoice(m, front = false) {
    const r = state.room;
    if (!r) return;
    if (front) r.voiceQueue.unshift(m); else r.voiceQueue.push(m);
    processVoiceQueue();
  }

  function markMsgPlaying(id, on) {
    const b = $(`[data-playmsg="${CSS.escape(id)}"]`);
    if (b) { b.classList.toggle('is-playing', on); b.textContent = on ? '♪ 再生中' : '▶ 聞く'; }
  }

  async function processVoiceQueue() {
    const r = state.room;
    if (!r || r.voiceBusy) return;
    const m = r.voiceQueue.shift();
    if (!m) return;
    r.voiceBusy = true;
    r.played.add(m.id);
    r.speakingId = m.type === 'ai' ? 'ai' : m.userId;
    renderPeople();
    markMsgPlaying(m.id, true);
    try {
      const buf = await getVoiceBuffer(m.fileId);
      duck(true);
      if (m.type === 'ai') await playJingle();
      await playVoiceBuffer(buf);
    } catch (e) {
      toast('音声を再生できませんでした', true);
    } finally {
      duck(false);
      markMsgPlaying(m.id, false);
      r.voiceBusy = false;
      r.speakingId = null;
      if (state.room === r) { renderPeople(); processVoiceQueue(); }
    }
  }

  async function toggleRecord() {
    const r = state.room;
    if (!r || r.uploading) return;
    if (r.recorder) { r.recorder.stop(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('このブラウザは録音に対応していません', true);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      toast('マイクの使用を許可してください', true);
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const label = $('#btnRecord .ctl-label');
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(r.recTimer);
      clearTimeout(r.recLimit);
      r.recorder = null;
      if (r.discard || state.room !== r) return;
      const blob = new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] });
      if (blob.size < 1500) { toast('録音が短すぎます'); renderControls(); return; }
      r.uploading = true;
      label.textContent = '送信中…';
      renderControls();
      try {
        const b64 = await blobToBase64(blob);
        const d = await api('room_post_voice', { roomId: r.id, base64: b64, mimeType: blob.type });
        r.played.add(d.message.id);
        addOwnMessage(d.message);
        toast('音声を投稿しました');
      } catch (e) {
        toast(e.message, true);
      } finally {
        r.uploading = false;
        renderControls();
      }
    };
    rec.start();
    r.recorder = rec;
    r.discard = false;
    const started = Date.now();
    label.textContent = `停止して送信 0:00 / ${fmtTime(CONFIG.MAX_VOICE_SEC)}`;
    r.recTimer = setInterval(() => {
      label.textContent = `停止して送信 ${fmtTime((Date.now() - started) / 1000)} / ${fmtTime(CONFIG.MAX_VOICE_SEC)}`;
    }, 500);
    r.recLimit = setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, CONFIG.MAX_VOICE_SEC * 1000);
    renderControls();
  }

  async function callRoomAi(btn) {
    const r = state.room;
    if (!r) return;
    unlockMedia();
    await withBusy(btn, '考え中…', async () => {
      try {
        const d = await api('room_ai', { roomId: r.id, persona: $('#roomPersona').value });
        if (state.room !== r) return;
        r.played.add(d.message.id);
        addOwnMessage(d.message);
        enqueueVoice(d.message, true);
      } catch (e) { toast(e.message, true); }
    });
  }

  function bindRooms() {
    $('#btnReloadRooms').addEventListener('click', loadRooms);
    $('#btnCreateRoom').addEventListener('click', () => {
      $('#createRoomForm').reset();
      $('#crPersona').value = state.persona;
      openModal('modalCreateRoom');
    });
    $('#createRoomForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      await withBusy(f.querySelector('button[type=submit]'), '作成中…', async () => {
        try {
          const d = await api('room_create', { title: f.title.value, topic: f.topic.value, persona: f.persona.value });
          closeModal('modalCreateRoom');
          await enterRoom(d.room.id);
        } catch (err) { toast(err.message, true); }
      });
    });
    $('#roomList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-room]');
      if (b) enterRoom(b.dataset.room);
    });
    $('#btnLeaveRoom').addEventListener('click', async () => {
      const r = state.room;
      if (!r) return;
      exitRoomLocal();
      try { await api('room_leave', { roomId: r.id }); } catch (e) { /* noop */ }
      loadRooms();
    });
    $('#btnCloseRoom').addEventListener('click', async () => {
      const r = state.room;
      if (!r || !confirm('ルームを終了しますか？参加者全員が退出します')) return;
      try {
        await api('room_close', { roomId: r.id });
        exitRoomLocal();
        toast('ルームを終了しました');
        loadRooms();
      } catch (e) { toast(e.message, true); }
    });
    $('#btnHand').addEventListener('click', async () => {
      const r = state.room;
      if (!r || !r.me) return;
      try { await api('room_hand', { roomId: r.id, raise: !r.me.hand }); pollRoom(); }
      catch (e) { toast(e.message, true); }
    });
    $('#btnStepDown').addEventListener('click', async () => {
      const r = state.room;
      if (!r) return;
      try { await api('room_role', { roomId: r.id, targetUserId: state.user.userId, role: 'listener' }); pollRoom(); }
      catch (e) { toast(e.message, true); }
    });
    $('#btnRecord').addEventListener('click', toggleRecord);
    $('#btnRoomAi').addEventListener('click', (e) => callRoomAi(e.currentTarget));
    $('#roomDetail').addEventListener('click', async (e) => {
      const r = state.room;
      if (!r) return;
      const inv = e.target.closest('[data-invite]');
      const dem = e.target.closest('[data-demote]');
      const pm = e.target.closest('[data-playmsg]');
      try {
        if (inv) { await api('room_invite', { roomId: r.id, targetUserId: inv.dataset.invite }); pollRoom(); }
        if (dem) { await api('room_role', { roomId: r.id, targetUserId: dem.dataset.demote, role: 'listener' }); pollRoom(); }
      } catch (err) { toast(err.message, true); }
      if (pm) {
        unlockMedia();
        const m = r.msgs.get(pm.dataset.playmsg);
        if (m && !pm.classList.contains('is-playing')) enqueueVoice(m, true);
      }
    });
    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = state.room;
      const input = $('#composerInput');
      const text = input.value.trim();
      if (!r || !text) return;
      input.value = '';
      try {
        const d = await api('room_post_text', { roomId: r.id, text });
        addOwnMessage(d.message);
      } catch (err) { toast(err.message, true); input.value = text; }
    });
    window.addEventListener('pagehide', sendLeaveBeacon);
  }

  /* =========================================================
   *  画面切り替え・モーダル・設定
   * ========================================================= */
  const VIEWS = ['radio', 'podcast', 'rooms', 'studio'];

  function showView(name) {
    if (state.view === 'studio' && name !== 'studio') leaveTalk();
    state.view = name;
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
    $$('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'rooms' && !state.room) loadRooms();
    window.scrollTo({ top: 0 });
  }

  function openModal(id) {
    const m = document.getElementById(id);
    m.hidden = false;
    const first = m.querySelector('input:not([type=hidden]):not([data-nofocus]), select, textarea');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (m.dataset.locked === '1') return;
    m.hidden = true;
  }

  function bindChrome() {
    $$('[data-nav]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); showView(b.dataset.nav); }));

    $$('.modal').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) closeModal(m.id);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      $$('.modal').filter((m) => !m.hidden).forEach((m) => closeModal(m.id));
      $('#playlistDrawer').hidden = true;
    });

    $('#userChip').addEventListener('click', () => {
      const u = state.user;
      $('#stEmail').textContent = u.email;
      $('#stRole').textContent = u.role === 'admin' ? '管理者' : 'メンバー';
      $('#profileForm').nickname.value = u.nickname;
      openModal('modalSettings');
    });
    $('#profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      await withBusy(f.querySelector('button'), '保存中…', async () => {
        try {
          const d = await api('profileUpdate', { nickname: f.nickname.value });
          state.user = d.user;
          saveSession();
          renderUser();
          toast(d.message);
        } catch (err) { toast(err.message, true); }
      });
    });
    $('#btnOpenChangePw').addEventListener('click', () => { closeModal('modalSettings'); openChangePw(false); });
    $('#btnLogout').addEventListener('click', () => { closeModal('modalSettings'); logout(); });
  }

  /* =========================================================
   *  音声キャッシュ（IndexedDB：台本の音声を保存して API 呼び出しを節約）
   * ========================================================= */
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('no idb')); return; }
      const r = indexedDB.open('nwr_audio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tts');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
      const t = db.transaction('tts', mode);
      const q = fn(t.objectStore('tts'));
      t.oncomplete = () => res(q ? q.result : undefined);
      t.onerror = () => rej(t.error);
    }));
    return {
      get: (k) => run('readonly', (s) => s.get(k)).catch(() => null),
      set: (k, v) => run('readwrite', (s) => s.put(v, k)).catch(() => null),
      has: (k) => run('readonly', (s) => s.getKey(k)).then((x) => x !== undefined && x !== null).catch(() => false)
    };
  })();

  /* =========================================================
   *  音声バッファの加工
   * ========================================================= */
  function offlineCtx(nch, length, rate) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return new OAC(nch, Math.max(1, length), rate);
  }

  /** 指定サンプルレートでデコード */
  function decodeAt(arrayBuffer, rate) {
    const oc = offlineCtx(2, 1, rate);
    return new Promise((res, rej) => oc.decodeAudioData(arrayBuffer, res, rej));
  }

  /** サンプルレート・チャンネル数をそろえる */
  async function renderTo(buf, rate, nch) {
    if (buf.sampleRate === rate && buf.numberOfChannels === nch) {
      return [...Array(nch)].map((_, c) => buf.getChannelData(c));
    }
    const oc = offlineCtx(nch, Math.ceil(buf.duration * rate), rate);
    const s = oc.createBufferSource();
    s.buffer = buf;
    s.connect(oc.destination);
    s.start();
    const out = await oc.startRendering();
    return [...Array(nch)].map((_, c) => out.getChannelData(c));
  }

  /** 複数のバッファを間（秒）をあけて1本につなぐ */
  async function joinBuffers(bufs, gapSec = 0.3) {
    bufs = bufs.filter(Boolean);
    if (!bufs.length) throw new Error('つなぐ音声がありません');
    const rate = Math.max(...bufs.map((b) => b.sampleRate));
    const nch = Math.max(...bufs.map((b) => b.numberOfChannels));
    const gap = Math.round(gapSec * rate);
    const sameRate = bufs.every((b) => b.sampleRate === rate && b.numberOfChannels === nch);
    if (sameRate) {
      const len = bufs.reduce((n, b) => n + b.length, 0) + gap * (bufs.length - 1);
      const out = ensureAudio().createBuffer(nch, len, rate);
      for (let c = 0; c < nch; c++) {
        const dst = out.getChannelData(c);
        let off = 0;
        bufs.forEach((b) => { dst.set(b.getChannelData(c), off); off += b.length + gap; });
      }
      return out;
    }
    const total = bufs.reduce((n, b) => n + b.duration, 0) + gapSec * (bufs.length - 1);
    const oc = offlineCtx(nch, Math.ceil(total * rate), rate);
    let t = 0;
    bufs.forEach((b) => {
      const s = oc.createBufferSource();
      s.buffer = b;
      s.connect(oc.destination);
      s.start(t);
      t += b.duration + gapSec;
    });
    return oc.startRendering();
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const safeFileName = (s) => String(s || 'audio').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 60) || 'audio';
  const stamp = () => {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
  };

  /* =========================================================
   *  書き出し（MP3 / WAV / FLAC / ALAC / AIFF）
   * ========================================================= */
  const EXPORT_NOTES = {
    mp3: 'ファイルが小さく、ほぼすべての機器で再生できます。',
    wav: 'もっとも互換性の高い非圧縮形式です。ファイルは大きめです。',
    flac: '音質そのままでサイズを小さくできる可逆圧縮。Android・Windows・多くのプレーヤーで再生できます。',
    alac: 'iPhone・Mac・ミュージックアプリ向けのロスレス形式（.m4a）。音質そのままですが、サイズは WAV と同じくらいです。',
    aiff: 'Mac や音楽制作ソフト向けの非圧縮形式です。'
  };
  let exportJob = null;

  function openExport(job) {
    exportJob = job;
    const f = $('#exportForm');
    const p = state.exportPrefs;
    f.format.value = p.format;
    f.bitDepth.value = String(p.bitDepth);
    f.bitrate.value = String(p.bitrate);
    f.sampleRate.value = String(p.sampleRate);
    f.channels.value = String(job.mono ? 1 : p.channels);
    $('#exTarget').textContent = job.title;
    $('#exProgress').hidden = true;
    $('#exSubmit').disabled = false;
    updateExportForm();
    openModal('modalExport');
  }

  function updateExportForm() {
    const f = $('#exportForm');
    const fmt = NWRExport.FORMATS[f.format.value];
    const depths = fmt.bitDepths || [];
    $('#exDepthWrap').hidden = !depths.length;
    [...f.bitDepth.options].forEach((o) => { o.disabled = !depths.includes(Number(o.value)); });
    if (depths.length && !depths.includes(Number(f.bitDepth.value))) f.bitDepth.value = String(depths[0]);
    $('#exRateWrap').hidden = f.format.value !== 'mp3';
    $('#exNote').textContent = EXPORT_NOTES[f.format.value] || '';
  }

  function setExportStep(text, ratio) {
    $('#exProgress').hidden = false;
    $('#exStep').textContent = text;
    if (ratio != null) $('#exBar').style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
  }

  async function submitExport(e) {
    e.preventDefault();
    const job = exportJob;
    if (!job) return;
    const f = e.target;
    const prefs = {
      format: f.format.value, bitDepth: Number(f.bitDepth.value), bitrate: Number(f.bitrate.value),
      sampleRate: Number(f.sampleRate.value), channels: Number(f.channels.value)
    };
    if (!job.mono) state.exportPrefs = Object.assign({}, prefs);
    else state.exportPrefs = Object.assign({}, prefs, { channels: state.exportPrefs.channels });
    savePrefs();
    const btn = $('#exSubmit');
    btn.disabled = true;
    const modal = $('#modalExport');
    modal.dataset.locked = '1';
    try {
      setExportStep('音声を準備しています…', 0.02);
      const src = await job.getBuffer(prefs.sampleRate);
      setExportStep('音声を整えています…', 0.08);
      const chans = await renderTo(src, prefs.sampleRate, prefs.channels);
      setExportStep('ファイルに変換しています…', 0.1);
      const blob = await NWRExport.encode(prefs.format, {
        channels: chans, sampleRate: prefs.sampleRate, bitDepth: prefs.bitDepth, bitrate: prefs.bitrate,
        tags: { title: job.title, artist: job.artist || CONFIG.APP_NAME }
      }, (r) => setExportStep('ファイルに変換しています…', 0.1 + r * 0.9));
      const ext = NWRExport.FORMATS[prefs.format].ext;
      downloadBlob(blob, `${safeFileName(job.title)}.${ext}`);
      setExportStep(`完成しました（${(blob.size / 1048576).toFixed(1)}MB）`, 1);
      toast('書き出しました');
      modal.dataset.locked = '';
      setTimeout(() => { if (exportJob === job) closeModal('modalExport'); }, 900);
    } catch (err) {
      setExportStep('書き出せませんでした：' + err.message);
      toast(err.message || '書き出せませんでした', true);
    } finally {
      modal.dataset.locked = '';
      btn.disabled = false;
    }
  }

  function exportTrack(id) {
    const t = state.tracks.find((x) => x.id === id);
    if (!t) return;
    openExport({
      title: t.title,
      artist: t.kind === 'podcast' ? t.showName : t.artist,
      getBuffer: async (rate) => {
        let ab;
        if (t.source === 'drive') {
          const d = await api('audio_get', { fileId: t.fileId });
          ab = b64ToBytes(d.base64).buffer;
        } else if (t.source === 'url') {
          try {
            const r = await fetch(t.url);
            if (!r.ok) throw new Error();
            ab = await r.arrayBuffer();
          } catch (e) {
            throw new Error('外部サイトの制限で、この曲は書き出せません');
          }
        } else {
          throw new Error('YouTube の曲は書き出せません');
        }
        try { return await decodeAt(ab, rate); } catch (e) { throw new Error('この音声はブラウザで読み込めませんでした'); }
      }
    });
  }

  function bindExport() {
    const sel = $('#exFormat');
    sel.innerHTML = Object.entries(NWRExport.FORMATS).map(([k, f]) => `<option value="${k}">${esc(f.label)}</option>`).join('');
    sel.addEventListener('change', updateExportForm);
    $('#exportForm').addEventListener('submit', submitExport);
  }

  /* =========================================================
   *  パーソナリティ管理（スタジオ）
   * ========================================================= */
  const canEditPersona = (p) => !p.builtin && state.user && (p.ownerId === state.user.userId || state.user.role === 'admin');
  const voiceInfo = (name) => state.voices.find((v) => v.name === name);
  const voiceLabel = (name) => { const v = voiceInfo(name); return v ? `${name}（${v.desc}）` : name || '—'; };
  const previewCache = new Map();

  function renderPersonaGrid() {
    const ul = $('#personaGrid');
    if (!ul) return;
    ul.innerHTML = state.personas.length ? state.personas.map((p) => `
      <li class="pcard" style="--pc:${esc(p.color)}">
        <div class="pcard-head">
          <span class="pcard-ico" aria-hidden="true">${esc(p.icon)}</span>
          <div class="pcard-id">
            <h4>${esc(p.name)}</h4>
            <p>${esc(GENDER_LABEL[p.gender] || 'その他')}／声：${esc(voiceLabel(p.voice))}</p>
          </div>
        </div>
        <p class="pcard-role">${esc(p.role || '')}${p.description ? '｜' + esc(p.description) : ''}</p>
        <p class="pcard-owner">${p.builtin ? '標準のパーソナリティ' : esc(p.ownerName || '') + ' さんが作成'}</p>
        <div class="pcard-actions">
          <button class="btn btn-small btn-ghost" data-pa="hear" data-id="${esc(p.id)}">▶ 声を聞く</button>
          ${canEditPersona(p) ? `<button class="btn btn-small btn-ghost" data-pa="edit" data-id="${esc(p.id)}">編集</button>` : ''}
          <button class="btn btn-small btn-ghost" data-pa="dup" data-id="${esc(p.id)}">複製</button>
          ${canEditPersona(p) ? `<button class="btn btn-small btn-danger" data-pa="del" data-id="${esc(p.id)}">削除</button>` : ''}
        </div>
      </li>`).join('') : '<li class="empty">読み込み中…</li>';
  }

  function renderStudioSelects() {
    if (!state.personas.length) return;
    $('#cvMe').innerHTML = personaOptions(state.convo.me);
    $('#cvAi').innerHTML = personaOptions(state.convo.ai);
    const males = state.personas.filter((p) => p.gender === 'male');
    const females = state.personas.filter((p) => p.gender === 'female');
    $('#dfA').innerHTML = personaOptions((males[0] || state.personas[0]).id);
    $('#dfB').innerHTML = personaOptions((females[0] || state.personas[1] || state.personas[0]).id);
  }

  function voiceOptions(selected) {
    const group = (g, label) => {
      const vs = state.voices.filter((v) => v.gender === g);
      return vs.length ? `<optgroup label="${label}">${vs.map((v) => `<option value="${esc(v.name)}"${v.name === selected ? ' selected' : ''}>${esc(v.name)}（${esc(v.desc)}）</option>`).join('')}</optgroup>` : '';
    };
    return group('female', '女性の声') + group('male', '男性の声');
  }

  function openPersonaModal(p, mode) {
    const f = $('#personaForm');
    const editing = mode === 'edit';
    $('#pmTitle').textContent = editing ? 'パーソナリティを編集' : 'パーソナリティを作る';
    f.pid.value = editing ? p.id : '';
    f.name.value = p ? (editing ? p.name : `${p.name}（コピー）`.slice(0, 20)) : '';
    f.icon.value = p ? p.icon : '🎙';
    f.color.value = p && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#ff4fb4';
    f.gender.value = p ? p.gender : 'female';
    $('#pmVoice').innerHTML = voiceOptions(p ? p.voice : 'Kore');
    f.prole.value = p ? p.role || '' : '';
    f.description.value = p ? p.description || '' : '';
    f.pstyle.value = p ? p.style || '' : '';
    f.prompt.value = p ? p.prompt || '' : '';
    openModal('modalPersona');
  }

  async function hearBuffer(key, req) {
    if (previewCache.has(key)) return previewCache.get(key);
    const p = api('tts_say', req).then((r) => audioToBuffer(r.audio));
    previewCache.set(key, p);
    p.catch(() => previewCache.delete(key));
    return p;
  }

  async function playPreview(btn, key, req) {
    unlockMedia();
    await withBusy(btn, '生成中…', async () => {
      try {
        const buf = await hearBuffer(key, req);
        btn.textContent = '♪ 再生中';
        duck(true);
        await playVoiceBuffer(buf);
      } catch (e) { toast(e.message, true); } finally { duck(false); }
    });
  }

  function bindPersonaStudio() {
    $('#btnNewPersona').addEventListener('click', () => openPersonaModal(null, 'new'));
    $('#personaGrid').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pa]');
      if (!b) return;
      const p = state.personas.find((x) => x.id === b.dataset.id);
      if (!p) return;
      if (b.dataset.pa === 'hear') {
        playPreview(b, `p:${p.id}:${p.voice}:${p.style}`, { persona: p.id, text: `こんにちは、${p.name}です。ネオンウェーブ・ラジオ、今日もよろしくお願いします。` });
      } else if (b.dataset.pa === 'edit') {
        openPersonaModal(p, 'edit');
      } else if (b.dataset.pa === 'dup') {
        openPersonaModal(p, 'dup');
      } else if (b.dataset.pa === 'del') {
        if (!confirm(`「${p.name}」を削除しますか？`)) return;
        try {
          const d = await api('persona_delete', { id: p.id });
          toast(d.message);
          await loadPersonas();
        } catch (err) { toast(err.message, true); }
      }
    });
    $('#pmPreview').addEventListener('click', (e) => {
      const f = $('#personaForm');
      const voice = f.voice.value, style = f.pstyle.value.trim();
      const name = f.name.value.trim() || 'わたし';
      playPreview(e.currentTarget, `v:${voice}:${style}:${name}`, { voice, style, text: `こんにちは、${name}です。この声でお話しします。どうぞよろしく。` });
    });
    $('#personaForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const persona = {
        id: f.pid.value || undefined, name: f.name.value, icon: f.icon.value, color: f.color.value, gender: f.gender.value,
        voice: f.voice.value, role: f.prole.value, description: f.description.value, style: f.pstyle.value, prompt: f.prompt.value
      };
      await withBusy(f.querySelector('button[type=submit]'), '保存中…', async () => {
        try {
          const d = await api('persona_save', { persona });
          toast(d.message);
          closeModal('modalPersona');
          await loadPersonas();
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  /* =========================================================
   *  台本の掛け合い（1人50セットまで保存・放送順を指定）
   * ========================================================= */
  /** 「名前：セリフ」形式のテキストをブロック（曲間1回分）に分ける */
  function parseScript(text) {
    const blocks = [];
    let cur = [];
    const push = () => { if (cur.length) blocks.push({ lines: cur.slice(0, 60) }); cur = []; };
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      if (/^([-ー―─=＝]\s*){3,}$/.test(line)) { push(); return; }
      if (/^(#|＃|\/\/)/.test(line)) return;
      let m = line.match(/^【([^】]{1,20})】\s*[：:]?\s*(.+)$/) || line.match(/^([^：:\s「『（(]{1,20})\s*[：:]\s*(.+)$/);
      if (m) cur.push({ speaker: m[1].trim(), text: m[2].trim() });
      else if (cur.length) cur[cur.length - 1].text += line;
    });
    push();
    return blocks;
  }

  function scriptSpeakers() {
    const out = [];
    state.script.blocks.forEach((b) => b.lines.forEach((l) => { if (!out.includes(l.speaker)) out.push(l.speaker); }));
    return out;
  }

  /** 名前から配役を自動で決める（名前が同じパーソナリティ → 男女の手がかり → 交互） */
  function autoCast(speakers) {
    const cast = {};
    const old = state.script.cast || {};
    if (!state.personas.length) return Object.assign({}, old);
    const males = state.personas.filter((p) => p.gender === 'male');
    const females = state.personas.filter((p) => p.gender === 'female');
    const used = new Set();
    const take = (list) => list.find((p) => !used.has(p.id)) || list[0];
    let alt = 0;
    speakers.forEach((sp) => {
      if (old[sp] && hasPersona(old[sp])) { cast[sp] = old[sp]; used.add(old[sp]); }
    });
    speakers.forEach((sp) => {
      if (cast[sp]) return;
      const exact = state.personas.find((p) => p.name === sp);
      let pick = exact;
      if (!pick && /女|母|姉|妹|妻|嬢|子$/.test(sp)) pick = take(females);
      if (!pick && /男|父|兄|弟|夫|氏$/.test(sp)) pick = take(males);
      if (!pick) pick = alt++ % 2 === 0 ? take(males) || take(females) : take(females) || take(males);
      pick = pick || state.personas[0];
      if (pick) { cast[sp] = pick.id; used.add(pick.id); }
    });
    return cast;
  }

  const castFor = (b, cast) => {
    const c = {};
    b.lines.forEach((l) => { c[l.speaker] = cast[l.speaker]; });
    return c;
  };
  const castLabel = (b) => [...new Set(b.lines.map((l) => l.speaker))].join(' × ');
  const blockText = (b) => b.lines.map((l) => `${l.speaker}：${l.text}`).join('\n');

  function hashStr(s) {
    let h1 = 0x811c9dc5, h2 = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = (Math.imul(h2, 31) + c) >>> 0;
    }
    return h1.toString(36) + h2.toString(36) + s.length.toString(36);
  }
  // 声（voice）が変わったら作り直す。v1.2.0 から指示文なしで読み上げるのでキーを更新
  const blockKey = (b, cast) => 'blk2_' + hashStr(JSON.stringify(b.lines.map((l) => [l.speaker, l.text, personaById(cast[l.speaker]).voice])));

  const blockBufCache = new Map();
  const blockReady = new Set();

  function getBlockBuffer(b, cast) {
    cast = cast || state.script.cast;
    const key = blockKey(b, cast);
    if (blockBufCache.has(key)) return blockBufCache.get(key);
    const p = (async () => {
      let data = await idb.get(key);
      if (!data || !data.segments) {
        const d = await api('script_tts', { lines: b.lines, cast: castFor(b, cast) });
        data = { segments: d.segments, gapMs: d.gapMs };
        idb.set(key, data);
      }
      const bufs = await Promise.all(data.segments.map((a) => audioToBuffer(a)));
      const out = await joinBuffers(bufs, (data.gapMs || 250) / 1000);
      blockReady.add(key);
      return out;
    })();
    blockBufCache.set(key, p);
    p.catch(() => blockBufCache.delete(key));
    while (blockBufCache.size > 40) blockBufCache.delete(blockBufCache.keys().next().value);
    return p;
  }

  /* ---------- 台本セットの読み込み・保存 ---------- */
  let castSaveTimer = null;

  async function loadScripts() {
    try {
      const d = await api('scripts_list');
      state.scripts = d.scripts || [];
      state.scriptsMax = d.max || 50;
    } catch (e) { toast(e.message, true); }
    // v1.1 でブラウザに残っていた台本を、最初の1セットとして保存
    if (!state.scripts.length && state.legacyScript && state.legacyScript.text.trim()) {
      try {
        const d = await api('script_save', { script: { title: '台本1', text: state.legacyScript.text, cast: state.legacyScript.cast } });
        state.scripts.push(d.script);
      } catch (e) { /* noop */ }
    }
    state.legacyScript = null;
    state.rundown = state.rundown.filter((it) => scriptById(it.sid));
    if (!scriptById(state.scriptId)) state.scriptId = state.scripts.length ? state.scripts[0].id : '';
    openScript(state.scriptId, true);
    savePrefs();
  }

  function scriptDirty() {
    const ta = $('#scriptText');
    return !!ta && (ta.value !== state.script.text || $('#scriptTitle').value.trim() !== state.script.title);
  }

  function openScript(id, silent) {
    const sc = scriptById(id);
    state.scriptId = sc ? sc.id : '';
    state.script = sc
      ? { id: sc.id, title: sc.title, text: sc.text, cast: Object.assign({}, sc.cast), blocks: parseScript(sc.text) }
      : { id: '', title: '', text: '', cast: {}, blocks: [] };
    if (state.script.blocks.length) syncAutoCast();
    $('#scriptText').value = state.script.text;
    $('#scriptTitle').value = state.script.title;
    if (!state.rundown.length) state.seqNext = 0;
    state.segPrefetch = null;
    if (!silent) savePrefs();
    renderScriptSelect();
    renderCast();
    renderBlocks();
    renderRundown();
    renderScriptStatus();
  }

  function renderScriptSelect() {
    const sel = $('#scriptSelect');
    if (!sel) return;
    sel.innerHTML = state.scripts.length
      ? state.scripts.map((x, i) => `<option value="${esc(x.id)}">掛${i + 1}　${esc(x.title)}（${blocksOf(x).length}ブロック）</option>`).join('')
      : '<option value="">（台本はまだありません）</option>';
    sel.value = state.scriptId;
    $('#scriptCount').textContent = `${state.scripts.length} / ${state.scriptsMax}`;
    $('#btnScriptDelete').disabled = !state.scriptId;
    renderScriptCatalog();
    renderProgram();
  }

  function storeScript(sc) {
    const i = state.scripts.findIndex((x) => x.id === sc.id);
    if (i >= 0) state.scripts[i] = sc; else state.scripts.push(sc);
  }

  /** 新しい台本セットを作って開く */
  async function createScript(title, text, cast) {
    if (state.scripts.length >= state.scriptsMax) { toast(`台本は ${state.scriptsMax} セットまでです。いらない台本を削除してください`, true); return null; }
    const d = await api('script_save', { script: { title, text, cast: cast || {} } });
    storeScript(d.script);
    openScript(d.script.id);
    return d.script;
  }

  /** 編集中の台本を保存して読み込み直す */
  async function saveCurrentScript(btn) {
    const text = $('#scriptText').value;
    const title = $('#scriptTitle').value.trim() || state.script.title || `台本${state.scripts.length + 1}`;
    const blocks = parseScript(text);
    state.script.text = text;
    state.script.title = title;
    state.script.blocks = blocks;
    state.script.cast = autoCast(scriptSpeakers());
    const run = async () => {
      try {
        if (!state.script.id) {
          await createScript(title, text, state.script.cast);
        } else {
          const d = await api('script_save', { script: { id: state.script.id, title, text, cast: state.script.cast } });
          storeScript(d.script);
          openScript(d.script.id);
        }
        if (blocks.length) toast(`保存しました（${blocks.length} ブロック・${scriptSpeakers().length} 人）`);
        else toast('保存しました。セリフは「名前：セリフ」の形で書いてください', true);
      } catch (e) { toast(e.message, true); }
    };
    if (btn) await withBusy(btn, '保存中…', run); else await run();
  }

  /** 配役が決まっていない話し手に声を割り当て、変わったら保存する */
  function syncAutoCast() {
    const before = JSON.stringify(state.script.cast);
    state.script.cast = autoCast(scriptSpeakers());
    if (state.personas.length && state.script.id && JSON.stringify(state.script.cast) !== before) scheduleCastSave();
  }

  function scheduleCastSave() {
    const sc = scriptById(state.script.id);
    if (!sc) return;
    sc.cast = Object.assign({}, state.script.cast);
    clearTimeout(castSaveTimer);
    castSaveTimer = setTimeout(async () => {
      try { await api('script_save', { script: { id: sc.id, title: sc.title, text: sc.text, cast: sc.cast } }); }
      catch (e) { toast('配役を保存できませんでした：' + e.message, true); }
    }, 700);
  }

  /* ---------- 表示 ---------- */
  function renderCast() {
    const ul = $('#castList');
    if (!ul) return;
    const sps = scriptSpeakers();
    ul.innerHTML = sps.length ? sps.map((sp) => {
      const p = personaById(state.script.cast[sp]);
      return `<li class="cast" style="--pc:${esc(p.color)}">
        <span class="cast-ico" aria-hidden="true">${esc(p.icon)}</span>
        <span class="cast-name">${esc(sp)}</span>
        <select data-cast="${esc(sp)}" aria-label="${esc(sp)} の声">${personaOptions(state.script.cast[sp])}</select>
      </li>`;
    }).join('') : '<li class="empty">台本を保存すると、話す人ごとに声を選べます</li>';
  }

  function renderBlocks() {
    const ol = $('#blockList');
    if (!ol) return;
    const bs = state.script.blocks;
    const cast = state.script.cast;
    const cur = betweenSeq()[state.seqNext];
    $('#blockCount').textContent = bs.length ? `${bs.length}` : '';
    ol.innerHTML = bs.length ? bs.map((b, i) => {
      const ready = blockReady.has(blockKey(b, cast));
      const isNext = cur && cur.sid === state.script.id && cur.bi === i;
      return `<li class="block${isNext ? ' is-next' : ''}">
        <div class="block-head">
          <span class="block-no">${state.script.id ? `${scriptNo(state.script.id)}-` : ''}${i + 1}</span>
          <span class="block-cast">${esc(castLabel(b))}</span>
          <span class="block-state" data-bstate="${i}">${ready ? '音声あり' : ''}</span>
          <span class="block-actions">
            <button class="icon-btn" data-bplay="${i}" title="試聴" aria-label="ブロック${i + 1}を試聴">▶</button>
            <button class="icon-btn" data-bexport="${i}" title="書き出す" aria-label="ブロック${i + 1}を書き出す">⬇</button>
            <button class="icon-btn" data-badd="${i}" title="放送順に追加" aria-label="ブロック${i + 1}を放送順に追加">＋</button>
          </span>
        </div>
        <p class="block-lines">${b.lines.map((l) => `<b>${esc(l.speaker)}</b>${esc(l.text)}`).join('<br>')}</p>
      </li>`;
    }).join('') : '<li class="empty">まだブロックがありません</li>';
    bs.forEach((b, i) => {
      const key = blockKey(b, cast);
      if (blockReady.has(key)) return;
      idb.has(key).then((ok) => {
        const el = ol.querySelector(`[data-bstate="${i}"]`);
        if (ok && el) el.textContent = '音声あり';
      });
    });
  }

  /** 放送順（曲間に流す順番） */
  function renderRundown() {
    const ol = $('#rundownList');
    if (!ol) return;
    const seq = betweenSeq();
    const cur = seq[state.seqNext];
    if (!state.rundown.length) {
      const sc = scriptById(state.scriptId);
      ol.innerHTML = `<li class="empty rd-empty">${sc
        ? `放送順が空のときは、開いている台本「${esc(sc.title)}」を最初から順に流します`
        : '台本のブロックの「＋」で、曲間に流す順番を組み立てられます'}</li>`;
      $('#rundownTotal').textContent = '';
      return;
    }
    $('#rundownTotal').textContent = `${seq.length} ブロック`;
    ol.innerHTML = state.rundown.map((it, ri) => {
      const sc = scriptById(it.sid);
      const bs = blocksOf(sc);
      const items = seq.filter((e) => e.ri === ri);
      const first = seq.indexOf(items[0]);
      const done = items.length && seq.indexOf(items[items.length - 1]) < state.seqNext;
      const isNext = cur && cur.ri === ri;
      const what = !sc ? '（削除された台本）'
        : it.b < 0 ? `全 ${bs.length} ブロック`
        : bs[it.b] ? `ブロック ${it.b + 1}（${esc(castLabel(bs[it.b]))}）` : '（ブロックがありません）';
      return `<li class="rd${isNext ? ' is-next' : ''}${done ? ' is-done' : ''}">
        <span class="rd-no">${ri + 1}</span>
        <div class="rd-main"><b>${esc(sc ? sc.title : '—')}</b><span>${what}${isNext && it.b < 0 ? `・次は ${cur.bi + 1}` : ''}</span></div>
        <span class="rd-actions">
          <button class="icon-btn" data-rfrom="${first}" title="次はここから" aria-label="次はここから"${items.length ? '' : ' disabled'}>⏵</button>
          <button class="icon-btn" data-rup="${ri}" title="上へ" aria-label="上へ"${ri === 0 ? ' disabled' : ''}>↑</button>
          <button class="icon-btn" data-rdown="${ri}" title="下へ" aria-label="下へ"${ri === state.rundown.length - 1 ? ' disabled' : ''}>↓</button>
          <button class="icon-btn" data-rdel="${ri}" title="放送順から外す" aria-label="放送順から外す">✕</button>
        </span>
      </li>`;
    }).join('');
  }

  function rundownChanged() {
    state.segPrefetch = null;
    state.seqNext = Math.min(state.seqNext, betweenSeq().length);
    savePrefs();
    renderRundown();
    renderBlocks();
    renderScriptStatus();
    maybePrefetchSegment();
  }

  function addToRundown(b) {
    if (!state.script.id) { toast('先に台本を保存してください', true); return; }
    if (scriptDirty()) { toast('台本に保存していない変更があります。先に保存してください', true); return; }
    if (state.rundown.length >= 200) { toast('放送順は200件までです', true); return; }
    state.rundown.push({ sid: state.script.id, b });
    rundownChanged();
    toast(b < 0 ? `「${state.script.title}」を放送順に追加しました` : `ブロック ${b + 1} を放送順に追加しました`);
  }

  async function readTextFile(file) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('\uFFFD')) {
      try { text = new TextDecoder('shift_jis').decode(buf); } catch (e) { /* そのまま */ }
    }
    return text.replace(/^\uFEFF/, '');
  }

  function bindScriptStudio() {
    const ta = $('#scriptText');
    $('#btnScriptParse').addEventListener('click', (e) => saveCurrentScript(e.currentTarget));
    $('#scriptSelect').addEventListener('change', (e) => {
      if (scriptDirty() && !confirm('保存していない変更があります。破棄して切り替えますか？')) { e.target.value = state.scriptId; return; }
      openScript(e.target.value);
    });
    $('#btnScriptNew').addEventListener('click', async (e) => {
      if (scriptDirty() && !confirm('保存していない変更があります。破棄して新しい台本を作りますか？')) return;
      const title = (prompt('新しい台本の名前', `台本${state.scripts.length + 1}`) || '').trim();
      if (!title) return;
      await withBusy(e.currentTarget, '作成中…', async () => {
        try { await createScript(title, '', {}); ta.focus(); } catch (err) { toast(err.message, true); }
      });
    });
    $('#btnScriptDelete').addEventListener('click', async () => {
      const sc = scriptById(state.scriptId);
      if (!sc || !confirm(`台本「${sc.title}」を削除しますか？（放送順からも外れます）`)) return;
      try {
        const d = await api('script_delete', { id: sc.id });
        state.scripts = state.scripts.filter((x) => x.id !== sc.id);
        state.rundown = state.rundown.filter((it) => it.sid !== sc.id);
        openScript(state.scripts.length ? state.scripts[0].id : '');
        rundownChanged();
        toast(d.message);
      } catch (err) { toast(err.message, true); }
    });
    $('#scriptFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 300 * 1024) { toast('テキストファイルが大きすぎます（300KBまで）', true); return; }
      const text = await readTextFile(file);
      try {
        const sc = await createScript(file.name.replace(/\.[^.]+$/, '').slice(0, 40), text, {});
        if (sc) await saveCurrentScript();   // 配役を自動で決めて保存
      } catch (err) { toast(err.message, true); }
    });
    $('#castList').addEventListener('change', (e) => {
      const s = e.target.closest('[data-cast]');
      if (!s) return;
      state.script.cast[s.dataset.cast] = s.value;
      state.segPrefetch = null;
      scheduleCastSave();
      renderCast();
      renderBlocks();
    });
    $('#blockList').addEventListener('click', (e) => {
      const play = e.target.closest('[data-bplay]');
      const ex = e.target.closest('[data-bexport]');
      const add = e.target.closest('[data-badd]');
      const b = (el, k) => state.script.blocks[Number(el.dataset[k])];
      if (play) {
        unlockMedia();
        const i = Number(play.dataset.bplay);
        performSegment(makeBlockSegment(b(play, 'bplay'), state.script.cast, `${state.script.title} ${i + 1}`), state.playing, '🎙 掛け合い（試聴）')
          .then(() => renderBlocks());
      }
      if (ex) {
        const i = Number(ex.dataset.bexport);
        const blk = b(ex, 'bexport');
        const cast = Object.assign({}, state.script.cast);
        openExport({ title: `${state.script.title || '掛け合い'} ${i + 1}（${castLabel(blk)}）`, artist: castLabel(blk), mono: true, getBuffer: () => getBlockBuffer(blk, cast) });
      }
      if (add) addToRundown(Number(add.dataset.badd));
    });
    $('#btnAddScriptToRundown').addEventListener('click', () => {
      if (!state.script.blocks.length) { toast('この台本にはまだブロックがありません', true); return; }
      addToRundown(-1);
    });
    $('#rundownList').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      const d = btn.dataset;
      const r = state.rundown;
      if (d.rup != null) { const i = Number(d.rup); [r[i - 1], r[i]] = [r[i], r[i - 1]]; }
      else if (d.rdown != null) { const i = Number(d.rdown); [r[i + 1], r[i]] = [r[i], r[i + 1]]; }
      else if (d.rdel != null) { r.splice(Number(d.rdel), 1); }
      else if (d.rfrom != null) { state.seqNext = Number(d.rfrom); toast(`次の曲間は放送順の ${state.seqNext + 1} 番目のブロックから流します`); }
      else return;
      rundownChanged();
    });
    $('#btnRundownClear').addEventListener('click', () => {
      if (!state.rundown.length || !confirm('放送順をすべてクリアしますか？（台本は消えません）')) return;
      state.rundown = [];
      state.seqNext = 0;
      rundownChanged();
    });
    $('#btnGenAll').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const bs = state.script.blocks;
      if (!bs.length) { toast('先に台本を保存してください', true); return; }
      btn.disabled = true;
      try {
        for (let i = 0; i < bs.length; i++) {
          btn.textContent = `生成中 ${i + 1}/${bs.length}`;
          await getBlockBuffer(bs[i], state.script.cast);
          renderBlocks();
        }
        toast('すべてのブロックの音声ができました');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '🔊 全部の音声を作る';
      }
    });
    $('#btnExportAllBlocks').addEventListener('click', () => {
      const bs = state.script.blocks.slice();
      const cast = Object.assign({}, state.script.cast);
      if (!bs.length) { toast('先に台本を保存してください', true); return; }
      openExport({
        title: `${state.script.title || '掛け合い台本'} ${stamp()}`, artist: scriptSpeakers().join(' × '), mono: true,
        getBuffer: async () => {
          const bufs = [];
          for (let i = 0; i < bs.length; i++) {
            setExportStep(`ブロック ${i + 1}/${bs.length} の音声を用意しています…`, (i / bs.length) * 0.08);
            bufs.push(await getBlockBuffer(bs[i], cast));
          }
          return joinBuffers(bufs, 1.2);
        }
      });
    });
    $('#btnUseScript').addEventListener('click', () => {
      if (!betweenSeq().length) { toast('流せる台本がありません。台本を保存するか、放送順に追加してください', true); return; }
      if (state.between.mode !== 'mix') state.between.mode = 'script';
      $('#betweenMode').value = state.between.mode;
      state.segPrefetch = null;
      savePrefs();
      renderScriptStatus();
      maybePrefetchSegment();
      showView('radio');
      toast('曲間で台本の掛け合いを流します');
    });

    // AIで下書き（新しい台本セットとして保存）
    $('#btnDraft').addEventListener('click', () => openModal('modalDraft'));
    $('#draftForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (state.scripts.length >= state.scriptsMax) { toast(`台本は ${state.scriptsMax} セットまでです`, true); return; }
      await withBusy(f.querySelector('button[type=submit]'), '書いています…', async () => {
        try {
          const d = await api('script_draft', { cast: [f.a.value, f.b.value], theme: f.theme.value, blocks: Number(f.blocks.value) });
          const cast = {};
          [f.a.value, f.b.value].forEach((id) => { const p = personaById(id); if (p.name) cast[p.name] = id; });
          const title = (f.theme.value.trim() || 'AIの下書き').slice(0, 40);
          const sc = await createScript(title, d.text, cast);
          if (sc) await saveCurrentScript();
          closeModal('modalDraft');
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  /* =========================================================
   *  番組表（曲No と 掛け合いNo の順番で放送）
   * ========================================================= */
  const trackById = (id) => state.tracks.find((t) => t.id === id);
  const scriptNo = (sid) => state.scripts.findIndex((x) => x.id === sid) + 1;
  let progSaveTimer = null;

  async function loadProgram() {
    try {
      const d = await api('program_get');
      state.program = d.items || [];
    } catch (e) { toast(e.message, true); }
    renderProgram();
  }

  function saveProgram() {
    clearTimeout(progSaveTimer);
    progSaveTimer = setTimeout(async () => {
      try { await api('program_save', { items: state.program }); }
      catch (e) { toast('番組表を保存できませんでした：' + e.message, true); }
    }, 600);
  }

  function programChanged() {
    if (state.progMode) {
      // 放送中に編集したら、番組表で放送し直すまで続きはそのまま
      state.progMode = false;
      toast('番組表を変更したので、番組表での放送を止めました。もう一度「番組表で放送」を押してください');
    }
    saveProgram();
    renderProgram();
  }

  /** 番組表の1行の表示 */
  function progLabel(it) {
    if (it.t === 's') {
      const t = trackById(it.id);
      if (!t) return { ico: '🎵', no: '曲?', title: '（見つからない曲）', sub: '', missing: true };
      const no = librarySongs().findIndex((x) => x.id === t.id) + 1;
      return { ico: '🎵', no: no ? `曲${no}` : '曲', title: t.title, sub: trackSubtitle(t) + (no ? '' : '（今のライブラリ外）') };
    }
    const sc = scriptById(it.sid);
    if (!sc) return { ico: '🎙', no: '掛?', title: '（削除された台本）', sub: '', missing: true };
    const n = scriptNo(sc.id);
    const bs = blocksOf(sc);
    if (it.b < 0) return { ico: '🎙', no: `掛${n}`, title: sc.title, sub: `全 ${bs.length} ブロックを続けて` };
    const blk = bs[it.b];
    return { ico: '🎙', no: `掛${n}-${it.b + 1}`, title: sc.title, sub: blk ? castLabel(blk) + '「' + blk.lines[0].text.slice(0, 24) + '」' : '（ブロックがありません）', missing: !blk };
  }

  function renderProgram() {
    const ol = $('#progList');
    if (!ol) return;
    const p = state.program;
    $('#progCount').textContent = p.length ? `${p.filter((x) => x.t === 's').length}曲・${p.filter((x) => x.t === 'k').length}トーク` : '';
    ol.innerHTML = p.length ? p.map((it, i) => {
      const l = progLabel(it);
      const now = state.progMode && i === state.progPos;
      const done = state.progMode && i < state.progPos;
      return `<li class="pg pg-${it.t}${now ? ' is-now' : ''}${done ? ' is-done' : ''}${l.missing ? ' is-missing' : ''}">
        <span class="pg-pos">${i + 1}</span>
        <span class="pg-no">${l.ico} ${esc(l.no)}</span>
        <div class="pg-main"><b>${esc(l.title)}</b><span>${esc(l.sub)}</span></div>
        <span class="rd-actions">
          <button class="icon-btn" data-pgfrom="${i}" title="ここから放送" aria-label="ここから放送">⏵</button>
          <button class="icon-btn" data-pgup="${i}" title="上へ" aria-label="上へ"${i === 0 ? ' disabled' : ''}>↑</button>
          <button class="icon-btn" data-pgdown="${i}" title="下へ" aria-label="下へ"${i === p.length - 1 ? ' disabled' : ''}>↓</button>
          <button class="icon-btn" data-pgdel="${i}" title="外す" aria-label="外す">✕</button>
        </span>
      </li>`;
    }).join('') : '<li class="empty">番号を入力するか、右の一覧の「＋」で曲と掛け合いを並べてください</li>';
    $('#btnStartProgram').hidden = !p.length;
    renderProgSources();
  }

  /** 番組表に入れる素材（曲No・掛け合いNo の一覧） */
  function renderProgSources() {
    const sl = $('#progSongs');
    if (!sl) return;
    const lib = libById(state.libId);
    $('#progLibName').textContent = lib ? `ライブラリ「${lib.name}」` : 'すべての曲';
    const songs = librarySongs();
    sl.innerHTML = songs.length ? songs.map((t, i) => `
      <li><button class="src-add" data-psong="${esc(t.id)}" aria-label="曲${i + 1}を追加">＋</button>
        <span class="src-no">曲${i + 1}</span><span class="src-title">${t.source === 'youtube' ? '📺 ' : ''}${esc(t.title)}</span></li>`).join('')
      : '<li class="empty">曲がありません</li>';
    $('#progTalks').innerHTML = state.scripts.length ? state.scripts.map((sc, si) => {
      const bs = blocksOf(sc);
      return `<li class="src-script">
        <div class="src-head"><button class="src-add" data-ptalk="${esc(sc.id)}" data-pb="-1" aria-label="掛${si + 1}を丸ごと追加">＋</button>
          <span class="src-no">掛${si + 1}</span><span class="src-title">${esc(sc.title)}</span></div>
        <ul>${bs.map((b, bi) => `<li><button class="src-add" data-ptalk="${esc(sc.id)}" data-pb="${bi}" aria-label="掛${si + 1}-${bi + 1}を追加">＋</button>
          <span class="src-no">掛${si + 1}-${bi + 1}</span><span class="src-title">${esc(castLabel(b))}「${esc(b.lines[0].text.slice(0, 20))}」</span></li>`).join('')}</ul>
      </li>`;
    }).join('') : '<li class="empty">台本がありません</li>';
  }

  /** 「曲1, 掛2-1, 曲2」のような番号の並びを番組表にする */
  function parseProgramText(text) {
    const songs = librarySongs();
    const items = [], bad = [];
    String(text || '').normalize('NFKC').split(/[\s,、，→>＞・;／/]+/).map((x) => x.trim()).filter(Boolean).forEach((tok) => {
      let m = tok.match(/^(?:曲|s|S)?(\d+)$/);
      if (m) {
        const t = songs[Number(m[1]) - 1];
        if (t) items.push({ t: 's', id: t.id }); else bad.push(tok);
        return;
      }
      m = tok.match(/^(?:掛|掛け合い|k|K|t|T)(\d+)(?:[-‐−ー―](\d+))?$/);
      if (m) {
        const sc = state.scripts[Number(m[1]) - 1];
        const b = m[2] ? Number(m[2]) - 1 : -1;
        if (sc && (b < 0 || blocksOf(sc)[b])) items.push({ t: 'k', sid: sc.id, b }); else bad.push(tok);
        return;
      }
      bad.push(tok);
    });
    return { items, bad };
  }

  /** 交互に並べるときに使う掛け合いブロックの一覧
   *  1. 「放送順」に入っているブロックを先に使う
   *  2. 足りない分は、保存済みの全台本（掛1-1, 掛1-2 … 掛2-1 …）から、まだ使っていないものを順に補う */
  function autoTalkPool(need) {
    const out = [], used = new Set();
    const add = (sid, bi) => {
      const key = sid + ':' + bi;
      if (used.has(key)) return;
      used.add(key);
      out.push({ sid, bi });
    };
    (state.rundown || []).forEach((it) => {
      const sc = scriptById(it.sid);
      if (!sc) return;
      const bs = blocksOf(sc);
      if (it.b < 0) bs.forEach((_, bi) => add(sc.id, bi));
      else if (bs[it.b]) add(sc.id, it.b);
    });
    if (out.length < need) {
      state.scripts.forEach((sc) => blocksOf(sc).forEach((_, bi) => add(sc.id, bi)));
    }
    return out;
  }

  /** 曲と掛け合いを交互に並べる（掛 → 曲 → 掛 → 曲 … → 掛） */
  function autoProgram() {
    const songs = librarySongs().slice(0, 149);   // 掛＋曲で300件以内に収める
    const talks = autoTalkPool(songs.length + 1);
    const out = [];
    let k = 0;
    const pushTalk = () => { if (k < talks.length) { out.push({ t: 'k', sid: talks[k].sid, b: talks[k].bi }); k++; } };
    pushTalk();                                   // オープニング
    songs.forEach((t) => {
      out.push({ t: 's', id: t.id });
      pushTalk();                                 // 曲のあとに1ブロック（最後はエンディング）
    });
    return { items: out, songs: songs.length, talks: k };
  }

  /* ---------- 番組表で放送 ---------- */
  async function startProgram(from = 0) {
    unlockMedia();
    if (!state.program.length) { toast('番組表が空です', true); return; }
    if (state.djBusy) { toast('トークの最中です。終わってからもう一度どうぞ'); return; }
    state.podQueue = false;
    state.queue = [];
    state.progSongIdx = [];
    state.program.forEach((it, i) => {
      const t = it.t === 's' && trackById(it.id);
      if (t) { state.progSongIdx[i] = state.queue.length; state.queue.push(t); }
    });
    stopAll();
    state.progMode = true;
    state.playedCount = 0;
    state.segPrefetch = null;
    state.progPos = from - 1;
    state.progRun = (state.progRun || 0) + 1;
    renderQueue();
    toast('番組表で放送します');
    progAdvance();
  }

  function stopProgram() {
    if (!state.progMode) return;
    state.progMode = false;
    state.progRun = (state.progRun || 0) + 1;
    renderProgram();
    renderScriptStatus();
  }

  async function progAdvance() {
    const run = state.progRun;
    let guard = 0;
    while (state.progMode && run === state.progRun) {
      if (++guard > state.program.length * 2 + 2) { stopProgram(); toast('番組表に流せる項目がありません', true); return; }
      state.progPos++;
      if (state.progPos >= state.program.length) {
        if (state.loop === 'all') { state.progPos = -1; continue; }
        stopProgram();
        setPlaying(false);
        toast('番組表を最後まで放送しました');
        return;
      }
      renderProgram();
      renderScriptStatus();
      const it = state.program[state.progPos];
      if (it.t === 's') {
        const qi = state.progSongIdx[state.progPos];
        if (qi == null) continue;
        loadTrack(qi);
        return;
      }
      const sc = scriptById(it.sid);
      if (!sc) continue;
      const bs = blocksOf(sc);
      const list = it.b < 0 ? bs.map((_, i) => i) : (bs[it.b] ? [it.b] : []);
      const n = scriptNo(sc.id);
      for (const bi of list) {
        await performSegment(makeBlockSegment(bs[bi], sc.cast || {}, `${sc.title} ${bi + 1}`), false, `🎙 掛${n}-${bi + 1}`);
        if (!state.progMode || run !== state.progRun) return;
      }
    }
  }

  /** 次に流すトークの音声を先に作っておく */
  function prefetchProgram() {
    for (let i = state.progPos + 1; i < state.program.length; i++) {
      const it = state.program[i];
      if (it.t === 's') return;
      const sc = scriptById(it.sid);
      if (!sc) continue;
      const bs = blocksOf(sc);
      (it.b < 0 ? bs : [bs[it.b]]).filter(Boolean).forEach((b) => getBlockBuffer(b, sc.cast || {}).catch(() => {}));
      return;
    }
  }

  function progPrev() {
    for (let i = state.progPos - 1; i >= 0; i--) {
      if (state.program[i].t === 's' && state.progSongIdx[i] != null) { state.progPos = i - 1; progAdvance(); return; }
    }
    seekTo(0);
  }

  function bindProgram() {
    $('#btnProgApply').addEventListener('click', () => {
      const { items, bad } = parseProgramText($('#progInput').value);
      if (!items.length) { toast(bad.length ? `番号が見つかりません：${bad.join('、')}` : '番号を入力してください', true); return; }
      if (state.program.length && !confirm('今の番組表を、入力した順番で置き換えますか？')) return;
      state.program = items.slice(0, 300);
      programChanged();
      toast(bad.length ? `${items.length} 件で作りました（見つからない番号：${bad.join('、')}）` : `${items.length} 件の番組表を作りました`, !!bad.length);
    });
    $('#btnProgAppend').addEventListener('click', () => {
      const { items, bad } = parseProgramText($('#progInput').value);
      if (!items.length) { toast(bad.length ? `番号が見つかりません：${bad.join('、')}` : '番号を入力してください', true); return; }
      state.program = state.program.concat(items).slice(0, 300);
      programChanged();
      toast(bad.length ? `追加しました（見つからない番号：${bad.join('、')}）` : `${items.length} 件を後ろに追加しました`, !!bad.length);
    });
    $('#btnProgAuto').addEventListener('click', () => {
      if (!librarySongs().length) { toast('今のライブラリに曲がありません', true); return; }
      if (!state.scripts.some((sc) => blocksOf(sc).length)) { toast('掛け合いの台本がありません。先に台本を保存してください', true); return; }
      if (state.program.length && !confirm('今の番組表を、曲と掛け合いを交互に並べた内容で置き換えますか？')) return;
      const r = autoProgram();
      if (!r.items.length) { toast('並べられる曲・掛け合いがありません', true); return; }
      stopProgram();
      state.program = r.items;
      programChanged();
      const ol = $('#progList');
      if (ol) ol.scrollTop = 0;
      toast(r.talks < r.songs + 1
        ? `${r.songs}曲・${r.talks}トークで並べました（掛け合いが足りない所は曲が続きます）`
        : `${r.songs}曲・${r.talks}トークを交互に並べました`, r.talks < r.songs + 1);
    });
    $('#btnProgClear').addEventListener('click', () => {
      if (!state.program.length || !confirm('番組表をクリアしますか？')) return;
      state.program = [];
      stopProgram();
      programChanged();
    });
    $('#progList').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      const d = btn.dataset, p = state.program;
      if (d.pgfrom != null) { startProgram(Number(d.pgfrom)); return; }
      if (d.pgup != null) { const i = Number(d.pgup); [p[i - 1], p[i]] = [p[i], p[i - 1]]; }
      else if (d.pgdown != null) { const i = Number(d.pgdown); [p[i + 1], p[i]] = [p[i], p[i + 1]]; }
      else if (d.pgdel != null) { p.splice(Number(d.pgdel), 1); }
      else return;
      programChanged();
    });
    $('#progSources').addEventListener('click', (e) => {
      const s = e.target.closest('[data-psong]');
      const k = e.target.closest('[data-ptalk]');
      if (!s && !k) return;
      if (state.program.length >= 300) { toast('番組表は300件までです', true); return; }
      state.program.push(s ? { t: 's', id: s.dataset.psong } : { t: 'k', sid: k.dataset.ptalk, b: Number(k.dataset.pb) });
      programChanged();
      const ol = $('#progList');
      ol.scrollTop = ol.scrollHeight;
    });
    $('#btnStartProgram').addEventListener('click', () => { showView('radio'); startProgram(0); });
    $('#btnRadioProgram').addEventListener('click', () => startProgram(0));
  }

  /* =========================================================
   *  台本一覧（概要）
   * ========================================================= */
  const fmtDate = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };

  function renderScriptCatalog() {
    const ul = $('#scriptCatalog');
    if (!ul) return;
    $('#catalogCount').textContent = `${state.scripts.length} / ${state.scriptsMax}`;
    ul.innerHTML = state.scripts.length ? state.scripts.map((sc, si) => {
      const bs = blocksOf(sc);
      const speakers = [];
      bs.forEach((b) => b.lines.forEach((l) => { if (!speakers.includes(l.speaker)) speakers.push(l.speaker); }));
      const lines = bs.reduce((n, b) => n + b.lines.length, 0);
      const chars = bs.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.text.length, 0), 0);
      const minutes = Math.max(1, Math.round(chars / 300));
      const first = bs[0] ? bs[0].lines.slice(0, 2).map((l) => `<b>${esc(l.speaker)}</b>${esc(l.text)}`).join('<br>') : '（セリフがありません）';
      return `<li class="cat">
        <div class="cat-head">
          <span class="cat-no">掛${si + 1}</span>
          <div class="cat-id"><h4>${esc(sc.title)}</h4>
            <p>${bs.length} ブロック・${lines} セリフ・約 ${minutes} 分${sc.updatedAt ? '・' + fmtDate(sc.updatedAt) + ' 更新' : ''}</p></div>
        </div>
        <div class="cat-cast">${speakers.map((sp) => { const p = personaById((sc.cast || {})[sp]); return `<span style="--pc:${esc(p.color)}">${esc(p.icon)} ${esc(sp)}</span>`; }).join('')}</div>
        <p class="cat-lead">${first}</p>
        ${bs.length ? `<details class="cat-blocks"><summary>ブロックの一覧</summary><ol>${bs.map((b, bi) =>
          `<li><span class="src-no">掛${si + 1}-${bi + 1}</span>${esc(castLabel(b))}「${esc(b.lines[0].text.slice(0, 30))}」（${b.lines.length}行）</li>`).join('')}</ol></details>` : ''}
        <div class="cat-actions">
          <button class="btn btn-small btn-ghost" data-cat-open="${esc(sc.id)}">開いて編集</button>
          <button class="btn btn-small btn-ghost" data-cat-prog="${esc(sc.id)}">＋ 番組表に追加</button>
          <button class="btn btn-small btn-ghost" data-cat-run="${esc(sc.id)}">＋ 曲間の放送順に追加</button>
        </div>
      </li>`;
    }).join('') : '<li class="empty">台本はまだありません。「掛け合い台本」タブで作れます</li>';
  }

  function bindScriptCatalog() {
    $('#scriptCatalog').addEventListener('click', (e) => {
      const op = e.target.closest('[data-cat-open]');
      const pg = e.target.closest('[data-cat-prog]');
      const rn = e.target.closest('[data-cat-run]');
      if (op) {
        if (scriptDirty() && !confirm('編集中の台本に保存していない変更があります。破棄して開きますか？')) return;
        openScript(op.dataset.catOpen);
        showStudioTab('script');
      }
      if (pg) {
        state.program.push({ t: 'k', sid: pg.dataset.catProg, b: -1 });
        programChanged();
        toast('番組表に追加しました');
      }
      if (rn) {
        state.rundown.push({ sid: rn.dataset.catRun, b: -1 });
        rundownChanged();
        toast('曲間の放送順に追加しました');
      }
    });
  }

  /* =========================================================
   *  マイク（間があっても途切れにくい聞き取り）
   * ========================================================= */
  const mic = { active: false };

  async function micStart(onLevel) {
    const ctx = ensureAudio();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('このブラウザはマイクに対応していません');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    Object.assign(mic, {
      active: true, stream, src, proc, sink, chunks: [], startedAt: performance.now(),
      noiseSum: 0, noiseN: 0, thresh: 0, spoken: false, firstVoice: -1, lastVoice: -1, lastVoiceAt: 0, rate: ctx.sampleRate
    });
    const silenceMs = state.convo.silence * 1000;
    return new Promise((resolve) => {
      mic.resolve = resolve;
      proc.onaudioprocess = (e) => {
        if (!mic.active) return;
        const d = e.inputBuffer.getChannelData(0);
        mic.chunks.push(new Float32Array(d));
        let sum = 0;
        for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / d.length);
        const now = performance.now();
        const el = now - mic.startedAt;
        if (el < 450) { mic.noiseSum += rms; mic.noiseN++; onLevel(0, null); return; }
        if (!mic.thresh) mic.thresh = Math.min(0.06, Math.max(0.012, (mic.noiseSum / Math.max(1, mic.noiseN)) * 2.8));
        const idx = mic.chunks.length - 1;
        if (rms > mic.thresh) {
          if (!mic.spoken) { mic.spoken = true; mic.firstVoice = idx; }
          mic.lastVoice = idx;
          mic.lastVoiceAt = now;
        }
        const quiet = mic.spoken ? now - mic.lastVoiceAt : 0;
        onLevel(Math.min(1, rms / (mic.thresh * 4)), mic.spoken ? Math.max(0, silenceMs - quiet) : null);
        if (mic.spoken && quiet > silenceMs) micStop('auto');
        else if (!mic.spoken && el > CONFIG.CONVO_WAIT_SEC * 1000) micStop('nospeech');
        else if (el > CONFIG.CONVO_MAX_SEC * 1000) micStop('max');
      };
    });
  }

  function micStop(reason) {
    if (!mic.active) return;
    mic.active = false;
    try { mic.proc.onaudioprocess = null; mic.proc.disconnect(); mic.src.disconnect(); mic.sink.disconnect(); } catch (e) { /* noop */ }
    mic.stream.getTracks().forEach((t) => t.stop());
    const resolve = mic.resolve;
    mic.resolve = null;
    if (reason === 'cancel' || reason === 'nospeech' || (!mic.spoken && reason !== 'manual')) {
      resolve && resolve({ reason, samples: null });
      return;
    }
    const chunks = mic.chunks;
    const from = mic.spoken ? Math.max(0, mic.firstVoice - 4) : 0;
    const to = mic.spoken ? Math.min(chunks.length, mic.lastVoice + 6) : chunks.length;
    const part = chunks.slice(from, to);
    const out = new Float32Array(part.reduce((n, c) => n + c.length, 0));
    let off = 0;
    part.forEach((c) => { out.set(c, off); off += c.length; });
    mic.chunks = [];
    resolve && resolve({ reason, samples: out, rate: mic.rate });
  }

  /** 文字起こし用に 16kHz モノラル WAV にする */
  async function toUploadWav(buf) {
    const [ch] = await renderTo(buf, 16000, 1);
    return NWRExport.encode('wav', { channels: [ch], sampleRate: 16000, bitDepth: 16 });
  }

  /* =========================================================
   *  AIとの対話
   * ========================================================= */
  const cv = state.convo;

  function setMicState(mode, text) {
    const btn = $('#btnMic');
    btn.classList.toggle('is-listening', mode === 'listening');
    btn.classList.toggle('is-busy', mode === 'busy');
    btn.disabled = mode === 'busy';
    btn.setAttribute('aria-label', mode === 'listening' ? '話し終わったので送る' : 'マイクで話しはじめる');
    $('#btnMicCancel').hidden = mode !== 'listening';
    $('#micStatus').textContent = text || (mode === 'listening' ? '聞いています…' : 'マイクを押して話しかけてください');
    if (mode !== 'listening') btn.style.setProperty('--lv', 0);
  }

  function renderSeats(speaking) {
    const seat = (el, p, label, on) => {
      el.style.setProperty('--pc', p.color);
      el.classList.toggle('is-speaking', !!on);
      el.innerHTML = `<span class="seat-ava" aria-hidden="true">${esc(p.icon)}</span><span class="seat-name">${esc(p.name)}</span><span class="seat-label">${label}</span>`;
    };
    if (!$('#seatMe')) return;
    seat($('#seatMe'), personaById(cv.me), cv.convert ? 'あなた（声を変換）' : 'あなた（地声）', speaking === 'user');
    seat($('#seatAi'), personaById(cv.ai), 'AI', speaking === 'ai');
  }

  function renderTalkLog() {
    const ol = $('#talkLog');
    const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 80;
    ol.innerHTML = cv.turns.length ? cv.turns.map((t, i) => {
      const p = personaById(t.persona);
      return `<li class="tl tl-${t.role}${t.speaking ? ' is-speaking' : ''}" style="--pc:${esc(p.color)}">
        <span class="tl-ava" aria-hidden="true">${esc(p.icon)}</span>
        <div class="tl-bubble">
          <div class="tl-name">${esc(p.name)}${t.role === 'user' ? '（あなた）' : ''}</div>
          <p>${esc(t.text)}</p>
          ${t.pending ? `<span class="tl-pending">${esc(t.pending)}</span>` : ''}
          ${t.buffer ? `<div class="tl-tools"><button data-tplay="${i}">▶ 聞く</button><button data-texport="${i}">⬇ 書き出す</button></div>` : ''}
        </div>
      </li>`;
    }).join('') : '<li class="empty talk-empty">ここに会話が残ります。マイクを押して話しかけるか、「AIから話しはじめる」をどうぞ</li>';
    if (atBottom || cv.turns.length) ol.scrollTop = ol.scrollHeight;
  }

  function pushTurn(t) {
    cv.turns.push(t);
    renderTalkLog();
    return t;
  }

  async function speakTurn(t) {
    if (!t.buffer) return;
    t.speaking = true;
    renderSeats(t.role);
    renderTalkLog();
    duck(true);
    try { await playVoiceBuffer(t.buffer); } finally {
      duck(false);
      t.speaking = false;
      renderSeats();
      renderTalkLog();
    }
  }

  const talkHistory = () => cv.turns.filter((t) => t.text && !t.failed).map((t) => ({ role: t.role, text: t.text })).slice(-16);
  const talkVisible = () => state.view === 'studio' && state.studioTab === 'talk';

  /** 自分の発言 → （声変換）→ AI の返事 */
  async function convoExchange(text, rawBuf) {
    const me = personaById(cv.me), ai = personaById(cv.ai);
    const uTurn = pushTurn({ role: 'user', persona: me.id, text, buffer: null, pending: cv.convert ? `${me.name} の声にしています…` : '' });
    const history = talkHistory();
    setMicState('busy', `${ai.name} が考えています…`);
    const userP = cv.convert
      ? api('tts_say', { persona: me.id, text }).then((r) => audioToBuffer(r.audio))
      : Promise.resolve(rawBuf || null);
    const replyP = api('talk_reply', { persona: ai.id, partnerName: cv.convert ? me.name : state.user.nickname, theme: cv.theme, history });
    replyP.catch(() => {});
    try {
      uTurn.buffer = await userP;
    } catch (e) {
      toast('声の変換に失敗したので、元の声を使います', true);
      uTurn.buffer = rawBuf || null;
    }
    uTurn.pending = '';
    renderTalkLog();
    await speakTurn(uTurn);
    await aiReply(replyP);
  }

  async function aiReply(replyP) {
    const ai = personaById(cv.ai);
    setMicState('busy', `${ai.name} が話しています…`);
    const r = await replyP;
    const buffer = await audioToBuffer(r.audio);
    const t = pushTurn({ role: 'ai', persona: r.persona, text: r.text, buffer });
    await speakTurn(t);
  }

  async function convoListen() {
    if (cv.busy || mic.active) return;
    unlockMedia();
    cv.stopLoop = false;
    setMicState('listening', '聞いています…');
    duck(true);
    let rec;
    try {
      rec = await micStart((lv, left) => {
        $('#btnMic').style.setProperty('--lv', lv.toFixed(2));
        if (left != null && left < state.convo.silence * 1000 - 400) $('#micStatus').textContent = `このまま ${Math.ceil(left / 1000)} 秒黙ると送ります（押すとすぐ送信）`;
        else if (left != null) $('#micStatus').textContent = '聞いています…（押すと送信）';
      });
    } catch (e) {
      duck(false);
      setMicState('idle');
      toast(e.name === 'NotAllowedError' ? 'マイクの使用を許可してください' : e.message, true);
      return;
    }
    duck(false);
    if (!rec.samples || !rec.samples.length) {
      setMicState('idle', rec.reason === 'nospeech' ? '声が聞こえなかったので止めました' : '');
      return;
    }
    cv.busy = true;
    setMicState('busy', '文字にしています…');
    try {
      const raw = ensureAudio().createBuffer(1, rec.samples.length, rec.rate);
      raw.getChannelData(0).set(rec.samples);
      const wav = await toUploadWav(raw);
      const d = await api('voice_transcribe', { base64: await blobToBase64(wav), mimeType: 'audio/wav' });
      if (!d.text) {
        toast('うまく聞き取れませんでした。もう一度どうぞ');
      } else {
        await convoExchange(d.text, raw);
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      cv.busy = false;
      setMicState('idle');
    }
    if (cv.continuous && !cv.stopLoop && talkVisible()) setTimeout(() => { if (talkVisible() && !cv.stopLoop) convoListen(); }, 400);
  }

  async function convoText(text) {
    if (cv.busy || mic.active) return;
    unlockMedia();
    cv.busy = true;
    try { await convoExchange(text, null); } catch (e) { toast(e.message, true); } finally {
      cv.busy = false;
      setMicState('idle');
    }
  }

  async function convoAiOpen() {
    if (cv.busy || mic.active) return;
    unlockMedia();
    cv.busy = true;
    try {
      const me = personaById(cv.me);
      setMicState('busy', `${personaById(cv.ai).name} が考えています…`);
      await aiReply(api('talk_reply', { persona: cv.ai, partnerName: cv.convert ? me.name : state.user.nickname, theme: cv.theme, history: talkHistory() }));
    } catch (e) { toast(e.message, true); } finally {
      cv.busy = false;
      setMicState('idle');
    }
    if (cv.continuous && talkVisible()) setTimeout(() => { if (talkVisible() && !cv.stopLoop) convoListen(); }, 400);
  }

  function leaveTalk() {
    cv.stopLoop = true;
    if (mic.active) micStop('cancel');
  }

  async function talkSessionBuffer() {
    const bufs = cv.turns.map((t) => t.buffer).filter(Boolean);
    if (!bufs.length) throw new Error('書き出せる会話がまだありません');
    return joinBuffers(bufs, 0.6);
  }

  function bindTalkStudio() {
    const me = $('#cvMe'), ai = $('#cvAi'), theme = $('#cvTheme');
    const conv = $('#cvConvert'), cont = $('#cvContinuous'), sil = $('#cvSilence');
    theme.value = cv.theme;
    conv.checked = cv.convert;
    cont.checked = cv.continuous;
    sil.value = String(cv.silence);
    $('#cvSilenceVal').textContent = cv.silence;
    me.addEventListener('change', () => { cv.me = me.value; savePrefs(); renderSeats(); });
    ai.addEventListener('change', () => { cv.ai = ai.value; savePrefs(); renderSeats(); });
    theme.addEventListener('change', () => { cv.theme = theme.value.trim(); savePrefs(); });
    conv.addEventListener('change', () => { cv.convert = conv.checked; savePrefs(); renderSeats(); });
    cont.addEventListener('change', () => { cv.continuous = cont.checked; if (!cv.continuous) cv.stopLoop = true; savePrefs(); });
    sil.addEventListener('input', () => { cv.silence = Number(sil.value); $('#cvSilenceVal').textContent = cv.silence; });
    sil.addEventListener('change', savePrefs);

    $('#btnMic').addEventListener('click', () => {
      if (mic.active) { micStop('manual'); return; }
      convoListen();
    });
    $('#btnMicCancel').addEventListener('click', () => { cv.stopLoop = true; micStop('cancel'); });
    $('#talkComposer').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#talkInput');
      const text = input.value.trim();
      if (!text) return;
      if (cv.busy || mic.active) { toast('いまは返事を待っています'); return; }
      input.value = '';
      convoText(text);
    });
    $('#btnAiOpen').addEventListener('click', convoAiOpen);
    $('#talkLog').addEventListener('click', async (e) => {
      const pl = e.target.closest('[data-tplay]');
      const ex = e.target.closest('[data-texport]');
      if (pl) {
        unlockMedia();
        const t = cv.turns[Number(pl.dataset.tplay)];
        if (t && !t.speaking && !cv.busy) speakTurn(t);
      }
      if (ex) {
        const t = cv.turns[Number(ex.dataset.texport)];
        if (t && t.buffer) {
          const p = personaById(t.persona);
          openExport({ title: `${p.name}「${t.text.slice(0, 16)}」`, artist: p.name, mono: true, getBuffer: async () => t.buffer });
        }
      }
    });
    $('#btnTalkExport').addEventListener('click', () => {
      if (!cv.turns.some((t) => t.buffer)) { toast('書き出せる会話がまだありません', true); return; }
      openExport({ title: `AIと対話 ${stamp()}`, artist: `${personaById(cv.me).name} × ${personaById(cv.ai).name}`, mono: true, getBuffer: talkSessionBuffer });
    });
    $('#btnTalkSave').addEventListener('click', async (e) => {
      if (!cv.turns.some((t) => t.buffer)) { toast('保存できる会話がまだありません', true); return; }
      const title = prompt('エピソードのタイトル', `AIと対話 ${stamp()}`);
      if (!title) return;
      await withBusy(e.currentTarget, '保存中…', async () => {
        try {
          const buf = await talkSessionBuffer();
          const [ch] = await renderTo(buf, 44100, 1);
          const blob = await NWRExport.encode('mp3', { channels: [ch], sampleRate: 44100, bitrate: 128 });
          if (blob.size > CONFIG.MAX_UPLOAD_MB * 1048576) throw new Error(`会話が長すぎます（${CONFIG.MAX_UPLOAD_MB}MBまで）。書き出して保存してください`);
          const desc = cv.turns.map((t) => `${personaById(t.persona).name}：${t.text}`).join('\n').slice(0, 500);
          const d = await api('track_add', {
            kind: 'podcast', source: 'drive', title: title.trim().slice(0, 80), showName: 'AIと対話',
            description: desc, mimeType: 'audio/mpeg', fileName: safeFileName(title) + '.mp3', fileBase64: await blobToBase64(blob)
          });
          toast(d.message + '（ポッドキャストに追加）');
          await loadTracks();
        } catch (err) { toast(err.message, true); }
      });
    });
    $('#btnTalkClear').addEventListener('click', () => {
      if (!cv.turns.length || !confirm('会話をすべて消しますか？（書き出していない音声は消えます）')) return;
      cv.turns = [];
      renderTalkLog();
    });
    setMicState('idle');
    renderTalkLog();
  }

  /* =========================================================
   *  スタジオ
   * ========================================================= */
  function showStudioTab(tab) {
    if (state.studioTab === 'talk' && tab !== 'talk') leaveTalk();
    state.studioTab = tab;
    $$('[data-studio-tab]').forEach((b) => {
      const on = b.dataset.studioTab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on);
    });
    $$('[data-studio-panel]').forEach((p) => (p.hidden = p.dataset.studioPanel !== tab));
  }

  function bindStudio() {
    $$('[data-studio-tab]').forEach((b) => b.addEventListener('click', () => showStudioTab(b.dataset.studioTab)));
    bindPersonaStudio();
    bindScriptStudio();
    bindTalkStudio();
    bindProgram();
    bindScriptCatalog();
    renderCast();
    renderBlocks();
  }

  /* =========================================================
   *  起動
   * ========================================================= */
  async function boot() {
    $$('.app-version').forEach((el) => (el.textContent = CONFIG.VERSION));
    $('#lcdFreq').textContent = CONFIG.FREQUENCY;
    loadPrefs();
    bindAuth();
    bindPlayer();
    bindDj();
    bindLibrary();
    bindPodcast();
    bindPodlist();
    bindHelp();
    bindRooms();
    bindStudio();
    bindExport();
    bindChrome();
    bindMediaSession();
    startVisualizer();

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CONFIG.SESSION_KEY) || 'null'); } catch (e) { /* noop */ }
    if (!saved || !saved.token) { showAuthScreen(''); return; }

    state.token = saved.token;
    state.user = saved.user;
    if (saved.user && saved.user.mustChange) { openChangePw(true); return; }
    enterApp();
    try {
      const d = await api('me');
      state.user = d.user;
      saveSession();
      renderUser();
    } catch (e) { /* AUTH / MUST_CHANGE は api() 内で処理済み */ }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
