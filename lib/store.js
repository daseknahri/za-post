// lib/store.js
// Single JSON-file data store + filesystem layout for the app.
// Layout (all under Electron userData):
//   <userData>/data.json                      -> { posts, groups, accounts, settings, proxies, useProxies }
//   <userData>/accounts/<name>/chrome-profile -> per-account Chromium user-data dir (Puppeteer)
//   <userData>/accounts/<name>/cookies.json   -> imported / saved cookies
//   <userData>/storage/images/                -> decoded post & comment images

const path = require('path');
const fs = require('fs');
const SPEED = require('./speed'); // canonical 3-tier speed model (safe/fast/max) — single source of truth for speedMode/pace normalization + migration

let USER_DATA = null;          // set once via init()
let DATA_FILE = null;
let ACCOUNTS_DIR = null;
let IMAGES_DIR = null;

const DEFAULT_SETTINGS = {
  // Pacing — defaults raised to a far more human, lower-spam-risk tempo (all delays are
  // additionally jittered ±20-30% at runtime so the cadence is never metronomic).
  parallelAccounts: 2,  // accounts posting concurrently per batch (staggered, see staggerAccounts)
  postsPerGroup: 1,     // posts each account makes per group per cycle (0 = no limit; unique modes always 1)
  maxCycles: 0,         // 0 = run continuously; N = stop after N cycles
  // RESERVED — NOT consumed by the engine. These were an early "contiguous-block group assignment" idea that the
  // campaign-plan split (group-signature clusters → idx%K) SUPERSEDED; per-account explicit group selection covers the
  // real workflow. Kept (persisted + clamped) only for backward-compat — do NOT assume they affect posting/assignment.
  groupsPerBlock: 4,    // RESERVED — not read by the engine
  accountsPerBatch: 1,  // RESERVED — not read by the engine
  proxyTimezone: '',    // IANA tz (e.g. "America/New_York") applied to all PROXIED accounts so their browser clock
                        // matches their proxy IP geo (an FB bot signal). Empty = no override (host clock). A
                        // per-account `account.timezone` overrides this. Set it to your proxy provider's region.
  proxyLocale: '',      // BCP-47 locale (e.g. "en-US") applied to all PROXIED accounts (navigator.language + Accept-Language)
                        // so the browser's locale matches the proxy IP country — else the HOST locale (e.g. French here)
                        // leaks on a foreign proxy (a correlation signal). Empty = no override. account.locale overrides this.
  // NOTE: the legacy single-value timing keys (waitInterval/accountDelay/groupDelay) were REMOVED — the loop
  // reads the *Min/*Max ranges below. migrateTimingRanges() still derives the ranges from an OLD data.json
  // that has only the legacy keys, so existing installs carry their tuning over.
  commentWithImage: false,
  autoDeletePosted: false,
  hideBrowser: true,    // hidden = off-screen + focus/visibility emulation (posts reliably; confirmed live)
  // NOTE: useProxies is a TOP-LEVEL data.json field (normalize() handles it), NOT a setting — do not add it here.
  enableTunnel: false,  // opt-in: start Cloudflare tunnel for remote dashboard access
  resumeOnStartup: false,  // opt-in: auto-resume an interrupted run after shutdown/crash
  launchOnStartup: false,  // register the app as a Windows login item
  autoStartDaily: false,   // opt-in: Windows Task Scheduler hook — launch + post daily at dailyPostTime even if closed
  loopCampaign: false,     // unique modes: false = complete after each post once; true = recycle + rotate forever
  shuffleCampaign: false,  // campaign-plan "random" work-pattern: shuffle the library before splitting it across agents
  postSets: [],            // named post-groups [{id,name}] — each batch can draw from ONE set (post.postSetId / account.postSetId); [] = feature off (one shared library)
  fireOrder: 'batch',      // launch order across batches: 'batch' (A1 A2 A3 B1 B2 B3) | 'interleave' (A1 B1 A2 B2 …) | 'random'
  // ---- anti-spam hardening (all on by default; tune in Settings) -----------------------
  commentDelayMin: 60,     // seconds: lower bound of the random wait between a post and its first comment
  commentDelayMax: 180,    // seconds: upper bound (the post→link pattern is a top spam trigger; 6s was bot-like)
  dailyCap: 0,             // max group-posts PER ACCOUNT per day (0 = no cap; e.g. 5-10 for young accounts)
  enableWarmup: true,      // ON by default: new accounts browse/scroll/react before their first post (only while run-count < warmupRuns, so established accounts are unaffected); toggle off in Settings
  warmupRuns: 5,           // an account is "new" (warmed up before posting) for its first N successful runs
  varyContent: true,       // expand {a|b|c} spintax in captions/comments so each post differs
  varyImages: true,        // perturb image bytes per post so the perceptual hash differs across groups
  randomizeLinks: true,    // append a unique tracking param to links in the first comment
  staggerAccounts: true,   // spread account start times within a batch instead of all-at-once
  rateLimitCooldownHours: 4, // base cool-down before a rate-limited account is tried again (doubles per strike)
  reserveAccounts: 0,      // 0 = off (set e.g. 3 in Settings). Keep this many healthy accounts OUT of posting each cycle — held in reserve to (a) place orphaned link-comments on posts whose own account got blocked, and (b) take over a cooled-down account's slot. Always leaves ≥1 account posting.
  reserveMaxJobsPerCycle: 1, // #5: max browser jobs ONE account may do per cycle (poster post / reserve takeover / Phase-3 rescue / Phase-4 re-post). 1 = today's one-job cap; raise 2..5 so a healthy reserve covers MULTIPLE drops when drops outnumber reserves (clamped 1..5).
  // ---- humanization / unpredictable cadence (every gap is a RANDOM value in [min,max], never a
  // constant — a fixed cadence is a top spam signal). The min/max RANGES below supersede the legacy
  // single-value keys above; normalize() migrates an old data.json (single key -> ±20% range).
  waitIntervalMin: 90,  waitIntervalMax: 180,   // minutes between cycles (range)
  accountDelayMin: 1,   accountDelayMax: 4,      // minutes between account starts (range)
  groupDelayMin: 120,   groupDelayMax: 300,      // seconds between groups within an account (range; floor 120s)
  realIpMaxConcurrent: 3, // MAX browsers posting AT ONCE on one shared IP (no-proxy fleets). The effective concurrency is
                          // min(parallelAccounts, this) — so on a real IP this is what caps how many browsers open together.
                          // 3 (default) ≈ a normal household's device count (the safe balance). Raise for more SPEED (up to 8) at
                          // more ban risk (many simultaneous FB sessions from one line is a spam/correlation signal). Also bounded by
                          // free RAM (~300-500MB/browser). Proxied fleets ignore this (concurrency = parallelAccounts). Clamped 1..8.
  realIpMinPostGapSec: 15, // per-IP aggregate post spacing — DEFAULT 15s (anti-burst hardening for one shared IP; set 0 = OFF). No-proxy fleets only: the MINIMUM
                          // seconds between two INTER-GROUP posts across the fleet on the one shared IP (effective inter-group gap =
                          // max(configured gap, this)). Each account's FIRST post is spaced by the launch throttle (~15-45s) instead,
                          // so a value up to ~45s is fully covered; larger values bound the sustained rate. Only ever SLOWS, never
                          // touches double-post/coverage guards. Enforced fleet-wide via orchestrator._ipPostGate.
  pageScrollDwellSecMin: 3,  pageScrollDwellSecMax: 15,  // human "reading the feed" browse before composing
  commentDwellSecMin: 1,     commentDwellSecMax: 4,      // pause on the post before typing the comment
  prePublishDwellSecMin: 3,  prePublishDwellSecMax: 8,   // "re-read before posting" pause
  composerOpenInitialDelayMs: 1500,  // first-attempt settle before scanning for the composer trigger
  humanizeMaster: true,  // master switch for jitter/stagger/dwell (the post->comment window stays random regardless)
  timingVariance: { interact: 0.4, settle: 0.35, pause: 0.3, wait: 0.25 }, // ± jitter fraction per delay class
  speedMode: 'safe', // canonical fleet-baseline tier: 'safe' | 'fast' | 'max' (see lib/speed.js). Set by the one-click Settings preset.
  moderationEnabled: false, // MOD: opt-in — let a designated moderator account approve held posts so post+comment go live
  moderationDryRun: false,  // MOD test mode: scan + log what WOULD be approved without clicking (default OFF = live approval)
  // ---- scheduling ---------------------------------------------------------------------
  scheduleMode: 'continuous', // 'continuous' = cycle every waitInterval; 'daily' = cyclesPerDay cycles/day at+after dailyPostTime
  dailyPostTime: '09:00',     // local HH:MM the daily run fires (only used when scheduleMode==='daily')
  cycleGapMin: 0,             // "time between cycles" (minutes) — explicit override of the inter-cycle wait; 0 = use the
                              // speed preset's waitInterval range. Applies to both the daily-run gap and continuous mode.
  cyclesPerDay: 1,            // DAILY mode: how many cycles fire per LOCAL day (1 = the classic one-cycle/day; 2..8 = that
                              // many cycles SPACED through the day, so each account posts up to N of its posts/day). Each
                              // account still posts at most cyclesPerDay times/day AND never re-posts the same post to the
                              // same group (pointer advance + dealt-set are unchanged) — N only relaxes the daily PACING.
  tabsPerBrowser: 2,          // MULTI-TAB posting (ADR-0018): 2 = DEFAULT — pre-loads the next group/comment page while posting the current, so slow navigation OVERLAPS posting (publishing stays strictly SEQUENTIAL; anti-spam gaps + double-post traps unchanged). 1 = classic one-group-at-a-time. 3..4 = opt-in for strong hardware. On the 1-IP box it's still one browser/live-IP per account (no extra IP concurrency).
                              // account, process its groups in BATCHES of N tabs — open+navigate the N group tabs IN
                              // PARALLEL, then post to each tab one-at-a-time (bringToFront; CDP input can't be parallel),
                              // then comment across the still-open tabs. Speeds up nav; POST/COMMENT stay SERIALIZED so the
                              // double-post/wrong-post guards are unchanged. Off-screen-tab publish must be validated first.
  postThenComment: false,     // TWO-PHASE posting: false = classic per-group (post→comment→next group, default). true = per
                              // account, PHASE 1 posts image+caption to every group back-to-back, then PHASE 2 goes back and
                              // places each post's first comment. The natural aging between the passes IS the anti-spam
                              // post→comment gap (no per-group settle wait), and every post lands before any comment work.
                              // Every double-post trap is unchanged (markDelivered fires at publish in Phase 1); a comment is
                              // a separate non-post action, so the comment pass can never double-post. Interrupted/blocked
                              // comments route to the reserve/moderator queues exactly like the per-group path.
  capturePostLinkFromNetwork: true, // (default-on, both phases) capture OUR post's permalink from Facebook's OWN publish
                              // response (the create-story GraphQL mutation) instead of reloading the feed and
                              // scraping the (now usually id-less) DOM for it — much faster + more reliable. The
                              // captured id is a CANDIDATE: Phase 2 re-verifies the post's caption+author on its own
                              // page before commenting, so a mis-parse self-heals to the feed-scan (wrong-post-safe).
                              // Default-on (the no-wrong-post floor's coverage layer); falls back to the guarded feed-scan if nothing matched.
  skipInlineVerify: true,     // DEFAULT-ON (v1.0.46): (two-phase only) skip the redundant inline post-landed feed-reload
                              // (~4s/group) for a comment-bearing post — Phase 2's group-scoped feed-scan already confirms
                              // live / detects held (feedConfirmed here is log-only). A stale persisted `false` (the old
                              // opt-in default) is migrated to true once in normalize(). Set false to force the old inline
                              // reload; also per-launch via ZA_SKIP_INLINE_VERIFY=1.
  fastPublish: false,         // (fast tiers only) cut the post-publish held-toast settle 1800→600ms — saves ~1.2s/post for
                              // an ADMIN of his OWN groups (whose posts are never held, so the "held for review" toast never
                              // fires). Off = byte-identical. Trade: a SLOW toast on a MODERATED group may be missed (that
                              // held post's comment then falls through). Also enable per-launch via ZA_FAST_PUBLISH=1.
  // ---- completion engine --------------------------------------------------------------
  completionMode: false,      // finite campaigns: keep self-healing (swap/retry/rescue/approve) until EVERY post
                              // is published AND every comment placed / held post approved, THEN auto-stop + report.
  // ---- held-post re-post rescue -------------------------------------------------------
  repostEnabled: false,       // opt-in: when a post stays HELD in "Spam potentiel" (moderator couldn't approve it),
                              // a healthy reserve account re-posts the content to that group so it goes live 100%.
  repostGraceSec: 180,        // wait this long after a hold is marked un-approvable before a reserve re-posts
                              // (lets FB's own auto-release win first; a live-feed check then prevents duplicates).
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function init(userDataPath) {
  USER_DATA = userDataPath;
  _progressCache = null; // fresh data context → drop any cached progress ledger from a prior USER_DATA (prod inits once; matters for tests)
  if (_progressFlushTimer) { try { clearTimeout(_progressFlushTimer); } catch {} _progressFlushTimer = null; } _progressDirty = false;
  DATA_FILE = path.join(USER_DATA, 'data.json');
  ACCOUNTS_DIR = ensureDir(path.join(USER_DATA, 'accounts'));
  IMAGES_DIR = ensureDir(path.join(USER_DATA, 'storage', 'images'));
  // Seed an empty data file on first run.
  if (!fs.existsSync(DATA_FILE)) save(blank());
  return { DATA_FILE, ACCOUNTS_DIR, IMAGES_DIR };
}

function blank() {
  return { posts: [], groups: [], accounts: [], settings: { ...DEFAULT_SETTINGS }, proxies: [], useProxies: false };
}

function stripBom(s) { return String(s).replace(/^\uFEFF/, ''); }

// Coerce the numeric/bookkeeping fields the engine does math on, so a hand-edited or
// partially-migrated data.json can't propagate strings/NaN into the daily-cap and cool-down
// logic (a NaN cap comparison silently disables the cap). Only touches fields that exist.
function normalizeAccount(a) {
  if (!a || typeof a !== 'object') return a;
  const out = { ...a };
  if (out.daily && typeof out.daily === 'object') {
    // DI-3: a negative/NaN/string count must not disable or skew the daily cap, and a malformed date
    // must not freeze the cap on a stale day. Floor the count at 0; reset a non-YYYY-MM-DD date.
    const cnt = Math.max(0, Math.floor(Number(out.daily.count) || 0));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(out.daily.date) ? out.daily.date : '';
    out.daily = { date, count: cnt };
  }
  if (out.rlStrikes !== undefined) out.rlStrikes = Math.max(0, Math.floor(Number(out.rlStrikes) || 0));
  if (out.attnStrikes !== undefined) out.attnStrikes = Math.max(0, Math.floor(Number(out.attnStrikes) || 0)); // attention-rest backoff counter (logged-out/blocked); persists across rest expiries, cleared on a clean delivery
  if (out.rateLimitedUntil !== undefined) {
    // DI-4: keep a cool-down timestamp ONLY if it's a sane future time. A corrupt far-future value
    // would block the account forever; a past value is already expired → reset both to 0 (not blocked).
    const v = Number(out.rateLimitedUntil) || 0;
    const now = Date.now(), yearMs = 365 * 24 * 60 * 60 * 1000;
    out.rateLimitedUntil = (v > now && v < now + yearMs) ? v : 0;
  }
  if (out.nextAttnRetry !== undefined) {
    // Attention-rest timer (logged-out/checkpoint/disabled): same sanity clamp as rateLimitedUntil — a corrupt
    // far-future value must not bar the account forever; a past value is already expired → 0 (eligible again).
    const v2 = Number(out.nextAttnRetry) || 0;
    const n2 = Date.now(), yr = 365 * 24 * 60 * 60 * 1000;
    out.nextAttnRetry = (v2 > n2 && v2 < n2 + yr) ? v2 : 0;
  }
  // MOD-1: moderator role + the FB display name used to author-match held posts in the queue.
  // Both default safely for an old data.json (absent → false / ''). fbDisplayName empty = "cannot
  // match" (the approval is fail-closed), so a missing name never widens what gets approved.
  if ('isModerator' in out) out.isModerator = !!out.isModerator;
  if ('fbDisplayName' in out) out.fbDisplayName = typeof out.fbDisplayName === 'string' ? out.fbDisplayName.trim() : '';
  // STANDBY (backup) account: never posts in normal cycles; only activates in its assigned groups when a
  // working account there drops, a post stays held, or a comment needs placing. Default off (a normal poster).
  if ('standby' in out) out.standby = !!out.standby;
  // PACE profile (per-account timing OVERRIDE): canonical tiers safe/fast/max, or ABSENT = inherit the fleet baseline.
  // normalizePace migrates legacy tokens (normal/''→inherit, slow→safe, turbo/instant→max) and drops anything unknown
  // to undefined (the "unset"/inherit sentinel). A migrated data.json is snapped to the new vocabulary on load.
  if ('pace' in out) { const _p = SPEED.normalizePace(out.pace); if (_p) out.pace = _p; else delete out.pace; }
  // POST-SETS: account.postSetId is an opaque string id (or null). Coerce a blank to null so '' never filters to an empty set.
  if ('postSetId' in out) out.postSetId = (out.postSetId && String(out.postSetId)) || null;
  // assignedGroups must be a string array — a corrupt non-array (hand-edited data.json / API) would break every
  // consumer's .includes/.slice; coerce defensively (the bulk-assign IPC always writes a clean array anyway).
  if ('assignedGroups' in out) out.assignedGroups = Array.isArray(out.assignedGroups) ? out.assignedGroups.map(String) : [];
  return out;
}

// Migrate a pre-overhaul data.json: if a legacy single-value timing key was customized but the new
// min/max range isn't present, derive the range (±20%) so the user's tuning carries over. The legacy
// key is kept (back-compat / rollback). New installs already have the range defaults.
function migrateTimingRanges(rawS) {
  const s = { ...(rawS || {}) };
  for (const [legacy, lo, hi] of [['waitInterval', 'waitIntervalMin', 'waitIntervalMax'], ['accountDelay', 'accountDelayMin', 'accountDelayMax'], ['groupDelay', 'groupDelayMin', 'groupDelayMax']]) {
    if (s[legacy] != null && s[lo] == null && s[hi] == null) {
      const v = Number(s[legacy]);
      if (Number.isFinite(v) && v > 0) { s[lo] = Math.floor(v * 0.8); s[hi] = Math.ceil(v * 1.2); }
    }
  }
  return s;
}

function normalize(raw) {
  const rs = migrateTimingRanges(raw.settings) || {};
  // ONE-TIME (v1.0.46): skipInlineVerify's default flipped opt-in(false)→on(true) — the inline post-landed reload is
  // redundant with Phase 2's feed-scan. A persisted `false` is ALWAYS the old stale default (false WAS the default, so
  // opting IN meant setting true) → flip it to true once. The `sivMigrated` marker preserves any LATER deliberate toggle.
  if (!rs.sivMigrated) { if (rs.skipInlineVerify === false) rs.skipInlineVerify = true; rs.sivMigrated = true; }
  // Migrate the fleet SPEED tier on load (legacy normal|slow→safe, fast→fast, turbo|instant→max) so an old data.json's
  // stored speedMode + the UI that reads it are on the canonical 3-tier vocabulary — not just the worker (which
  // normalizes at resolve time regardless). Per-account pace is migrated in normalizeAccount below.
  if ('speedMode' in rs) rs.speedMode = SPEED.normalizeSpeedMode(rs.speedMode);
  return {
    posts: Array.isArray(raw.posts) ? raw.posts : [],
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map(normalizeAccount),
    settings: { ...DEFAULT_SETTINGS, ...rs, postSets: Array.isArray(raw.settings && raw.settings.postSets) ? raw.settings.postSets.filter((s) => s && s.id && s.name).map((s) => ({ id: String(s.id), name: String(s.name) })) : [] },
    proxies: Array.isArray(raw.proxies) ? raw.proxies : [],
    useProxies: !!raw.useProxies,
  };
}

// Durable write: temp file -> write -> fsync (flush bytes to disk) -> rename. The fsync
// is what the old code lacked: without it, a crash/power-loss after rename could leave a
// 0-byte file (exactly the corruption this app already suffered). Throws on ENOSPC so the
// caller learns the write failed instead of silently truncating.
function writeFileAtomic(dest, content) {
  const tmp = dest + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    // Loop the writeSync: a SHORT write (POSIX permits it; Windows WriteFile can under low-resource/large-write) would
    // otherwise fsync+rename a TRUNCATED tmp over the real file. fs.writeFileSync loops internally — the hand-rolled fd
    // path must too, since this is THE write primitive for data.json / cookies / moderation / comments / Preferences.
    const buf = Buffer.from(content);
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
}

let lastLoadIssue = null; // 'recovered-from-backup' | 'corrupt-no-backup' \u2014 surfaced once to the UI
let _primaryUnreadable = false; // set by load() when an EXISTING data.json couldn't be READ (transient OS lock, bytes intact, NOT corrupt); update() then SKIPS its save() so a blank/.bak-based result can't clobber the good-but-locked primary

// Keep only the newest 3 data.json.corrupt-* files so repeated corruption can't fill the disk.
function pruneCorrupt(file) {
  try {
    const target = file || DATA_FILE; // default = data.json (back-compat); pass a path to prune another file's quarantine
    const dir = path.dirname(target);
    const base = path.basename(target) + '.corrupt-';
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
    for (const f of olds.slice(0, -3)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } // keep only the newest 3 quarantined copies (unbounded growth otherwise)
  } catch {}
}

function load() {
  // Separate the READ from the PARSE. The original wrapped both in one try/catch and treated a transient READ
  // failure (Windows EBUSY/EPERM/EACCES \u2014 Defender / OneDrive sync / search indexer briefly locking data.json,
  // bytes perfectly intact) IDENTICALLY to provable corruption: it quarantined the good file and returned blank(),
  // which update() then SAVED over the primary \u2192 the operator's accounts/posts/groups silently vanished on an I/O blip.
  _primaryUnreadable = false;
  let txt;
  try {
    txt = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (readErr) {
    // Missing on first run \u2192 normal, blank with no quarantine.
    if (readErr && readErr.code === 'ENOENT') return blank();
    // The primary EXISTS but is transiently UNREADABLE. Do NOT quarantine a good file on a lock. FLAG it so the
    // surrounding update() skips its save() (else the result \u2014 built on blank/.bak \u2014 overwrites the real data).
    // Recover read-only from .bak for THIS read if we can; either way never persist over the locked primary.
    _primaryUnreadable = true;
    try { return normalize(JSON.parse(stripBom(fs.readFileSync(DATA_FILE + '.bak', 'utf8')))); } catch {}
    return blank();
  }
  // The bytes were read successfully \u2014 a parse/normalize failure now is PROVABLE corruption (half-written /
  // disk-full), so it's safe to quarantine the primary and recover from .bak.
  try {
    return normalize(JSON.parse(stripBom(txt)));
  } catch (e) {
    let existed = false;
    try { existed = fs.existsSync(DATA_FILE) && fs.statSync(DATA_FILE).size > 0; } catch {}
    try {
      const bak = normalize(JSON.parse(stripBom(fs.readFileSync(DATA_FILE + '.bak', 'utf8'))));
      // Quarantine the bad primary so the next save() can't copy it over the good .bak.
      if (existed) { try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch {} pruneCorrupt(); }
      try { writeFileAtomic(DATA_FILE, JSON.stringify(bak, null, 2)); } catch {}
      lastLoadIssue = 'recovered-from-backup';
      return bak;
    } catch {
      // No usable backup. Preserve the unreadable primary instead of blanking-then-saving
      // over it, so it stays recoverable by hand.
      if (existed) { try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch {} pruneCorrupt(); lastLoadIssue = 'corrupt-no-backup'; }
      return blank();
    }
  }
}

function save(data) {
  const json = JSON.stringify(data, null, 2);
  // Snapshot the current good file as .bak BEFORE overwriting so any bad write stays
  // recoverable. load() has already quarantined a corrupt primary, so what we copy here
  // is the last value we successfully wrote.
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch {}
  writeFileAtomic(DATA_FILE, json);
  return data;
}

// Serialize every read-modify-write cycle. The orchestrator loop, IPC handlers, and the
// remote HTTP server all mutate data.json from the same process but across await points;
// without this, two overlapping load->mutate->save cycles drop one of the changes
// (lost-update). Route all mutations through update() and they apply one at a time.
let _writeChain = Promise.resolve();
function update(mutator, opts) {
  const run = async () => {
    try {
      const data = load();
      // Capture NOW (synchronously, before the mutator awaits — a concurrent direct load() from getData()/an IPC
      // handler would reset the module flag). If load() couldn't READ an existing primary (transient OS lock, bytes
      // intact), persisting `data` (built on blank/.bak) would WIPE the real on-disk data → skip the save entirely.
      const _unreadable = _primaryUnreadable;
      const result = await mutator(data);
      if (_unreadable) {
        try { console.error('[store.update] save skipped — data.json was transiently unreadable on load; on-disk data preserved (the next mutation retries once the lock clears)'); } catch {}
        // A caller that would otherwise report FALSE SUCCESS on this silent skip (e.g. the bulk importer, which then
        // writes orphan cookie jars for accounts that never persisted and clears the operator's paste) passes
        // { throwIfUnsaved: true } to turn the skip into a typed error it can catch and report as a retryable failure.
        if (opts && opts.throwIfUnsaved) { const err = new Error('data.json was temporarily unreadable — your changes were NOT saved. Please retry in a moment (a virus scanner or sync tool briefly locked the file).'); err.code = 'E_SAVE_SKIPPED'; throw err; }
        return result;
      }
      save(data);
      return result;
    } catch (e) {
      // Surface the failure instead of swallowing it: a mutator throw or a disk-full save would
      // otherwise leave the UI and the on-disk data diverged with no trace. Log here so even
      // fire-and-forget callers leave a breadcrumb, then re-throw so awaiting callers learn the
      // write failed and can react.
      try { console.error('[store.update] mutation/write failed:', (e && e.message) || e); } catch {}
      throw e;
    }
  };
  const next = _writeChain.then(run, run); // run regardless of a prior update's outcome
  _writeChain = next.then(() => {}, () => {}); // never let a rejection wedge the chain
  return next;
}

// Serialized read-modify-write for moderation-state.json and pending-comments.json (their own chains, like
// update() for data.json). The parallel posting pool has multiple account closures appending held/pending
// records across await points; without serialization the second save clobbers the first's appends → silently
// lost held posts (never approved) or orphaned comments (never rescued). Returns { ok, result } — ok is the
// save() boolean, result is the mutator's return value.
let _modChain = Promise.resolve();
function updateModeration(mutator) {
  const run = async () => { const ms = loadModeration(); const result = await mutator(ms); const ok = saveModeration(ms); return { ok, result }; };
  const next = _modChain.then(run, run);
  _modChain = next.then(() => {}, () => {});
  return next;
}
let _comChain = Promise.resolve();
function updateComments(mutator) {
  const run = async () => { const cs = loadComments(); const result = await mutator(cs); const ok = saveComments(cs); return { ok, result }; };
  const next = _comChain.then(run, run);
  _comChain = next.then(() => {}, () => {});
  return next;
}

// Read-and-clear the last load problem so the UI can warn the operator exactly once.
function consumeLoadIssue() { const v = lastLoadIssue; lastLoadIssue = null; return v; }

// ---- per-account paths -------------------------------------------------
function accountDir(name) {
  return ensureDir(path.join(ACCOUNTS_DIR, sanitizeName(name)));
}
function profileDir(name) {
  return ensureDir(path.join(accountDir(name), 'chrome-profile'));
}
function cookiesFile(name) {
  return path.join(accountDir(name), 'cookies.json');
}
function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_');
}

// Stop Chromium from reopening the previous session's tabs (it does this when the last
// run exited uncleanly — e.g. the browser was killed). Without this, each launch piles
// up dozens of restored tabs and bogs the machine down.
function sanitizeProfile(name, hidden = false) {
  const def = path.join(profileDir(name), 'Default');
  // Delete the session snapshots so there is nothing to restore.
  for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try { fs.rmSync(path.join(def, f), { force: true }); } catch {}
  }
  // Mark a clean exit + set startup to a single New Tab Page (not "continue where you left off").
  const prefs = path.join(def, 'Preferences');
  try {
    if (fs.existsSync(prefs)) {
      const p = JSON.parse(fs.readFileSync(prefs, 'utf8'));
      p.profile = p.profile || {}; p.profile.exit_type = 'Normal'; p.profile.exited_cleanly = true;
      p.session = p.session || {}; p.session.restore_on_startup = 5; delete p.session.startup_urls;
      // Pin the window placement to THIS launch's intent. Chrome otherwise restores the last
      // run's rectangle: a hidden run saves off-screen (-32000) bounds, so a later interactive
      // LOGIN would open invisibly; a visible login saves on-screen bounds, so the next hidden
      // run flashes on-screen. Force off-screen when hidden; otherwise clear it so Chrome opens
      // on-screen at its default (logins MUST be visible).
      p.browser = p.browser || {};
      if (hidden) {
        const prev = p.browser.window_placement || {};
        p.browser.window_placement = {
          left: -32000, top: -32000, right: -30720, bottom: -31100, maximized: false,
          work_area_left: prev.work_area_left || 0, work_area_top: prev.work_area_top || 0,
          work_area_right: prev.work_area_right || 1366, work_area_bottom: prev.work_area_bottom || 768,
        };
      } else {
        delete p.browser.window_placement;
      }
      writeFileAtomic(prefs, JSON.stringify(p)); // atomic: a torn write (ENOSPC) would make Preferences
      // unparseable → next launch can't prep the profile → the account silently skips every run.
    }
  } catch {}
}

