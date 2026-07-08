// scripts/apply-brand.js <brandName>
// Make brands/<brandName>.json the ACTIVE brand before a build:
//   1. copy it to brand.json (read at runtime by lib/brand.js + shipped inside the asar),
//   2. stamp the build-time keys into package.json (name, build.appId, build.productName, build.win.icon),
//   3. stamp the window <title> into renderer/index.html.
// Then `npm run pack:portable` produces that brand's app. With no arg, prints the current brand.
// Build the original with:  node scripts/apply-brand.js zapost   (restores the "Za Post" identity).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const name = process.argv[2];

if (!name) {
  try { console.log('Active brand.json:\n' + fs.readFileSync(path.join(ROOT, 'brand.json'), 'utf8')); }
  catch { console.log('(no brand.json yet)'); }
  const dir = path.join(ROOT, 'brands');
  try { console.log('Available brands: ' + fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).join(', ')); } catch {}
  process.exit(0);
}

const profPath = path.join(ROOT, 'brands', name + '.json');
let b;
try { b = JSON.parse(fs.readFileSync(profPath, 'utf8')); }
catch (e) { console.error('Cannot read brand profile ' + profPath + ': ' + e.message); process.exit(1); }

for (const k of ['name', 'appId', 'productName', 'icon']) {
  if (!b[k]) { console.error('brand profile is missing required field: ' + k); process.exit(1); }
}

// 1) active brand.json (runtime + shipped in asar)
fs.writeFileSync(path.join(ROOT, 'brand.json'), JSON.stringify(b, null, 2) + '\n');

// 2) package.json build-time identity (electron-builder needs these literal at build time)
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.name = b.name;
pkg.build = pkg.build || {};
pkg.build.appId = b.appId;
pkg.build.productName = b.productName;
pkg.build.win = pkg.build.win || {};
pkg.build.win.icon = b.icon;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 3) renderer window <title>
const idxPath = path.join(ROOT, 'renderer', 'index.html');
try {
  let idx = fs.readFileSync(idxPath, 'utf8');
  idx = idx.replace(/<title>[\s\S]*?<\/title>/i, '<title>' + (b.windowTitle || b.productName) + '</title>');
  idx = idx.replace(/(<h1\b[^>]*id="brand-name"[^>]*>)[\s\S]*?(<\/h1>)/i, '$1' + (b.shortName || b.productName) + '$2'); // in-app header name
  fs.writeFileSync(idxPath, idx);
} catch (e) { console.error('Could not stamp <title> in index.html: ' + e.message); }

console.log('Applied brand "' + name + '": ' + b.productName + '  (name=' + b.name + ', appId=' + b.appId + ', port=' + b.remotePort + ', icon=' + b.icon + ')');
