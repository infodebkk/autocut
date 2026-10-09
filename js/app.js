import {
  MIN_CLIP, fitSegments, buildAuto, locate, srcTime, bgPlan, bgTimeAt,
  clipDur, newId, clamp, fmtTime,
} from './model.js';
import { renderProject, abortExport, preloadFFmpeg } from './export.js';

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'), stage: $('stage'), stageWrap: $('stageWrap'), logo: $('logoEl'),
  play: $('btnPlay'), restart: $('btnRestart'), scrub: $('scrub'), tCur: $('tCur'), tTot: $('tTot'),
  undo: $('btnUndo'), redo: $('btnRedo'), exportBtn: $('btnExport'),
  tlScroll: $('tlScroll'), tlInner: $('tlInner'), ruler: $('ruler'),
  trkVideo: $('trkVideo'), trkMain: $('trkMain'), trkBg: $('trkBg'),
  cvMain: $('cvMain'), cvBg: $('cvBg'), playhead: $('playhead'), zoom: $('zoom'),
};
const mainEl = new Audio(); mainEl.preload = 'auto';
const bgEl = new Audio(); bgEl.preload = 'auto';

/* ------------------------------------------------------------------ state */
const S = {
  files: { video: null, main: null, bg: null, logo: null },
  urls: {},
  vid: { dur: 0, w: 0, h: 0 },
  mainDur: 0, bgDur: 0,
  logoImg: null,
  peaks: { main: null, bg: null },
  editor: false, playing: false, t: 0, sel: null, pps: 20, lastSeg: null,
  ac: null, gains: null, scrubbing: false,
};

const defaultP = () => ({
  segments: [],
  pattern: 'alt',
  vol: { video: 100, main: 100, bg: 60 },
  bgLoop: { infinite: true, repeats: 1 },
  bgOn: false,
  logoOn: false,
  logo: { fx: 0.03, fy: 0.8, fw: 0.15, opacity: 1 },
});
let P = defaultP();
const hist = { undo: [], redo: [] };
let pending = null;
const snap = () => JSON.stringify(P);
const touch = () => { if (pending === null) pending = snap(); };
function commit() {
  if (pending !== null && pending !== snap()) {
    hist.undo.push(pending);
    if (hist.undo.length > 100) hist.undo.shift();
    hist.redo = [];
  }
  pending = null;
  updateUndo();
}
const updateUndo = () => { el.undo.disabled = !hist.undo.length; el.redo.disabled = !hist.redo.length; };
function undo() {
  if (!hist.undo.length) return;
  hist.redo.push(snap());
  P = JSON.parse(hist.undo.pop());
  pending = null; updateUndo(); renderAll();
}
function redo() {
  if (!hist.redo.length) return;
  hist.undo.push(snap());
  P = JSON.parse(hist.redo.pop());
  pending = null; updateUndo(); renderAll();
}

/* ---------------------------------------------------------------- helpers */
function toast(msg, isErr = false, ms = 4200) {
  const d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), ms);
}
function busy(msg) { $('busyMsg').textContent = msg || ''; $('busy').classList.toggle('hidden', !msg); }
function once(target, okEv, badEv = 'error') {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error('media error')); };
    const cleanup = () => { target.removeEventListener(okEv, ok); target.removeEventListener(badEv, bad); };
    target.addEventListener(okEv, ok); target.addEventListener(badEv, bad);
  });
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function aspectText(w, h) {
  const g = gcd(w, h), a = w / g, b = h / g;
  return a <= 50 && b <= 50 ? `${a}:${b}` : (w / h).toFixed(3);
}
function revoke(kind) { if (S.urls[kind]) { URL.revokeObjectURL(S.urls[kind]); S.urls[kind] = null; } }
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');

function setMeta(kind, html, err = false) {
  const m = $('meta-' + kind);
  m.innerHTML = html;
  m.classList.toggle('err', err);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------ audio graph */
function getAC() {
  if (!S.ac) { const C = window.AudioContext || window.webkitAudioContext; S.ac = new C(); }
  return S.ac;
}
function ensureGraph() {
  if (S.gains) return;
  try {
    const ac = getAC();
    S.gains = {};
    for (const [k, node] of [['video', el.video], ['main', mainEl], ['bg', bgEl]]) {
      const src = ac.createMediaElementSource(node);
      const g = ac.createGain();
      src.connect(g); g.connect(ac.destination);
      S.gains[k] = g;
    }
  } catch (e) { console.warn('WebAudio graph failed, using element volume', e); S.gains = null; }
  applyGains();
}
function applyGains() {
  const v = P.vol.video / 100, m = P.vol.main / 100, b = (P.bgOn && S.files.bg) ? P.vol.bg / 100 : 0;
  if (S.gains) { S.gains.video.gain.value = v; S.gains.main.gain.value = m; S.gains.bg.gain.value = b; }
  else { el.video.volume = v; mainEl.volume = m; bgEl.volume = b; }
}

const AUDIO_MIME = { aac: 'audio/aac', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' };
function audioBlob(file) {
  if (file.type && file.type.startsWith('audio/')) return file;
  const m = /\.([a-z0-9]+)$/i.exec(file.name || '');
  const t = m && AUDIO_MIME[m[1].toLowerCase()];
  return t ? new Blob([file], { type: t }) : file;
}

function bufToWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, data[c][i]));
    out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

