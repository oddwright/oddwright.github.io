// Strength standards → strength level (L) → metal rank tiers, plus the XP level curve.
//
// L is a continuous strength level: 1 = Beginner, 2 = Novice, 3 = Intermediate,
// 4 = Advanced, 5 = Elite (≈ population percentiles 5/20/50/80/95 among lifters).
// Standards are approximations compiled from public strength-standard datasets.
// They are expressed at a reference bodyweight (80 kg men / 60 kg women) and scaled
// allometrically (bodyweight^0.67) so lighter and heavier lifters are judged fairly,
// then nudged for height (longer levers = more work per rep) and age (masters / teens).

import { clamp, isNum } from './util.js';

/** Bump whenever the standards below change: server-side board scores are recomputed for the new version. */
export const STANDARDS_VERSION = 1;

const REF_BW = { m: 80, f: 60 };
const REF_H = { m: 178, f: 165 };

// [beginner, novice, intermediate, advanced, elite]
const KEY = {
  squat_bb: { m: [0.85, 1.15, 1.55, 2.0, 2.55], f: [0.5, 0.8, 1.15, 1.6, 2.1] },
  bench_press_bb: { m: [0.6, 0.85, 1.2, 1.6, 2.05], f: [0.33, 0.52, 0.78, 1.1, 1.45] },
  deadlift_bb: { m: [1.0, 1.4, 1.85, 2.35, 2.9], f: [0.68, 1.0, 1.4, 1.9, 2.4] },
  ohp_bb: { m: [0.4, 0.57, 0.77, 1.0, 1.27], f: [0.26, 0.4, 0.57, 0.78, 1.0] },
  bent_over_row_bb: { m: [0.5, 0.72, 1.0, 1.35, 1.75], f: [0.3, 0.47, 0.7, 0.98, 1.3] },
  bench_press_db: { m: [0.21, 0.34, 0.49, 0.66, 0.86], f: [0.12, 0.2, 0.3, 0.43, 0.57] },
  shoulder_press_db: { m: [0.15, 0.24, 0.35, 0.49, 0.64], f: [0.09, 0.15, 0.22, 0.31, 0.41] },
  curl_bb: { m: [0.25, 0.4, 0.6, 0.85, 1.1], f: [0.15, 0.25, 0.4, 0.57, 0.77] },
  curl_db: { m: [0.1, 0.16, 0.25, 0.36, 0.48], f: [0.06, 0.1, 0.16, 0.24, 0.33] },
  lateral_raise_db: { m: [0.05, 0.1, 0.16, 0.25, 0.35], f: [0.03, 0.06, 0.1, 0.16, 0.23] },
  tricep_pushdown_bar: { m: [0.25, 0.4, 0.6, 0.85, 1.15], f: [0.15, 0.26, 0.4, 0.58, 0.8] },
  lat_pulldown: { m: [0.5, 0.7, 0.98, 1.3, 1.66], f: [0.33, 0.5, 0.72, 1.0, 1.3] },
  leg_press: { m: [1.0, 1.8, 2.9, 4.3, 5.8], f: [0.9, 1.6, 2.6, 3.8, 5.1] },
  leg_extension: { m: [0.4, 0.66, 1.0, 1.4, 1.9], f: [0.3, 0.5, 0.78, 1.1, 1.5] },
  leg_curl_lying: { m: [0.32, 0.5, 0.75, 1.04, 1.36], f: [0.22, 0.36, 0.55, 0.78, 1.04] },
  hip_thrust_bb: { m: [0.68, 1.23, 1.9, 2.7, 3.6], f: [0.6, 1.05, 1.6, 2.3, 3.1] },
  // total load = bodyweight + added (or − assistance)
  pull_up: { kind: 'total', m: [1.03, 1.2, 1.43, 1.7, 1.97], f: [0.8, 1.03, 1.17, 1.37, 1.6] },
  dip_triceps: { kind: 'total', m: [1.07, 1.33, 1.67, 2.0, 2.33], f: [0.85, 1.03, 1.2, 1.45, 1.7] },
  // best reps in a set
  push_up: { kind: 'reps', m: [4, 15, 30, 48, 70], f: [1, 5, 15, 28, 45] },
  inverted_row: { kind: 'reps', m: [3, 8, 15, 22, 30], f: [1, 4, 10, 16, 24] },
  hanging_leg_raise: { kind: 'reps', m: [2, 6, 12, 20, 30], f: [1, 4, 10, 16, 25] },
  pistol_squat: { kind: 'reps', m: [1, 3, 8, 15, 25], f: [1, 2, 6, 12, 20] },
  handstand_push_up: { kind: 'reps', m: [1, 2, 6, 12, 20], f: [1, 1.5, 3, 7, 12] },
  bw_squat: { kind: 'reps', m: [10, 25, 45, 70, 100], f: [8, 20, 40, 60, 90] },
  // best seconds held
  plank: { kind: 'time', m: [20, 45, 90, 150, 240], f: [20, 45, 90, 150, 240] },
};

