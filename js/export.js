// MP4 export with FFmpeg WebAssembly (single-thread build: works on GitHub Pages,
// no COOP/COEP headers needed). FFmpeg itself runs inside its own Web Worker.

import { clipDur, bgPlan } from './model.js';

const SOURCES = [
  // 1) self-hosted copy (optional, see README / scripts/vendor-ffmpeg.sh)
  { lib: './vendor/ffmpeg', core: './vendor/ffmpeg' },
  // 2) CDNs
  { lib: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd', core: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd' },
  { lib: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd', core: 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd' },
];

let assets = null;      // { coreURL, wasmURL, classWorkerURL }
let ff = null;          // FFmpeg instance
let logBuf = [];
let aborted = false;

const abs = (u) => new URL(u, document.baseURI).href;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => { s.remove(); rej(new Error('script load failed: ' + src)); };
    document.head.appendChild(s);
  });
}

async function fetchBlobURL(url, type, onProg) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !r.body.getReader) {
    return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
  }
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProg) onProg(total ? Math.min(0.99, got / total) : 0, got);
  }
  return URL.createObjectURL(new Blob(chunks, { type }));
}

async function loadAssets(onStatus) {
  if (assets) return assets;
  let lastErr;
  for (const src of SOURCES) {
    try {
      const where = src.lib.startsWith('http') ? new URL(src.lib).host : 'এই সাইট';
      onStatus(`FFmpeg লাইব্রেরি লোড হচ্ছে (${where})…`);
      if (!window.FFmpegWASM) await loadScript(abs(src.lib + '/ffmpeg.js'));
      if (!window.FFmpegWASM) throw new Error('FFmpegWASM global missing');
      const classWorkerURL = await fetchBlobURL(abs(src.lib + '/814.ffmpeg.js'), 'text/javascript');
      const coreURL = await fetchBlobURL(abs(src.core + '/ffmpeg-core.js'), 'text/javascript');
      const wasmURL = await fetchBlobURL(abs(src.core + '/ffmpeg-core.wasm'), 'application/wasm',
        (f, got) => onStatus(`FFmpeg ইঞ্জিন নামছে… ${(got / 1048576).toFixed(0)} MB${f ? ` (${Math.round(f * 100)}%)` : ''}`));
      assets = { coreURL, wasmURL, classWorkerURL };
      return assets;
    } catch (e) {
      lastErr = e;
      console.warn('FFmpeg source failed', src.lib, e);
    }
  }
  throw new Error('FFmpeg লোড করা যায়নি। ইন্টারনেট সংযোগ দেখুন (CDN দরকার), অথবা README অনুযায়ী vendor/ffmpeg এ ফাইল রাখুন। ' + (lastErr ? lastErr.message : ''));
}

// FFmpeg UMD বিল্ড worker-টা {type:"module"} হিসেবে চালু করে; module worker-এ importScripts নেই,
// তাই ffmpeg-core লোড না হয়ে "Cannot find module 'blob:…'" আসে। load() চলাকালীন Worker-কে classic করে দিই।
async function loadInstance(a, forceClassic) {
  const inst = new window.FFmpegWASM.FFmpeg();
  inst.on('log', ({ message }) => { logBuf.push(message); if (logBuf.length > 400) logBuf.shift(); });
  const Native = window.Worker;
  if (forceClassic) {
    window.Worker = class extends Native {
      constructor(url, opts) { super(url, opts && opts.type === 'module' ? { ...opts, type: 'classic' } : opts); }
    };
  }
  try {
    await inst.load({ coreURL: a.coreURL, wasmURL: a.wasmURL, classWorkerURL: a.classWorkerURL });
  } catch (e) {
    try { inst.terminate(); } catch (_) {}
    throw e;
  } finally {
    window.Worker = Native;
  }
  return inst;
}

