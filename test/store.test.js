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

test('index states: validated, only our feature ids, kept across a restart, dropped per device', (t) => {
  const dir = tempDir(t);
  const id = 'ext:gladys:homee:0123456789ab-12:a123';
  writeFileSync(
    `${dir}/state.json`,
    JSON.stringify({
      indexes: {
        [id]: {
          last: { value: 312.4, at: 5 },
          held: { direction: 'up', from: 312.4, to: 5000, threshold: 5000, at: 6 },
        },
        'ext:gladys:homee:0123456789ab-13:a1': { last: { value: 0, at: 5 } },
        'ext:gladys:other:x': { last: { value: 1, at: 5 } },
        __proto__: { last: { value: 1, at: 5 } },
        'ext:gladys:homee:bad': { last: { value: 1, at: 5 }, held: { direction: 'sideways' } },
      },
    }),
  );
  const store = new StateStore({ dir });
  assert.deepEqual(Object.keys(store.data.indexes).sort(), [id, 'ext:gladys:homee:bad']);
  assert.equal(store.indexState('ext:gladys:homee:bad').held, null);
  assert.equal(store.indexState(id).held.to, 5000);
  assert.equal(store.indexState('toString'), undefined);
  store.setIndexState(id, { last: { value: 312.5, at: 7 }, held: null });
  assert.deepEqual(new StateStore({ dir }).indexState(id), {
    last: { value: 312.5, at: 7 },
    held: null,
  });
  store.dropIndexStates('ext:gladys:homee:0123456789ab-12');
  assert.equal(new StateStore({ dir }).indexState(id), undefined);
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