// Derived standards: [reference exercise, multiplier]. Selectorized/plate-loaded machines get
// multipliers ≥ their free-weight cousin — stacks and levers carry mechanical advantage.
const REL = {
  incline_bench_bb: ['bench_press_bb', 0.82], incline_bench_db: ['bench_press_db', 0.9],
  incline_bench_smith: ['bench_press_bb', 0.88], decline_bench_bb: ['bench_press_bb', 1.05],
  decline_bench_db: ['bench_press_db', 1.03], bench_press_smith: ['bench_press_bb', 1.05],
  close_grip_bench: ['bench_press_bb', 0.88], floor_press_bb: ['bench_press_bb', 0.92],
  chest_press_machine: ['bench_press_bb', 1.05], incline_chest_press_machine: ['bench_press_bb', 0.98],
  chest_fly_db: ['bench_press_db', 0.5], incline_fly_db: ['bench_press_db', 0.45],
  pec_deck: ['bench_press_bb', 0.8], cable_crossover: ['bench_press_bb', 0.3], cable_fly_low: ['bench_press_bb', 0.25],
  pullover_db: ['bench_press_db', 0.77],
  dip_chest: ['dip_triceps', 1], dip_assisted: ['dip_triceps', 1],
  sumo_deadlift_bb: ['deadlift_bb', 0.97], trap_bar_deadlift: ['deadlift_bb', 1.05],
  romanian_deadlift_bb: ['deadlift_bb', 0.72], romanian_deadlift_db: ['deadlift_bb', 0.33],
  stiff_leg_deadlift_bb: ['deadlift_bb', 0.7], rack_pull: ['deadlift_bb', 1.15], good_morning: ['squat_bb', 0.5],
  pendlay_row: ['bent_over_row_bb', 0.95], row_db: ['bent_over_row_bb', 0.47], t_bar_row: ['bent_over_row_bb', 0.9],
  seated_cable_row: ['bent_over_row_bb', 0.95], chest_supported_row_db: ['bent_over_row_bb', 0.38],
  row_machine: ['bent_over_row_bb', 0.95],
  chin_up: ['pull_up', 1.04], pull_up_assisted: ['pull_up', 1],
  lat_pulldown_close: ['lat_pulldown', 1], straight_arm_pulldown: ['lat_pulldown', 0.45],
  face_pull: ['lat_pulldown', 0.35], shrug_bb: ['deadlift_bb', 0.75], shrug_db: ['deadlift_bb', 0.32],
  reverse_fly_db: ['lateral_raise_db', 0.9], reverse_pec_deck: ['lat_pulldown', 0.62], reverse_fly_cable: ['lateral_raise_db', 0.6],
  shoulder_press_machine: ['ohp_bb', 1.2], shoulder_press_smith: ['ohp_bb', 1.05], push_press: ['ohp_bb', 1.25],
  arnold_press: ['shoulder_press_db', 0.85], landmine_press: ['ohp_bb', 0.7],
  lateral_raise_cable: ['lateral_raise_db', 0.75], lateral_raise_machine: ['ohp_bb', 0.6],
  front_raise_db: ['lateral_raise_db', 1.15], upright_row_bb: ['ohp_bb', 0.8],
  curl_ez: ['curl_bb', 1], curl_cable: ['curl_bb', 0.9], hammer_curl_db: ['curl_db', 1.1],
  preacher_curl: ['curl_bb', 0.85], preacher_curl_machine: ['curl_bb', 0.85], incline_curl_db: ['curl_db', 0.8],
  concentration_curl: ['curl_db', 0.85], reverse_curl_bb: ['curl_bb', 0.75],
  tricep_pushdown_rope: ['tricep_pushdown_bar', 0.85], skull_crusher: ['bench_press_bb', 0.38],
  overhead_ext_db: ['bench_press_db', 0.56], overhead_ext_cable: ['tricep_pushdown_bar', 0.8],
  kickback_db: ['curl_db', 0.6], wrist_curl_bb: ['curl_bb', 0.95], reverse_wrist_curl: ['curl_bb', 0.6],
  front_squat_bb: ['squat_bb', 0.82], squat_smith: ['squat_bb', 0.95], goblet_squat: ['squat_bb', 0.34],
  hack_squat: ['squat_bb', 1.1], bulgarian_split_squat_db: ['squat_bb', 0.22], lunge_db: ['squat_bb', 0.22],
  walking_lunge_db: ['squat_bb', 0.22], lunge_bb: ['squat_bb', 0.55], step_up_db: ['squat_bb', 0.2],
  leg_curl_seated: ['leg_curl_lying', 1.05], hip_thrust_machine: ['hip_thrust_bb', 0.9], glute_bridge_bb: ['hip_thrust_bb', 0.9],
  glute_kickback_cable: ['leg_curl_lying', 0.45], hip_abduction_machine: ['leg_extension', 1], hip_adduction_machine: ['leg_extension', 1],
  calf_raise_standing: ['squat_bb', 0.85], calf_raise_seated: ['squat_bb', 0.6], calf_press_leg_press: ['leg_press', 0.55],
  kettlebell_swing: ['deadlift_bb', 0.25], cable_crunch: ['lat_pulldown', 0.75], ab_crunch_machine: ['lat_pulldown', 0.7],
  power_clean: ['deadlift_bb', 0.55], hang_clean: ['deadlift_bb', 0.52], snatch: ['deadlift_bb', 0.42],
  clean_and_jerk: ['deadlift_bb', 0.52], thruster: ['squat_bb', 0.45],
  push_up_incline: ['push_up', 1.5], push_up_decline: ['push_up', 0.8], push_up_diamond: ['push_up', 0.65],
  side_plank: ['plank', 0.7], hollow_hold: ['plank', 0.6], dead_hang: ['plank', 0.65],
  pause_squat_bb: ['squat_bb', 0.88], pause_bench_bb: ['bench_press_bb', 0.93], floor_press_db: ['bench_press_db', 0.9],
  row_db_two_arm: ['bent_over_row_bb', 0.4], single_leg_rdl_db: ['deadlift_bb', 0.2], cable_pull_through: ['deadlift_bb', 0.35],
  pike_push_up: ['push_up', 0.5], squat_bw: ['bw_squat', 1], lunge_bw: ['bw_squat', 0.6], glute_bridge_bw: ['bw_squat', 1.1],
};

