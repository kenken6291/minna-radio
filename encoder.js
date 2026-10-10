/**
 * NEON WAVE RADIO - encoder.js  v1.1.0
 * ブラウザ内で音声ファイルを書き出すエンコーダー（サーバー不要）
 *   WAV  : 非圧縮 PCM（16/24bit）
 *   AIFF : 非圧縮 PCM（16/24bit・ビッグエンディアン）
 *   FLAC : 可逆圧縮（固定予測 + ライス符号、ステレオ相関除去つき）
 *   ALAC : Apple Lossless（.m4a コンテナ、16bit）
 *   MP3  : lamejs（cdnjs から初回のみ読み込み）
 *
 * 使い方：
 *   const blob = await NWRExport.encode('flac', { channels:[Float32Array,…], sampleRate:44100, bitDepth:16,
 *                                                 bitrate:192, tags:{ title, artist } }, (p) => {});
 */
(function (root) {
  'use strict';

  const LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';

  const FORMATS = {
    mp3:  { label: 'MP3（圧縮・どこでも再生）', ext: 'mp3', mime: 'audio/mpeg', bitDepths: [], bitrates: [128, 192, 256, 320] },
    wav:  { label: 'WAV（非圧縮）', ext: 'wav', mime: 'audio/wav', bitDepths: [16, 24] },
    flac: { label: 'FLAC（可逆圧縮・高音質）', ext: 'flac', mime: 'audio/flac', bitDepths: [16, 24] },
    alac: { label: 'ALAC（Apple ロスレス・.m4a）', ext: 'm4a', mime: 'audio/mp4', bitDepths: [16] },
    aiff: { label: 'AIFF（非圧縮・Mac 向け）', ext: 'aiff', mime: 'audio/aiff', bitDepths: [16, 24] }
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /* ---------------------------------------------------------
   *  Float32 → 整数サンプル
   * --------------------------------------------------------- */
  function toInt(ch, bits) {
    const pos = Math.pow(2, bits - 1) - 1, neg = Math.pow(2, bits - 1);
    const out = new Int32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      let v = ch[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[i] = Math.round(v < 0 ? v * neg : v * pos);
    }
    return out;
  }

  /* ---------------------------------------------------------
   *  WAV
   * --------------------------------------------------------- */
  async function encodeWav(o, progress) {
    const nch = o.channels.length, n = o.channels[0].length, bits = o.bitDepth === 24 ? 24 : 16;
    const bps = bits / 8, dataLen = n * nch * bps;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
    v.setUint32(24, o.sampleRate, true); v.setUint32(28, o.sampleRate * nch * bps, true);
    v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
    ws(36, 'data'); v.setUint32(40, dataLen, true);
    const ints = o.channels.map((c) => toInt(c, bits));
    const u8 = new Uint8Array(buf);
    let p = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const s = ints[c][i];
        u8[p++] = s & 255; u8[p++] = (s >> 8) & 255;
        if (bits === 24) u8[p++] = (s >> 16) & 255;
      }
      if ((i & 0x3ffff) === 0 && i) { progress(i / n); await tick(); }
    }
    progress(1);
    return new Blob([buf], { type: FORMATS.wav.mime });
  }

  /* ---------------------------------------------------------
   *  AIFF
   * --------------------------------------------------------- */
  function ext80(rate) {
    const out = new Uint8Array(10);
    const e = Math.floor(Math.log2(rate));
    const exp = 16383 + e;
    out[0] = (exp >> 8) & 0x7f; out[1] = exp & 255;
    const hi = Math.floor(rate * Math.pow(2, 31 - e)) >>> 0;
    out[2] = hi >>> 24; out[3] = (hi >>> 16) & 255; out[4] = (hi >>> 8) & 255; out[5] = hi & 255;
    return out;
  }

  async function encodeAiff(o, progress) {
    const nch = o.channels.length, n = o.channels[0].length, bits = o.bitDepth === 24 ? 24 : 16;
    const bps = bits / 8, dataLen = n * nch * bps;
    const total = 12 + 26 + 16 + dataLen;
    const buf = new ArrayBuffer(total);
    const v = new DataView(buf), u8 = new Uint8Array(buf);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'FORM'); v.setUint32(4, total - 8); ws(8, 'AIFF');
    ws(12, 'COMM'); v.setUint32(16, 18); v.setUint16(20, nch); v.setUint32(22, n); v.setUint16(26, bits);
    u8.set(ext80(o.sampleRate), 28);
    ws(38, 'SSND'); v.setUint32(42, 8 + dataLen); v.setUint32(46, 0); v.setUint32(50, 0);
    const ints = o.channels.map((c) => toInt(c, bits));
    let p = 54;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const s = ints[c][i];
        if (bits === 24) u8[p++] = (s >> 16) & 255;
        u8[p++] = (s >> 8) & 255; u8[p++] = s & 255;
      }
      if ((i & 0x3ffff) === 0 && i) { progress(i / n); await tick(); }
    }
    progress(1);
    return new Blob([buf], { type: FORMATS.aiff.mime });
  }

  /* ---------------------------------------------------------
   *  ビットライター（MSB から）
   * --------------------------------------------------------- */
  class BitWriter {
    constructor(cap) { this.buf = new Uint8Array(cap || 1 << 16); this.pos = 0; this.acc = 0; this.n = 0; }
    grow(k) {
      if (this.pos + k <= this.buf.length) return;
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + k + 1024));
      nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb;
    }
    write(v, bits) {
      if (bits <= 0) return;
      if (bits > 24) {
        const hi = Math.floor(v / 16777216);
        this.write(hi, bits - 24);
        this.write(v - hi * 16777216, 24);
        return;
      }
      this.grow(4);
      this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
      this.n += bits;
      while (this.n >= 8) {
        this.n -= 8;
        this.buf[this.pos++] = (this.acc >>> this.n) & 255;
      }
      this.acc &= (1 << this.n) - 1;
    }
    writeSigned(v, bits) { this.write(v < 0 ? v + Math.pow(2, bits) : v, bits); }
    writeUnary(q) { while (q >= 24) { this.write(0, 24); q -= 24; } this.write(1, q + 1); }
    align() { if (this.n) this.write(0, 8 - this.n); }
    bytes() { return this.buf.subarray(0, this.pos); }
  }

  /* ---------------------------------------------------------
   *  FLAC
   * --------------------------------------------------------- */
  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  (function () {
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255;
      CRC8[i] = c;
      let d = i << 8;
      for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
      CRC16[i] = d;
    }
  })();
  const crc8 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
  const crc16 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

  const FLAC_BLOCK = 4096;
  const RATE_CODE = { 88200: 3, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
  const SIZE_CODE = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 };

  /** 固定予測の残差（order 0〜4） */
  function residual(x, n, order, out) {
    switch (order) {
      case 0: for (let i = 0; i < n; i++) out[i] = x[i]; break;
      case 1: for (let i = 1; i < n; i++) out[i] = x[i] - x[i - 1]; break;
      case 2: for (let i = 2; i < n; i++) out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: for (let i = 3; i < n; i++) out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: for (let i = 4; i < n; i++) out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }

  /** 1チャンネル分の最適な符号化方法を決める */
  function planSubframe(x, n, bps, work) {
    let constant = true;
    for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
    if (constant) return { type: 'const', bits: 8 + bps };
    const verbatim = { type: 'verbatim', bits: 8 + n * bps };
    if (n < 5) return verbatim;

    // 予測次数：残差の絶対値和が最小のもの
    let best = 0, bestSum = Infinity;
    for (let o = 0; o <= 4; o++) {
      residual(x, n, o, work);
      let s = 0;
      for (let i = 4; i < n; i++) s += Math.abs(work[i]);
      if (s < bestSum) { bestSum = s; best = o; }
    }
    const order = best;
    residual(x, n, order, work);
    const u = new Float64Array(n);
    for (let i = order; i < n; i++) { const r = work[i]; u[i] = r >= 0 ? r * 2 : -r * 2 - 1; }

    // パーティション分割とライスパラメーター
    let maxP = 0;
    while (maxP < 8 && n % (1 << (maxP + 1)) === 0 && (n >> (maxP + 1)) > order) maxP++;
    let plan = null;
    for (let p = 0; p <= maxP; p++) {
      const parts = 1 << p, len = n >> p;
      const ks = [];
      let bits = 0, needWide = false;
      for (let k = 0; k < parts; k++) {
        const s = k === 0 ? order : k * len, e = (k + 1) * len;
        let sum = 0;
        for (let i = s; i < e; i++) sum += u[i];
        const cnt = e - s;
        let bk = 0, bb = Infinity;
        for (let r = 0; r <= 30; r++) {
          const b = cnt * (r + 1) + Math.floor(sum / Math.pow(2, r));
          if (b < bb) { bb = b; bk = r; }
          if (Math.pow(2, r) > sum) break;
        }
        if (bk > 14) needWide = true;
        ks.push(bk);
        bits += bb;
      }
      bits += parts * (needWide ? 5 : 4);
      if (!plan || bits < plan.rbits) plan = { p, ks, rbits: bits, wide: needWide };
    }
    const total = 8 + order * bps + 2 + 4 + plan.rbits;
    if (total >= verbatim.bits) return verbatim;
    return { type: 'fixed', order, u, p: plan.p, ks: plan.ks, wide: plan.wide, bits: total };
  }

  function writeSubframe(bw, x, n, bps, plan) {
    if (plan.type === 'const') { bw.write(0, 8); bw.writeSigned(x[0], bps); return; }
    if (plan.type === 'verbatim') {
      bw.write(0b00000010, 8);
      for (let i = 0; i < n; i++) bw.writeSigned(x[i], bps);
      return;
    }
    bw.write((0b001000 | plan.order) << 1, 8);
    for (let i = 0; i < plan.order; i++) bw.writeSigned(x[i], bps);
    bw.write(plan.wide ? 1 : 0, 2);
    bw.write(plan.p, 4);
    const parts = 1 << plan.p, len = n >> plan.p, pb = plan.wide ? 5 : 4;
    for (let k = 0; k < parts; k++) {
      const kk = plan.ks[k];
      bw.write(kk, pb);
      const s = k === 0 ? plan.order : k * len, e = (k + 1) * len;
      const div = Math.pow(2, kk), mask = (1 << kk) - 1;
      for (let i = s; i < e; i++) {
        const u = plan.u[i];
        const q = Math.floor(u / div);
        bw.writeUnary(q);
        if (kk) bw.write((u - q * div) & mask, kk);
      }
    }
  }

  function writeUtf8Num(bw, v) {
    if (v < 0x80) { bw.write(v, 8); return; }
    const n = v < 0x800 ? 1 : v < 0x10000 ? 2 : v < 0x200000 ? 3 : v < 0x4000000 ? 4 : 5;
    const lead = (0xff << (7 - n)) & 0xff;
    bw.write(lead | Math.floor(v / Math.pow(2, 6 * n)), 8);
    for (let i = n - 1; i >= 0; i--) bw.write((Math.floor(v / Math.pow(2, 6 * i)) & 0x3f) | 0x80, 8);
  }

  async function encodeFlac(o, progress) {
    const nch = o.channels.length, n = o.channels[0].length, bps = o.bitDepth === 24 ? 24 : 16;
    const ints = o.channels.map((c) => toInt(c, bps));
    const frames = [];
    const work = new Float64Array(FLAC_BLOCK);
    let minF = Infinity, maxF = 0;

    for (let start = 0, fno = 0; start < n; start += FLAC_BLOCK, fno++) {
      const bs = Math.min(FLAC_BLOCK, n - start);
      const ch = ints.map((c) => c.subarray(start, start + bs));
      let assign, subs;
      if (nch === 2) {
        const L = ch[0], R = ch[1];
        const S = new Int32Array(bs), M = new Int32Array(bs);
        for (let i = 0; i < bs; i++) { S[i] = L[i] - R[i]; M[i] = (L[i] + R[i]) >> 1; }
        const pL = planSubframe(L, bs, bps, work), pR = planSubframe(R, bs, bps, work);
        const pS = planSubframe(S, bs, bps + 1, work), pM = planSubframe(M, bs, bps, work);
        const opts = [
          { a: 1, bits: pL.bits + pR.bits, s: [[L, bps, pL], [R, bps, pR]] },
          { a: 8, bits: pL.bits + pS.bits, s: [[L, bps, pL], [S, bps + 1, pS]] },
          { a: 9, bits: pS.bits + pR.bits, s: [[S, bps + 1, pS], [R, bps, pR]] },
          { a: 10, bits: pM.bits + pS.bits, s: [[M, bps, pM], [S, bps + 1, pS]] }
        ].sort((a, b) => a.bits - b.bits);
        assign = opts[0].a;
        subs = opts[0].s;
      } else {
        assign = nch - 1;
        subs = ch.map((x) => [x, bps, planSubframe(x, bs, bps, work)]);
      }

      const bw = new BitWriter(bs * nch * 4 + 64);
      bw.write(0b11111111111110, 14); bw.write(0, 1); bw.write(0, 1);
      bw.write(7, 4);                                   // ブロックサイズ：ヘッダー末尾に16bit
      bw.write(RATE_CODE[o.sampleRate] || 0, 4);
      bw.write(assign, 4);
      bw.write(SIZE_CODE[bps], 3); bw.write(0, 1);
      writeUtf8Num(bw, fno);
      bw.write(bs - 1, 16);
      const hb = bw.bytes();
      bw.write(crc8(hb, 0, hb.length), 8);
      subs.forEach(([x, b, plan]) => writeSubframe(bw, x, bs, b, plan));
      bw.align();
      const fb = bw.bytes();
      bw.write(crc16(fb, 0, fb.length), 16);
      const frame = bw.bytes().slice();
      frames.push(frame);
      minF = Math.min(minF, frame.length); maxF = Math.max(maxF, frame.length);
      if (fno % 8 === 7) { progress(start / n); await tick(); }
    }

    // メタデータ
    const head = new BitWriter(256);
    head.write(0x664c6143, 32);                         // "fLaC"
    const tags = [];
    if (o.tags && o.tags.title) tags.push('TITLE=' + o.tags.title);
    if (o.tags && o.tags.artist) tags.push('ARTIST=' + o.tags.artist);
    tags.push('ENCODER=NEON WAVE RADIO');
    head.write(0, 1); head.write(0, 7); head.write(34, 24);
    head.write(FLAC_BLOCK, 16); head.write(FLAC_BLOCK, 16);
    head.write(frames.length ? minF : 0, 24); head.write(maxF, 24);
    head.write(o.sampleRate, 20); head.write(nch - 1, 3); head.write(bps - 1, 5);
    head.write(n, 36);
    for (let i = 0; i < 4; i++) head.write(0, 32);       // MD5（未設定）
    const enc = new TextEncoder();
    const vendor = enc.encode('NEON WAVE RADIO');
    const cm = tags.map((t) => enc.encode(t));
    const le32 = (x) => [x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255];
    const vc = [...le32(vendor.length), ...vendor, ...le32(cm.length)];
    cm.forEach((c) => vc.push(...le32(c.length), ...c));
    head.write(1, 1); head.write(4, 7); head.write(vc.length, 24);
    vc.forEach((b) => head.write(b, 8));
    progress(1);
    return new Blob([head.bytes().slice(), ...frames], { type: FORMATS.flac.mime });
  }

  /* ---------------------------------------------------------
   *  ALAC（.m4a）
   *  フレームは非圧縮（エスケープ）モードで格納。完全ロスレスで
   *  iPhone / Mac / iTunes / VLC などで再生できます。
   * --------------------------------------------------------- */
  const ALAC_FRAME = 4096;

  function u32(x) { return [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]; }
  function u16(x) { return [(x >>> 8) & 255, x & 255]; }
  function str4(s) { return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]; }
  function box(type, ...parts) {
    const flat = [];
    parts.forEach((p) => { for (let i = 0; i < p.length; i++) flat.push(p[i]); });
    return [...u32(8 + flat.length), ...str4(type), ...flat];
  }
  const fullBox = (type, ver, flags, ...parts) => box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  const MATRIX = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

  async function encodeAlac(o, progress) {
    const nch = Math.min(2, o.channels.length), n = o.channels[0].length, bits = 16, rate = o.sampleRate;
    const ints = o.channels.slice(0, nch).map((c) => toInt(c, bits));
    const frames = [];
    let maxFrame = 0, totalBytes = 0;
    for (let s = 0, k = 0; s < n; s += ALAC_FRAME, k++) {
      const len = Math.min(ALAC_FRAME, n - s);
      const bw = new BitWriter(len * nch * 2 + 32);
      bw.write(nch === 2 ? 1 : 0, 3);                    // SCE / CPE
      bw.write(0, 4);                                    // element instance tag
      bw.write(0, 12);                                   // 未使用
      const partial = len !== ALAC_FRAME;
      bw.write(partial ? 1 : 0, 1);
      bw.write(0, 2);                                    // bytes shifted
      bw.write(1, 1);                                    // escape（非圧縮）
      if (partial) bw.write(len, 32);
      for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) bw.writeSigned(ints[c][s + i], 16);
      bw.write(7, 3);                                    // ID_END
      bw.align();
      const f = bw.bytes().slice();
      frames.push(f);
      maxFrame = Math.max(maxFrame, f.length);
      totalBytes += f.length;
      if (k % 32 === 31) { progress((s / n) * 0.95); await tick(); }
    }
    const dur = n;
    const avgBitrate = n ? Math.round((totalBytes * 8 * rate) / n) : 0;

    const cookie = [
      ...u32(ALAC_FRAME), 0, bits, 40, 10, 14, nch, ...u16(255), ...u32(maxFrame), ...u32(avgBitrate), ...u32(rate)
    ];
    const sampleEntry = box('alac',
      [0, 0, 0, 0, 0, 0], u16(1), u16(0), u16(0), u32(0),
      u16(nch), u16(bits), u16(0), u16(0), u32((rate * 65536) >>> 0),
      fullBox('alac', 0, 0, cookie)
    );
    const full = Math.floor(n / ALAC_FRAME), rest = n % ALAC_FRAME;
    const sttsEntries = [];
    if (full) sttsEntries.push(...u32(full), ...u32(ALAC_FRAME));
    if (rest) sttsEntries.push(...u32(1), ...u32(rest));
    const stszBody = [...u32(0), ...u32(frames.length)];
    frames.forEach((f) => { const b = u32(f.length); stszBody.push(b[0], b[1], b[2], b[3]); });

    const buildMoov = (mdatOffset) => box('moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(rate), u32(dur), u32(0x10000), u16(0x100), new Array(10).fill(0), MATRIX, new Array(24).fill(0), u32(2)),
      box('trak',
        fullBox('tkhd', 0, 7, u32(0), u32(0), u32(1), u32(0), u32(dur), new Array(8).fill(0), u16(0), u16(0), u16(0x100), u16(0), MATRIX, u32(0), u32(0)),
        box('mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(rate), u32(dur), u16(0x55c4), u16(0)),
          fullBox('hdlr', 0, 0, u32(0), str4('soun'), new Array(12).fill(0), [...new TextEncoder().encode('SoundHandler'), 0]),
          box('minf',
            fullBox('smhd', 0, 0, u16(0), u16(0)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            box('stbl',
              fullBox('stsd', 0, 0, u32(1), sampleEntry),
              fullBox('stts', 0, 0, u32(sttsEntries.length / 8), sttsEntries),
              fullBox('stsc', 0, 0, u32(1), u32(1), u32(frames.length), u32(1)),
              fullBox('stsz', 0, 0, stszBody),
              fullBox('stco', 0, 0, u32(1), u32(mdatOffset))
            )
          )
        )
      )
    );
    const ftyp = box('ftyp', str4('M4A '), u32(0), str4('M4A '), str4('mp42'), str4('isom'));
    const moovLen = buildMoov(0).length;
    const moov = buildMoov(ftyp.length + moovLen + 8);
    const mdatHead = [...u32(8 + totalBytes), ...str4('mdat')];
    progress(1);
    return new Blob([new Uint8Array(ftyp), new Uint8Array(moov), new Uint8Array(mdatHead), ...frames], { type: FORMATS.alac.mime });
  }

  /* ---------------------------------------------------------
   *  MP3（lamejs）
   * --------------------------------------------------------- */
  let lamePromise = null;
  function loadLame() {
    if (root.lamejs) return Promise.resolve(root.lamejs);
    if (lamePromise) return lamePromise;
    lamePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LAME_URL;
      s.onload = () => (root.lamejs ? resolve(root.lamejs) : reject(new Error('MP3 エンコーダーを読み込めませんでした')));
      s.onerror = () => { lamePromise = null; reject(new Error('MP3 エンコーダーを読み込めませんでした（通信環境を確認してください）')); };
      document.head.appendChild(s);
    });
    return lamePromise;
  }

  async function encodeMp3(o, progress) {
    const lame = await loadLame();
    const nch = Math.min(2, o.channels.length), n = o.channels[0].length;
    let kbps = Number(o.bitrate) || 192;
    if (o.sampleRate < 32000) kbps = Math.min(kbps, 160);
    const enc = new lame.Mp3Encoder(nch, o.sampleRate, kbps);
    const pcm = o.channels.slice(0, nch).map((c) => {
      const out = new Int16Array(c.length);
      for (let i = 0; i < c.length; i++) {
        let v = c[i];
        if (v > 1) v = 1; else if (v < -1) v = -1;
        out[i] = v < 0 ? v * 32768 : v * 32767;
      }
      return out;
    });
    const parts = [];
    const STEP = 1152 * 32;
    for (let i = 0; i < n; i += STEP) {
      const l = pcm[0].subarray(i, i + STEP);
      const b = nch === 2 ? enc.encodeBuffer(l, pcm[1].subarray(i, i + STEP)) : enc.encodeBuffer(l);
      if (b.length) parts.push(new Uint8Array(b));
      if ((i / STEP) % 4 === 3) { progress(i / n); await tick(); }
    }
    const end = enc.flush();
    if (end.length) parts.push(new Uint8Array(end));
    progress(1);
    return new Blob(parts, { type: FORMATS.mp3.mime });
  }

  /* ---------------------------------------------------------
   *  公開API
   * --------------------------------------------------------- */
  async function encode(format, opts, onProgress) {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    if (!opts || !opts.channels || !opts.channels.length || !opts.channels[0].length) throw new Error('書き出す音声がありません');
    switch (format) {
      case 'wav': return encodeWav(opts, progress);
      case 'aiff': return encodeAiff(opts, progress);
      case 'flac': return encodeFlac(opts, progress);
      case 'alac': return encodeAlac(opts, progress);
      case 'mp3': return encodeMp3(opts, progress);
      default: throw new Error('未対応の形式です: ' + format);
    }
  }

  root.NWRExport = { FORMATS, encode, loadLame };
})(typeof window !== 'undefined' ? window : globalThis);
