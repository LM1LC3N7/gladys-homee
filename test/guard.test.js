// The IndexGuard (src/guard.js), taken from gladys-p1-monitor with its tests
// (test/model.test.js there), here with the maximum power of a homee device
// (25 kW, INDEX_MAX_KW) instead of 100 kW.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_MAX_KW } from '../src/constants.js';
import { IndexGuard } from '../src/guard.js';

const MINUTE = 60_000;

test('index guard: 25 kW by default, the maximum power a parameter', () => {
  assert.equal(INDEX_MAX_KW, 25);
  assert.equal(new IndexGuard().maxKw, 25);
  // 30 kWh in one hour: above 25 kW, held; with 100 kW, taken.
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(130, 60 * MINUTE), false);
  assert.equal(
    new IndexGuard({ value: 100, at: 0 }, undefined, undefined, 100).accept(130, 60 * MINUTE),
    true,
  );
});

test('index guard: never 0, a normal rise goes through', () => {
  const guard = new IndexGuard();
  assert.equal(guard.accept(0, 0), false, 'never 0, even as the first reference');
  assert.equal(guard.accept(1000, 0), true);
  assert.equal(guard.accept(1000.2, MINUTE), true);
  for (let i = 2; i < 200; i += 1) {
    assert.equal(guard.accept(0, i * MINUTE), false);
  }
  assert.equal(guard.accept(1000.3, 200 * MINUTE), true);
  assert.equal(new IndexGuard().accept(-1, 0), false);
  assert.equal(new IndexGuard().accept(NaN, 0), false);
  assert.equal(new IndexGuard({ value: 100, at: 0 }).accept(400, 24 * 60 * MINUTE), true);
});

test('index guard: a jump up is never confirmed by repetition, only by the user', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  for (let i = 1; i <= 500; i += 1) {
    assert.equal(guard.accept(6000 + i * 0.01, i * MINUTE), false);
  }
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 1000,
    to: 6005,
    threshold: 6000.01,
    at: 500 * MINUTE,
  });
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 6005 });
  assert.equal(guard.accept(6005.01, 501 * MINUTE), true);
  assert.equal(guard.held, undefined);
  const back = new IndexGuard({ value: 1000, at: 0 });
  back.accept(9000, MINUTE);
  assert.equal(back.accept(1000.1, 2 * MINUTE), true);
  assert.equal(back.held, undefined);
  back.acceptHeld();
  assert.equal(back.accept(9000, 3 * MINUTE), false, 'an old acceptance never covers a new jump');
});

test('index guard: a held jump is never covered by the margin growing over time', () => {
  const guard = new IndexGuard({ value: 2.5, at: 0 });
  assert.equal(guard.accept(12345, MINUTE), false);
  assert.equal(guard.accept(12345.5, 200 * 60 * MINUTE), false);
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 2.5,
    to: 12345.5,
    threshold: 12345,
    at: 200 * 60 * MINUTE,
  });
  assert.equal(guard.accept(2.6, 200 * 60 * MINUTE + MINUTE), true);
});