async function decodePeaks(file, buckets = 3000) {
  const ac = getAC();
  const buf = await ac.decodeAudioData(await file.arrayBuffer());
  const ch = buf.getChannelData(0), n = ch.length;
  const per = Math.max(1, Math.floor(n / buckets));
  const step = Math.max(1, per >> 6);
  const out = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let m = 0;
    for (let j = i * per, e = Math.min(n, j + per); j < e; j += step) { const a = Math.abs(ch[j]); if (a > m) m = a; }
    out[i] = m;
  }
  return { peaks: out, duration: buf.duration, buf };
}

/* ------------------------------------------------------------ file loading */
async function loadVideo(file) {
  revoke('video');
  const url = URL.createObjectURL(file);
  S.urls.video = url;
  el.video.src = url;
  await once(el.video, 'loadedmetadata');
  let dur = el.video.duration;
  if (!isFinite(dur)) { el.video.currentTime = 1e7; await once(el.video, 'timeupdate', 'error'); dur = el.video.duration; el.video.currentTime = 0; }
  const w = el.video.videoWidth, h = el.video.videoHeight;
  if (!w || !h || !isFinite(dur) || dur <= 0) throw new Error('ভিডিও পড়া যায়নি');
  S.files.video = file;
  S.vid = { dur, w, h };
  setMeta('video', `<span class="name">${esc(file.name)}</span><br>${fmtTime(dur)} · ${w}×${h} · ${aspectText(w, h)} · ${fmtSize(file.size)}`);
}

async function loadAudio(kind, file) {
  const node = kind === 'main' ? mainEl : bgEl;
  revoke(kind);
  const url = URL.createObjectURL(audioBlob(file));
  S.urls[kind] = url;
  node.src = url;
  let nativeOk = true;
  try { await once(node, 'loadedmetadata'); } catch { nativeOk = false; }
  let dur = nativeOk ? node.duration : NaN;
  S.peaks[kind] = null;
  const dec = decodePeaks(file).then((r) => {
    S.peaks[kind] = r.peaks;
    return r;
  }).catch(() => null);
  if (!nativeOk || !isFinite(dur) || dur <= 0) {
    // raw .aac (ADTS) প্রায়ই duration দেয় না / কিছু ব্রাউজার চালাতে পারে না → ডিকোড করে WAV প্রিভিউ বানাই
    const r = await dec;
    if (!r) throw new Error('অডিও পড়া যায়নি');
    dur = r.duration;
    if (!nativeOk || !isFinite(node.duration)) {
      revoke(kind);
      S.urls[kind] = URL.createObjectURL(bufToWav(r.buf));
      node.src = S.urls[kind];
      await once(node, 'loadedmetadata').catch(() => {});
    }
  } else {
    dec.then(() => { if (S.editor) renderWaves(); });
  }
  S.files[kind] = file;
  if (kind === 'main') S.mainDur = dur; else S.bgDur = dur;
  setMeta(kind, `<span class="name">${esc(file.name)}</span><br>${fmtTime(dur)} · ${fmtSize(file.size)}`);
}

async function loadLogo(file) {
  revoke('logo');
  const url = URL.createObjectURL(file);
  S.urls.logo = url;
  const img = new Image();
  img.src = url;
  await img.decode();
  if (!img.naturalWidth) throw new Error('ইমেজ পড়া যায়নি');
  S.files.logo = file; S.logoImg = img;
  el.logo.src = url;
  setMeta('logo', `<span class="name">${esc(file.name)}</span><br>${img.naturalWidth}×${img.naturalHeight} · ${fmtSize(file.size)}`);
}