async function getFF(onStatus) {
  if (ff) return ff;
  const a = await loadAssets(onStatus);
  onStatus('FFmpeg চালু হচ্ছে…');
  let inst;
  try {
    inst = await loadInstance(a, true);
  } catch (e1) {
    console.warn('classic worker load failed, retrying as module worker', e1);
    try {
      inst = await loadInstance(a, false);
    } catch (e2) {
      throw new Error('FFmpeg চালু করা যায়নি: ' + (e1 && e1.message || e1) + ' | ' + (e2 && e2.message || e2));
    }
  }
  ff = inst;
  return ff;
}

/** Preload in the background so Export starts quickly. Errors are ignored here. */
export function preloadFFmpeg(onStatus = () => {}) {
  return getFF(onStatus).catch(() => {});
}

export function abortExport() {
  aborted = true;
  if (ff) { try { ff.terminate(); } catch (_) {} ff = null; }
}

const QUALITY = {
  draft:    { crf: 30, preset: 'ultrafast', clipCrf: 24 },
  standard: { crf: 23, preset: 'veryfast',  clipCrf: 18 },
  high:     { crf: 18, preset: 'fast',      clipCrf: 15 },
};
export const QUALITY_KEYS = Object.keys(QUALITY);

const ext = (name, fallback) => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : fallback;
};
const num = (n, d = 3) => (+n).toFixed(d);

async function logoToPng(img, wPx, opacity) {
  const hPx = Math.max(2, Math.round(wPx * (img.naturalHeight / img.naturalWidth)));
  const c = document.createElement('canvas');
  c.width = wPx; c.height = hPx;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.globalAlpha = opacity;
  g.drawImage(img, 0, 0, wPx, hPx);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return { data: new Uint8Array(await blob.arrayBuffer()), w: wPx, h: hPx };
}

/**
 * job = {
 *   videoFile, mainFile, bgFile, logoImg,
 *   W, H, T, srcDur, quality,
 *   P: { segments, vol:{video,main,bg}, bgLoop:{infinite,repeats}, bgOn, logoOn, logo:{fx,fy,fw,opacity} }
 * }
 * hooks = { onProgress(0..1), onStatus(text) }
 * returns { blob, info }
 */