test('index guard: a drop is never confirmed by time; back up, nothing fictive is billed', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  for (let i = 1; i <= 7 * 24 * 60; i += 60) {
    assert.equal(guard.accept(10 + i * 0.0001, i * MINUTE), false, `minute ${i}`);
  }
  assert.equal(guard.held.direction, 'down');
  assert.deepEqual(guard.last, { value: 50_000, at: 0 });
  assert.equal(guard.accept(50_001, 7 * 24 * 60 * MINUTE + MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: a drop accepted by the user, then the values rise normally', () => {
  const guard = new IndexGuard({ value: 50_000, at: 0 });
  assert.equal(guard.accept(10, MINUTE), false);
  guard.acceptHeld();
  assert.equal(guard.accept(10.01, 2 * MINUTE), true);
  assert.deepEqual(guard.last, { value: 10.01, at: 2 * MINUTE });
  assert.equal(guard.accept(10.5, 3 * MINUTE), true);
  assert.equal(guard.accept(50_000, 4 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
});

test('index guard: an acceptance of a drop never takes a jump', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(10, MINUTE);
  guard.acceptHeld();
  assert.equal(guard.accept(90_000, 2 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
  assert.equal(guard.accept(90_000, 3 * MINUTE), false);
});

test('index guard: a frozen reading never shrinks the margin of the next rise', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  for (let i = 1; i <= 180; i += 1) {
    assert.equal(guard.accept(1000, i * MINUTE), true);
  }
  assert.deepEqual(guard.last, { value: 1000, at: 0 }, 'the date of the value is kept');
  assert.equal(guard.accept(1004, 181 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: its state survives a restart; same value, the oldest date', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  guard.accept(1050, MINUTE);
  const saved = JSON.parse(JSON.stringify(guard.state()));
  const again = new IndexGuard({ value: 900, at: -1000 * MINUTE }, saved);
  assert.deepEqual(again.last, { value: 1000, at: 0 });
  assert.equal(again.accept(1050.1, 60 * MINUTE), false, 'still held after the restart');
  again.acceptHeld();
  assert.equal(again.accept(1050.2, 61 * MINUTE), true);
  assert.deepEqual(new IndexGuard({ value: 1100, at: 5 }, saved).last, { value: 1100, at: 5 });
  assert.deepEqual(new IndexGuard({ value: 1000, at: 50 }, saved).last, { value: 1000, at: 0 });
  assert.deepEqual(
    new IndexGuard({ value: 1000, at: -50 }, { last: { value: 1000, at: 10 } }).last,
    { value: 1000, at: -50 },
  );
});

test('index guard: an acceptance is bounded to the value shown and the margin since', () => {
  const guard = new IndexGuard({ value: 1000, at: 0 });
  assert.equal(guard.accept(1005, MINUTE), false);
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 1005 });
  assert.equal(guard.accept(5000, 2 * MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 5000);
  assert.equal(guard.accepted, undefined);
  assert.equal(guard.accept(5000.1, 3 * MINUTE), false, 'still held');
  const fair = new IndexGuard({ value: 1000, at: 0 });
  fair.accept(1005, MINUTE);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 2 * MINUTE), true);
  const below = new IndexGuard({ value: 1000, at: 0 });
  below.accept(1005, MINUTE);
  below.acceptHeld();
  assert.equal(below.accept(1004, 2 * MINUTE), false);
  const drop = new IndexGuard({ value: 1000, at: 0 });
  drop.accept(10, MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(900, 2 * MINUTE), false, 'not the drop shown');
  drop.accept(10, 3 * MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(10.2, 4 * MINUTE), true);
  assert.equal(new IndexGuard({ value: 1, at: 0 }).acceptHeld(), undefined, 'nothing held');
});

test('index guard: a value held read back from /data is dated at its loading', () => {
  const DAY = 24 * 60 * MINUTE;
  const saved = {
    last: { value: 1000, at: 0 },
    held: { direction: 'up', from: 1000, to: 1005, threshold: 1005, at: 0 },
  };
  const guard = new IndexGuard(undefined, saved, 5 * DAY);
  assert.equal(guard.held.at, 5 * DAY);
  guard.acceptHeld();
  assert.equal(guard.accept(5000, 5 * DAY + MINUTE), false, 'the old date never widens it');
  assert.equal(guard.held.to, 5000);
  const fair = new IndexGuard(undefined, saved, 5 * DAY);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 5 * DAY + MINUTE), true);
});

test('index guard: under a held jump, an old reference never lets a big rise through', () => {
  const DAY = 24 * 60 * MINUTE;
  const guard = new IndexGuard({ value: 1000, at: 0 });
  assert.equal(guard.accept(15_000, MINUTE), false);
  assert.equal(guard.accept(15_000, 10 * DAY), false);
  assert.equal(guard.held.threshold, 15_000);
  assert.equal(guard.accept(5000, 10 * DAY + MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 5000);
  assert.equal(guard.held.from, 1000);
  assert.equal(guard.accept(1000.2, 10 * DAY + 2 * MINUTE), true);
  assert.equal(guard.held, undefined);
});