async function handleFile(kind, file) {
  if (!file) return;
  const labels = { video: 'ভিডিও', main: 'মেইন অডিও', bg: 'ব্যাকগ্রাউন্ড অডিও', logo: 'লোগো' };
  const wasEditor = S.editor;
  busy(`${labels[kind]} লোড হচ্ছে…`);
  try {
    if (kind === 'video') await loadVideo(file);
    else if (kind === 'main') await loadAudio('main', file);
    else if (kind === 'bg') await loadAudio('bg', file);
    else await loadLogo(file);
  } catch (e) {
    setMeta(kind, 'এই ফাইলটি ব্রাউজারে খোলা যায়নি। অন্য ফরম্যাট চেষ্টা করুন।', true);
    toast(`${labels[kind]}: ফাইল পড়া যায়নি`, true);
    busy(''); return;
  }
  busy('');

  if (kind === 'bg') {
    touch(); P.bgOn = true; commit();
  } else if (kind === 'logo') {
    touch(); P.logoOn = true; P.logo.fw = 0.15; P.logo.opacity = 1; resetLogoPos(); commit();
  }
  if (wasEditor) {
    if (kind === 'video') { rebuild(); if (S.files.logo && P.logoOn) resetLogoPos(); clearHistory(); fitStage(); S.t = 0; seek(0); }
    else if (kind === 'main') { refit(); S.t = Math.min(S.t, S.mainDur); }
    renderAll();
  } else {
    refreshCards();
    if (S.files.video && S.files.main) enterEditor();
  }
  refreshCards();
}

function removeOptional(kind) {
  touch();
  if (kind === 'bg') { P.bgOn = false; bgEl.pause(); setMeta('bg', ''); }
  else { P.logoOn = false; setMeta('logo', ''); }
  commit();
  renderAll();
}

function refreshCards() {
  const has = { video: !!S.files.video, main: !!S.files.main, bg: !!(S.files.bg && P.bgOn), logo: !!(S.files.logo && P.logoOn) };
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('ok', has[c.dataset.kind]));
  for (const k of ['bg', 'logo']) {
    document.querySelector(`[data-remove="${k}"]`).classList.toggle('hidden', !has[k]);
    if (!S.files[k]) setMeta(k, '');
    else if (!has[k]) setMeta(k, '<span class="name">সরানো হয়েছে</span> (Undo করলে ফিরবে)');
  }
  if (has.bg) setMeta('bg', `<span class="name">${esc(S.files.bg.name)}</span><br>${fmtTime(S.bgDur)} · ${fmtSize(S.files.bg.size)}`);
  if (has.logo) setMeta('logo', `<span class="name">${esc(S.files.logo.name)}</span><br>${S.logoImg.naturalWidth}×${S.logoImg.naturalHeight} · ${fmtSize(S.files.logo.size)}`);
}

/* ---------------------------------------------------------- editor control */
function clearHistory() { hist.undo = []; hist.redo = []; pending = null; updateUndo(); }
const refit = () => { P.segments = fitSegments(P.segments, S.mainDur, S.vid.dur, P.pattern); };
function rebuild() { P.segments = buildAuto(S.vid.dur, S.mainDur, P.pattern); S.sel = null; }

function enterEditor() {
  S.editor = true;
  document.body.classList.replace('mode-upload', 'mode-editor');
  if (!P.logoOn) P.logoOn = false;
  if (S.files.logo && P.logoOn) resetLogoPos();
  rebuild();
  clearHistory();
  S.t = 0;
  mainEl.currentTime = 0;
  fitStage();
  fitZoom();
  renderAll();
  seek(0);
  requestAnimationFrame(frame);
  toast('ভিডিও অটো তৈরি হয়েছে। প্রিভিউ চালিয়ে দেখুন।');
  preloadFFmpeg((m) => { $('btnExport').title = m; });
}

function renderAll() {
  if (!S.editor) return;
  S.sel = P.segments.some((s) => s.id === S.sel) ? S.sel : null;
  syncControls();
  renderTimeline();
  updateClipBar();
  updateStats();
  layoutLogo();
  applyGains();
  el.tTot.textContent = fmtTime(S.mainDur);
  sync(true);
  refreshCards();
}

