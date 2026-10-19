// /data/state.json, in a folder of the repository (git-ignored data/), never
// a system temporary folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIMINGS } from '../src/constants.js';
import { StateStore } from '../src/store.js';

const creds = { host: '192.168.1.60', username: 'gladys', password: 'secret password' };

function tempDir(t) {
  const dir = fileURLToPath(
    new URL(`../data/test-${process.pid}-${Math.random().toString(36).slice(2)}`, import.meta.url),
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a refusal outlives a restart, without the user name nor the password', (t) => {
  const dir = tempDir(t);
  const now = 1_000_000;
  const store = new StateStore({ dir, now: () => now });
  const first = store.refuse(creds, 'refused (HTTP 401)');
  assert.equal(first.retryAt, now + TIMINGS.authRetryMin);
  assert.equal(store.refuse(creds, 'again').retryAt, now + 2 * TIMINGS.authRetryMin);
  const file = readFileSync(`${dir}/state.json`, 'utf8');
  assert.ok(!file.includes('secret'), 'no password');
  assert.ok(!file.includes('gladys'), 'no user name');
  const again = new StateStore({ dir, now: () => now });
  assert.ok(again.refusalOf(creds));
  assert.equal(again.refusalOf({ ...creds, password: 'new one' }), undefined);
  again.clearRefusal();
  assert.equal(new StateStore({ dir, now: () => now }).refusalOf(creds), undefined);
});

test('retries double up to 24 h; dates far ahead are bounded when read back', (t) => {
  const dir = tempDir(t);
  const now = 5_000_000;
  const store = new StateStore({ dir, now: () => now });
  let refusal;
  for (let i = 0; i < 12; i += 1) {
    refusal = store.refuse(creds, 'x');
  }
  assert.equal(refusal.retryAt, now + TIMINGS.authRetryMax);
  store.pauseUntil(now + 100 * TIMINGS.rateLimitMax);
  assert.equal(store.pausedUntil, now + TIMINGS.rateLimitMax);
  const json = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
  json.refused.retryAt = now * 1000;
  json.pausedUntil = now * 1000;
  writeFileSync(`${dir}/state.json`, JSON.stringify(json));
  const read = new StateStore({ dir, now: () => now });
  assert.equal(read.refusalOf(creds).retryAt, now + TIMINGS.authRetryMax);
  assert.equal(read.pausedUntil, now + TIMINGS.rateLimitMax);
});

test('an unreadable or hostile file starts empty', (t) => {
  const dir = tempDir(t);
  writeFileSync(
    `${dir}/state.json`,
    '{"__proto__":{"polluted":1},"refused":{"key":"zz"},"salt":"nothex"}',
  );
  const store = new StateStore({ dir });
  assert.equal({}.polluted, undefined);
  assert.equal(store.data.refused, undefined);
  assert.match(store.data.salt, /^[0-9a-f]{32}$/);
  writeFileSync(`${dir}/state.json`, 'not json');
  assert.equal(new StateStore({ dir }).pausedUntil, 0);
});
