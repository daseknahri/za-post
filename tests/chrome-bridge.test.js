// tests/chrome-bridge.test.js — the "Import from Chrome" companion-extension receiver.
// mapChromeCookie must faithfully convert the chrome.cookies shape (so datr/c_user/xs inject correctly), and the
// localhost receiver must token-gate (never import on a bad/absent token) and hand valid payloads to onImport.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startBridge, mapChromeCookie } = require('../lib/chrome-bridge');

test('mapChromeCookie converts Chrome cookie shape → app/puppeteer shape', () => {
  const m = mapChromeCookie({ name: 'datr', value: 'v', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: 1893456000.7 });
  assert.equal(m.name, 'datr'); assert.equal(m.value, 'v'); assert.equal(m.sameSite, 'None');
  assert.equal(m.secure, true); assert.equal(m.httpOnly, true); assert.equal(m.expires, 1893456000, 'expirationDate floored to integer expires');
  assert.equal(mapChromeCookie({ name: 'a', value: 'b', sameSite: 'lax' }).sameSite, 'Lax');
  assert.equal(mapChromeCookie({ name: 'a', value: 'b', sameSite: 'strict' }).sameSite, 'Strict');
  assert.equal('sameSite' in mapChromeCookie({ name: 'a', value: 'b', sameSite: 'unspecified' }), false, 'unspecified sameSite → omitted (let normalizeCookie decide)');
  assert.equal(mapChromeCookie({ name: 'a', value: null }), null, 'no value → dropped');
  assert.equal(mapChromeCookie({ name: 'a', value: '' }), null, 'empty-string value → dropped (matches import-cookies/bulk; keeps the xs check honest)');
  assert.equal(mapChromeCookie(null), null, 'null → dropped');
  assert.equal(mapChromeCookie({ name: 'a', value: 'b' }).domain, '.facebook.com', 'missing domain defaults to .facebook.com');
});

test('startBridge: token-gates every import, answers /ping, 404s the rest', async () => {
  const seen = [];
  const server = startBridge({ port: 0, token: 'secret123', onImport: async (p) => { seen.push(p); return { name: 'acc', created: true }; }, log: () => {} });
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = (method, path, body) => new Promise((res) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res({ status: r.statusCode, body: b })); });
    req.on('error', () => res({ status: 0, body: '' }));
    if (data) req.write(data); req.end();
  });
  try {
    const ping = await call('GET', '/ping');
    assert.equal(ping.status, 200); assert.match(ping.body, /za-post/);
    const bad = await call('POST', '/bridge', { token: 'WRONG', c_user: '1', cookies: [{ name: 'c_user', value: '1' }] });
    assert.equal(bad.status, 401, 'bad token → 401');
    assert.equal(seen.length, 0, 'onImport NEVER called on a bad token');
    const none = await call('POST', '/bridge', { c_user: '1', cookies: [] });
    assert.equal(none.status, 401, 'absent token → 401');
    const good = await call('POST', '/bridge', { token: 'secret123', c_user: '100', cookies: [{ name: 'c_user', value: '100' }] });
    assert.equal(good.status, 200, 'valid token → 200');
    assert.equal(seen.length, 1, 'onImport called exactly once on a valid token');
    assert.equal(seen[0].c_user, '100');
    const nf = await call('GET', '/nope');
    assert.equal(nf.status, 404, 'unknown route → 404');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