function syncControls() {
  $('vVideo').value = P.vol.video; $('oVideo').textContent = P.vol.video + '%';
  $('vMain').value = P.vol.main; $('oMain').textContent = P.vol.main + '%';
  $('vBg').value = P.vol.bg; $('oBg').textContent = P.vol.bg + '%';
  const bgOn = !!(S.files.bg && P.bgOn);
  $('vBg').closest('.slider').classList.toggle('off', !bgOn);
  $('bgLoopBox').classList.toggle('off', !bgOn);
  $('bgInf').checked = P.bgLoop.infinite;
  $('bgRep').disabled = P.bgLoop.infinite;
  $('bgRep').value = P.bgLoop.repeats;
  if (bgOn) {
    const pl = bgPlan(S.bgDur, S.mainDur, P.bgLoop.infinite, P.bgLoop.repeats);
    $('bgNote').textContent = S.bgDur > S.mainDur + 0.01
      ? `ব্যাকগ্রাউন্ড মেইন অডিওর চেয়ে বড় — শেষ অংশ কেটে দেওয়া হবে।`
      : `ব্যাকগ্রাউন্ড ${pl.plays} বার চলবে${pl.activeUntil < S.mainDur - 0.01 ? '; তারপর নীরব' : ''}।`;
  } else $('bgNote').textContent = 'ব্যাকগ্রাউন্ড অডিও নেই।';
  const logoOn = !!(S.files.logo && P.logoOn);
  $('logoCtl').classList.toggle('off', !logoOn);
  $('lSize').value = Math.round(P.logo.fw * 100); $('oSize').textContent = Math.round(P.logo.fw * 100) + '%';
  $('lOpac').value = Math.round(P.logo.opacity * 100); $('oOpac').textContent = Math.round(P.logo.opacity * 100) + '%';
  $('loopPattern').value = P.pattern;
}

function updateStats() {
  const nN = P.segments.filter((s) => s.mode === 'normal').length;
  const nR = P.segments.length - nN;
  const total = P.segments.reduce((a, s) => a + clipDur(s), 0);
  const rows = [
    ['ভিডিও', `${fmtTime(S.vid.dur)} · ${S.vid.w}×${S.vid.h}`],
    ['রেশিও', aspectText(S.vid.w, S.vid.h)],
    ['মেইন অডিও', fmtTime(S.mainDur)],
    ['চূড়ান্ত দৈর্ঘ্য', fmtTime(total)],
    ['ক্লিপ', `${P.segments.length} (▶${nN} ◀${nR})`],
  ];
  $('projStats').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
}

/* ------------------------------------------------------------------ stage */
function fitStage() {
  if (!S.vid.w) return;
  const r = el.stageWrap.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const k = Math.min(r.width / S.vid.w, r.height / S.vid.h);
  el.stage.style.width = Math.floor(S.vid.w * k) + 'px';
  el.stage.style.height = Math.floor(S.vid.h * k) + 'px';
}
new ResizeObserver(() => { fitStage(); }).observe(el.stageWrap);

/* ------------------------------------------------------------------- logo */
function logoHeightFrac() {
  if (!S.logoImg || !S.vid.w) return 0.1;
  return (P.logo.fw * S.vid.w * S.logoImg.naturalHeight / S.logoImg.naturalWidth) / S.vid.h;
}
function resetLogoPos() {
  const m = 0.03; // margin = 3% of width / height, so it scales with any resolution
  P.logo.fx = clamp(m, 0, Math.max(0, 1 - P.logo.fw));
  P.logo.fy = clamp(1 - m - logoHeightFrac(), 0, 1);
}
function layoutLogo() {
  const on = !!(S.files.logo && P.logoOn);
  el.logo.classList.toggle('hidden', !on);
  if (!on) return;
  el.logo.style.left = (P.logo.fx * 100) + '%';
  el.logo.style.top = (P.logo.fy * 100) + '%';
  el.logo.style.width = (P.logo.fw * 100) + '%';
  el.logo.style.opacity = P.logo.opacity;
}
el.logo.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  el.logo.setPointerCapture(e.pointerId);
  el.logo.classList.add('drag');
  touch();
  const r = el.stage.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY, fx0 = P.logo.fx, fy0 = P.logo.fy;
  const hf = el.logo.offsetHeight / r.height;
  const mv = (ev) => {
    P.logo.fx = clamp(fx0 + (ev.clientX - sx) / r.width, 0, Math.max(0, 1 - P.logo.fw));
    P.logo.fy = clamp(fy0 + (ev.clientY - sy) / r.height, 0, Math.max(0, 1 - hf));
    layoutLogo();
  };
  const up = () => {
    el.logo.classList.remove('drag');
    el.logo.removeEventListener('pointermove', mv);
    el.logo.removeEventListener('pointerup', up);
    el.logo.removeEventListener('pointercancel', up);
    commit();
  };
  el.logo.addEventListener('pointermove', mv);
  el.logo.addEventListener('pointerup', up);
  el.logo.addEventListener('pointercancel', up);
});

/* --------------------------------------------------------------- playback */
function seek(t) {
  S.t = clamp(t, 0, S.mainDur);
  try { mainEl.currentTime = S.t; } catch (_) {}
  S.lastSeg = null;
  sync(true);
  updateUI();
}