// COOKIES AT REST are ENCRYPTED with the OS keystore (Windows DPAPI / macOS Keychain, via lib/secret) — the xs
// cookie is a live, 2FA-bypassing session, so a COPIED cookies.json (stolen/backed-up profile) must be useless
// off-box. FAIL-SAFE + BACKWARD-COMPATIBLE by design:
//  • read: a legacy PLAINTEXT jar (no enc:v1: marker) still parses; an encrypted jar decrypts in the app (same
//    OS user). If it can't be decrypted HERE (a standalone script in plain Node has no safeStorage, or a
//    different OS user), secret.decrypt yields '' → we return [] — the SAME "no usable cookies" signal a read
//    error already returns, never a throw. This can NOT log anyone out: every writeCookies caller writes FRESH
//    live browser cookies (guarded on a live c_user), never a value derived from readCookies, and the persistent
//    chrome-profile — not this jar — is the session source of truth (the jar is only a Tier-2 fallback).
//  • write: encrypts when the OS keystore is available (the Electron app); in dev/tests/scripts it's absent, so
//    the jar is written plaintext (unchanged behavior). A legacy plaintext jar is transparently re-encrypted on
//    the app's next write. secret.encrypt is idempotent (won't double-wrap) and never throws.
const secret = require('./secret');
function readCookies(name) {
  try {
    const raw = fs.readFileSync(cookiesFile(name), 'utf8');
    if (secret.isEncrypted(raw)) { const dec = secret.decrypt(raw); return dec ? JSON.parse(dec) : []; }
    return JSON.parse(raw); // legacy plaintext jar (or one written in a no-keystore context)
  } catch { return []; }
}
// A4: durable atomic write (tmp + fsync + rename) so a crash mid-write can't corrupt cookies.json.
function writeCookies(name, cookies) {
  writeFileAtomic(cookiesFile(name), secret.encrypt(JSON.stringify(cookies, null, 2)));
}

