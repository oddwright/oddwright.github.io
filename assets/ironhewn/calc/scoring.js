// Pure scoring rules shared by the app and the server (docs/launch/engagement.md §3–§6, §13).
//
// No signals, no clock: `now` and every input are passed in. The Edge Functions run a byte-identical
// copy in supabase/functions/_shared/scoring/ (refresh it with `node scripts/sync-scoring.mjs`;
// supabase/tests/unit_scoring_test.ts fails if the copies drift or disagree on the fixtures).
//
//   • Heat (weekly league score): hard sets with per-workout, per-day and weekly caps, a workout
//     bonus, a consistency bonus and accepted-PR bonuses. Only live workouts count.
//   • Board e1RM (1–10 reps, no RPE credit, lift-time "ranking" bodyweight), the free-weight
//     whitelist, the personal plausibility ("jump") check and the board Forge Score.
//
// Personal ranks in the app keep their own (more generous) rules in progress.js; only setPerf moved here.

import { e1rm, effectiveLoad, WEIGHTED_TYPES } from './calc.js';
import { thresholds, levelFrom, hasStandard, PATTERNS, STANDARDS_VERSION } from './ranks.js';
import { isNum, DAY, HOUR } from './util.js';

export { STANDARDS_VERSION };
/** Bump when the Heat or board rules below change. */
export const SCORING_VERSION = 1;

/** League weeks run Monday 00:00 → Sunday 23:59:59 in this time zone (one US bucket at launch). */
export const LEAGUE_TZ = 'America/Chicago';

/** Heat rules (engagement.md §4.2). */
export const HEAT = Object.freeze({
  minMinutes: 10,          // H1: shorter workouts earn nothing
  maxMinutes: 360,         // L1: longer than 6 h is not a workout
  capMinutes: 240,         // for caps, anything over 4 h counts as 4 h
  lateHours: 72,           // first synced more than 72 h after the end → "late", no Heat
  maxWorkoutsPerDay: 10,
  hsLoadPct: 0.4,          // H2: weighted set ≥ 40 % of the best e1RM on that exercise
  hsMaxReps: 30,
  hsBwMinReps: 3,
  hsHoldSec: 15,
  cardioSecPerHs: 300,     // 1 hard set per full 5 min of cardio…
  cardioMaxHs: 6,          // …at most 6 per workout
  workoutCap: 25,          // H3: counted HS ≤ min(25, 5 + ⌊minutes / 2⌋)
  workoutCapBase: 5,
  dayCap: 40,
  taper: [[100, 10], [150, 4]],   // HS 1–100 earn 10, 101–150 earn 4, above 150 earn 0
  workoutBonus: 40, workoutBonusMinHs: 6, workoutBonusMinMinutes: 15, workoutBonusPerWeek: 6,
  consistencyBonus: 100, consistencyAt: 3,
  prBonus: 25, prPerWorkout: 3, prPerWeek: 6, prOtherMaxJump: 1.15,
  minPromoteHeat: 250,
});

/** League tiers (engagement.md §4.3): promote / demote counts of a full cohort of 30. */
export const LEAGUE_TIERS = Object.freeze([
  { tier: 1, id: 'kindling', name: 'Kindling', promote: 15, demote: 0, immunity: false },
  { tier: 2, id: 'ember', name: 'Ember', promote: 10, demote: 3, immunity: true },
  { tier: 3, id: 'flame', name: 'Flame', promote: 8, demote: 5, immunity: true },
  { tier: 4, id: 'blaze', name: 'Blaze', promote: 7, demote: 5, immunity: true },
  { tier: 5, id: 'inferno', name: 'Inferno', promote: 6, demote: 5, immunity: false },
  { tier: 6, id: 'crucible', name: 'Crucible', promote: 5, demote: 5, immunity: false },
  { tier: 7, id: 'sunforge', name: 'Sunforge', promote: 0, demote: 7, immunity: false },
]);
export const COHORT_SIZE = 30;

/**
 * How many real lifters move up / down in a cohort of `n` real lifters (ghosts never count).
 * Small cohorts: promote = max(1, round(n·P/30)), demote = floor(n·D/30); under 8 never demote.
 */