export function hasStandard(exId) {
  return !!(KEY[exId] || REL[exId]);
}

function resolve(exId) {
  if (KEY[exId]) return { ...KEY[exId], mult: 1, kind: KEY[exId].kind || 'ratio', ref: exId };
  const rel = REL[exId];
  if (!rel) return null;
  const base = KEY[rel[0]];
  return { ...base, mult: rel[1], kind: base.kind || 'ratio', ref: rel[0] };
}

/** Age in years. `prof.atYear` (optional) takes the age in that year instead of now (server: age at the lift). */
export function ageOf(prof) {
  return prof.birthYear ? (prof.atYear ?? new Date().getFullYear()) - prof.birthYear : null;
}

/** Performance multiplier for age (masters + teenage lifters get credit). */
export function ageFactor(age) {
  if (!isNum(age)) return 1;
  return 1 + Math.max(0, age - 35) * 0.012 + Math.max(0, 19 - age) * 0.025;
}

/** Thresholds (in kg / reps / seconds) for an exercise and lifter, or null. */
export function thresholds(exId, prof) {
  const s = resolve(exId);
  if (!s) return null;
  const sex = prof.sex === 'female' ? 'f' : 'm';
  const bw = clamp(prof.bodyweight || REF_BW[sex], 30, 250);
  let t = s[sex].map((x) => x * s.mult);
  if (s.kind === 'ratio' || s.kind === 'total') {
    if (s.kind === 'ratio') t = t.map((x) => x * REF_BW[sex] * Math.pow(bw / REF_BW[sex], 0.67));
    else t = t.map((x) => x * bw);
    const hf = clamp(Math.sqrt((prof.height || REF_H[sex]) / REF_H[sex]), 0.93, 1.07);
    const af = ageFactor(ageOf(prof));
    t = t.map((x) => x / hf / af);
  }
  return { kind: s.kind, t, ref: s.ref };
}

