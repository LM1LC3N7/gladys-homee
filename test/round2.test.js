// -----------------------------------------------------------------------------
// The approval round of the review (commit cc8eab4), inverted: R1 (one click
// took every held index of a device, the badge showed one), the two-click
// acceptance, the badge summing every hold, the grouped writes of the index
// references, and a node message without options.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HomeeApp } from '../src/app.js';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { T } from '../src/i18n.js';
import { StateStore } from '../src/store.js';
import { attr, node } from './fixtures/box.js';
import { CONFIG, fakeBox, settle } from './helpers/fakeBox.js';

async function setup(t, { store } = {}) {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: Date.parse('2026-10-20T08:00:00Z'),
  });
  const gladys = createFakeGladys({ config: CONFIG });
  const box = fakeBox();
  // A double metering relay: one energy index per channel.
  box.all.nodes.push(
    node(40, 'Relais double', 33, [
      attr(401, 40, 1, 1, { editable: 1, instance: 1 }),
      attr(402, 40, 1, 1, { editable: 1, instance: 2 }),
      attr(403, 40, 4, 100, { max: 1e6, unit: 'kWh', instance: 1 }),
      attr(404, 40, 4, 200, { max: 1e6, unit: 'kWh', instance: 2 }),
    ]),
  );
  const app = new HomeeApp({
    gladys,
    token: box.token,
    live: box.openLive,
    now: () => Date.now(),
    store: store ?? new StateStore({ dir: null, now: () => Date.now() }),
    logger: createLogger({ level: 'silent' }),
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  await gladys.connect();
  await settle();
  const relay = gladys.fake.discoveredDevices.find((d) => d.name === 'Relais double');
  await gladys.fake.deviceCreated(relay);
  await tick(11_000);
  const id = (a) => `${relay.external_id}:a${a}`;
  return { gladys, app, box, tick, relay, id };
}

const badgeOf = (gladys, device) =>
  gladys.fake.transports.filter((e) => e.device_external_id === device.external_id).at(-1);

async function twoHolds({ box, tick }) {
  box.emit(403, 0.5); // channel 1: the user reset its meter (a real drop)
  await tick(11_000);
  box.emit(404, 5200); // channel 2: a glitch (+5000 kWh)
  await tick(11_000);
}

test('R1 inverted: the badge sums every hold; the first click takes nothing and lists them all', async (t) => {
  const ctx = await setup(t);
  const { gladys, app, tick, relay, id } = ctx;
  assert.equal(gladys.fake.lastState(id(403)), 100);
  assert.equal(gladys.fake.lastState(id(404)), 200);
  await twoHolds(ctx);
  const badge = badgeOf(gladys, relay);
  assert.equal(badge.degraded, true);
  assert.match(badge.message.fr, /^2 index d'énergie retenus \(5000 kWh en attente, 1 baisse\)/);
  assert.ok(badge.message.fr.length <= LIMITS.badgeMessage);
  assert.ok(badge.message.en.length <= LIMITS.badgeMessage);
  const first = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(first.fr, /^Rien n'est pris/);
  assert.match(first.fr, /baisse de 100 à 0\.5 kWh \(0 kWh\)/);
  assert.match(first.fr, /saut de 200 à 5200 kWh \(5000 kWh\)/);
  assert.match(first.fr, /\(5000 kWh comptés/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id(404)), 200, 'nothing billed by the first click');
  assert.equal(gladys.fake.lastState(id(403)), 100);
  // The second click within 60 s takes exactly this set.
  const second = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(second.fr, /^Accepté : 5000 kWh/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id(404)), 5200);
  assert.equal(gladys.fake.lastState(id(403)), 0.5);
  assert.equal(badgeOf(gladys, relay).degraded, undefined);
});

test('a set that changes between the two clicks is a first click again', async (t) => {
  const ctx = await setup(t);
  const { gladys, app, box, tick, relay, id } = ctx;
  box.emit(403, 0.5);
  await tick(11_000);
  const first = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(first.en, /^Nothing taken yet/);
  assert.doesNotMatch(first.en, /5200/);
  box.emit(404, 5200); // a new hold appears before the second click
  await tick(11_000);
  const again = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(again.en, /^Nothing taken yet/, 'not the set shown: nothing taken');
  assert.match(again.en, /jump from 200 to 5200 kWh/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id(404)), 200);
  assert.equal(gladys.fake.lastState(id(403)), 100);
  const third = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(third.en, /^Accepted: 5000 kWh/);
});

test('a second click after 60 s is a first click again', async (t) => {
  const ctx = await setup(t);
  const { gladys, app, tick, relay, id } = ctx;
  await twoHolds(ctx);
  await app.acceptHeldIndex({ device: relay.external_id });
  await tick(TIMINGS.acceptConfirm + 1000);
  const late = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(late.en, /^Nothing taken yet/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id(404)), 200);
  assert.equal(T.accept.nothing.en.length > 0, true);
});