async function play() {
  if (!S.editor) return;
  ensureGraph();
  try { if (S.ac && S.ac.state === 'suspended') await S.ac.resume(); } catch (_) {}
  if (S.t >= S.mainDur - 0.05) S.t = 0;
  mainEl.currentTime = S.t;
  S.lastSeg = null;
  try { await mainEl.play(); } catch (e) { toast('প্লে করা যায়নি: ' + e.message, true); return; }
  S.playing = true;
  el.play.textContent = '⏸';
}
function pause() {
  S.playing = false;
  mainEl.pause(); el.video.pause(); bgEl.pause();
  el.play.textContent = '▶';
}

function sync(force = false) {
  if (!S.editor) return;
  const T = S.mainDur;
  const L = locate(P.segments, Math.min(S.t, Math.max(0, T - 1e-4)));
  const v = el.video;
  if (L) {
    const seg = L.seg;
    const maxT = Math.max(0, S.vid.dur - 0.05);
    const target = clamp(srcTime(seg, L.offset), 0, maxT);
    if (seg.mode === 'normal') {
      if (S.playing) {
        if (force || S.lastSeg !== seg.id || Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
        if (v.paused && !v.ended) v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - target) > 0.02) v.currentTime = target;
      }
    } else {
      // reverse: step through frames by seeking (browsers cannot play backwards)
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - target) > 0.01) v.currentTime = target;
    }
    S.lastSeg = seg.id;
  }
  // background audio
  if (P.bgOn && S.files.bg && S.bgDur > 0) {
    const plan = bgPlan(S.bgDur, T, P.bgLoop.infinite, P.bgLoop.repeats);
    const bt = bgTimeAt(plan, S.bgDur, S.t);
    if (bt === null || !S.playing) {
      if (!bgEl.paused) bgEl.pause();
      if (bt !== null && Math.abs(bgEl.currentTime - bt) > 0.05) bgEl.currentTime = bt;
    } else {
      if (Math.abs(bgEl.currentTime - bt) > 0.25) bgEl.currentTime = bt;
      if (bgEl.paused) bgEl.play().catch(() => {});
    }
  } else if (!bgEl.paused) bgEl.pause();
}

function updateUI() {
  const T = S.mainDur || 1;
  el.tCur.textContent = fmtTime(S.t);
  if (!S.scrubbing) el.scrub.value = Math.round((S.t / T) * 1000);
  const x = S.t * S.pps;
  el.playhead.style.transform = `translateX(${x}px)`;
  if (S.playing) {
    const sc = el.tlScroll;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - 40);
  }
}

function frame() {
  if (!S.editor) return;
  if (S.playing) {
    S.t = mainEl.currentTime;
    if (mainEl.ended || S.t >= S.mainDur - 0.02) {
      pause(); S.t = S.mainDur;
    }
  }
  sync();
  updateUI();
  requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => { if (document.hidden && S.playing) pause(); });

/* --------------------------------------------------------------- timeline */
const MAX_CANVAS = 16000;
function fitPps() { return Math.max(1, (el.tlScroll.clientWidth - 2) / Math.max(0.1, S.mainDur)); }
function ppsFromZoom() {
  const v = +el.zoom.value;
  const maxPps = MAX_CANVAS / Math.max(0.1, S.mainDur);
  return Math.min(maxPps, fitPps() * Math.pow(1.05, v - 1));
}
function fitZoom() { el.zoom.value = 1; S.pps = ppsFromZoom(); }

function renderTimeline() {
  const T = S.mainDur, pps = S.pps;
  const w = Math.ceil(T * pps);
  el.tlInner.style.width = w + 'px';

  // ruler
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * pps >= 64) || 600;
  let html = '';
  for (let t = 0; t <= T + 1e-6; t += step) html += `<div class="tick" style="left:${t * pps}px">${fmtTime(t).replace(/\.0$/, '')}</div>`;
  el.ruler.innerHTML = html;

  // video clips
  el.trkVideo.innerHTML = '';
  let acc = 0;
  P.segments.forEach((s, i) => {
    const d = clipDur(s);
    const c = document.createElement('div');
    c.className = 'clip ' + (s.mode === 'normal' ? 'n' : 'r') + (s.id === S.sel ? ' sel' : '');
    c.dataset.id = s.id;
    c.style.left = acc * pps + 'px';
    c.style.width = Math.max(4, d * pps - 2) + 'px';
    c.innerHTML = `<b>${i + 1} · ${s.mode === 'normal' ? '▶ Normal' : '◀ Reverse'}</b>${fmtTime(s.start)}–${fmtTime(s.end)}<div class="hd" data-hd="1"></div>`;
    el.trkVideo.appendChild(c);
    acc += d;
  });
  renderWaves();
  updateUI();
}

