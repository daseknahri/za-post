'use strict';
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// lib/speed.js — the SINGLE SOURCE OF TRUTH for the posting-speed model.
//
// ONE vocabulary, THREE tiers, used identically by the fleet baseline (settings.speedMode) AND each account's
// optional override (account.pace): 'safe' | 'fast' | 'max'.  (An absent / '' / 'inherit' pace = FOLLOW the fleet.)
//
//   safe — full human: real typing, reading dwells, jitter, and the FULL 20s/30s anti-spam floors. Cold / warming /
//          reserve accounts.  (Behaviourally = the app's old 'normal' + 'slow'.)
//   fast — paste + skip the cosmetic reading dwells, but KEEP the full anti-spam floors (the safe speed-up). Warmed
//          accounts.  (= old 'fast'.)
//   max  — everything pasted, smallest still-nonzero gaps + trimmed settles; aggressive. All-warmed fleet, manual
//          first post.  (= old 'turbo' + 'instant' merged, taking the aggressive end.)
//
// WHY a resolver instead of renaming the worker internals: the worker branches on an INTERNAL speed token in ~65
// places, and the double-post / post→link ANTI-SPAM FLOORS key off the exact strings 'instant' / 'turbo'. Renaming
// those in place is a Sacred-surface edit. Instead this module maps each user tier to the worker's EXISTING internal
// token (TIER_INTERNAL) so the worker — and every floor/guard — is byte-for-byte unchanged. The 3-tier vocabulary
// lives at the store + UI + resolver boundary; the internal token is an implementation detail behind resolve*().
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const TIERS = ['safe', 'fast', 'max']; // ordered most-human → most-aggressive

// Per-tier timing ranges (the numeric fields the worker reads). Lifted VERBATIM from the old presets so a migrated
// config behaves identically:  safe = old 'normal', fast = old 'fast', max = old 'instant'.
const TIER_TIMING = {
  safe: { waitIntervalMin: 90, waitIntervalMax: 180, accountDelayMin: 1, accountDelayMax: 4, groupDelayMin: 120, groupDelayMax: 300, commentDelayMin: 60, commentDelayMax: 180, pageScrollDwellSecMin: 3, pageScrollDwellSecMax: 15, prePublishDwellSecMin: 3, prePublishDwellSecMax: 8, commentDwellSecMin: 1, commentDwellSecMax: 4, composerOpenInitialDelayMs: 1500 },
  fast: { waitIntervalMin: 45, waitIntervalMax: 90, accountDelayMin: 1, accountDelayMax: 2, groupDelayMin: 120, groupDelayMax: 180, commentDelayMin: 45, commentDelayMax: 90, pageScrollDwellSecMin: 2, pageScrollDwellSecMax: 6, prePublishDwellSecMin: 1, prePublishDwellSecMax: 4, commentDwellSecMin: 1, commentDwellSecMax: 3, composerOpenInitialDelayMs: 1000 },
  max:  { waitIntervalMin: 0, waitIntervalMax: 3, accountDelayMin: 0, accountDelayMax: 0, groupDelayMin: 0, groupDelayMax: 7, commentDelayMin: 0, commentDelayMax: 7, pageScrollDwellSecMin: 0, pageScrollDwellSecMax: 0, prePublishDwellSecMin: 0, prePublishDwellSecMax: 0, commentDwellSecMin: 0, commentDwellSecMax: 0, composerOpenInitialDelayMs: 800 },
};

// Map a user tier → the worker's INTERNAL speed token. The worker's ~65 branches + the anti-spam floors read THIS
// token and are UNCHANGED; only this table knows the user↔internal correspondence. safe→'normal' (full human,
// full floors), fast→'fast' (paste, full floors), max→'instant' (paste, small floors, trimmed settles).
const TIER_INTERNAL = { safe: 'normal', fast: 'fast', max: 'instant' };

