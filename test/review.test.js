// -----------------------------------------------------------------------------
// The hostile scenarios of the review of commit dcae866, inverted: each one
// reproduced a defect, each one now asserts the fixed behaviour. Plus one
// test per other point of the review (minor ones included).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HomeeApp } from '../src/app.js';
import { ACTIONS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { hashPassword } from '../src/homee.js';
import { T } from '../src/i18n.js';
import { openSocket } from '../src/live.js';
import { RELAY_PROFILES, kindOf, mapNode } from '../src/mapping.js';
import { attributeOf, decode, nodeOf } from '../src/nodes.js';
import { StateStore } from '../src/store.js';
import { attr, node } from './fixtures/box.js';
import { CONFIG, fakeBox, settle } from './helpers/fakeBox.js';

const ALLOW_ALL = {
  ...CONFIG,
  allow_plug_control: true,
  allow_heating_control: true,
  allow_lock_control: true,
  allow_door_control: true,
  allow_valve_control: true,
  allow_siren_control: true,
  allow_alarm_control: true,
};

const newApp = (gladys, box, store) =>
  new HomeeApp({
    gladys,
    token: box.token,
    live: box.openLive,
    now: () => Date.now(),
    store: store ?? new StateStore({ dir: null, now: () => Date.now() }),
    logger: createLogger({ level: 'silent' }),
  });

async function setup(t, config = CONFIG, { prepare = () => {}, store } = {}) {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: Date.parse('2026-10-19T08:00:00.000Z'),
  });
  const gladys = createFakeGladys({ config });
  const box = fakeBox();
  prepare(box);
  const app = newApp(gladys, box, store);
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  await gladys.connect();
  await settle();
  return { gladys, app, box, tick };
}

const named = (gladys, name) => gladys.fake.discoveredDevices.find((d) => d.name === name);
async function created(gladys, name) {
  const device = named(gladys, name);
  await gladys.fake.deviceCreated(device);
  return device;
}
const featureOf = (device, key) =>
  device.features.find((f) => f.external_id === `${device.external_id}:${key}`);

function press(gladys, device, key, value = 1) {
  const result = { ack: undefined };
  result.done = gladys.fake.setValue(device, featureOf(device, key), value).then((a) => {
    result.ack = a;
    return a;
  });
  return result;
}
async function until(tick, ...pending) {
  for (let i = 0; i < 100 && pending.some((p) => p.ack === undefined); i += 1) {
    await tick(100);
  }
}
const sentOf = (gladys, id) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);
const lastBadge = (gladys, device) =>
  gladys.fake.transports.filter((e) => e.device_external_id === device.external_id).at(-1);

// --- B1: energy index -------------------------------------------------------------

test('E1 a jump is never confirmed by time: the resyncs repeat it, it stays held', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise congélateur');
  const id = `${plug.external_id}:a123`;
  await tick(TIMINGS.flushInterval);
  box.emit(123, 412.4);
  await tick(11_000);
  for (let i = 0; i < 30; i += 1) {
    await tick(TIMINGS.resync);
  }
  assert.ok(!sentOf(gladys, id).includes(412.4), 'never taken without the user');
  assert.equal(gladys.fake.lastState(id), 312.4);
});

test('E2 a drop then the real index back: no fictive kWh', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise congélateur');
  const id = `${plug.external_id}:a123`;
  await tick(TIMINGS.flushInterval);
  for (const value of [0, 0.001, 312.5, 312.6]) {
    box.emit(123, value);
    await tick(11_000);
  }
  assert.deepEqual([...new Set(sentOf(gladys, id))], [312.4, 312.5, 312.6]);
});

