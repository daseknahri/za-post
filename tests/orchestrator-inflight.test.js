// tests/orchestrator-inflight.test.js
// Login-during-run: you must be able to log in any account WHILE a run is active — except the one posting RIGHT
// NOW (its profile browser is open). isAccountInFlight(name) drives that gate in main.openLoginBrowser; it is
// true ONLY when the account's live state is 'running'. Everything else (queued / done / dropped) is loggable.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('isAccountInFlight is true only for the actively-posting account', () => {
  const { Orchestrator } = require('../automation/orchestrator');
  const o = new Orchestrator(() => {}, {});
  o._acctLive = {
    A: { state: 'running' },       // posting now → in-flight → login blocked
    B: { state: 'done' },          // finished → loggable
    C: { state: 'queued' },        // waiting → loggable (worker skips it via isLoginOpen while login is open)
    D: { state: 'rate_limited' },  // dropped → loggable (the common "re-login a logged-out account" case)
  };
  assert.equal(o.isAccountInFlight('A'), true);
  assert.equal(o.isAccountInFlight('B'), false);
  assert.equal(o.isAccountInFlight('C'), false);
  assert.equal(o.isAccountInFlight('D'), false);
  assert.equal(o.isAccountInFlight('Z'), false); // not in this cycle → loggable
});