function renderWaves() {
  const T = S.mainDur, pps = S.pps;
  const w = Math.min(MAX_CANVAS, Math.max(1, Math.ceil(T * pps)));
  const H = 58;
  const paint = (cv, peaks, dur, timeAt, color, marks) => {
    cv.width = w; cv.height = H; cv.style.width = w + 'px';
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, H);
    g.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const t = (x / w) * T;
      const at = timeAt(t);
      if (at === null) continue;
      let a = 0.25;
      if (peaks) a = peaks[Math.min(peaks.length - 1, Math.floor((at / dur) * peaks.length))] || 0;
      const h = Math.max(1.5, Math.min(1, a * 1.25) * (H - 10));
      g.fillRect(x, (H - h) / 2, 1, h);
    }
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.setLineDash([3, 3]);
    for (const m of marks) { const x = Math.round((m / T) * w) + .5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  };
  if (S.files.main) paint(el.cvMain, S.peaks.main, S.mainDur, (t) => (t <= S.mainDur ? t : null), '#60a5fa', []);
  const bgOn = !!(S.files.bg && P.bgOn);
  el.trkBg.classList.toggle('empty', !bgOn);
  el.trkBg.dataset.empty = 'ব্যাকগ্রাউন্ড অডিও নেই';
  el.cvBg.style.display = bgOn ? '' : 'none';
  if (bgOn) {
    const plan = bgPlan(S.bgDur, T, P.bgLoop.infinite, P.bgLoop.repeats);
    const marks = [];
    for (let k = 1; k < plan.plays; k++) if (k * S.bgDur < plan.activeUntil) marks.push(k * S.bgDur);
    paint(el.cvBg, S.peaks.bg, S.bgDur, (t) => bgTimeAt(plan, S.bgDur, t), '#c084fc', marks);
  }
}

function tlTime(e) {
  const r = el.tlInner.getBoundingClientRect();
  return clamp((e.clientX - r.left) / S.pps, 0, S.mainDur);
}