// UI display metadata — kept here so Settings + Quick Setup + the Accounts card all render ONE consistent label.
const TIER_META = {
  safe: { label: 'Safe', emoji: '🛡️', blurb: 'Full human behaviour — real typing, reading pauses, full anti-spam gaps. Safest; best for cold, warming, or reserve accounts.' },
  fast: { label: 'Fast', emoji: '⚡', blurb: 'Pastes and skips the reading pauses but KEEPS the full anti-spam gaps. The quickest still-safe pace — for warmed accounts.' },
  max:  { label: 'Max', emoji: '🚀', blurb: 'Everything pasted, smallest gaps, aggressive. Highest ban risk — all-warmed fleet only, and post the first item manually.' },
};

// Which timing keys a PER-ACCOUNT override controls (per-post cadence) vs. which stay FLEET-level (cycle/stagger).
// A per-account tier NEVER changes cycle cadence — that would move fleet-wide timing — so those come from the baseline.
const PER_POST_KEYS = ['groupDelayMin', 'groupDelayMax', 'commentDelayMin', 'commentDelayMax', 'pageScrollDwellSecMin', 'pageScrollDwellSecMax', 'commentDwellSecMin', 'commentDwellSecMax', 'prePublishDwellSecMin', 'prePublishDwellSecMax', 'composerOpenInitialDelayMs'];
const CYCLE_KEYS = ['waitIntervalMin', 'waitIntervalMax', 'accountDelayMin', 'accountDelayMax'];

const isTier = (v) => v === 'safe' || v === 'fast' || v === 'max';

// Migrate a legacy / global speedMode → a canonical tier (NEVER 'inherit' — the fleet baseline is always concrete).
// old:  normal|slow → safe · fast → fast · turbo|instant → max · (already-canonical passes through) · unknown → safe.
function normalizeSpeedMode(v) {
  if (isTier(v)) return v;
  if (v === 'normal' || v === 'slow') return 'safe';
  if (v === 'fast') return 'fast';
  if (v === 'turbo' || v === 'instant') return 'max';
  return 'safe';
}

// Migrate a legacy per-account pace → a canonical override tier, or null = INHERIT the fleet baseline.
// old:  '' | null | 'inherit' | 'normal' (the old 1× / follow-global) → inherit(null) · 'safe' → safe · 'slow' → safe
//       · 'fast' → fast · 'turbo'|'instant' → max · unknown → inherit (never pin an account to an unexpected pace).
function normalizePace(v) {
  if (v == null || v === '' || v === 'inherit' || v === 'normal') return null;
  if (isTier(v)) return v;
  if (v === 'slow') return 'safe';
  if (v === 'turbo' || v === 'instant') return 'max';
  return null;
}

// THE resolver — replaces the old multiplicative applyPace. Given the fleet settings + ONE account's pace, return
// the effective settings the worker consumes. NO COMPOUNDING: a per-account tier SELECTS that tier's per-post timing
// (it is not a multiplier stacked on the fleet ranges). Cycle/stagger cadence ALWAYS comes from the fleet baseline.
// The worker keeps reading the same granular keys + settings.speedMode — this just fills them from the tier table.
function resolveEffectiveSettings(settings, accountPace) {
  settings = settings || {};
  const fleetTier = normalizeSpeedMode(settings.speedMode);
  const override = normalizePace(accountPace);
  const effTier = override || fleetTier;               // the account's effective tier (override else fleet baseline)
  const post = TIER_TIMING[effTier];
  const base = TIER_TIMING[fleetTier];
  const out = { ...settings };
  for (const k of CYCLE_KEYS) out[k] = base[k];        // cycle cadence: ALWAYS the fleet baseline (per-account can't move it)
  for (const k of PER_POST_KEYS) out[k] = post[k];     // per-post cadence: the effective tier
  out.speedMode = TIER_INTERNAL[effTier];              // hand the worker its INTERNAL token (unchanged branches read this)
  if (effTier === 'safe') out.humanizeMaster = true;   // safe = fully human regardless of any global humanize toggle
  return out;
}

module.exports = { TIERS, TIER_TIMING, TIER_INTERNAL, TIER_META, PER_POST_KEYS, CYCLE_KEYS, isTier, normalizeSpeedMode, normalizePace, resolveEffectiveSettings };