test('/data: a hold is written at once, the reference at most once a minute', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  let writes = 0;
  const save = store.save.bind(store);
  store.save = () => {
    writes += 1;
    save();
  };
  const ctx = await setup(t, { store });
  const { box, tick, id } = ctx;
  await tick(TIMINGS.indexWriteEvery); // the first references written
  writes = 0;
  for (let i = 1; i <= 10; i += 1) {
    box.emit(403, 100 + i * 0.01); // a rise every 5 s
    await tick(5000);
  }
  assert.ok(writes <= 2, `${writes} writes for 10 references in 50 s`);
  assert.equal(store.indexState(id(403)).last.value >= 100, true);
  writes = 0;
  box.emit(404, 5200); // a hold: at once
  await settle();
  assert.equal(writes, 1);
  assert.equal(store.indexState(id(404)).held.to, 5200);
  await tick(TIMINGS.indexWriteEvery);
  assert.equal(store.indexState(id(403)).last.value, 100.1, 'the last reference written in time');
});

test('the second click never counts more than listed: a jump grown past the margin is listed again', async (t) => {
  const ctx = await setup(t);
  const { gladys, app, box, tick, relay, id } = ctx;
  box.emit(404, 5200);
  await tick(11_000);
  const first = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(first.en, /jump from 200 to 5200 kWh \(5000 kWh\)/);
  box.emit(404, 9200); // same hold (same start and threshold), 4000 kWh more
  await tick(11_000);
  const second = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(second.en, /^Nothing taken yet/, '9000 kWh were never listed');
  assert.match(second.en, /jump from 200 to 9200 kWh \(9000 kWh\)/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id(404)), 200);
  // Within the margin since the listing: taken.
  box.emit(404, 9200.05);
  await tick(1000);
  const third = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(third.en, /^Accepted: 9000\.05 kWh/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id(404)), 9200.05);
});

test('a meter reset that counts again stays one drop: the second click takes it', async (t) => {
  const ctx = await setup(t);
  const { gladys, app, box, tick, relay, id } = ctx;
  box.emit(403, 0.5);
  await tick(11_000);
  const first = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(first.en, /drop from 100 to 0\.5 kWh/);
  box.emit(403, 0.6); // the reset meter goes on counting: its threshold moves
  await tick(11_000);
  const second = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(second.en, /^Accepted: 0 kWh/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id(403)), 0.6);
  // A drop far above what was listed is listed again.
  box.emit(404, 50);
  await tick(11_000);
  await app.acceptHeldIndex({ device: relay.external_id });
  box.emit(404, 150);
  await tick(11_000);
  const again = await app.acceptHeldIndex({ device: relay.external_id });
  assert.match(again.en, /^Nothing taken yet/);
});

test('a durable drop logs once and writes /data once, however often the reset meter counts', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  let writes = 0;
  const save = store.save.bind(store);
  store.save = () => {
    writes += 1;
    save();
  };
  const ctx = await setup(t, { store });
  const { app, box, tick } = ctx;
  const warnings = [];
  app.logger = { warn: (m) => warnings.push(m), info() {}, error() {}, debug() {} };
  await tick(TIMINGS.indexWriteEvery);
  writes = 0;
  for (let i = 0; i < 30; i += 1) {
    box.emit(403, 0.5 + i * 0.01);
    await tick(5000);
  }
  assert.equal(writes, 1, 'the hold written once');
  assert.equal(warnings.filter((w) => /held back/.test(w)).length, 1);
});

test('a node message without options keeps the direction known', async (t) => {
  const { app, box, tick } = await setup(t);
  // The garage door reversed in GET:all, then a node message without options.
  box.attribute(141).options = { reverse_control_ui: 1 };
  box.message('all', box.all);
  await tick(0);
  assert.equal(app.nodes.get(14).attributes.get(141).reversed, true);
  const n = structuredClone(box.node(14));
  delete n.attributes[0].options;
  box.message('node', n);
  await tick(0);
  assert.equal(app.nodes.get(14).attributes.get(141).reversed, true);
  // A new attribute in a node message: not reversed.
  n.attributes.push(attr(142, 14, 304, 0, { editable: 1 }));
  box.message('node', n);
  await tick(0);
  assert.equal(app.nodes.get(14).attributes.get(142).reversed, false);
});