el.tlScroll.addEventListener('pointerdown', (e) => {
  const hd = e.target.closest('[data-hd]');
  const clip = e.target.closest('.clip');
  if (hd && clip) { startTrim(e, +clip.dataset.id); return; }
  if (clip) { S.sel = +clip.dataset.id; renderTimeline(); updateClipBar(); seek(tlTime(e)); return; }
  if (e.pointerType === 'touch' && !e.target.closest('#ruler')) { seek(tlTime(e)); return; }
  S.scrubbing = true;
  seek(tlTime(e));
  const mv = (ev) => seek(tlTime(ev));
  const up = () => {
    S.scrubbing = false;
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
});

function startTrim(e, id) {
  e.preventDefault(); e.stopPropagation();
  const base = JSON.parse(JSON.stringify(P.segments));
  const b = base.find((s) => s.id === id);
  if (!b) return;
  S.sel = id;
  touch();
  const sx = e.clientX, d0 = clipDur(b);
  const mv = (ev) => {
    const segs = JSON.parse(JSON.stringify(base));
    const s = segs.find((x) => x.id === id);
    const maxD = s.mode === 'normal' ? S.vid.dur - s.start : s.end;
    const nd = clamp(d0 + (ev.clientX - sx) / S.pps, MIN_CLIP, maxD);
    if (s.mode === 'normal') s.end = s.start + nd; else s.start = s.end - nd;
    P.segments = fitSegments(segs, S.mainDur, S.vid.dur, P.pattern);
    renderTimeline(); updateClipBar(); updateStats();
  };
  const up = () => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    commit(); renderAll();
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}

/* --------------------------------------------------------------- clip bar */
const selSeg = () => P.segments.find((s) => s.id === S.sel);
function updateClipBar() {
  const s = selSeg();
  const bar = $('clipBar');
  bar.classList.toggle('off', !s);
  if (!s) { $('clipLbl').textContent = 'ক্লিপ বেছে নিন'; $('cIn').value = ''; $('cOut').value = ''; return; }
  const i = P.segments.indexOf(s);
  $('clipLbl').textContent = `ক্লিপ ${i + 1}/${P.segments.length}`;
  $('cmNormal').classList.toggle('active', s.mode === 'normal');
  $('cmReverse').classList.toggle('active', s.mode === 'reverse');
  $('cIn').value = s.start.toFixed(2); $('cOut').value = s.end.toFixed(2);
  $('cLeft').disabled = i === 0; $('cRight').disabled = i === P.segments.length - 1;
}
function editClip(fn) {
  const s = selSeg(); if (!s) return;
  touch(); fn(s); refit(); commit(); renderAll();
}
$('cmNormal').onclick = () => editClip((s) => { s.mode = 'normal'; });
$('cmReverse').onclick = () => editClip((s) => { s.mode = 'reverse'; });
$('cIn').onchange = () => editClip((s) => { s.start = clamp(parseFloat($('cIn').value) || 0, 0, s.end - MIN_CLIP); });
$('cOut').onchange = () => editClip((s) => { s.end = clamp(parseFloat($('cOut').value) || 0, s.start + MIN_CLIP, S.vid.dur); });
$('cLeft').onclick = () => { const s = selSeg(); if (!s) return; const i = P.segments.indexOf(s); if (i < 1) return; touch(); [P.segments[i - 1], P.segments[i]] = [P.segments[i], P.segments[i - 1]]; commit(); renderAll(); };
$('cRight').onclick = () => { const s = selSeg(); if (!s) return; const i = P.segments.indexOf(s); if (i >= P.segments.length - 1) return; touch(); [P.segments[i + 1], P.segments[i]] = [P.segments[i], P.segments[i + 1]]; commit(); renderAll(); };
$('cDup').onclick = () => { const s = selSeg(); if (!s) return; touch(); const c = { ...s, id: newId() }; P.segments.splice(P.segments.indexOf(s) + 1, 0, c); S.sel = c.id; refit(); commit(); renderAll(); };
$('cDel').onclick = () => { const s = selSeg(); if (!s) return; touch(); P.segments.splice(P.segments.indexOf(s), 1); S.sel = null; refit(); commit(); renderAll(); };

/* ---------------------------------------------------- panel controls wiring */
function slider(id, apply) {
  const n = $(id);
  n.addEventListener('input', () => { touch(); apply(+n.value); syncControls(); applyGains(); layoutLogo(); if (id === 'lSize') clampLogo(); });
  n.addEventListener('change', () => { commit(); if (id.startsWith('v')) renderWaves(); });
}
function clampLogo() {
  P.logo.fx = clamp(P.logo.fx, 0, Math.max(0, 1 - P.logo.fw));
  P.logo.fy = clamp(P.logo.fy, 0, Math.max(0, 1 - logoHeightFrac()));
  layoutLogo();
}
slider('vVideo', (v) => { P.vol.video = v; });
slider('vMain', (v) => { P.vol.main = v; });
slider('vBg', (v) => { P.vol.bg = v; });
slider('lSize', (v) => { P.logo.fw = v / 100; });
slider('lOpac', (v) => { P.logo.opacity = v / 100; });

$('bgInf').onchange = () => { touch(); P.bgLoop.infinite = $('bgInf').checked; commit(); renderAll(); };
$('bgRep').onchange = () => { touch(); P.bgLoop.repeats = clamp(Math.floor(+$('bgRep').value) || 1, 1, 999); commit(); renderAll(); };
$('btnLogoReset').onclick = () => { touch(); resetLogoPos(); commit(); renderAll(); };
$('btnLogoRemove').onclick = () => removeOptional('logo');
document.querySelectorAll('[data-remove]').forEach((b) => { b.onclick = () => removeOptional(b.dataset.remove); });
$('btnRebuild').onclick = () => { touch(); rebuild(); commit(); S.t = 0; seek(0); renderAll(); toast('ভিডিও আবার অটো তৈরি হয়েছে'); };
$('loopPattern').onchange = () => { touch(); P.pattern = $('loopPattern').value; rebuild(); commit(); renderAll(); };

el.play.onclick = () => (S.playing ? pause() : play());
el.restart.onclick = () => { seek(0); if (S.playing) { mainEl.currentTime = 0; } };
el.scrub.addEventListener('pointerdown', () => { S.scrubbing = true; });
window.addEventListener('pointerup', () => { S.scrubbing = false; });
el.scrub.addEventListener('input', () => seek((el.scrub.value / 1000) * S.mainDur));
el.zoom.addEventListener('input', () => { S.pps = ppsFromZoom(); renderTimeline(); });
$('btnFit').onclick = () => { fitZoom(); renderTimeline(); };
window.addEventListener('resize', () => { if (S.editor && +el.zoom.value === 1) { fitZoom(); renderTimeline(); } });
el.undo.onclick = undo; el.redo.onclick = redo;

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' && e.target.type !== 'range' || tag === 'select' || tag === 'textarea';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.code === 'Space' && S.editor && !typing && tag !== 'button') { e.preventDefault(); S.playing ? pause() : play(); }
});