/** Continuous strength level from a performance value. */
export function levelFrom(v, t) {
  if (!isNum(v) || v <= 0 || !t) return 0;
  if (v < t[0]) return v / t[0];
  for (let i = 0; i < 4; i++) if (v < t[i + 1]) return 1 + i + (v - t[i]) / (t[i + 1] - t[i]);
  return Math.min(7, 5 + (v - t[4]) / Math.max(1e-6, t[4] - t[3]));
}

/** Inverse: performance needed for a level. */
export function valueForLevel(L, t) {
  if (!t) return 0;
  if (L <= 1) return L * t[0];
  if (L >= 5) return t[4] + (L - 5) * (t[4] - t[3]);
  const i = Math.floor(L) - 1;
  return t[i] + (L - 1 - i) * (t[i + 1] - t[i]);
}

export const LEVEL_NAMES = ['Untrained', 'Beginner', 'Novice', 'Intermediate', 'Advanced', 'Elite', 'World Class'];
export const levelName = (L) => LEVEL_NAMES[clamp(Math.floor(L), 0, 6)];

// ── Metal rank tiers
export const TIERS = [
  { id: 'rust', name: 'Rust', min: 0, c: ['#5B2E1C', '#A9552F', '#D9824F'], ink: '#FFD9C2' },
  { id: 'copper', name: 'Copper', min: 0.75, c: ['#6E3B1E', '#C2733A', '#F2A66B'], ink: '#FFE7D4' },
  { id: 'bronze', name: 'Bronze', min: 1.25, c: ['#4F3A22', '#A67C46', '#E4BE7F'], ink: '#FFF0D6' },
  { id: 'iron', name: 'Iron', min: 1.75, c: ['#2E3238', '#6B737D', '#B4BCC6'], ink: '#EEF2F6' },
  { id: 'steel', name: 'Steel', min: 2.25, c: ['#28394A', '#5C7D99', '#B5CDE0'], ink: '#EAF4FC' },
  { id: 'silver', name: 'Silver', min: 2.75, c: ['#5F6770', '#B9C2CB', '#F7FAFC'], ink: '#1B1F24' },
  { id: 'gold', name: 'Gold', min: 3.25, c: ['#7A5208', '#D9A21E', '#FFE58A'], ink: '#2B1C00' },
  { id: 'platinum', name: 'Platinum', min: 3.75, c: ['#1E5E5A', '#5FC9C0', '#DFFFFB'], ink: '#062523' },
  { id: 'titanium', name: 'Titanium', min: 4.25, c: ['#2C2F5E', '#7D82C9', '#DADDFF'], ink: '#0D0F2E' },
  { id: 'orichalcum', name: 'Orichalcum', min: 4.75, c: ['#7A1F0C', '#F0602E', '#FFC98A'], ink: '#2A0700' },
  { id: 'starforged', name: 'Starforged', min: 5.4, c: ['#2A145E', '#8A5CFF', '#7FE7FF'], ink: '#FFFFFF' },
];
export const TIER_BY_ID = Object.fromEntries(TIERS.map((t) => [t.id, t]));
const DIVS = ['III', 'II', 'I'];

