// scripts/migrate.js
// One-shot migration of an existing shipped-app runtime (za-post-comment-tool[-king])
// into the restored app's data model + userData layout.
//
//   node scripts/migrate.js [king|base]      (default: king)
//
// Copies: posts (+images), groups, accounts (+per-account cookies.json), settings.
// Does NOT copy full Chromium profiles (large + regenerated) — cookies are enough.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VARIANT = (process.argv[2] || 'king').toLowerCase();
const SRC_NAME = VARIANT === 'base' ? 'za-post-comment-tool' : 'za-post-comment-tool-king';
const SRC_ROOT = path.join(process.env.APPDATA, 'za-post', SRC_NAME);
const SRC_DATA = fs.existsSync(path.join(SRC_ROOT, 'accounts', 'data.json'))
  ? path.join(SRC_ROOT, 'accounts', 'data.json')
  : path.join(SRC_ROOT, 'storage', 'data.json');

// King -> default userData (za-post-restored); base -> za-post-restored-base
// (matches main.js `--profile=base`, which sets the app name to za-post-restored-base).
const DEST_ROOT = path.join(process.env.APPDATA, VARIANT === 'base' ? 'za-post-restored-base' : 'za-post-restored');
const DEST_DATA = path.join(DEST_ROOT, 'data.json');
const DEST_ACCOUNTS = path.join(DEST_ROOT, 'accounts');
const DEST_IMAGES = path.join(DEST_ROOT, 'storage', 'images');

// M4-08: use the app's hardened defaults (lower-spam tempo) as the base so a migrated install
// doesn't start at the old aggressive cadence; the SOURCE app's settings still override on top.
const DEFAULT_SETTINGS = require('../lib/store').DEFAULT_SETTINGS;

function log(...a) { console.log(...a); }
function ensure(d) { fs.mkdirSync(d, { recursive: true }); return d; }

function main() {
  if (!fs.existsSync(SRC_DATA)) { console.error('Source data not found:', SRC_DATA); process.exit(1); }
  ensure(DEST_ROOT); ensure(DEST_ACCOUNTS); ensure(DEST_IMAGES);

  const src = JSON.parse(fs.readFileSync(SRC_DATA, 'utf8'));
  log(`Source: ${SRC_DATA}`);
  log(`  posts=${(src.posts || []).length} groups=${(src.groups || []).length} accounts=${(src.accounts || []).length}`);

  // Backup any existing destination data.
  if (fs.existsSync(DEST_DATA)) {
    const bak = DEST_DATA + '.bak-' + Date.now();
    fs.copyFileSync(DEST_DATA, bak);
    log(`Backed up existing data.json -> ${path.basename(bak)}`);
  }

  // ---- groups: keep {id, groupId, name} (preserve internal id so assignedGroups resolve)
  const groups = (src.groups || []).map((g, i) => ({
    id: g.id || 'group-' + (i + 1),
    groupId: g.groupId || g.id,
    name: g.name || `Group ${i + 1}`,
  }));

  // ---- posts: copy image into DEST, map imagePath -> imagePaths[]
  let imgCopied = 0, imgMissing = 0, imgCollision = 0;
  const usedNames = new Map(); // destBasename -> the source path that claimed it (collision detection)
  const SRC_IMAGES = path.join(SRC_ROOT, 'storage', 'images');
  const posts = (src.posts || []).map((p, i) => {
    const imagePaths = [];
    if (p.imagePath) {
      // Stored absolute paths are stale; resolve by basename against the source storage dir.
      const base = path.basename(p.imagePath);
      const candidates = [p.imagePath, path.join(SRC_IMAGES, base)];
      const found = candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
      if (found) {
        // M3-08: two posts can have same-basename images from DIFFERENT source dirs. Copying both to
        // DEST_IMAGES/<base> would overwrite the first (last-wins) and silently mis-assign the image.
        // Disambiguate the SECOND+ distinct source by appending a short hash of its full path.
        let destBase = base;
        const prior = usedNames.get(destBase);
        if (prior && prior !== found) {
          const h = crypto.createHash('sha1').update(found).digest('hex').slice(0, 8);
          const ext = path.extname(base);
          destBase = `${path.basename(base, ext)}-${h}${ext}`;
          imgCollision++;
          log(`  ⚠️ image name collision: "${base}" already taken — saving as "${destBase}" so it isn't overwritten`);
        }
        usedNames.set(destBase, found);
        const dest = path.join(DEST_IMAGES, destBase);
        try { fs.copyFileSync(found, dest); imagePaths.push(dest); imgCopied++; }
        catch { imagePaths.push(found); }
      } else { imgMissing++; }
    }
    return {
      id: p.id || 'post-' + (Date.now() + i),
      caption: p.caption || '',
      comment: p.comment || '',
      imagePaths,
      imageUrl: p.imageUrl || '',
      commentImagePath: p.commentImagePath || null,
      commentImageUrl: p.commentImageUrl || '',
    };
  });

  // ---- accounts: map + copy cookies.json from old per-account dir
  let cookieCopied = 0, cookieMissing = 0, withSession = 0;
  const accounts = (src.accounts || []).map((a) => {
    const name = a.name;
    const srcCookies = path.join(SRC_ROOT, 'accounts', name, 'cookies.json');
    const destDir = ensure(path.join(DEST_ACCOUNTS, name));
    ensure(path.join(destDir, 'chrome-profile'));
    if (fs.existsSync(srcCookies)) {
      try {
        const raw = fs.readFileSync(srcCookies, 'utf8');
        fs.writeFileSync(path.join(destDir, 'cookies.json'), raw);
        cookieCopied++;
        const ck = JSON.parse(raw);
        if (Array.isArray(ck) && ck.some((c) => c.name === 'c_user') && ck.some((c) => c.name === 'xs')) withSession++;
      } catch { cookieMissing++; }
    } else { cookieMissing++; }
    return {
      name,
      alias: a.alias || '',
      status: a.status === 'logged_in' ? 'logged_in' : (a.status || 'not_logged_in'),
      lastMessage: '',
      assignedGroups: Array.isArray(a.assignedGroups) ? a.assignedGroups : [],
      postFilter: a.postFilter || 'all',
      postingOrder: a.postingOrder || 'post-centric',
      enabled: a.enabled !== false,
    };
  });

  const out = {
    posts, groups, accounts,
    settings: { ...DEFAULT_SETTINGS, ...(src.settings || {}) },
    proxies: Array.isArray(src.proxies) ? src.proxies : [],
    useProxies: !!(src.settings && src.settings.useProxies) || !!src.useProxies,
  };

  const tmp = DEST_DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, DEST_DATA);

  log('\n=== MIGRATION COMPLETE ===');
  log(`Destination: ${DEST_DATA}`);
  log(`  posts:    ${posts.length}  (images copied ${imgCopied}, missing ${imgMissing}, name-collisions resolved ${imgCollision})`);
  log(`  groups:   ${groups.length}`);
  log(`  accounts: ${accounts.length}  (cookies copied ${cookieCopied}, missing ${cookieMissing}, with c_user+xs session ${withSession})`);
  log(`  settings: ${JSON.stringify(out.settings)}`);
  log(`  proxies:  ${out.proxies.length}  useProxies=${out.useProxies}`);
}

main();