/* ---------------------------------------------------------- file inputs */
for (const kind of ['video', 'main', 'bg', 'logo']) {
  const input = $('in-' + kind);
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; handleFile(kind, f); });
  const card = document.querySelector(`.card[data-kind="${kind}"]`);
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('over'); handleFile(kind, e.dataTransfer.files[0]); });
}
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* ---------------------------------------------------------------- export */
const modal = $('exportModal');
const show = (id) => { for (const s of ['expSetup', 'expRun', 'expDone', 'expError']) $(s).classList.toggle('hidden', s !== id); };
let lastBlobUrl = null;

el.exportBtn.onclick = () => {
  if (!S.editor) return;
  pause();
  const T = S.mainDur;
  const info = [
    `দৈর্ঘ্য: ${fmtTime(T)} (মেইন অডিওর সমান)`,
    `রেজোলিউশন: ${S.vid.w - (S.vid.w % 2)}×${S.vid.h - (S.vid.h % 2)} (মূলের মতোই)`,
    `ক্লিপ: ${P.segments.length}টি${P.logoOn && S.files.logo ? ' · লোগোসহ' : ''}${P.bgOn && S.files.bg ? ' · ব্যাকগ্রাউন্ড অডিওসহ' : ''}`,
  ];
  const mp = (S.vid.w * S.vid.h) / 1e6;
  if (S.files.video.size > 700 * 1048576) info.push('⚠ ভিডিও ফাইল বড় — ব্রাউজারের মেমোরি শেষ হয়ে যেতে পারে।');
  if (mp * T > 400) info.push('⚠ এই রেজোলিউশন/দৈর্ঘ্যে রেন্ডার অনেক সময় নিতে পারে। প্রথমে "ড্রাফট" কোয়ালিটি চেষ্টা করুন।');
  $('expInfo').innerHTML = info.map((i) => `<li>${esc(i)}</li>`).join('');
  show('expSetup');
  modal.classList.remove('hidden');
};
$('expCancelSetup').onclick = () => modal.classList.add('hidden');
$('expClose').onclick = () => modal.classList.add('hidden');
$('expErrClose').onclick = () => modal.classList.add('hidden');
$('expRetry').onclick = () => show('expSetup');
$('expAbort').onclick = () => { abortExport(); $('expStatus').textContent = 'বন্ধ করা হচ্ছে…'; };

$('expStart').onclick = async () => {
  show('expRun');
  const setPct = (f) => { const p = Math.round(f * 100); $('expFill').style.width = p + '%'; $('expPct').textContent = p + '%'; };
  setPct(0); $('expStatus').textContent = 'শুরু হচ্ছে…';
  const job = {
    videoFile: S.files.video, mainFile: S.files.main, bgFile: S.files.bg, bgDur: S.bgDur,
    logoImg: S.logoImg, W: S.vid.w, H: S.vid.h, T: S.mainDur, srcDur: S.vid.dur,
    quality: $('expQuality').value, P: JSON.parse(JSON.stringify(P)),
  };
  try {
    const { blob, info } = await renderProject(job, { onProgress: setPct, onStatus: (m) => { $('expStatus').textContent = m; } });
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = URL.createObjectURL(blob);
    const a = $('expDownload');
    a.href = lastBlobUrl;
    a.download = `autocut-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
    const rv = $('expResult');
    rv.src = lastBlobUrl;
    $('expDoneMsg').textContent = `সম্পন্ন! ${fmtSize(blob.size)} · ${info.W}×${info.H} · ${info.fps}fps`;
    rv.onloadedmetadata = () => {
      const diff = Math.abs(rv.duration - S.mainDur);
      $('expDoneMsg').textContent += ` · দৈর্ঘ্য ${fmtTime(rv.duration)} (লক্ষ্য ${fmtTime(S.mainDur)}${diff > 0.25 ? ', ⚠ পার্থক্য ' + diff.toFixed(2) + 's' : ' ✓'})`;
    };
    show('expDone');
  } catch (e) {
    console.error(e);
    const em = (e && e.message) || String(e);
    if (/বাতিল/.test(em) || /terminate/i.test(em)) {
      show('expSetup'); toast('এক্সপোর্ট বন্ধ করা হয়েছে');
    } else {
      $('expErrMsg').textContent = 'এক্সপোর্ট ব্যর্থ: ' + em;
      $('expLog').textContent = (e && e.log) || '';
      $('expLog').classList.toggle('hidden', !(e && e.log));
      show('expError');
    }
  }
};

/* ------------------------------------------------------------------- init */
updateUndo();
el.video.addEventListener('error', () => { if (S.files.video) toast('ভিডিও চালাতে সমস্যা হয়েছে', true); });