// Cookie normalizer — THE single source (main.js, worker.js, and the diagnostic scripts all use this one via worker's
// re-export). Strips fields Puppeteer's setCookie rejects and keeps a VALID attribute set; wrapped so one bad cookie
// can't throw. CRITICAL correctness rule: Chrome REQUIRES secure:true whenever SameSite=None, or setCookie REJECTS the
// cookie — and the caller's one-by-one fallback then SILENTLY DROPS it (e.g. `xs`), leaving a half-seeded jar that logs
// the account out. So we force secure:true whenever SameSite ends up 'None' (all FB cookies are https/secure anyway).
function normalizeCookie(c) {
  try {
    const out = {
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
    };
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') out.secure = c.secure;
    const ss = String(c.sameSite || '').toLowerCase();
    out.sameSite = ss === 'lax' ? 'Lax' : ss === 'strict' ? 'Strict' : 'None';
    if (out.sameSite === 'None') out.secure = true; // REQUIRED by Chrome for SameSite=None, else setCookie drops the cookie
    return out;
  } catch {
    return { name: String((c && c.name) || '__bad__'), value: '', domain: '.facebook.com', path: '/' };
  }
}

// Per-account WARM-UP run counter (drives the new-account warm-up gate). Atomic write so a crash mid-write
// can't zero a partial file and silently restart warm-up. Read floors at 0 (a corrupt/NaN file → 0).
function runCountFile(name) { return path.join(accountDir(name), 'run-count.txt'); }
function loadRunCount(name) { try { return Math.max(0, parseInt(fs.readFileSync(runCountFile(name), 'utf8'), 10) || 0); } catch { return 0; } }
function saveRunCount(name, n) { try { writeFileAtomic(runCountFile(name), String(Math.max(0, Math.floor(Number(n) || 0)))); return true; } catch { return false; } }