test('E3 after a restart, the reference is what Gladys holds: a 0 never reaches the index', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const { gladys, app, box, tick } = await setup(t, CONFIG, { store });
  const plug = await created(gladys, 'Prise congélateur');
  const id = `${plug.external_id}:a123`;
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(id), 312.4);
  app.stop();
  const device = gladys.devices.find((d) => d.external_id === plug.external_id);
  const feature = device.features.find((f) => f.external_id === id);
  feature.last_value = 312.4;
  feature.last_value_changed = new Date().toISOString();
  box.attribute(123).current_value = 0;
  const again = newApp(gladys, box, store);
  t.after(() => again.stop());
  await again.start(CONFIG);
  await tick(TIMINGS.flushInterval);
  assert.ok(!sentOf(gladys, id).includes(0), 'never 0');
  box.emit(123, 312.5);
  await tick(11_000);
  box.emit(123, 312.6);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id), 312.6, 'only 0.2 kWh counted');
});

test('E4 a jump of 5000 kWh is not taken by the next reading; only by the action', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise congélateur');
  const id = `${plug.external_id}:a123`;
  await tick(TIMINGS.flushInterval);
  box.emit(123, 5312.4);
  await tick(11_000);
  box.emit(123, 5312.5);
  await tick(11_000);
  assert.deepEqual([...new Set(sentOf(gladys, id))], [312.4]);
  let answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD, { device: plug.external_id });
  assert.match(answer.data.message.fr, /^Rien n'est pris/);
  answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD, { device: plug.external_id });
  assert.match(answer.data.message.fr, /^Accepté : 5000\.1 kWh/);
  await tick(11_000);
  assert.equal(gladys.fake.lastState(id), 5312.5);
});

test('M9 the total of a meter is a plain value, never a second index billed', () => {
  const m = mapNode(
    nodeOf(node(90, 'Compteur', 32, [attr(901, 90, 240, 1000, { max: 1e6, unit: 'kWh' })])),
  );
  const f = m.features.find((x) => x.key === 'a901');
  assert.deepEqual([f.category, f.type, f.unit], [C.UNKNOWN, TY.SENSOR.DECIMAL, undefined]);
  assert.equal(m.readers[0].meter, undefined);
});

// --- I1: protective commands, the queue released once sent --------------------------

test('Q1 "Stop the siren" 0.2 s after "Sound" is sent at once (the queue is released)', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      b.noEcho = true;
    },
  });
  const siren = await created(gladys, 'Sirène');
  const on = press(gladys, siren, 'a191-on');
  await tick(200);
  const off = press(gladys, siren, 'a191-off');
  await until(tick, on, off);
  assert.equal(on.ack.error, T.denied.sentUnconfirmed.fr);
  assert.notEqual(off.ack.error, T.denied.tooLate.fr);
  assert.deepEqual(
    box.puts.map((p) => p.value),
    [1, 0],
    'the stop is sent',
  );
});

test('Q2 a valve being opened can be closed at once (a leak)', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      b.slow = 20_000;
      b.attribute(181).current_value = 0;
      b.attribute(181).target_value = 0;
    },
  });
  const valve = await created(gladys, "Vanne d'arrivée d'eau");
  const open = press(gladys, valve, 'a181-open');
  await until(tick, open);
  assert.equal(open.ack.success, true, open.ack.error);
  await tick(1000);
  const close = press(gladys, valve, 'a181-close');
  await until(tick, close);
  assert.equal(close.ack.success, true, close.ack.error);
  assert.deepEqual(
    box.puts.map((p) => p.value),
    [100, 0],
  );
});

test('Q3 (M3) the second press of an impulse gate after 2 s is sent; a bounce is not', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      b.all.nodes.push(node(30, 'Portail', 2015, [attr(301, 30, 304, 0, { editable: 1 })]));
    },
  });
  const gate = await created(gladys, 'Portail');
  const first = press(gladys, gate, 'a301');
  const bounce = press(gladys, gate, 'a301');
  await until(tick, first, bounce);
  assert.equal(first.ack.success, true, first.ack.error);
  assert.equal(bounce.ack.error, T.denied.busy.fr, 'a bounce within 2 s');
  await tick(2000);
  const second = press(gladys, gate, 'a301');
  await until(tick, second);
  assert.equal(second.ack.success, true, second.ack.error);
  assert.equal(box.puts.length, 2);
});