export function zoneSizes(tier, n) {
  const t = LEAGUE_TIERS[Math.min(7, Math.max(1, tier)) - 1];
  if (n <= 0) return { promote: 0, demote: 0 };
  const full = n >= COHORT_SIZE;
  const promote = t.promote === 0 ? 0 : full ? t.promote : Math.max(1, Math.round((n * t.promote) / COHORT_SIZE));
  const demote = t.demote === 0 || n < 8 ? 0 : full ? t.demote : Math.floor((n * t.demote) / COHORT_SIZE);
  return { promote, demote };
}

/** Global strength-board whitelist (engagement.md §3.3): exercise → movement pattern. */
export const BOARD_LIFTS = Object.freeze({
  squat_bb: 'squat', front_squat_bb: 'squat', pause_squat_bb: 'squat',
  deadlift_bb: 'hinge', sumo_deadlift_bb: 'hinge', trap_bar_deadlift: 'hinge',
  bench_press_bb: 'h_push', pause_bench_bb: 'h_push', bench_press_db: 'h_push',
  ohp_bb: 'v_push', shoulder_press_db: 'v_push',
  bent_over_row_bb: 'h_pull', pendlay_row: 'h_pull', row_db: 'h_pull',
  pull_up: 'v_pull', chin_up: 'v_pull',
});

/** Board rules (engagement.md §3.2, §3.4, §6.3–§6.6). */
export const BOARD = Object.freeze({
  windowDays: 180, minPatterns: 4, minAccountDays: 7, minLiveWorkouts30d: 3,
  verifyLevel: 4.75,       // unverified lifters at or above this stay off public lists
  holdLevel: 6.5,          // held everywhere until verified
  softLevel: 3.25,         // below this a failed jump check is accepted with a soft flag
});

// ── sets and sources

/** Performance value of one set for ranking purposes (kg / reps / seconds). Used by personal ranks. */
export function setPerf(set, type, bw) {
  if (WEIGHTED_TYPES.has(type)) return e1rm(effectiveLoad(set, type, bw), set.r, set.rpe);
  if (type === 'bw_reps') return set.r || 0;
  if (type === 'time' || type === 'weight_time') return set.s || 0;
  return 0;
}

/** A completed working set (normal, drop or failure; never a warm-up). */
export const isWorkingSet = (s) => !!s && s.done !== false && s.t !== 'w' && (s.t == null || s.t === 'n' || s.t === 'd' || s.t === 'f');

/** Board e1RM: 1–10 reps only, no RPE credit, effective load at the given (ranking) bodyweight. 0 if n/a. */
export function boardE1rm(set, type, bw) {
  if (!isWorkingSet(set) || !WEIGHTED_TYPES.has(type)) return 0;
  const r = set.r;
  if (!isNum(r) || r < 1 || r > 10 || r !== Math.floor(r)) return 0;
  const load = effectiveLoad(set, type, bw || 0);
  if (!(load > 0) || load > 500) return 0;
  return e1rm(load, r);
}

/** Where a workout came from: live | import_strong | import_hevy | backup | calibration. */
export function sourceOf(w) {
  if (w.source) return w.source;
  if (w.calibration) return 'calibration';
  if (w.imported) return w.imported === 'hevy' ? 'import_hevy' : 'import_strong';
  return 'live';
}

// ── dates (league weeks are Monday-based in LEAGUE_TZ; daily caps use the lifter's own zone)

const dateFmts = new Map();
function fmtFor(tz) {
  let f = dateFmts.get(tz || 'UTC');
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { f = fmtFor('UTC'); }
    dateFmts.set(tz || 'UTC', f);
  }
  return f;
}

