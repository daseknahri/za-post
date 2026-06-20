// scripts/test-antispam.js
// End-to-end tests for the anti-spam features that DON'T require a live Facebook session:
//   A) spintax expansion          B) image variation (different hash, same-seed stable)
//   C) link variation + jitter bounds
//   D) orchestrator integration — real Orchestrator + real store (temp dir) + a STUBBED worker,
//      proving the daily cap, rate-limit cool-down, and persistence actually fire end-to-end.
// Run: node scripts/test-antispam.js   (exit 0 = all passed)
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log('PASS ' + name); } else { failed++; console.log('FAIL ' + name + (extra ? '  → ' + extra : '')); } };

(async () => {
  // ---- A) spintax ---------------------------------------------------------
  const spintax = require('../lib/spintax');
  const tpl = '{Hello|Hi|Hey} {there|all}, {check out|see} our {deal|offer}!';
  const outs = new Set(Array.from({ length: 60 }, () => spintax.expand(tpl)));
  ok('spintax produces multiple distinct variants', outs.size > 3, `${outs.size} distinct`);
  ok('spintax variantCount = product of options (3*2*2*2=24)', spintax.variantCount(tpl) === 24, String(spintax.variantCount(tpl)));
  ok('spintax leaves plain text unchanged', spintax.expand('no spintax here') === 'no spintax here');
  ok('spintax leaves literal braces (no pipe) untouched', spintax.expand('a {literal} brace') === 'a {literal} brace');
  ok('spintax every expansion is a valid leaf (no braces left)', Array.from(outs).every((s) => !/[{}]/.test(s)));

  // ---- B) image variation -------------------------------------------------
  const imageVary = require('../lib/imageVary');
  const Jimp = require('jimp');
  ok('imageVary reports jimp available', imageVary.available() === true);
  const src = path.join(os.tmpdir(), 'zpv-test-src.png');
  await (new Jimp(300, 200, 0x2266ccff)).writeAsync(src);
  const a1 = await imageVary.varyImage(src, 'acct1|grpA');
  const a2 = await imageVary.varyImage(src, 'acct1|grpA'); // same seed
  const b1 = await imageVary.varyImage(src, 'acct2|grpB'); // different seed
  const bytes = (p) => fs.readFileSync(p);
  ok('imageVary returns a new file for a valid image', !!a1 && fs.existsSync(a1));
  ok('imageVary: DIFFERENT seeds → different bytes (different hash)', !!a1 && !!b1 && !bytes(a1).equals(bytes(b1)));
  ok('imageVary: SAME seed → identical bytes (stable on retry)', !!a1 && !!a2 && bytes(a1).equals(bytes(a2)));
  ok('imageVary output is a valid readable image', await Jimp.read(a1).then(() => true).catch(() => false));
  for (const f of [src, a1, a2, b1]) { try { fs.unlinkSync(f); } catch {} }

  // ---- C) link variation + jitter bounds ----------------------------------
  const worker = require('../automation/worker');
  const linked = worker.varyLinks('see http://example.com and https://shop.io/p?id=9 now', 'acctX|grp7');
  const refs = (linked.match(/ref=/g) || []).length;
  ok('varyLinks tags BOTH urls with a ref param', refs === 2, linked);
  ok('varyLinks keeps the original domains', linked.includes('http://example.com') && linked.includes('https://shop.io/p?id=9'));
  ok('varyLinks uses ? for param-less url and & for one with a query', /example\.com\?ref=/.test(linked) && /id=9&ref=/.test(linked));
  ok('varyLinks leaves link-free text alone', worker.varyLinks('no links here', 's') === 'no links here');
  let jmin = Infinity, jmax = -Infinity, jneg = false;
  for (let i = 0; i < 2000; i++) { const v = worker.jitter(1000, 0.3); jmin = Math.min(jmin, v); jmax = Math.max(jmax, v); if (v < 0) jneg = true; }
  ok('jitter stays within ±30% bounds [700,1300]', jmin >= 700 && jmax <= 1300, `min=${jmin} max=${jmax}`);
  ok('jitter actually varies (spread observed)', jmax - jmin > 200, `spread=${jmax - jmin}`);
  ok('jitter never negative; jitter(0)=0', !jneg && worker.jitter(0) === 0);

  // ---- D) orchestrator integration (real Orchestrator + store, stubbed worker) -----
  // Stub the worker BEFORE requiring the orchestrator so its destructured runAccount is our stub.
  const calls = [];
  worker.runAccount = async (o) => {
    const name = o.account.name;
    const ng = (o.account.assignedGroups || []).length;
    calls.push(name);
    if (name === 'rlacct') return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: 'rate_limited', postedIds: [], dealtIds: [], fullyPosted: false, offline: false };
    const ids = o.post && o.post.id ? [o.post.id] : [];
    return { posted: ng, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ids, dealtIds: ids, fullyPosted: true, offline: false };
  };
  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-orch-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: '{Hi|Hello} there', comment: 'see http://example.com', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }, { id: 'g2', name: 'G2', groupId: '222' }, { id: 'g3', name: 'G3', groupId: '333' }],
    accounts: [
      { name: 'capacct', enabled: true, assignedGroups: ['g1', 'g2', 'g3'], postingOrder: 'post-centric' },
      { name: 'rlacct', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' },
      { name: 'okacct', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' },
    ],
    settings: {
      parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 3,
      staggerAccounts: false, dailyCap: 2, varyImages: false, varyContent: true,
    },
    proxies: [], useProxies: false,
  });

  const logs = [];
  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event, payload) => { if (event === 'automation-log') logs.push(String(payload)); if (event === 'automation-stopped') doneResolve(); };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  const finished = await Promise.race([done.then(() => true), new Promise((r) => setTimeout(() => r(false), 25000))]);
  try { orch.stop(); } catch {}
  ok('orchestrator run completed (no hang)', finished === true);

  const count = (n) => calls.filter((c) => c === n).length;
  const hasLog = (re) => logs.some((l) => re.test(l));
  ok('daily cap: capacct ran ONCE then was capped (3 posts >= cap 2)', count('capacct') === 1, `ran ${count('capacct')}x`);
  ok('daily cap: log shows the cap skip', hasLog(/daily cap reached/i));
  ok('cool-down: rlacct ran ONCE then was skipped while cooling down', count('rlacct') === 1, `ran ${count('rlacct')}x`);
  ok('cool-down: log shows the cooling-down skip', hasLog(/cooling down/i));
  const after = store.load();
  const cap = after.accounts.find((a) => a.name === 'capacct');
  const rl = after.accounts.find((a) => a.name === 'rlacct');
  ok('persisted: capacct.daily.count recorded (=3)', cap && cap.daily && cap.daily.count === 3, JSON.stringify(cap && cap.daily));
  ok('persisted: rlacct.rateLimitedUntil set in the future', rl && rl.rateLimitedUntil > Date.now(), String(rl && rl.rateLimitedUntil));
  ok('persisted: rlacct.rlStrikes incremented', rl && rl.rlStrikes >= 1, String(rl && rl.rlStrikes));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