// ---- image helpers -----------------------------------------------------
// Decode a {data:<base64>, ext:<png|jpg|...>} object to a file on disk; return path.
function saveBase64Image(img, prefix = 'post') {
  if (!img || !img.data) return null;
  const ext = (img.ext || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const file = path.join(IMAGES_DIR, `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  return file;
}

// LOCAL calendar-day key (YYYY-MM-DD) for per-account daily-cap bookkeeping. LOCAL — matches the engine's
// _localDayKey (daily-rotation / campaign pacing) and the operator's local daily schedule, so the cap window and
// the posting-pace window are the SAME calendar day (the earlier UTC key disagreed with local pacing for up to an
// hour around local midnight → an account could be cap-gated a cycle early or late). Safety is unchanged: the
// MONOTONIC dailyRolledOver (forward-only) still prevents a clock moved BACKWARD from resetting the count, and a
// DST transition shifts the HOUR not the calendar DATE, so the key stays stable across DST.
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Has the daily-cap window advanced to a genuinely LATER day than `daily` last recorded?
// Monotonic: only a FORWARD move rolls the window over. A clock moved BACKWARD (key <= stored)
// keeps the existing count rather than resetting it — so the cap can never be cleared by
// rewinding the clock. (Lexicographic compare on YYYY-MM-DD is chronological.)
function dailyRolledOver(daily, key = todayKey()) {
  if (!daily || !daily.date) return true;
  return key > daily.date;
}
// Group-posts an account has used in the CURRENT cap window (0 once the window rolls over).
function dailyUsed(daily, key = todayKey()) {
  if (dailyRolledOver(daily, key)) return 0;
  return Number(daily.count) || 0;
}

// Clamp/validate numeric settings so out-of-range or reversed values from the UI / HTTP API /
// hand-edited data.json can't produce negative sleeps, a Min>Max delay window, or silently disable
// a cap. Only touches keys present in the patch. (M2-07)
function clampSettings(s) {
  const n = (v, def, min, max) => { let x = Number(v); if (!Number.isFinite(x)) x = def; return Math.min(max, Math.max(min, Math.round(x * 1000) / 1000)); };
  const out = { ...(s || {}) };
  if ('parallelAccounts' in out) out.parallelAccounts = n(out.parallelAccounts, 2, 1, 20);
  // Legacy single-value timing keys: superseded by the *Min/*Max ranges and migrated on load, but still
  // clamped defensively here for the save-settings / HTTP-API paths that bypass migration (tested contract).
  if ('waitInterval' in out)     out.waitInterval     = n(out.waitInterval, 120, 0, 1440);
  if ('accountDelay' in out)     out.accountDelay     = n(out.accountDelay, 2, 0, 1440);
  if ('groupDelay' in out)       out.groupDelay       = n(out.groupDelay, 180, 0, 3600);
  if ('postsPerGroup' in out)    out.postsPerGroup    = n(out.postsPerGroup, 1, 0, 100000);
  if ('groupsPerBlock' in out)   out.groupsPerBlock   = n(out.groupsPerBlock, 4, 1, 1000);
  if ('accountsPerBatch' in out) out.accountsPerBatch = n(out.accountsPerBatch, 1, 1, 1000);
  if ('maxCycles' in out)        out.maxCycles        = n(out.maxCycles, 0, 0, 100000);
  if ('commentDelayMin' in out)  out.commentDelayMin  = n(out.commentDelayMin, 60, 0, 86400);
  if ('commentDelayMax' in out)  out.commentDelayMax  = n(out.commentDelayMax, 180, 0, 86400);
  if ('dailyCap' in out)         out.dailyCap         = n(out.dailyCap, 0, 0, 100000);
  if ('warmupRuns' in out)       out.warmupRuns       = n(out.warmupRuns, 5, 0, 1000);
  if ('rateLimitCooldownHours' in out) out.rateLimitCooldownHours = n(out.rateLimitCooldownHours, 4, 0, 168);
  if ('reserveAccounts' in out) out.reserveAccounts = Math.round(n(out.reserveAccounts, 0, 0, 100));
  if ('reserveMaxJobsPerCycle' in out) out.reserveMaxJobsPerCycle = Math.round(n(out.reserveMaxJobsPerCycle, 1, 1, 5));
  // Humanization ranges (supersede the legacy single keys).
  if ('waitIntervalMin' in out) out.waitIntervalMin = n(out.waitIntervalMin, 90, 0, 1440);
  if ('waitIntervalMax' in out) out.waitIntervalMax = n(out.waitIntervalMax, 180, 0, 1440);
  if ('accountDelayMin' in out) out.accountDelayMin = n(out.accountDelayMin, 1, 0, 1440);
  if ('accountDelayMax' in out) out.accountDelayMax = n(out.accountDelayMax, 4, 0, 1440);
  if ('groupDelayMin' in out)   out.groupDelayMin   = n(out.groupDelayMin, 120, 0, 3600);
  if ('groupDelayMax' in out)   out.groupDelayMax   = n(out.groupDelayMax, 300, 0, 3600);
  if ('realIpMinPostGapSec' in out) out.realIpMinPostGapSec = n(out.realIpMinPostGapSec, 15, 0, 3600); // per-IP aggregate post gap (default 15s; 0=off), clamped 0..3600s
  if ('realIpMaxConcurrent' in out) out.realIpMaxConcurrent = n(out.realIpMaxConcurrent, 3, 1, 8); // max concurrent browsers on one shared IP (clamped 1..8; matches the orchestrator _realIpMax gate)
  if ('pageScrollDwellSecMin' in out) out.pageScrollDwellSecMin = n(out.pageScrollDwellSecMin, 3, 0, 600);
  if ('pageScrollDwellSecMax' in out) out.pageScrollDwellSecMax = n(out.pageScrollDwellSecMax, 15, 0, 600);
  if ('commentDwellSecMin' in out) out.commentDwellSecMin = n(out.commentDwellSecMin, 1, 0, 300);
  if ('commentDwellSecMax' in out) out.commentDwellSecMax = n(out.commentDwellSecMax, 4, 0, 300);
  if ('prePublishDwellSecMin' in out) out.prePublishDwellSecMin = n(out.prePublishDwellSecMin, 3, 0, 60);
  if ('prePublishDwellSecMax' in out) out.prePublishDwellSecMax = n(out.prePublishDwellSecMax, 8, 0, 60);
  if ('composerOpenInitialDelayMs' in out) out.composerOpenInitialDelayMs = n(out.composerOpenInitialDelayMs, 1500, 800, 3000);
  if ('humanizeMaster' in out) out.humanizeMaster = !!out.humanizeMaster;
  if ('speedMode' in out) out.speedMode = SPEED.normalizeSpeedMode(out.speedMode); // canonical fleet tier safe/fast/max (migrates legacy normal|slow→safe, fast→fast, turbo|instant→max)
  // POST-SETS: sanitize on the save-settings / HTTP-API path too (normalize() does it on load) so the in-memory
  // settings the engine reads right after a save can never carry a malformed postSets array.
  if ('postSets' in out) out.postSets = Array.isArray(out.postSets) ? out.postSets.filter((s) => s && s.id && s.name).map((s) => ({ id: String(s.id), name: String(s.name) })) : [];
  if ('moderationEnabled' in out) out.moderationEnabled = !!out.moderationEnabled;
  if ('autoStartDaily' in out) out.autoStartDaily = !!out.autoStartDaily; // 🕒 Windows daily clock-hook toggle
  if ('enableWarmup' in out) out.enableWarmup = !!out.enableWarmup; // 🌱 warm new accounts before posting
  if ('scheduleMode' in out) out.scheduleMode = (out.scheduleMode === 'daily') ? 'daily' : 'continuous';
  if ('dailyPostTime' in out) out.dailyPostTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(out.dailyPostTime || '')) ? out.dailyPostTime : '09:00';
  if ('cyclesPerDay' in out) out.cyclesPerDay = Math.max(1, Math.min(20, Math.round(Number(out.cyclesPerDay) || 1))); // daily mode: cycles/day (1..20); the worker+orchestrator read the same clamp
  if ('tabsPerBrowser' in out) out.tabsPerBrowser = Math.max(1, Math.min(4, Math.round(Number(out.tabsPerBrowser) || 1))); // multi-tab batch size (1 = classic sequential; 2..4 = parallel-load tabs, serialized post/comment)
  if ('cycleGapMin' in out) out.cycleGapMin = (Number(out.cycleGapMin) > 0) ? Math.max(0.5, Math.min(720, Number(out.cycleGapMin))) : 0; // 0 = use waitInterval; else 0.5..720 min (allow decimals for sub-minute gaps, e.g. 0.5 = 30s — operator-controlled, ban risk warned in UI)
  if ('completionMode' in out) out.completionMode = !!out.completionMode;
  if ('shuffleCampaign' in out) out.shuffleCampaign = !!out.shuffleCampaign;
  if ('fireOrder' in out) out.fireOrder = ['batch', 'interleave', 'random'].includes(out.fireOrder) ? out.fireOrder : 'batch';
  if ('repostEnabled' in out) out.repostEnabled = !!out.repostEnabled;
  if ('repostGraceSec' in out) out.repostGraceSec = n(out.repostGraceSec, 180, 0, 86400);
  // Coerce the remaining boolean toggles so a stray string/number (e.g. the string "false" from a hand-edited
  // data.json or an import) can't read as truthy where the engine does `if (settings.X)`.
  for (const _b of ['commentWithImage', 'autoDeletePosted', 'hideBrowser', 'enableTunnel', 'resumeOnStartup', 'launchOnStartup', 'loopCampaign', 'varyContent', 'varyImages', 'randomizeLinks', 'staggerAccounts', 'postThenComment', 'capturePostLinkFromNetwork', 'skipInlineVerify', 'fastPublish']) { if (_b in out) out[_b] = !!out[_b]; }
  if (out.timingVariance && typeof out.timingVariance === 'object') {
    const def = { interact: 0.4, settle: 0.35, pause: 0.3, wait: 0.25 };
    const tv = {}; for (const k of Object.keys(def)) tv[k] = n(out.timingVariance[k], def[k], 0, 0.6);
    out.timingVariance = tv;
  }
  // Keep every min/max pair coherent — if both bounds are present and reversed, swap them.
  for (const [lo, hi] of [['commentDelayMin', 'commentDelayMax'], ['waitIntervalMin', 'waitIntervalMax'], ['accountDelayMin', 'accountDelayMax'], ['groupDelayMin', 'groupDelayMax'], ['pageScrollDwellSecMin', 'pageScrollDwellSecMax'], ['commentDwellSecMin', 'commentDwellSecMax'], ['prePublishDwellSecMin', 'prePublishDwellSecMax']]) {
    if (lo in out && hi in out && Number(out[lo]) > Number(out[hi])) { const t = out[lo]; out[lo] = out[hi]; out[hi] = t; }
  }
  return out;
}

// M2-02: should a status write be IGNORED to preserve a high-priority attention flag? A concurrent
// headless status check (or any lower-priority writer) must not clear a rate-limit/checkpoint/
// verification/disabled flag the run just set. rate_limited is protected only while still active
// (rateLimitedUntil in the future); once it expires a clearing write is allowed through.
function preserveAttentionStatus(curStatus, curRateLimitedUntil, newStatus, now = Date.now()) {
  const PROTECTED = new Set(['rate_limited', 'checkpoint', 'needs_verification', 'account_disabled']);
  const CLEARING = new Set(['logged_in', 'checking', 'not_logged_in', 'error']);
  if (!PROTECTED.has(curStatus) || curStatus === newStatus) return false;
  if (!CLEARING.has(newStatus)) return false; // an equal/higher attention status may overwrite
  if (curStatus === 'rate_limited' && !((Number(curRateLimitedUntil) || 0) > now)) return false; // expired → allow clear
  return true;
}

// ---- rotation state (per-account "next post index" for sequence/unique modes) ----
// Mirrors the original app's .pcu-state.json. Survives restarts.
function stateFile() { return path.join(USER_DATA, 'pcu-state.json'); }
function loadRotation() {
  try { return JSON.parse(stripBom(fs.readFileSync(stateFile(), 'utf8'))) || {}; }
  catch {
    // Corrupt/partial primary — recover from the .bak so a bad write can't silently empty the dealt
    // set and make a unique campaign re-post the whole library on the next resume.
    try { return JSON.parse(stripBom(fs.readFileSync(stateFile() + '.bak', 'utf8'))) || {}; } catch { return {}; }
  }
}
// Returns true on success, false on failure so the caller can warn the operator (a silently-dropped
// rotation write risks re-posting already-published content on resume). Snapshots a .bak first.
function saveRotation(obj) {
  try {
    try { if (fs.existsSync(stateFile())) fs.copyFileSync(stateFile(), stateFile() + '.bak'); } catch {}
    writeFileAtomic(stateFile(), JSON.stringify(obj || {}, null, 2));
    return true;
  } catch { return false; }
}
// E (observability): machine-readable run-health snapshot for an away operator polling the tunnel. Lives at the
// userData root next to run-state.json. Overwritten (never appended) on a ~5-min timer; a torn write is harmless
// (the next tick rewrites it). Best-effort — never throws into the run.
function statusFile() { return path.join(path.dirname(stateFile()), 'status.json'); }
function writeStatus(obj) { try { writeFileAtomic(statusFile(), JSON.stringify(obj || {}, null, 2)); return true; } catch { return false; } }

// ---- crash-durability inflight journal (R5) -----------------------------------------------------
// One durable line per (agent,post,group) delivery, APPENDED at markDelivered (before the account's
// rotation/dealt commit). A HARD kill mid-account (OS crash / power loss / force-kill) loses the in-memory
// _cycleDelivered + the un-persisted pointer; on the next run start the surviving lines are FOLDED back into
// the pointer/postsToday/owed/dealt exactly as a clean account-return would have written them (see the
// orchestrator's _recoverInflightJournal) — so no delivered group is re-posted. Supersession is a per-agent
// 'icommit' watermark written atomically with the pointer on a clean commit (NOT a physical delete), so a
// failed compaction can never resurrect a committed line and a fresh line is never wrongly dropped.
function inflightFile() { return path.join(USER_DATA, 'pcu-inflight.jsonl'); }
function appendInflight(entry) {
  try { fs.appendFileSync(inflightFile(), JSON.stringify(entry) + '\n'); return true; }
  catch { return false; } // best-effort: a failed append degrades to today's behavior (a possible re-post), never worse
}
function loadInflight() {
  let txt = '';
  try { txt = fs.readFileSync(inflightFile(), 'utf8'); } catch { return []; } // ENOENT on first run → []
  const out = [];
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* tolerate a torn final line from a kill mid-append — skip it */ }
  }
  return out;
}
function compactInflight(keepFn) {
  try {
    const kept = loadInflight().filter((e) => { try { return keepFn(e); } catch { return true; } }); // keepFn throw → retain (never drop on doubt)
    writeFileAtomic(inflightFile(), kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
    return true;
  } catch { return false; }
}

// ── OBLIGATION crash-journal (v1.0.72): held-post records + orphan/deferred link-comments are otherwise kept ONLY in
// the worker's memory until account-return, so a hard-kill mid-run loses them (a live post left without its comment, a
// stranded held card — worst in two-phase). Mirror the delivery inflight journal: append each obligation at CREATION,
// fold survivors into moderation/comments on the next Start (orchestrator._foldObligationJournal), compact per-account
// after its clean return-persist. SEPARATE file from pcu-inflight (different commit lifecycle — obligations commit at
// account-return, deliveries at cycle-commit). Best-effort throughout: a failure degrades to today's lost-on-crash.
function obligationFile() { return path.join(USER_DATA, 'pcu-obligations.jsonl'); }
function appendObligation(entry) {
  try { fs.appendFileSync(obligationFile(), JSON.stringify(entry) + '\n'); return true; }
  catch { return false; }
}
function loadObligations() {
  let txt = '';
  try { txt = fs.readFileSync(obligationFile(), 'utf8'); } catch { return []; } // ENOENT → []
  const out = [];
  for (const line of txt.split('\n')) { const s = line.trim(); if (!s) continue; try { out.push(JSON.parse(s)); } catch { /* tolerate a torn final line from a kill mid-append */ } }
  return out;
}
function compactObligations(keepFn) {
  try {
    const kept = loadObligations().filter((e) => { try { return keepFn(e); } catch { return true; } }); // keepFn throw → retain (never drop on doubt)
    writeFileAtomic(obligationFile(), kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
    return true;
  } catch { return false; }
}

// ---- moderation state (held posts awaiting moderator approval) ----------------------------------
// MOD: one record per post FB held in the group "Spam potentiel"/pending queue. The single source of
// truth across the post→approve→comment phases; survives restart. Mirrors the rotation state.
function moderationFile() { return path.join(USER_DATA, 'moderation-state.json'); }
function loadModeration() {
  try { const o = JSON.parse(stripBom(fs.readFileSync(moderationFile(), 'utf8'))); return o && Array.isArray(o.held) ? o : { held: [] }; }
  catch {
    try { const o = JSON.parse(stripBom(fs.readFileSync(moderationFile() + '.bak', 'utf8'))); return o && Array.isArray(o.held) ? o : { held: [] }; } catch { return { held: [] }; }
  }
}
function saveModeration(obj) {
  try {
    const safe = obj && Array.isArray(obj.held) ? obj : { held: [] };
    try { if (fs.existsSync(moderationFile())) fs.copyFileSync(moderationFile(), moderationFile() + '.bak'); } catch {}
    writeFileAtomic(moderationFile(), JSON.stringify(safe, null, 2));
    return true;
  } catch { return false; }
}

// ---- orphaned-comment queue (posts that went live but whose first comment couldn't be placed) -------
// One record per post that published successfully but failed to get its link-comment (rate-limit, block,
// or the post couldn't be found). A healthy account that is a member of the group later places the
// comment so a post is NEVER left without its link. Survives restart; mirrors the moderation state.
function commentsFile() { return path.join(USER_DATA, 'pending-comments.json'); }
function loadComments() {
  try { const o = JSON.parse(stripBom(fs.readFileSync(commentsFile(), 'utf8'))); return o && Array.isArray(o.pending) ? o : { pending: [] }; }
  catch {
    try { const o = JSON.parse(stripBom(fs.readFileSync(commentsFile() + '.bak', 'utf8'))); return o && Array.isArray(o.pending) ? o : { pending: [] }; } catch { return { pending: [] }; }
  }
}
function saveComments(obj) {
  try {
    const safe = obj && Array.isArray(obj.pending) ? obj : { pending: [] };
    try { if (fs.existsSync(commentsFile())) fs.copyFileSync(commentsFile(), commentsFile() + '.bak'); } catch {}
    writeFileAtomic(commentsFile(), JSON.stringify(safe, null, 2));
    return true;
  } catch { return false; }
}

// ---- run report (per-post audit trail) ---------------------------------
// Append-only JSONL + a parallel CSV for spreadsheets. One row per (account, group, post)
// outcome so an operator can audit exactly what landed across a 120-post campaign.
function reportDir() { return ensureDir(path.join(USER_DATA, 'logs')); }
function reportFile() { return path.join(reportDir(), 'run-report.jsonl'); }
function reportCsvFile() { return path.join(reportDir(), 'run-report.csv'); }
// Returns true on success, false on failure so the caller can warn the operator that the audit
// trail (run-report.jsonl/.csv) may be incomplete — a silently-dropped row makes the report lie
// about what actually posted.
function appendReport(record) {
  try {
    // Rotate at 5 MB so the append-only report can't grow unbounded over months of daily use.
    try {
      if (fs.existsSync(reportFile()) && fs.statSync(reportFile()).size > 5 * 1024 * 1024) {
        fs.renameSync(reportFile(), reportFile() + '.1');
        if (fs.existsSync(reportCsvFile())) fs.renameSync(reportCsvFile(), reportCsvFile() + '.1');
      }
    } catch {}
    fs.appendFileSync(reportFile(), JSON.stringify(record) + '\n');
    const csv = reportCsvFile();
    if (!fs.existsSync(csv)) fs.appendFileSync(csv, '﻿' + 'timestamp,account,group,groupId,postId,caption,result,comment,detail\n'); // UTF-8 BOM on header creation so Excel/LibreOffice render Arabic/accented group names instead of mojibake (write-only CSV; no reader needs to strip it)
    const esc = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; s = s.replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; }; // prefix a lone quote so attacker/FB-controlled caption/comment/group can't run as an Excel/LibreOffice formula (=cmd, +, -, @)
    fs.appendFileSync(csv, [record.ts, record.account, record.group, record.groupId, record.postId, record.caption, record.result, record.comment, record.detail].map(esc).join(',') + '\n');
    try { recordProgress(record); } catch {} // fold into the durable per-day "done" ledger (survives the 5 MB log rotation)
    return true;
  } catch (e) {
    try { console.error('[store.appendReport] failed to write audit row:', (e && e.message) || e); } catch {}
    return false;
  }
}

// ---- daily progress ledger (the "done" truth for the dashboard plan) ------------------------------------
// A compact, durable rollup keyed by LOCAL day, so the dashboard shows what was delivered each day even after
// the 5 MB report log rotates old history away. Updated from appendReport (one sink captures every delivery).
function progressFile() { return path.join(USER_DATA, 'daily-progress.json'); }
let _progressCache = null; // single in-process writer (recordProgress) → cache avoids re-parsing the file every post
function loadProgress() {
  if (_progressCache) return _progressCache;
  let raw = null;
  try { raw = fs.readFileSync(progressFile(), 'utf8'); } catch { raw = null; } // read error (missing/locked) = transient, do NOT quarantine
  if (raw != null) {
    try { _progressCache = JSON.parse(stripBom(raw)) || { days: {} }; }
    catch {
      // Primary READ but did NOT parse = provable corruption → quarantine it (mirrors data.json's load()) so its bytes
      // are preserved AND it can't be copied over a still-good .bak on the next save.
      try { fs.renameSync(progressFile(), progressFile() + '.corrupt-' + Date.now()); pruneCorrupt(progressFile()); } catch {} // prune old .corrupt-* so a recurring-corruption loop can't fill the disk (mirrors data.json)
    }
  }
  if (!_progressCache) { try { _progressCache = JSON.parse(stripBom(fs.readFileSync(progressFile() + '.bak', 'utf8'))) || { days: {} }; } catch { _progressCache = { days: {} }; } }
  if (!_progressCache.days) _progressCache.days = {};
  return _progressCache;
}
function saveProgress(obj) {
  const next = obj || { days: {} };
  try {
    // Refresh .bak from the primary ONLY when the primary currently PARSES — never overwrite a good backup with a
    // corrupt/absent primary (that was a double-corruption data-loss path).
    try { const cur = fs.readFileSync(progressFile(), 'utf8'); JSON.parse(stripBom(cur)); fs.copyFileSync(progressFile(), progressFile() + '.bak'); } catch {}
    writeFileAtomic(progressFile(), JSON.stringify(next, null, 2));
    _progressCache = next; // commit to the shared cache ONLY after a successful write, so a failed write leaves cache == disk
    return true;
  } catch { return false; }
}
const _progressDayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PROGRESS_KEEP_DAYS = 120; // prune ledger days older than this so the file stays small
// Fold one report record into the day ledger. status: posted→done, pending→held, error→error; other results
// (skipped) aren't deliveries. Best-effort — never throws into the caller.
function recordProgress(record) {
  try {
    if (!record || record.account === '(run summary)' || !record.postId || !record.groupId) return;
    const status = record.result === 'posted' ? 'done' : record.result === 'pending' ? 'held' : record.result === 'error' ? 'error' : null;
    if (!status) return;
    const when = record.ts ? new Date(record.ts) : new Date();
    const dayKey = _progressDayKey(when); // LOCAL day, matching the engine's once-per-day boundary
    // Mutate the in-memory cache DIRECTLY (no per-post deep-clone of the whole ledger) and COALESCE the disk write on a
    // short debounce — a burst of deliveries becomes ONE full-file write instead of one per delivery. The cache is the
    // live truth (get-plan reads it immediately); disk lags ≤~1.2s and is flushed on app quit. Safe at scale because this
    // ledger is a DISPLAY rollup only: the posting-critical rotation pointer and the append-only run-report are each
    // persisted per delivery, so a hard-crash between flushes loses at most ~1.2s of dashboard cells (self-heals), never
    // a double-post or an audit-row.
    const led = loadProgress(); led.days = led.days || {}; // loadProgress() returns the shared cache — mutate it in place
    const day = led.days[dayKey] || (led.days[dayKey] = { posted: 0, held: 0, errors: 0, items: {} });
    const key = `${record.account}|${record.postId}|${record.groupId}`;
    const bump = (st, n) => { if (st === 'done') day.posted += n; else if (st === 'held') day.held += n; else if (st === 'error') day.errors += n; };
    if (day.items[key]) bump(day.items[key].status, -1); // a re-report of the same cell updates rather than double-counts
    bump(status, +1);
    day.items[key] = { account: record.account, postId: record.postId, caption: record.caption || '', groupId: record.groupId, group: record.group || '', status, comment: record.comment || '', ts: record.ts || when.toISOString(), round: Number(record.round) || 0, cycle: Number(record.cycle) || 0 }; // round+cycle: the campaign round-offset + slice position at delivery, so the dashboard groups the plan BY CYCLE (reset each round)
    const cutoff = _progressDayKey(new Date(Date.now() - PROGRESS_KEEP_DAYS * 86400000));
    for (const k of Object.keys(led.days)) if (k < cutoff) delete led.days[k];
    _scheduleProgressFlush();
  } catch {}
}
// Coalesced write of the (cache-resident) progress ledger. A burst of deliveries schedules ONE flush ~1.2s later.
let _progressDirty = false, _progressFlushTimer = null;
function _scheduleProgressFlush() {
  _progressDirty = true;
  if (_progressFlushTimer) return;
  _progressFlushTimer = setTimeout(() => { _progressFlushTimer = null; flushProgress(); }, 1200);
  if (_progressFlushTimer && _progressFlushTimer.unref) _progressFlushTimer.unref(); // don't hold the process open just to flush
}
// Write the coalesced ledger NOW (debounce timer + synchronously on app quit). Stays dirty on failure so the next
// delivery/quit retries. Never throws into the caller.
function flushProgress() {
  if (_progressFlushTimer) { try { clearTimeout(_progressFlushTimer); } catch {} _progressFlushTimer = null; }
  if (!_progressDirty || !_progressCache) return true;
  try {
    try { const cur = fs.readFileSync(progressFile(), 'utf8'); JSON.parse(stripBom(cur)); fs.copyFileSync(progressFile(), progressFile() + '.bak'); } catch {} // refresh .bak only from a parseable primary
    writeFileAtomic(progressFile(), JSON.stringify(_progressCache, null, 2));
    _progressDirty = false;
    return true;
  } catch { _progressDirty = true; return false; }
}
// Wipe the dashboard progress ledger (used by "Start over" so the plan view restarts clean). The permanent audit
// trail in run-report.jsonl is NOT touched — this only resets the dashboard's "what's done" rollup.
function clearProgress() { try { if (_progressFlushTimer) { clearTimeout(_progressFlushTimer); _progressFlushTimer = null; } _progressDirty = false; return saveProgress({ days: {} }); } catch { return false; } } // cancel any pending flush so it can't rewrite the just-wiped ledger
module.exports = {
  init, load, save, update, updateModeration, updateComments, normalize, blank, DEFAULT_SETTINGS, consumeLoadIssue,
  primaryUnreadable: () => _primaryUnreadable, // true when the last load() couldn't READ an existing data.json (transient OS lock) — callers doing a bare save() must skip it, or they clobber the good-but-locked primary with .bak/blank data
  accountDir, profileDir, cookiesFile, sanitizeName, readCookies, writeCookies, normalizeCookie, writeFileAtomic, writeStatus, statusFile,
  saveBase64Image, loadRotation, saveRotation, inflightFile, appendInflight, loadInflight, compactInflight, appendObligation, loadObligations, compactObligations, loadModeration, saveModeration, loadComments, saveComments, sanitizeProfile, todayKey, dailyRolledOver, dailyUsed,
  loadRunCount, saveRunCount,
  clampSettings, preserveAttentionStatus,
  appendReport, reportFile, reportCsvFile, loadProgress, recordProgress, clearProgress, flushProgress,
  get paths() { return { USER_DATA, DATA_FILE, ACCOUNTS_DIR, IMAGES_DIR }; },
};