/** 'YYYY-MM-DD' of an instant in a time zone (falls back to UTC for an unknown zone). */
export function localDate(ms, tz) {
  const p = {};
  for (const x of fmtFor(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Monday of the week containing a 'YYYY-MM-DD' date. */
export function mondayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * DAY).toISOString().slice(0, 10);
}

/** League week (its Monday, 'YYYY-MM-DD') of an instant. */
export const leagueWeekOf = (ms, tz = LEAGUE_TZ) => mondayOf(localDate(ms, tz));

// ── bodyweight used for ranking (engagement.md §6.5)

/**
 * Rate-limited "ranking bodyweight": gains apply at once, counted losses are capped at 1.5 % a week,
 * and nothing goes below BMI 16 at the given height. points: [{t, kg}]. Returns bwAt(t) (null if no data).
 */
export function bwSeries(points, heightCm) {
  const pts = (points || []).filter((p) => p && isNum(p.t) && isNum(p.kg) && p.kg >= 30 && p.kg <= 250).sort((a, b) => a.t - b.t);
  const floor = isNum(heightCm) && heightCm >= 120 && heightCm <= 220 ? 16 * (heightCm / 100) ** 2 : 30;
  const series = [];
  let prev = null;
  for (const p of pts) {
    let v = p.kg;
    if (prev) v = Math.max(p.kg, prev.v * (1 - (0.015 * (p.t - prev.t)) / DAY / 7));
    prev = { t: p.t, v: Math.max(v, floor) };
    series.push(prev);
  }
  return (t) => {
    if (!series.length) return null;
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return series[ans < 0 ? 0 : ans].v;
  };
}

/** Strength level of a lift value for a lifter, with age taken in the year of the lift. */
export function liftLevel(exId, value, prof, bw, atMs) {
  const t = thresholds(exId, {
    sex: prof?.sex, bodyweight: bw || prof?.bodyweight, height: prof?.height, birthYear: prof?.birthYear,
    atYear: isNum(atMs) ? new Date(atMs).getUTCFullYear() : undefined,
  });
  return t ? levelFrom(value, t.t) : 0;
}

/** "Stronger than X % of lifters your size": the standards are built so L 1–5 ≈ the 5/20/50/80/95th percentile. */
const PCT_KNOTS = [[0, 0], [1, 5], [2, 20], [3, 50], [4, 80], [5, 95], [6, 99], [7, 99.9]];
export function standardsPercentile(L) {
  if (!isNum(L) || L <= 0) return 0;
  for (let i = 1; i < PCT_KNOTS.length; i++) {
    const [l1, p1] = PCT_KNOTS[i], [l0, p0] = PCT_KNOTS[i - 1];
    if (L <= l1) return Math.round((p0 + ((L - l0) / (l1 - l0)) * (p1 - p0)) * 10) / 10;
  }
  return 99.9;
}

// ── lift history and the plausibility ("jump") check (engagement.md §6.3)

const MONTH = 30.44 * DAY;
const monthlyAllowance = (L) => (L < 2 ? 0.15 : L < 3 ? 0.08 : L < 4 ? 0.04 : L < 5 ? 0.02 : 0.01);
const bestOf = (list) => list.reduce((b, x) => (!b || x.v > b.v ? x : b), null);

/**
 * Judge one lift's sessions in time order. Each session: { wid, t, v, L, base, board }
 *   base  = may serve as history (live, late or imported)   board = may be a board value (live, synced in time)
 * Sets s.status ('accepted' | 'pending' | 'unconfirmed' | 'held' | 'ignored') and s.pr (beat the previous
 * accepted best). `jump` = whitelisted lift (full check); other lifts with a standard only allow +15 %.
 * Confirmations only count from sessions up to `until` (ms).
 */
export function judgeLift(sessions, { jump = true, until = Infinity } = {}) {
  const acc = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    s.pr = false;
    if (!s.base && !s.board) { s.status = 'ignored'; continue; }
    const prev = bestOf(acc);
    if (prev && s.v <= prev.v * 1.0001) {
      s.status = 'accepted';
    } else {
      s.pr = !!prev;   // a lift's first record is never a PR
      const t = s.t;
      if (!jump) {
        s.status = !prev || s.v <= prev.v * HEAT.prOtherMaxJump ? 'accepted' : 'pending';
      } else {
        const allTime = bestOf(acc.filter((a) => a.t >= t - 3 * 365 * DAY));
        const short = bestOf(acc.filter((a) => a.t >= t - 365 * DAY && a.t <= t - 28 * DAY));
        const long = bestOf(acc.filter((a) => a.t >= t - 365 * DAY && a.t <= t - 180 * DAY));
        const allowed = (b) => b.v * (1 + 0.05 + monthlyAllowance(b.L) * Math.min(12, (t - b.t) / MONTH));
        if (allTime && s.v <= allTime.v * 1.05) s.status = 'accepted';                         // comeback
        else if (!short && !long) s.status = s.L >= BOARD.softLevel ? 'unconfirmed' : 'accepted';   // first record
        else {
          const pass = (!short || s.v <= allowed(short)) && (!long || s.v <= allowed(long));
          s.status = pass || s.L < BOARD.softLevel ? 'accepted' : 'pending';
        }
      }
      if (s.status !== 'accepted') {
        // a later session confirms it: ≥ 95 % within 21 days (pending), ≥ 90 % within 42 days (first record)
        const [days, frac] = s.status === 'pending' ? [21, 0.95] : [42, 0.9];
        const c = sessions.slice(i + 1).find((o) => o.wid !== s.wid && o.t > s.t && o.t <= until && o.t - s.t <= days * DAY && o.v >= frac * s.v && (o.base || o.board));
        if (c) s.status = 'accepted';
      }
    }
    if (s.L >= BOARD.holdLevel) s.status = 'held';
    if (s.status === 'accepted') acc.push(s);
  }
  return sessions;
}

