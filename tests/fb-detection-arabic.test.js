// tests/fb-detection-arabic.test.js
// The operator's accounts are Moroccan — Facebook's UI there is frequently ARABIC. The rate-limit / checkpoint /
// pending classifiers (worker.js FB.rateLimit/checkpoint/pending) carry HAMZA-FREE Arabic patterns on purpose: the
// matcher NFD-normalizes, which decomposes أ/إ/ؤ/ئ into base+U+0654 (NOT stripped), so a hamza-bearing pattern could
// never match — the patterns use plain letters that normalize to themselves. NO existing test exercised Arabic, so a
// "cleanup" of these strings or a normalization change could SILENTLY break block-detection on an Arabic-locale
// account → it posts into an UNDETECTED block (ban) or a held post goes unnoticed. This pins the Arabic detection.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../automation/worker');

test('isRateLimitText: Arabic temporary-block phrasings match', () => {
  assert.ok(w.isRateLimitText('عذرًا، أنت محظور مؤقتًا من النشر'), '"محظور" (blocked) present');
  assert.ok(w.isRateLimitText('لقد تم حظرك بسبب النشر بشكل متكرر'), '"حظرك" + "بشكل متكرر" present');
  assert.ok(w.isRateLimitText('لا يمكنك استخدام هذه الميزة الآن'), 'full "لا يمكنك استخدام هذه الميزة" phrase');
});

test('isCheckpointText: Arabic identity-check phrasings match', () => {
  assert.ok(w.isCheckpointText('يرجى التحقق من هويتك للمتابعة', ''), '"التحقق من هويتك" present');
  assert.ok(w.isCheckpointText('نحتاج إلى تأكيد أنك شخص حقيقي', ''), '"شخص حقيقي" present');
});

test('isPendingText: Arabic pending-approval phrasings match', () => {
  assert.ok(w.isPendingText('منشورك بانتظار الموافقة من المشرف'), '"بانتظار الموافقة" present');
  assert.ok(w.isPendingText('هذا المنشور قيد المراجعة'), '"قيد المراجعة" present');
});

test('Arabic classifiers do NOT fire on benign Arabic text (false-positive guard)', () => {
  assert.equal(w.isRateLimitText('مرحبا بك في مجموعتنا، شارك منشورك الآن'), false, 'a normal Arabic greeting is not a block');
  assert.equal(w.isPendingText('لديك 3 طلبات صداقة معلقة'), false, 'Arabic "pending friend requests" is not a post-pending notice');
});
