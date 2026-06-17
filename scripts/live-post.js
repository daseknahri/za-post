// scripts/live-post.js  —  node scripts/live-post.js <account> <groupId> <postIndex>
// Runs the REAL worker for one account -> one member group -> one post (+ first comment).
// This PUBLISHES to Facebook. User-authorized, used to validate/tune the live flow.

const fs = require('fs'), path = require('path');
const { runAccount } = require('../automation/worker');

const ACC = process.argv[2] || 'account17';
const GROUP_ID = process.argv[3] || '1805238113111247'; // Dr. Barbara O'Neill Health Tips (B17 is a member)
const POST_IDX = parseInt(process.argv[4] || '1', 10);   // post[1] = purslane health post

const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
require('../lib/store').init(ROOT); // sets ACCOUNTS_DIR / IMAGES_DIR for the worker
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
// Resolve (or synthesize) the target group so this works even if it's not in data.groups.
let group = data.groups.find((g) => g.groupId === GROUP_ID || g.id === GROUP_ID);
if (!group) group = { id: 'tmp-' + GROUP_ID, groupId: GROUP_ID, name: 'Group ' + GROUP_ID };
const groups = data.groups.some((g) => g.id === group.id) ? data.groups : [...data.groups, group];
const account = { ...data.accounts.find(a => a.name === ACC), assignedGroups: [group.id] };
const post = data.posts[POST_IDX];
const settings = { ...data.settings, postsPerGroup: 1 };

console.log(`LIVE POST  account=${ACC}(${account.alias})  group=${GROUP_ID}  post="${(post.caption || '').slice(0, 50)}"`);
console.log(`  image: ${(post.imagePaths || [])[0] || '(none)'}`);
console.log(`  comment: ${post.comment || '(none)'}\n`);

runAccount({
  account, post, groups, settings,
  useProxies: false, proxies: [],
  log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
  shouldStop: () => false,
}).then((r) => { console.log('\nRESULT:', JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error('FATAL', e); process.exit(1); });