// ── hard sets and Heat

/** Exercise info lookup → { type, pattern, mech } (unknown exercises: inferred from the set fields). */
function typeFor(info, exId, sets) {
  const x = info(exId);
  if (x?.type) return x.type;
  const s = sets.find(isWorkingSet) || {};
  if (isNum(s.d) && s.d > 0) return isNum(s.w) && s.w > 0 ? 'weight_distance' : 'distance_time';
  if (isNum(s.w) && s.w > 0) return isNum(s.r) ? 'weight_reps' : 'weight_time';
  if (isNum(s.r) && s.r > 0) return 'bw_reps';
  if (isNum(s.s) && s.s > 0) return 'time';
  return 'weight_reps';
}

/**
 * Raw hard sets in a workout (before caps), engagement.md §4.2 H2.
 * best: exId → best e1RM before this workout (for the 40 % load rule).
 */
export function hardSets(w, { info, best = {}, bw = 0 }) {
  let hs = 0, cardioSec = 0;
  for (const it of w.items || []) {
    const sets = it.sets || [];
    const type = typeFor(info, it.ex, sets);
    for (const s of sets) {
      if (!isWorkingSet(s)) continue;
      if (WEIGHTED_TYPES.has(type)) {
        const r = s.r;
        if (!isNum(r) || r < 1 || r > HEAT.hsMaxReps) continue;
        const load = effectiveLoad(s, type, bw);
        if (type === 'weight_reps' && !(load > 0)) continue;
        if (best[it.ex] > 0 && load < HEAT.hsLoadPct * best[it.ex]) continue;
        hs++;
      } else if (type === 'bw_reps') {
        if (isNum(s.r) && s.r >= HEAT.hsBwMinReps) hs++;
      } else if (type === 'time' || type === 'weight_time') {
        if (isNum(s.s) && s.s >= HEAT.hsHoldSec) hs++;
      } else if (type === 'distance_time') {
        if (isNum(s.s) && s.s > 0) cardioSec += Math.min(s.s, 3600);
      } else if (type === 'weight_distance') {
        if (isNum(s.d) && s.d > 0 && isNum(s.w) && s.w > 0) hs++;
      }
    }
  }
  return hs + Math.min(HEAT.cardioMaxHs, Math.floor(cardioSec / HEAT.cardioSecPerHs));
}

/**
 * Facts about one synced workout that Heat needs (stored server-side, frozen for edits made > 48 h
 * after the workout). receivedAt = when the server first saw it.
 */