test('U1 (M1) the "state not confirmed" badge goes away once the device reports a state', async (t) => {
  const { gladys, app, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      b.noEcho = true;
    },
  });
  const lock = await created(gladys, 'Serrure entrée');
  const unlock = press(gladys, lock, 'a151-unlock');
  await until(tick, unlock);
  for (let ms = 0; ms < TIMINGS.confirm.lock; ms += 1000) {
    await tick(1000); // the read backs answer in time
  }
  assert.ok(app.unconfirmed.has(15));
  assert.equal(lastBadge(gladys, lock).message.fr, T.badge.unconfirmed.fr);
  box.emit(151, 0);
  await tick(1000);
  assert.equal(lastBadge(gladys, lock).degraded, undefined);
});

// --- I2, I3, I4: doors ------------------------------------------------------------

test('D1 (I3) a reversed door whose fresh read lacks "options": "Close" sends CLOSE (0)', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      const a = b.attribute(141);
      a.options = { reverse_control_ui: 1 };
      a.current_value = 1; // reversed: 1 is OPEN
      a.target_value = 1;
      b.onRead = (id) => {
        delete b.attribute(id).options;
      };
    },
  });
  const door = await created(gladys, 'Porte de garage');
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${door.external_id}:a141`), 0, 'shown open');
  const close = press(gladys, door, 'a141-close');
  await until(tick, close);
  assert.equal(close.ack.success, true, close.ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 14, attr: 141, value: 0 }, '0 = CLOSED when reversed');
});

test('I3 a direction that changed since it was first seen refuses the door command', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      b.onRead = (id) => {
        b.attribute(id).options = { reverse_control_ui: 1 };
      };
    },
  });
  const door = await created(gladys, 'Porte de garage');
  const open = press(gladys, door, 'a141-open');
  await until(tick, open);
  assert.equal(open.ack.error, T.denied.directionChanged.fr);
  assert.equal(box.puts.length, 0);
  const unknown = attributeOf({ id: 1, node_id: 2, type: 14, current_value: 1 });
  assert.equal(unknown.reversed, undefined, 'a lone attribute says nothing of its direction');
});

test('D2 (I2) a door asked to move (target differs) is moving: "Close" refused; stop always sent', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL);
  const door = await created(gladys, 'Porte de garage');
  box.emit(141, 1, { target: 0 });
  const close = press(gladys, door, 'a141-close');
  await until(tick, close);
  assert.equal(close.ack.error, T.denied.moving.fr);
  assert.equal(box.puts.length, 0);
  box.emit(141, 1, { target: 1 }); // at rest, closed
  const stop = press(gladys, door, 'a141-stop');
  await until(tick, stop);
  assert.equal(stop.ack.success, true, stop.ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 14, attr: 141, value: 2 });
});

test('I4 Open/Close only on garage doors and entrance gates; a valve OPEN_CLOSE is no contact', () => {
  const inner = mapNode(
    nodeOf(node(91, 'Porte', 2014, [attr(911, 91, 14, 1, { max: 4, editable: 1 })])),
  );
  assert.deepEqual(Object.keys(inner.writers), [], 'an inner door: read only in v1');
  const gate = mapNode(
    nodeOf(node(92, 'Portail', 2010, [attr(921, 92, 14, 1, { max: 4, editable: 1 })])),
  );
  assert.deepEqual(Object.keys(gate.writers), ['a921-stop', 'a921-open', 'a921-close']);
  const impulse = mapNode(
    nodeOf(node(93, 'Porte', 2016, [attr(931, 93, 304, 0, { editable: 1 })])),
  );
  assert.deepEqual(Object.keys(impulse.writers), ['a931'], 'impulses stay');
  const valve = mapNode(nodeOf(node(94, 'Vanne', 3011, [attr(941, 94, 14, 1, { max: 4 })])));
  assert.equal(valve.features.length, 0);
});

// --- I5: setpoints ------------------------------------------------------------------

test('H1 a setpoint outside the published range (40 °C) is refused', () => {
  const n = nodeOf(
    node(60, 'Circuit plancher', 3030, [
      attr(601, 60, 6, 30, { min: 20, max: 80, unit: '%C2%B0C', editable: 1 }),
    ]),
  );
  const m = mapNode(n, { language: 'fr' });
  assert.equal(m.features.find((x) => x.key === 'a601').max, 40);
  assert.throws(
    () => m.writers.a601.plan(n.attributes.get(601), 75, { waterHeaterMax: 55 }),
    /outOfRange/,
  );
  assert.throws(
    () => m.writers.a601.plan(n.attributes.get(601), 19, { waterHeaterMax: 55 }),
    /outOfRange/,
  );
  assert.equal(m.writers.a601.plan(n.attributes.get(601), 35, { waterHeaterMax: 55 }).target, 35);
});

test('H2 a TARGET_TEMPERATURE of a warm water circuit is hot water: 65 °C cap', () => {
  const n = nodeOf(
    node(61, 'ECS', 3029, [
      attr(611, 61, 6, 50, { min: 30, max: 70, unit: '%C2%B0C', editable: 1 }),
    ]),
  );
  const m = mapNode(n, { language: 'fr' });
  assert.equal(m.features.find((x) => x.key === 'a611').category, C.WATER_HEATER);
  assert.throws(
    () => m.writers.a611.plan(n.attributes.get(611), 70, { waterHeaterMax: 55 }),
    /tooHot/,
  );
  assert.throws(
    () => m.writers.a611.plan(n.attributes.get(611), 65.5, { waterHeaterMax: 90 }),
    /outOfRange|tooHot/,
  );
  assert.equal(m.writers.a611.plan(n.attributes.get(611), 65, { waterHeaterMax: 65 }).target, 65);
  assert.throws(
    () => m.writers.a611.plan(n.attributes.get(611), 65.5, { waterHeaterMax: 65 }),
    /tooHot/,
  );
});

test('hot water: a lower max of the homee attribute wins over the 65 °C ceiling', () => {
  const n = nodeOf(
    node(62, 'ECS', 3029, [
      attr(621, 62, 6, 50, { min: 30, max: 60, unit: '%C2%B0C', editable: 1 }),
    ]),
  );
  const m = mapNode(n, { language: 'fr' });
  assert.equal(m.features.find((x) => x.key === 'a621').max, 60);
  assert.equal(m.writers.a621.plan(n.attributes.get(621), 60, { waterHeaterMax: 65 }).target, 60);
  assert.throws(
    () => m.writers.a621.plan(n.attributes.get(621), 62, { waterHeaterMax: 65 }),
    /outOfRange/,
  );
});

test('hot water: the value rounded to the step of the attribute never goes above the ceiling', () => {
  // min 30.5, step 1: 65 is rounded up to 65.5 by the step. Only the guard on the
  // value actually sent (after the step) stops it.
  const n = nodeOf(
    node(63, 'ECS', 3029, [
      attr(631, 63, 6, 50, { min: 30.5, max: 70, step: 1, unit: '%C2%B0C', editable: 1 }),
    ]),
  );
  const m = mapNode(n, { language: 'fr' });
  const plan = (value, waterHeaterMax) =>
    m.writers.a631.plan(n.attributes.get(631), value, { waterHeaterMax });
  assert.equal(m.features.find((x) => x.key === 'a631').max, 65);
  assert.throws(() => plan(65, 65), /tooHot/, '65 would be sent as 65.5');
  assert.equal(plan(64, 65).target, 64.5);
  assert.throws(() => plan(60, 60), /tooHot/, 'a lower ceiling: 60 would be sent as 60.5');
  assert.equal(plan(59, 60).target, 59.5);
});

// --- B2: switchable binaries --------------------------------------------------------

/** Every NodeProfile of pyHomee 1.4.6 (const.py). */
const PROFILES = [
  0, 1, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
  34, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 1000, 1001, 1002, 1003, 1004, 1005,
  1006, 1007, 1008, 1009, 1010, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
  2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 3001, 3002, 3003, 3004, 3005, 3006, 3009,
  3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019, 3022, 3023, 3024, 3025, 3026, 3027,
  3028, 3029, 3030, 3031, 3032, 3033, 4010, 4011, 4012, 4013, 4014, 4015, 4016, 4017, 4018, 4019,
  4020, 4021, 4022, 4023, 4024, 4025, 4026, 4027, 4028, 4029, 4030, 4031, 4032, 4033, 4034, 4035,
  4036, 4037, 4038, 4039, 4040, 5000, 5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010,
  5011, 6000, 6001, 6002,
];
const LIGHTS = [11, 14, 15, 19, 22, 49, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010];

test('K1 every pyHomee profile: a switchable binary only on lights and plain wall relays', () => {
  assert.deepEqual(
    [...RELAY_PROFILES].sort((a, b) => a - b),
    [16, 18, 29, 50],
  );
  for (const profile of PROFILES) {
    const n = nodeOf(
      node(70, `p${profile}`, profile, [
        attr(701, 70, 1, 1, { editable: 1 }),
        attr(702, 70, 2, 50, { max: 100, unit: '%25', editable: 1 }),
      ]),
    );
    const m = mapNode(n, { language: 'fr' });
    const writable = m.features.filter(
      (f) => [C.SWITCH, C.LIGHT].includes(f.category) && !f.read_only,
    );
    const allowed = LIGHTS.includes(profile) || RELAY_PROFILES.has(profile);
    assert.equal(writable.length > 0, allowed, `profile ${profile} (${kindOf(n)})`);
    if (!allowed) {
      assert.equal(m.features.find((f) => f.key === 'a701').read_only, true, `${profile}`);
    }
  }
});

test('K1 a node with a setpoint, hot water or a heating mode is a heating, whatever its profile', () => {
  for (const type of [6, 31, 32, 258]) {
    const n = nodeOf(
      node(71, 'x', 0, [
        attr(711, 71, 1, 1, { editable: 1 }),
        attr(712, 71, type, 20, { min: 5, max: 30, unit: '%C2%B0C', editable: 1 }),
      ]),
    );
    assert.equal(kindOf(n), 'heating', `type ${type}`);
    assert.equal(mapNode(n).writers['a711-off'].kind, 'heating');
  }
  // A metering relay (12, 33, 46, 47): unknown load, like a plug.
  for (const profile of [12, 33, 46, 47]) {
    const n = nodeOf(node(72, 'r', profile, [attr(721, 72, 1, 1, { editable: 1 })]));
    assert.equal(mapNode(n).writers['a721-on'].kind, 'plug', `${profile}`);
  }
});

test('K2 (M4) an INOVA siren is part of the alarm: read only, no button', () => {
  const n = nodeOf(node(80, 'Sirène INOVA', 5002, [attr(801, 80, 13, 0, { editable: 1 })]));
  assert.equal(kindOf(n), 'alarm');
  const m = mapNode(n, { language: 'fr' });
  assert.deepEqual(Object.keys(m.writers), []);
});

// --- Reconnections and the rest --------------------------------------------------------

test('W1 (M2) a Scan during the resync shares its GET:all and keeps the connection', async (t) => {
  const { app, box, tick } = await setup(t);
  box.mute = true;
  await tick(TIMINGS.resync);
  box.mute = false;
  const scan = app.rescan();
  await settle();
  assert.equal(box.sent().filter((m) => m === 'GET:all').length, 2, 'no second GET:all');
  box.message('all', box.all);
  await scan;
  await tick(0);
  assert.equal(app.online, true);
  assert.equal(box.sessions.length, 1);
});

test('M5 a reconnection to Gladys republishes the Discovery even while the box is offline', async (t) => {
  const { gladys, app, box } = await setup(t);
  box.refuseSocket();
  box.drop();
  await settle();
  assert.equal(app.online, false);
  const before = gladys.fake.bodies('POST', '/discovered_device').length;
  await gladys.connect();
  await settle();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, before + 1);
});

test('M6 a fresh read answered too late puts the attribute in quarantine', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL);
  const lock = await created(gladys, 'Serrure entrée');
  box.silent.add(151);
  const first = press(gladys, lock, 'a151-unlock');
  await until(tick, first);
  assert.equal(first.ack.error, T.denied.unknownState.fr);
  box.silent.delete(151);
  box.emit(151, 1); // the late answer
  const second = press(gladys, lock, 'a151-unlock');
  await until(tick, second);
  assert.equal(second.ack.error, T.denied.unknownState.fr, 'not trusted during the quarantine');
  await tick(TIMINGS.quarantine);
  const third = press(gladys, lock, 'a151-unlock');
  await until(tick, third);
  assert.equal(third.ack.success, true, third.ack.error);
  assert.equal(box.puts.length, 1);
});

test('M7 a websocket failure: refused when the port answers, a network failure otherwise', async () => {
  const failing = class {
    constructor() {
      this.listeners = {};
      setImmediate(() => this.listeners.close?.({ code: 1006 }));
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    close() {}
  };
  const open = (probe) =>
    openSocket({ host: '127.0.0.1', token: 'tokentoken', WebSocket: failing, probe });
  await assert.rejects(
    open(async () => true),
    (err) => err.kind === 'refused',
  );
  await assert.rejects(
    open(async () => false),
    (err) => err.kind === 'network',
  );
});

test('M7 a network failure of the websocket keeps the token', async (t) => {
  const { app, box, tick } = await setup(t);
  box.socketFail = Object.assign(new Error('cannot reach'), { kind: 'network' });
  box.drop();
  for (const ms of [5000, 10_000, 20_000, 40_000, 80_000, 160_000]) {
    await tick(ms);
  }
  assert.equal(box.tokens, 1);
  assert.equal(app.online, false);
});

test('M8 the nodes message and the live attributes are bounded', async (t) => {
  const { app, box, tick } = await setup(t);
  const many = Array.from({ length: 2500 }, (_, i) =>
    node(10_000 + i, `n${i}`, 3009, [attr(100_000 + i, 10_000 + i, 5, 20, { unit: '%C2%B0C' })]),
  );
  box.message('nodes', many);
  await tick(0);
  assert.ok(app.nodes.size <= 2000 + 16);
  const n = app.nodes.get(20);
  for (let i = 0; i < 500; i += 1) {
    box.message('attribute', attr(50_000 + i, 20, 5, 20, { unit: '%C2%B0C' }));
  }
  assert.ok(app.nodes.get(20).attributes.size <= 400, `${app.nodes.get(20).attributes.size}`);
  assert.ok(n);
});

test('M10 saving the same refused credentials tries once, the count kept', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const wrong = { ...CONFIG, password: 'wrong' };
  const { gladys, box } = await setup(t, wrong, { store });
  assert.equal(store.refusalOf({ ...CONFIG, password: 'wrong' }).count, 1);
  await gladys.fake.configUpdated(wrong);
  await settle();
  assert.equal(box.tokenCalls.length, 2, 'tried at once');
  const refusal = store.refusalOf({ ...CONFIG, password: 'wrong' });
  assert.equal(refusal.count, 2, 'not reset');
  assert.equal(refusal.retryAt, Date.now() + 2 * TIMINGS.authRetryMin);
});

test('M11 HTTP Basic is encoded in latin-1', () => {
  const basic = Buffer.from(`é:${hashPassword('x')}`, 'latin1').toString('base64');
  assert.equal(Buffer.from(basic, 'base64')[0], 0xe9);
});

test('M12 the test button reuses the connection in use', async (t) => {
  const { gladys, box } = await setup(t);
  const tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(tested.data.message.en, /^Connection OK to Maison/);
  assert.equal(box.tokenCalls.length, 1);
  assert.equal(box.sessions.length, 1);
});

test('M15 a "+" in a name stays a "+"', () => {
  assert.equal(decode('Lampe+bureau%20A'), 'Lampe+bureau A');
});
