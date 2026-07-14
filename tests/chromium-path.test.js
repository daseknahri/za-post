// tests/chromium-path.test.js
// chromium.findSystemBrowser probes known Chrome/Edge install paths (opt-in ZA_USE_SYSTEM_CHROME=1).
// INVARIANT: it returns null OR a path that fs.existsSync confirms — NEVER a phantom path, which would
// make every Puppeteer launch spawn-fail with a misleading ENOENT. This pins that null-or-real contract.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { findSystemBrowser } = require('../lib/chromium');

test('findSystemBrowser: returns null or a REAL existing path (never a phantom)', () => {
  const r = findSystemBrowser();
  assert.ok(r === null || (typeof r === 'string' && r.length > 0 && fs.existsSync(r)),
    `must be null or an existing file, got: ${r}`);
});
