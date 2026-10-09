// Pure editing-model helpers (no DOM). Time unit: seconds.

export const MIN_CLIP = 0.1;
const EPS = 1e-6;
const MIN_FRAME = 0.034; // ~1 frame; anything shorter is dropped

let _id = 1;
export const newId = () => _id++;
export const clipDur = (s) => s.end - s.start;
export const totalDur = (segs) => segs.reduce((a, s) => a + clipDur(s), 0);

/**
 * Normalise a clip list so its total length equals T exactly:
 *  - clips beyond T are dropped, the last clip is shortened
 *  - if the list is too short, clips are appended, alternating normal/reverse
 * A reverse clip plays from `end` down to `start`.
 */
export function fitSegments(segs, T, src, pattern = 'alt') {
  const out = [];
  let acc = 0;
  for (const s of segs) {
    if (acc >= T - EPS) break;
    const c = { ...s };
    c.start = Math.max(0, Math.min(c.start, src));
    c.end = Math.max(c.start, Math.min(c.end, src));
    if (clipDur(c) < MIN_FRAME) continue;
    if (acc + clipDur(c) > T + EPS) {
      const keep = T - acc;
      if (keep < MIN_FRAME) break;
      if (c.mode === 'normal') c.end = c.start + keep;
      else c.start = c.end - keep;
    }
    out.push(c);
    acc += clipDur(c);
  }
  let last = out.length ? out[out.length - 1].mode : 'reverse';
  let guard = 0;
  while (acc < T - EPS && guard++ < 20000) {
    const mode = pattern === 'normal' ? 'normal' : pattern === 'reverse' ? 'reverse' : (last === 'normal' ? 'reverse' : 'normal');
    const d = Math.min(src, T - acc);
    if (d < MIN_FRAME) break;
    out.push(mode === 'normal'
      ? { id: newId(), mode, start: 0, end: d }
      : { id: newId(), mode, start: src - d, end: src });
    acc += d;
    last = mode;
  }
  return out;
}

export const buildAuto = (src, T, pattern = 'alt') => fitSegments([], T, src, pattern === 'reverse' ? 'alt' : pattern);

/** Which clip is on screen at time t, and how far into it. */
export function locate(segs, t) {
  if (!segs.length) return null;
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const d = clipDur(segs[i]);
    if (t < acc + d - EPS || i === segs.length - 1) {
      const offset = Math.max(0, Math.min(d, t - acc));
      return { seg: segs[i], idx: i, offset, at: acc };
    }
    acc += d;
  }
  return null;
}

/** Source-video time for a given offset into a clip. */
export function srcTime(seg, offset) {
  return seg.mode === 'normal' ? seg.start + offset : seg.end - offset;
}

/** Background-audio loop plan. */
export function bgPlan(bgDur, T, infinite, repeats) {
  const needed = Math.max(1, Math.ceil(T / bgDur - EPS));
  const plays = infinite ? needed : Math.max(1, Math.min(Math.floor(repeats) || 1, needed));
  return { plays, needed, activeUntil: Math.min(T, plays * bgDur) };
}

/** Position inside the bg file at timeline time t, or null when silent. */
export function bgTimeAt(plan, bgDur, t) {
  if (t >= plan.activeUntil - EPS) return null;
  return t - Math.floor(t / bgDur + EPS) * bgDur;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