export function workoutFacts(w, { info, best = {}, bw = 0, receivedAt = null, tz } = {}) {
  const start = Number(w.start), end = Number(w.end);
  const mins = (end - start) / 60000;
  const source = sourceOf(w);
  let reason = null;
  if (source !== 'live') reason = 'source';
  else if (!isNum(start) || !isNum(end) || !(end > start)) reason = 'invalid';
  else if (mins < HEAT.minMinutes) reason = 'too_short';
  else if (mins > HEAT.maxMinutes) reason = 'too_long';
  else if (isNum(receivedAt) && receivedAt - end > HEAT.lateHours * HOUR) reason = 'late';
  else if (isNum(receivedAt) && start > receivedAt + 10 * 60000) reason = 'future';
  return {
    id: String(w.id), start, end, source,
    day: isNum(start) ? localDate(start, tz) : null,
    week: isNum(end) ? leagueWeekOf(end) : null,
    mins: isNum(mins) ? Math.round(Math.min(Math.max(mins, 0), HEAT.capMinutes) * 10) / 10 : 0,
    hs: reason ? 0 : hardSets(w, { info, best, bw }),
    eligible: !reason, reason,
    prs: [],
  };
}

/**
 * Heat for one league week from that week's workout facts (engagement.md §4.2 H3–H7).
 * Returns { heat, reachedAt, hs, counted, eligible, firstAt, breakdown, per: [{id, hs, sets, workout, consistency, pr, prs, heat}] }.
 */
