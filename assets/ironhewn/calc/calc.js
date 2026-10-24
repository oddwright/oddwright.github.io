// Strength math: estimated 1RM, rep-max tables, volume, plates and warm-ups.
// Everything here is unit-agnostic (works in kg or lb) and side-effect free.

import { isNum } from './util.js';

/** Estimated one-rep max. Averages Epley and Brzycki (they bracket each other
 *  well in the 2–10 rep range). RPE stays out: PRs and ranks compare sets logged with and
 *  without it, so reps in reserve would read as a stronger lift. */
export function e1rm(weight, reps) {
  if (!isNum(weight) || !isNum(reps) || weight <= 0 || reps <= 0) return 0;
  const r = reps;
  if (r <= 1) return weight;
  const epley = weight * (1 + r / 30);
  const brzycki = r < 37 ? weight * (36 / (37 - r)) : epley;
  return r <= 10 ? (epley + brzycki) / 2 : epley * 0.65 + brzycki * 0.35;
}

/** Weight you can likely move for `reps` given a 1RM (inverse of e1rm). */
export function weightForReps(oneRm, reps) {
  if (!oneRm || reps <= 0) return 0;
  if (reps === 1) return oneRm;
  const ep = oneRm / (1 + reps / 30);
  const br = reps < 37 ? (oneRm * (37 - reps)) / 36 : ep;
  return reps <= 10 ? (ep + br) / 2 : ep * 0.65 + br * 0.35;
}

/** Percent of 1RM for a rep count (handy for program tables). */
export const pctForReps = (reps) => weightForReps(100, reps) / 100;

export function repMaxTable(oneRm, max = 12) {
  return Array.from({ length: max }, (_, i) => ({ reps: i + 1, weight: weightForReps(oneRm, i + 1) }));
}

/** Round to the nearest loadable increment. */
export function roundTo(v, step) {
  if (!step) return v;
  return Math.round(v / step) * step;
}

/** Greedy plate breakdown for ONE side of the bar. */
export function plateBreakdown(total, bar, plates) {
  const sorted = [...plates].sort((a, b) => b - a);
  let side = (total - bar) / 2;
  if (side < 0) return { perSide: [], remainder: total - bar, achievable: bar };
  const out = [];
  for (const p of sorted) {
    while (side >= p - 1e-9) { out.push(p); side -= p; }
  }
  const loaded = out.reduce((a, b) => a + b, 0) * 2 + bar;
  return { perSide: out, remainder: Math.round(side * 2 * 1000) / 1000, achievable: loaded };
}

/** Warm-up ladder towards a working weight. */
export function warmupSets(working, { bar = 20, step = 2.5, equip = 'barbell', reps = 5 } = {}) {
  if (!working || working <= 0) return [];
  const round = (v) => Math.max(equip === 'barbell' ? bar : step, roundTo(v, step));
  let scheme;
  if (equip === 'barbell' || equip === 'smith' || equip === 'trap_bar') {
    scheme = working < bar * 2
      ? [[0, 10], [0.6, 5]]
      : working < bar * 3.5
        ? [[0, 10], [0.5, 5], [0.7, 3], [0.85, 1]]
        : [[0, 10], [0.4, 5], [0.55, 4], [0.7, 3], [0.8, 2], [0.9, 1]];
  } else {
    scheme = [[0.5, Math.max(8, reps + 2)], [0.75, Math.max(4, Math.round(reps / 2))]];
  }
  const out = [];
  for (const [pct, r] of scheme) {
    const w = pct === 0 ? bar : round(working * pct);
    if (w >= working) continue;
    if (out.length && out[out.length - 1].w === w) continue;
    out.push({ w, r });
  }
  return out;
}

/** Sum of weight × reps for completed working sets of a weight-based item. */
export function setVolume(set, type, bodyweight = 0) {
  if (!set.done || set.t === 'w') return 0;
  const r = set.r || 0;
  switch (type) {
    case 'weight_reps': return (set.w || 0) * r;
    case 'weighted_bw': return (bodyweight + (set.w || 0)) * r;
    case 'assisted_bw': return Math.max(0, bodyweight - (set.w || 0)) * r;
    case 'bw_reps': return bodyweight * 0.65 * r;
    default: return 0;
  }
}

/** Effective load used for e1RM / ranking. */
export function effectiveLoad(set, type, bodyweight = 0) {
  switch (type) {
    case 'weight_reps': return set.w || 0;
    case 'weighted_bw': return bodyweight + (set.w || 0);
    case 'assisted_bw': return Math.max(0, bodyweight - (set.w || 0));
    default: return 0;
  }
}

export const WEIGHTED_TYPES = new Set(['weight_reps', 'weighted_bw', 'assisted_bw']);
export const REP_TYPES = new Set(['weight_reps', 'weighted_bw', 'assisted_bw', 'bw_reps']);