async function renderInner(job, hooks) {
  aborted = false;
  logBuf = [];
  const { onProgress, onStatus } = hooks;
  const q = QUALITY[job.quality] || QUALITY.standard;
  const { P, T } = job;
  const W = job.W - (job.W % 2), H = job.H - (job.H % 2);
  const created = [];

  const f = await getFF(onStatus);
  const put = async (name, data) => { await f.writeFile(name, data); created.push(name); };
  const del = async (name) => { try { await f.deleteFile(name); } catch (_) {} };

  let curUnits = 0, doneUnits = 0, totalUnits = 1;
  const progressCb = ({ progress }) => {
    const p = Math.max(0, Math.min(1, isFinite(progress) ? progress : 0));
    onProgress(Math.min(0.99, (doneUnits + p * curUnits) / totalUnits));
  };
  f.on('progress', progressCb);

  const run = async (args, units, label) => {
    if (aborted) throw new Error('বাতিল করা হয়েছে');
    curUnits = units;
    if (label) onStatus(label);
    const code = await f.exec(args);
    if (aborted) throw new Error('বাতিল করা হয়েছে');
    if (code !== 0) {
      const err = new Error(`FFmpeg ব্যর্থ হয়েছে (কোড ${code})`);
      err.log = logBuf.slice(-40).join('\n');
      throw err;
    }
    doneUnits += units;
    onProgress(Math.min(0.99, doneUnits / totalUnits));
  };

  try {
    // ---- inputs ----
    onStatus('ফাইল লোড হচ্ছে…');
    const vName = 'in_video.' + ext(job.videoFile.name, 'mp4');
    const mName = 'in_main.' + ext(job.mainFile.name, 'mp3');
    await put(vName, new Uint8Array(await job.videoFile.arrayBuffer()));
    await put(mName, new Uint8Array(await job.mainFile.arrayBuffer()));
    const useBg = !!(P.bgOn && job.bgFile && P.vol.bg > 0);
    let bName = null;
    if (useBg) {
      bName = 'in_bg.' + ext(job.bgFile.name, 'mp3');
      await put(bName, new Uint8Array(await job.bgFile.arrayBuffer()));
    }

    // ---- probe (audio stream? fps?) ----
    onStatus('ভিডিও বিশ্লেষণ হচ্ছে…');
    logBuf = [];
    await f.exec(['-hide_banner', '-i', vName]); // exits non-zero by design (no output)
    const probe = logBuf.join('\n');
    const hasAudio = /Stream #\d+:\d+.*Audio:/.test(probe);
    let fps = 30;
    const fm = /,\s*([\d.]+)\s*fps/.exec(probe);
    if (fm) fps = Math.min(60, Math.max(15, parseFloat(fm[1]) || 30));
    fps = Math.round(fps * 1000) / 1000;
    const vidAudio = hasAudio && P.vol.video > 0;

    // ---- logo ----
    const useLogo = !!(P.logoOn && job.logoImg);
    let logo = null;
    if (useLogo) {
      const wPx = Math.max(2, Math.round(P.logo.fw * W));
      logo = await logoToPng(job.logoImg, wPx, P.logo.opacity);
      await put('logo.png', logo.data);
    }

    // ---- unique clips ----
    const key = (s) => `${s.mode}_${num(s.start)}_${num(s.end)}`;
    const uniq = new Map();
    for (const s of P.segments) if (!uniq.has(key(s))) uniq.set(key(s), s);

    const frameBytes = W * H * 1.5;
    const maxFrames = Math.max(8, Math.floor(250e6 / frameBytes));
    const chunkLen = Math.max(0.25, maxFrames / fps);

    const plan = []; // {key, parts:[{s,e,rev,name}]}
    let clipUnits = 0;
    let n = 0;
    for (const [k, s] of uniq) {
      const parts = [];
      if (s.mode === 'normal') {
        parts.push({ s: s.start, e: s.end, rev: false, name: `c${String(n++).padStart(4, '0')}.mkv` });
      } else {
        let pos = s.end;
        while (pos > s.start + 1e-6) {
          const cs = Math.max(s.start, pos - chunkLen);
          parts.push({ s: cs, e: pos, rev: true, name: `c${String(n++).padStart(4, '0')}.mkv` });
          pos = cs;
        }
      }
      clipUnits += clipDur(s);
      plan.push({ key: k, parts });
    }
    const finalUnits = T * 1.2;
    totalUnits = clipUnits + finalUnits;

    // ---- pass 1: render each unique clip ----
    let ci = 0;
    for (const item of plan) {
      ci++;
      for (const p of item.parts) {
        const d = p.e - p.s;
        const vf = [`fps=${fps}`, `scale=${W}:${H}:flags=bicubic`, 'setsar=1', 'format=yuv420p', p.rev ? 'reverse' : null]
          .filter(Boolean).join(',');
        const args = ['-ss', num(p.s), '-t', num(d), '-i', vName, '-vf', vf];
        if (vidAudio) {
          args.push('-af', 'aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo' + (p.rev ? ',volume=0' : ''));
          args.push('-c:a', 'pcm_s16le');
        } else {
          args.push('-an');
        }
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(q.clipCrf), '-pix_fmt', 'yuv420p', p.name);
        await run(args, d, `ক্লিপ রেন্ডার ${ci}/${plan.length}${p.rev ? ' (রিভার্স)' : ''}…`);
        created.push(p.name);
      }
    }

    // ---- concat list ----
    const byKey = new Map(plan.map((i) => [i.key, i]));
    const lines = [];
    for (const s of P.segments) for (const p of byKey.get(key(s)).parts) lines.push(`file '${p.name}'`);
    await put('list.txt', new TextEncoder().encode(lines.join('\n') + '\n'));

    // ---- pass 2: concat + audio mix + logo + encode ----
    const args = ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-i', mName];
    let idx = 2, bgIdx = -1, logoIdx = -1;
    if (useBg) { args.push('-i', bName); bgIdx = idx++; }
    if (useLogo) { args.push('-i', 'logo.png'); logoIdx = idx++; }

    const Ts = num(T);
    const fc = [];
    fc.push('[0:v]tpad=stop_mode=clone:stop_duration=1[v0]');
    if (useLogo) {
      const x = Math.max(0, Math.min(W - logo.w, Math.round(P.logo.fx * W)));
      const y = Math.max(0, Math.min(H - logo.h, Math.round(P.logo.fy * H)));
      fc.push(`[v0][${logoIdx}:v]overlay=${x}:${y}:format=auto[v1]`);
    } else {
      fc.push('[v0]null[v1]');
    }
    fc.push('[v1]format=yuv420p[vout]');

    const norm = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const mix = [];
    fc.push(`[1:a]${norm},volume=${num(P.vol.main / 100)},apad=whole_dur=${Ts},atrim=0:${Ts}[am]`);
    mix.push('[am]');
    if (vidAudio) {
      fc.push(`[0:a]${norm},volume=${num(P.vol.video / 100)},apad=whole_dur=${Ts},atrim=0:${Ts}[av]`);
      mix.push('[av]');
    }
    if (useBg) {
      const bp = bgPlan(job.bgDur, T, P.bgLoop.infinite, P.bgLoop.repeats);
      const loopArg = bp.plays > 1
        ? `aloop=loop=${bp.plays - 1}:size=${Math.ceil(job.bgDur * 44100) + 44100},`
        : '';
      fc.push(`[${bgIdx}:a]${norm},${loopArg}volume=${num(P.vol.bg / 100)},atrim=0:${Ts},apad=whole_dur=${Ts}[ab]`);
      mix.push('[ab]');
    }
    if (mix.length === 1) fc.push('[am]anull[aout]');
    else fc.push(`${mix.join('')}amix=inputs=${mix.length}:duration=longest:dropout_transition=0,volume=${mix.length}[aout]`);

    args.push(
      '-filter_complex', fc.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
      '-movflags', '+faststart', '-t', Ts, 'out.mp4'
    );
    await run(args, finalUnits, 'অডিও মিক্স ও চূড়ান্ত MP4 রেন্ডার…');
    created.push('out.mp4');

    onStatus('ফাইল তৈরি হচ্ছে…');
    const data = await f.readFile('out.mp4');
    const blob = new Blob([data], { type: 'video/mp4' });
    onProgress(1);
    return { blob, info: { W, H, fps, hasAudio, clips: P.segments.length, uniqueClips: plan.length } };
  } finally {
    try { f.off('progress', progressCb); } catch (_) {}
    if (ff) for (const name of created) await del(name);
  }
}

const errText = (e) => {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.reason) return errText(e.reason);
  try { return e.type ? `event: ${e.type}` : JSON.stringify(e); } catch (_) { return String(e); }
};

/** FFmpeg worker কখনো Error নয়, সাধারণ স্ট্রিং/Event ছোড়ে — সব Error-এ রূপান্তর করে লগসহ ফেরত দেয়। */
export async function renderProject(job, hooks) {
  try {
    return await renderInner(job, hooks);
  } catch (e) {
    const err = e instanceof Error && e.message ? e : new Error(errText(e) || 'অজানা ত্রুটি (সম্ভবত মেমোরি শেষ বা FFmpeg বন্ধ হয়ে গেছে)');
    if (!err.log) err.log = logBuf.slice(-40).join('\n');
    if (/memory|out of bounds|abort/i.test(err.message + err.log) && !/বাতিল/.test(err.message)) {
      err.message += ' — মেমোরি কম হতে পারে; "ড্রাফট" কোয়ালিটি বা ছোট ভিডিও চেষ্টা করুন।';
    }
    throw err;
  }
}