export function weekHeat(facts) {
  const list = facts.filter((f) => f.eligible).sort((a, b) => a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dayHs = {}, dayBonus = {}, dayN = {};
  let weekHs = 0, bonuses = 0, counted = 0, prCount = 0, total = 0, reachedAt = null;
  const sum = { sets: 0, workout: 0, consistency: 0, pr: 0 };
  const per = [];
  for (const f of list) {
    dayN[f.day] = (dayN[f.day] || 0) + 1;
    if (dayN[f.day] > HEAT.maxWorkoutsPerDay) { per.push({ id: f.id, hs: 0, sets: 0, workout: 0, consistency: 0, pr: 0, prs: [], heat: 0 }); continue; }
    const cap = Math.min(HEAT.workoutCap, HEAT.workoutCapBase + Math.floor(f.mins / 2));
    const hs = Math.max(0, Math.min(f.hs, cap, HEAT.dayCap - (dayHs[f.day] || 0)));
    dayHs[f.day] = (dayHs[f.day] || 0) + hs;
    let sets = 0;
    for (let i = 1; i <= hs; i++) {
      const n = weekHs + i;
      const band = HEAT.taper.find(([upTo]) => n <= upTo);
      sets += band ? band[1] : 0;
    }
    weekHs += hs;
    let workout = 0, consistency = 0;
    if (hs >= HEAT.workoutBonusMinHs && f.mins >= HEAT.workoutBonusMinMinutes && !dayBonus[f.day] && bonuses < HEAT.workoutBonusPerWeek) {
      workout = HEAT.workoutBonus;
      bonuses++;
      dayBonus[f.day] = 1;
      counted++;
      if (counted === HEAT.consistencyAt) consistency = HEAT.consistencyBonus;
    }
    const prs = [...new Set(f.prs || [])].slice(0, Math.max(0, Math.min(HEAT.prPerWorkout, HEAT.prPerWeek - prCount)));
    prCount += prs.length;
    const pr = prs.length * HEAT.prBonus;
    const heat = sets + workout + consistency + pr;
    sum.sets += sets; sum.workout += workout; sum.consistency += consistency; sum.pr += pr;
    total += heat;
    if (heat > 0) reachedAt = f.end;
    per.push({ id: f.id, hs, sets, workout, consistency, pr, prs, heat });
  }
  return {
    heat: total, reachedAt, hs: weekHs, counted, eligible: list.length,
    firstAt: list.length ? list[0].end : null, breakdown: { ...sum, hs: weekHs, workouts: counted, prs: prCount }, per,
  };
}

// ── per-user scoring (server entry point)

function sessionValue(type, sets, bw) {
  let v = 0;
  for (const s of sets) {
    if (!isWorkingSet(s)) continue;
    if (WEIGHTED_TYPES.has(type)) v = Math.max(v, boardE1rm(s, type, bw));
    else if (type === 'bw_reps') v = Math.max(v, isNum(s.r) && s.r <= 300 ? s.r : 0);
    else if (type === 'time' || type === 'weight_time') v = Math.max(v, isNum(s.s) && s.s <= 3600 ? s.s : 0);
  }
  return v;
}

/**
 * Score one lifter from their synced records.
 *   workouts: [{ id, w (payload), received (ms), modified (ms) }]   profile: synced profile payload
 *   body: synced weigh-ins [{t, weight}]   info(exId) → {type, pattern, mech}   tz: lifter's zone
 *   weeks: [{ week: 'YYYY-MM-DD', closesAt: ms }] league weeks still open for scoring
 *   frozen: workoutId → facts stored earlier (used for workouts edited > 48 h after they ended)
 *   boardProfile: {sex, height, birthYear} locked at board opt-in (falls back to the profile)
 * Returns { facts: [...], weeks: [...], board: {...} }.
 */
export function scoreUser({ workouts = [], profile = {}, body = [], info, tz, now, weeks = [], frozen = {}, boardProfile = null, accountCreatedAt = null }) {
  const prof = { sex: profile.sex, height: profile.height, birthYear: profile.birthYear, bodyweight: profile.bodyweight };
  const bprof = boardProfile && boardProfile.sex ? { ...prof, ...boardProfile } : prof;
  const list = workouts
    .filter((r) => r && r.w && isNum(Number(r.w.start)) && isNum(Number(r.w.end)))
    .map((r) => ({ ...r, src: sourceOf(r.w), start: Number(r.w.start), end: Number(r.w.end) }))
    .filter((r) => r.end <= now + 10 * 60000)
    .sort((a, b) => a.start - b.start || (String(a.id) < String(b.id) ? -1 : 1));

  const bwAt = bwSeries([
    ...list.filter((r) => r.src !== 'calibration').map((r) => ({ t: r.start, kg: Number(r.w.bw) })),
    ...(body || []).filter((b) => b && b.source !== 'samsung').map((b) => ({ t: Number(b.t), kg: Number(b.weight) })),
  ], bprof.height);
  const bwOf = (r) => bwAt(r.start) || Number(r.w.bw) || prof.bodyweight || null;

  // live & synced in time → board value; live (late) or imported → history only
  const inTime = (r) => r.src === 'live' && !(isNum(r.received) && r.received - r.end > HEAT.lateHours * HOUR);
  const isBase = (r) => r.src === 'live' || r.src === 'import_strong' || r.src === 'import_hevy';

  // per-exercise sessions, in time order
  const sessions = new Map();
  for (const r of list) {
    const bw = bwOf(r);
    for (const it of r.w.items || []) {
      if (!it || !it.ex) continue;
      const type = typeFor(info, it.ex, it.sets || []);
      const v = sessionValue(type, it.sets || [], bw);
      if (!(v > 0)) continue;
      const std = hasStandard(it.ex);
      const L = std ? liftLevel(it.ex, v, BOARD_LIFTS[it.ex] ? bprof : prof, bw, r.start) : 0;
      if (!sessions.has(it.ex)) sessions.set(it.ex, []);
      sessions.get(it.ex).push({ wid: String(r.id), t: r.start, v, L, bw, base: isBase(r), board: inTime(r), std });
    }
  }
  const bestBefore = (exId, t) => {
    let b = 0;
    for (const s of sessions.get(exId) || []) { if (s.t >= t) break; if ((s.base || s.board) && s.v > b) b = s.v; }
    return b;
  };

  // Heat: facts per workout in the open weeks, accepted PRs judged with sessions up to the week's close
  const openWeeks = new Map(weeks.map((x) => [x.week, x]));
  const factsOut = [];
  const weeksOut = [];
  for (const [week, wk] of openWeeks) {
    const judged = new Map();
    for (const [exId, ss] of sessions) {
      if (!hasStandard(exId)) continue;
      const copy = ss.filter((s) => s.t < wk.closesAt).map((s) => ({ ...s }));
      judged.set(exId, judgeLift(copy, { jump: !!BOARD_LIFTS[exId], until: wk.closesAt }));
    }
    const facts = [];
    for (const r of list) {
      if (r.end >= wk.closesAt || leagueWeekOf(r.end) !== week) continue;
      const fz = frozen[String(r.id)];
      let f;
      if (fz && isNum(r.modified) && r.modified - r.end > 48 * HOUR) {
        f = { ...fz, frozen: true };
      } else {
        const best = {};
        for (const it of r.w.items || []) if (it?.ex && !(it.ex in best)) best[it.ex] = bestBefore(it.ex, r.start);
        f = workoutFacts(r.w, { info, best, bw: bwOf(r) || 0, receivedAt: r.received, tz });
        if (f.eligible) {
          for (const [exId, js] of judged) {
            const s = js.find((x) => x.wid === String(r.id));
            if (s && s.pr && s.status === 'accepted') f.prs.push(exId);
          }
          f.prs.sort();
        }
      }
      facts.push(f);
    }
    const h = weekHeat(facts);
    const perById = new Map(h.per.map((p) => [p.id, p]));
    for (const f of facts) {
      const p = perById.get(f.id);
      factsOut.push({ id: f.id, week, end: f.end, eligible: f.eligible, reason: f.reason, heat: p ? p.heat : 0, hs: p ? p.hs : 0, facts: f });
    }
    weeksOut.push({ week, heat: h.heat, reachedAt: h.reachedAt, hs: h.hs, counted: h.counted, eligible: h.eligible, firstAt: h.firstAt, breakdown: h.breakdown });
  }

  return { facts: factsOut, weeks: weeksOut, board: boardFor({ list, sessions, now, accountCreatedAt, inTime, bprof }) };
}

/** Board Forge Score from the whitelisted lifts (engagement.md §3.2): ≥ 4 of 6 patterns, best of 180 days. */
function boardFor({ list, sessions, now, accountCreatedAt, inTime, bprof }) {
  const live30 = list.filter((r) => inTime(r) && r.end >= now - 30 * DAY && (r.end - r.start) / 60000 >= HEAT.minMinutes).length;
  const byPattern = {};
  let held = 0;
  for (const [exId, pattern] of Object.entries(BOARD_LIFTS)) {
    const ss = sessions.get(exId);
    if (!ss) continue;
    const judged = judgeLift(ss.map((s) => ({ ...s })), { jump: true, until: now });
    for (const s of judged) {
      if (s.status === 'held') { held++; continue; }
      if (s.status !== 'accepted' || !s.board || s.t < now - BOARD.windowDays * DAY) continue;
      if (!byPattern[pattern] || s.L > byPattern[pattern].L) byPattern[pattern] = { ex: exId, L: s.L, score: Math.round(s.L * 100) };
    }
  }
  const vals = Object.values(byPattern);
  const patterns = vals.length;
  let L = 0;
  if (patterns) {
    const tot = vals.reduce((a, v) => a + v.L, 0);
    L = (tot + (PATTERNS.length - patterns) * (tot / patterns) * 0.5) / PATTERNS.length;
  }
  let reason = null;
  if (isNum(accountCreatedAt) && now - accountCreatedAt < BOARD.minAccountDays * DAY) reason = 'account_age';
  else if (live30 < BOARD.minLiveWorkouts30d) reason = 'few_workouts';
  else if (patterns < BOARD.minPatterns) reason = 'patterns';
  return {
    eligible: !reason, reason, patterns, live30, held,
    level: Math.round(L * 1000) / 1000, score: Math.round(L * 100),
    standardsPct: standardsPercentile(L),
    cat: bprof.sex === 'female' ? 'f' : 'm',
    lifts: byPattern,
    listable: !reason && L < BOARD.verifyLevel,
    standardsVersion: STANDARDS_VERSION,
  };
}
