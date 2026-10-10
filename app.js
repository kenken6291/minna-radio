/**
 * NEON WAVE RADIO - app.js  v1.0.0
 * 認証 / プレイヤー / AI DJ（Gemini TTS）/ ラジオエフェクト / ライブルーム
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
    autoDj: true,
    fx: { lofi: true, echo: 0.15, reverb: 0.25 },
    volume: 0.8,
    djBusy: false,
    djPrefetch: null,
    room: null
  };

  const musicEl = $('#musicEl');
  const rawEl = $('#rawEl');

  /* ---------- 設定の保存 ---------- */
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(CONFIG.PREFS_KEY) || '{}');
      if (p.persona && CONFIG.PERSONAS.some((x) => x.id === p.persona)) state.persona = p.persona;
      if (typeof p.autoDj === 'boolean') state.autoDj = p.autoDj;
      if (p.fx) state.fx = Object.assign(state.fx, p.fx);
      if (typeof p.volume === 'number') state.volume = p.volume;
      if (typeof p.shuffle === 'boolean') state.shuffle = p.shuffle;
      if (['off', 'all', 'one'].includes(p.loop)) state.loop = p.loop;
    } catch (e) { /* 初回 */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(CONFIG.PREFS_KEY, JSON.stringify({
        persona: state.persona, autoDj: state.autoDj, fx: state.fx,
        volume: state.volume, shuffle: state.shuffle, loop: state.loop
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
    loadTracks();
    const hash = location.hash.replace('#', '');
    showView(['radio', 'podcast', 'rooms'].includes(hash) ? hash : 'radio');
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
    if (state.shuffle && n > 1) {
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
    maybePrefetchDj();
  }

  function playList(list, start = 0) {
    if (!list.length) return;
    unlockMedia();
    state.queue = list.slice();
    state.playedCount = 0;
    state.djPrefetch = null;
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
    const n = state.plannedNext;
    if (n == null) {
      setPlaying(false);
      toast('プレイリストを最後まで再生しました');
      return;
    }
    if (state.autoDj && state.playedCount % CONFIG.DJ_EVERY_N_TRACKS === 0) {
      const pf = state.djPrefetch;
      const promise = pf && pf.fromIdx === state.idx && pf.toIdx === n ? pf.promise : requestBetweenTalk(state.idx, n);
      state.djPrefetch = null;
      const token = state.loadToken;
      await performDj(promise, false);
      if (token !== state.loadToken) return; // DJ中に別の曲が選ばれた
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
      state.djPrefetch = null;
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
      if (b) { unlockMedia(); loadTrack(Number(b.dataset.q)); }
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
   *  AI DJ
   * ========================================================= */
  const personaById = (id) => CONFIG.PERSONAS.find((p) => p.id === id) || CONFIG.PERSONAS[0];

  function renderPersonas() {
    $('#personaList').innerHTML = CONFIG.PERSONAS.map((p) => `
      <button class="persona" role="radio" aria-checked="${p.id === state.persona}" data-persona="${p.id}" style="--pc:${p.color}">
        <span class="persona-ico" aria-hidden="true">${p.icon}</span>
        <span><span class="persona-name">${esc(p.name)}</span><span class="persona-desc">${esc(p.role)}｜${esc(p.desc)}</span></span>
      </button>`).join('');
    const opts = CONFIG.PERSONAS.map((p) => `<option value="${p.id}">${p.icon} ${esc(p.name)}</option>`).join('');
    $('#crPersona').innerHTML = opts;
    $('#roomPersona').innerHTML = opts;
  }

  function showCaption(p, text, loading) {
    const box = $('#djCaption');
    box.hidden = false;
    box.classList.toggle('is-loading', !!loading);
    $('#djCaptionWho').textContent = `${p.icon} ${p.name}`;
    $('#djCaptionText').textContent = text;
  }

  function requestBetweenTalk(fromIdx, toIdx) {
    const a = state.queue[fromIdx] || {}, b = state.queue[toIdx] || {};
    const p = api('dj_talk', {
      persona: state.persona,
      context: {
        mode: 'between',
        prevTitle: a.title, prevArtist: a.kind === 'podcast' ? a.showName : a.artist,
        nextTitle: b.title, nextArtist: b.kind === 'podcast' ? b.showName : b.artist,
        nextAi: !!b.aiGenerated
      }
    });
    p.catch(() => {});
    return p;
  }

  /** 次の曲が終わったときにDJが入る予定なら、台本と音声を先に作っておく */
  function maybePrefetchDj() {
    if (!state.autoDj || state.plannedNext == null || state.loop === 'one') return;
    if ((state.playedCount + 1) % CONFIG.DJ_EVERY_N_TRACKS !== 0) return;
    if (state.djPrefetch && state.djPrefetch.fromIdx === state.idx && state.djPrefetch.toIdx === state.plannedNext) return;
    state.djPrefetch = { fromIdx: state.idx, toIdx: state.plannedNext, promise: requestBetweenTalk(state.idx, state.plannedNext) };
  }

  async function performDj(promise, overMusic) {
    if (state.djBusy) return;
    state.djBusy = true;
    setOnAir(true);
    const p = personaById(state.persona);
    showCaption(p, 'トークを準備しています…', true);
    $('#btnCallDj').disabled = true;
    try {
      const r = await promise;
      const buf = await audioToBuffer(r.audio);
      showCaption(personaById(r.persona), r.text, false);
      setLcd(`${personaById(r.persona).name} ON AIR`);
      if (overMusic) duck(true);
      await playJingle();
      await playVoiceBuffer(buf);
      await sleep(350);
    } catch (e) {
      showCaption(p, 'トークを用意できませんでした：' + e.message, true);
      toast('AI DJ：' + e.message, true);
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
    if (state.djBusy) { toast('DJ がしゃべっている最中です'); return; }
    const cur = state.queue[state.idx];
    const ctxInfo = state.playing && cur ? { mode: 'nowplaying', nowTitle: cur.title } : { mode: 'opening' };
    const p = api('dj_talk', { persona: state.persona, context: ctxInfo });
    performDj(p, state.playing);
  }

  async function startRadio() {
    unlockMedia();
    const songs = state.tracks.filter((t) => t.kind === 'song');
    if (!songs.length) {
      toast('まずは曲を登録しましょう');
      openAddTrack('song');
      return;
    }
    const start = state.shuffle ? Math.floor(Math.random() * songs.length) : 0;
    state.queue = songs;
    state.playedCount = 0;
    state.djPrefetch = null;
    if (state.autoDj && !state.djBusy) {
      await performDj(api('dj_talk', { persona: state.persona, context: { mode: 'opening' } }), false);
    }
    loadTrack(start);
  }

  function bindDj() {
    renderPersonas();
    $('#personaList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-persona]');
      if (!b) return;
      state.persona = b.dataset.persona;
      state.djPrefetch = null;
      renderPersonas();
      savePrefs();
      maybePrefetchDj();
    });
    const auto = $('#autoDj');
    auto.checked = state.autoDj;
    auto.addEventListener('change', () => {
      state.autoDj = auto.checked;
      savePrefs();
      if (state.autoDj) maybePrefetchDj(); else state.djPrefetch = null;
    });
    $('#djEveryN').textContent = CONFIG.DJ_EVERY_N_TRACKS;

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
  }

  /* =========================================================
   *  ライブラリ（楽曲・ポッドキャスト）
   * ========================================================= */
  async function loadTracks() {
    try {
      const d = await api('tracks_list');
      state.tracks = d.tracks || [];
    } catch (e) {
      toast(e.message, true);
    }
    renderSongs();
    renderPodcasts();
  }

  const canDelete = (t) => state.user && (t.ownerId === state.user.userId || state.user.role === 'admin');

  function trackItemHtml(t, listName, i) {
    const sub = t.kind === 'podcast'
      ? `${esc(t.ownerName || '')} さんが登録`
      : `${esc(trackSubtitle(t))}（${esc(t.ownerName || '')} さんが登録）`;
    return `
      <li class="track" data-track-id="${esc(t.id)}">
        <button class="track-cover" style="background:${coverBg(t.title)}" data-play="${listName}" data-i="${i}" aria-label="「${esc(t.title)}」を再生"><span class="play-ico">▶</span></button>
        <div class="track-main">
          <div class="track-title">${t.source === 'youtube' ? '📺 ' : ''}${esc(t.title)}</div>
          <div class="track-meta">${sub}</div>
          ${t.kind === 'podcast' && t.description ? `<p class="ep-desc">${esc(t.description)}</p>` : ''}
        </div>
        <div class="track-actions">
          <button class="icon-btn" data-next="${esc(t.id)}" title="次に再生" aria-label="次に再生">＋</button>
          ${canDelete(t) ? `<button class="icon-btn" data-del="${esc(t.id)}" title="削除" aria-label="削除">🗑</button>` : ''}
        </div>
      </li>`;
  }

  const lists = { songs: [], shows: {} };

  function renderSongs() {
    let songs = state.tracks.filter((t) => t.kind === 'song');
    const f = state.songFilter;
    if (f === 'ai') songs = songs.filter((t) => t.aiGenerated);
    if (f === 'youtube') songs = songs.filter((t) => t.source === 'youtube');
    if (f === 'mine') songs = songs.filter((t) => state.user && t.ownerId === state.user.userId);
    lists.songs = songs;
    $('#songList').innerHTML = songs.length
      ? songs.map((t, i) => trackItemHtml(t, 'songs', i)).join('')
      : '<li class="empty">まだ曲がありません。「＋ 曲を追加」から登録できます</li>';
    markCurrentInLists();
  }

  function renderPodcasts() {
    const eps = state.tracks.filter((t) => t.kind === 'podcast');
    const shows = {};
    eps.forEach((t) => { const k = t.showName || '番組名なし'; (shows[k] = shows[k] || []).push(t); });
    lists.shows = shows;
    const names = Object.keys(shows);
    $('#podcastShows').innerHTML = names.length
      ? names.map((name, si) => `
        <article class="show">
          <div class="show-head">
            <div class="show-art" style="background:hsl(${hue(name)} 85% 62%)">${esc(initial(name))}</div>
            <div><h3 class="show-name">${esc(name)}</h3><span class="show-count">${shows[name].length} エピソード</span></div>
          </div>
          <ul class="track-list">${shows[name].map((t, i) => trackItemHtml(t, 'show:' + si, i)).join('')}</ul>
        </article>`).join('')
      : '<p class="empty">ポッドキャストはまだありません。「＋ エピソードを登録」から追加できます</p>';
    markCurrentInLists();
  }

  function listByName(name) {
    if (name === 'songs') return lists.songs;
    const si = Number(name.split(':')[1]);
    return lists.shows[Object.keys(lists.shows)[si]] || [];
  }

  function markCurrentInLists() {
    const cur = state.queue[state.idx];
    $$('.track').forEach((li) => li.classList.toggle('is-current', !!cur && li.dataset.trackId === cur.id));
  }

  function addNext(id) {
    const t = state.tracks.find((x) => x.id === id);
    if (!t) return;
    if (state.idx < 0) { playList([t], 0); return; }
    state.queue.splice(state.idx + 1, 0, t);
    state.plannedNext = state.idx + 1;
    state.djPrefetch = null;
    renderQueue();
    maybePrefetchDj();
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
      if (play) { playList(listByName(play.dataset.play), Number(play.dataset.i)); return; }
      const nx = e.target.closest('[data-next]');
      if (nx) { unlockMedia(); addNext(nx.dataset.next); return; }
      const del = e.target.closest('[data-del]');
      if (del) { deleteTrack(del.dataset.del); return; }
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
    openModal('modalAddTrack');
  }

  async function submitAddTrack(e) {
    e.preventDefault();
    const f = e.target;
    const src = f.source.value;
    const payload = {
      kind: addKind,
      title: f.title.value.trim(),
      artist: f.artist.value.trim(),
      showName: f.showName.value.trim(),
      description: f.description.value.trim(),
      aiGenerated: addKind === 'song' && f.aiGenerated.checked
    };
    if (src === 'upload') {
      const file = f.file.files[0];
      if (!file) { toast('音声ファイルを選んでください', true); return; }
      if (!file.type.startsWith('audio/')) { toast('音声ファイルを選んでください', true); return; }
      if (file.size > CONFIG.MAX_UPLOAD_MB * 1024 * 1024) { toast(`ファイルが大きすぎます（${CONFIG.MAX_UPLOAD_MB}MBまで）`, true); return; }
      payload.source = 'drive';
      payload.mimeType = file.type;
      payload.fileName = file.name;
      if (!payload.title) payload.title = file.name.replace(/\.[^.]+$/, '');
    } else {
      const url = f.url.value.trim();
      if (!url) { toast('URL を入力してください', true); return; }
      payload.source = src === 'drivelink' ? 'drive' : src;
      payload.url = url;
    }
    if (!payload.title) { toast('タイトルを入力してください', true); return; }

    await withBusy($('#atSubmit'), src === 'upload' ? 'アップロード中…' : '登録中…', async () => {
      try {
        if (src === 'upload') payload.fileBase64 = await blobToBase64(f.file.files[0]);
        const d = await api('track_add', payload);
        toast(d.message);
        closeModal('modalAddTrack');
        await loadTracks();
      } catch (err) { toast(err.message, true); }
    });
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
  function showView(name) {
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
    $$('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'rooms' && !state.room) loadRooms();
    window.scrollTo({ top: 0 });
  }

  function openModal(id) {
    const m = document.getElementById(id);
    m.hidden = false;
    const first = m.querySelector('input:not([type=hidden]), select, textarea');
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
    bindRooms();
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