export function rankOf(L) {
  L = Math.max(0, L || 0);
  let i = TIERS.length - 1;
  while (i > 0 && L < TIERS[i].min) i--;
  const tier = TIERS[i];
  const nextTier = TIERS[i + 1];
  if (!nextTier) {
    return { tier, idx: i, div: null, label: tier.name, step: i * 3 + 3, progress: 1, next: null, L };
  }
  const span = nextTier.min - tier.min;
  const pos = (L - tier.min) / span; // 0..1 across the whole tier
  const d = Math.min(2, Math.floor(pos * 3));
  const divStart = tier.min + (span * d) / 3;
  const divEnd = tier.min + (span * (d + 1)) / 3;
  const nextLabel = d < 2 ? `${tier.name} ${DIVS[d + 1]}` : nextTier.id === 'starforged' ? 'Starforged' : `${nextTier.name} III`;
  return {
    tier, idx: i, div: DIVS[d], label: `${tier.name} ${DIVS[d]}`,
    step: i * 3 + d, // monotonic index used to detect rank-ups
    progress: (L - divStart) / (divEnd - divStart),
    next: { label: nextLabel, L: divEnd },
    L,
  };
}

export const UNRANKED = { tier: { id: 'unranked', name: 'Unranked', c: ['#24272E', '#3A3F49', '#5A606C'], ink: '#C9CED6' }, idx: -1, div: null, label: 'Unranked', step: -1, progress: 0, next: null, L: 0 };

export const strengthScore = (L) => Math.round((L || 0) * 100);

// ── Movement patterns used for the overall "Forge Rank"
export const PATTERNS = [
  { id: 'squat', name: 'Squat', ex: 'squat_bb' },
  { id: 'hinge', name: 'Hinge', ex: 'deadlift_bb' },
  { id: 'h_push', name: 'Horizontal Push', ex: 'bench_press_bb' },
  { id: 'v_push', name: 'Vertical Push', ex: 'ohp_bb' },
  { id: 'h_pull', name: 'Horizontal Pull', ex: 'bent_over_row_bb' },
  { id: 'v_pull', name: 'Vertical Pull', ex: 'pull_up' },
];

// ── XP levels (forging titles)
/** Cumulative XP needed to reach level n. Level 2 = 300 XP; each level costs 120 XP more than the last. */
export const xpForLevel = (n) => (n <= 1 ? 0 : 300 * (n - 1) + 60 * (n - 1) * (n - 2));

export function levelInfo(xp) {
  let n = 1;
  // closed-form estimate then adjust
  n = Math.max(1, Math.floor((-(240) + Math.sqrt(240 * 240 + 240 * xp)) / 120) + 1);
  while (xpForLevel(n + 1) <= xp) n++;
  while (n > 1 && xpForLevel(n) > xp) n--;
  const base = xpForLevel(n), next = xpForLevel(n + 1);
  return { level: n, xp, into: xp - base, need: next - base, progress: (xp - base) / (next - base), title: titleFor(n) };
}

export const TITLES = [
  [1, 'Fresh Ore'], [3, 'Spark'], [5, 'Apprentice'], [10, 'Journeyman'], [15, 'Ironsmith'],
  [20, 'Steelsmith'], [25, 'Bladesmith'], [30, 'Master Smith'], [40, 'Forgemaster'],
  [50, 'Ironlord'], [65, 'Titan'], [80, 'Mythic'], [100, 'Legend of the Forge'],
];
export function titleFor(level) {
  let t = TITLES[0][1];
  for (const [l, name] of TITLES) if (level >= l) t = name;
  return t;
}

// ── Accent colours unlocked by level (cosmetic rewards)
export const ACCENTS = [
  { id: 'ember', name: 'Ember', level: 1, c: '#FF5A1F', c2: '#FFA23A' },
  { id: 'arc', name: 'Arc Blue', level: 5, c: '#2F8CFF', c2: '#6FD3FF' },
  { id: 'venom', name: 'Venom', level: 10, c: '#2BD46E', c2: '#B8FF5C' },
  { id: 'royal', name: 'Royal', level: 15, c: '#8A5CFF', c2: '#E07BFF' },
  { id: 'crimson', name: 'Crimson', level: 20, c: '#E8173D', c2: '#FF7A59' },
  { id: 'gold', name: 'Gilded', level: 30, c: '#E0A400', c2: '#FFE58A' },
  { id: 'glacier', name: 'Glacier', level: 40, c: '#5FC9C0', c2: '#DFFFFB' },
  { id: 'star', name: 'Starforged', level: 50, c: '#8A5CFF', c2: '#7FE7FF' },
];
