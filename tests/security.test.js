// tests/security.test.js
// M3-03: the SSRF guard for remote image URLs. M3-06: proxy-string validation. Both are the kind of
// input-validation that's only worth anything if the NEGATIVE cases are pinned.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../automation/worker');

test('isSafeImageUrl: allows public http/https image hosts', () => {
  assert.ok(w.isSafeImageUrl('https://example.com/a.jpg'));
  assert.ok(w.isSafeImageUrl('http://cdn.images.net/x.png'));
  assert.ok(w.isSafeImageUrl('https://8.8.8.8/pic.webp')); // public IP literal is fine
});

test('isSafeImageUrl: blocks internal/private targets and non-http schemes (SSRF)', () => {
  for (const bad of [
    'http://localhost/x', 'http://127.0.0.1/x', 'http://0.0.0.0/x',
    'http://169.254.169.254/latest/meta-data/',     // cloud metadata
    'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://172.16.0.9/x', 'http://172.31.255.1/x',
    'http://[::1]/x', 'http://[fd00::1]/x', 'http://[fe80::1]/x',
    'file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://host/x', 'gopher://host',
    'not a url', '', null, undefined,
  ]) {
    assert.equal(w.isSafeImageUrl(bad), false, `should block: ${bad}`);
  }
});

test('isSafeImageUrl: a public host in the 172 range outside 16-31 is allowed', () => {
  assert.ok(w.isSafeImageUrl('http://172.15.0.1/x'));  // not private
  assert.ok(w.isSafeImageUrl('http://172.32.0.1/x'));  // not private
});

test('parseProxy: accepts valid schemes + ports, with and without auth', () => {
  const a = w.parseProxy('socks5://1.2.3.4:1080');
  assert.equal(a.scheme, 'socks5');
  assert.equal(a.server, 'socks5://1.2.3.4:1080');
  assert.equal(a.username, null);

  const b = w.parseProxy('http://user:pass@1.2.3.4:8080');
  assert.equal(b.username, 'user');
  assert.equal(b.password, 'pass');
});

test('parseProxy: rejects bad scheme, out-of-range port, and garbage', () => {
  assert.equal(w.parseProxy('ftp://1.2.3.4:8080'), null);     // scheme not allowed
  assert.equal(w.parseProxy('socks5://1.2.3.4:99999'), null); // port > 65535
  assert.equal(w.parseProxy('socks5://1.2.3.4:0'), null);     // port 0
  assert.equal(w.parseProxy('1.2.3.4:8080'), null);           // no scheme
  assert.equal(w.parseProxy('garbage'), null);
  assert.equal(w.parseProxy(''), null);
});

test('proxyFormatHint: suggests a schemed form for the common no-scheme mistakes (E-X2)', () => {
  assert.match(w.proxyFormatHint('1.2.3.4:8080'), /socks5:\/\/1\.2\.3\.4:8080/);
  assert.match(w.proxyFormatHint('1.2.3.4:8080:user:pass'), /host:port:user:pass|user:pass@/);
  assert.equal(w.proxyFormatHint('socks5://1.2.3.4:8080'), '', 'already-schemed string gets no hint');
  assert.equal(w.proxyFormatHint(''), '');
});
