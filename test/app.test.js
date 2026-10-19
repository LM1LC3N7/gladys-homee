// -----------------------------------------------------------------------------
// The app through the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, and a fake homee serving the fixture with its websocket messages.
// Timers are mocked: the resyncs, the reconnections, the echoes and the state
// flush run when the test ticks.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_TRANSPORTS,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HomeeApp } from '../src/app.js';
import { normalizeConfig } from '../src/config.js';
import { ACTIONS, TIMINGS } from '../src/constants.js';
import { HomeeError } from '../src/homee.js';
import { registerHandlers } from '../src/handlers.js';
import { T } from '../src/i18n.js';
import { StateStore } from '../src/store.js';
import { OFFERED, UID } from './fixtures/box.js';
import { CONFIG, PASSWORD, fakeBox, settle } from './helpers/fakeBox.js';

async function setup(t, config = CONFIG, { prepare = () => {}, store } = {}) {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: Date.parse('2026-10-19T08:00:00.000Z'),
  });
  const gladys = createFakeGladys({ config });
  const box = fakeBox();
  prepare(box);
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
  return { gladys, app, box, tick };
}

const named = (gladys, name) => gladys.fake.discoveredDevices.find((d) => d.name === name);

async function created(gladys, name) {
  const device = named(gladys, name);
  assert.ok(device, `${name} is discovered`);
  await gladys.fake.deviceCreated(device);
  return device;
}

const featureOf = (device, key) => {
  const feature = device.features.find((f) => f.external_id === `${device.external_id}:${key}`);
  assert.ok(feature, `${device.name} has ${key}`);
  return feature;
};

/** setValue through the fake Gladys, ticking the mocked clock until it acks. */
async function command(gladys, tick, device, key, value) {
  const pending = gladys.fake.setValue(device, featureOf(device, key), value);
  let ack;
  pending.then((a) => {
    ack = a;
  });
  for (let i = 0; i < 60 && ack === undefined; i += 1) {
    await tick(100);
  }
  assert.ok(ack, 'the command was acked');
  return ack;
}

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

test('the nodes become Gladys devices, their values sent once created', async (t) => {
  const { gladys, tick } = await setup(t);
  assert.equal(gladys.fake.discoveredDevices.length, OFFERED);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.connectionStatus.message.en, T.connected(OFFERED, 'Maison').en);
  const lamp = named(gladys, 'Plafonnier');
  assert.equal(lamp.external_id, `ext:test-integration:homee:${UID.toLowerCase()}-10`);
  assert.ok(named(gladys, 'Maison'), 'the box itself, for its mode');
  assert.equal(named(gladys, 'Télécommande'), undefined, 'nothing to show yet');

  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.states.length, 0, 'nothing is sent for a device not created');
  await created(gladys, 'Plafonnier');
  const radiator = await created(gladys, 'Radiateur chambre');
  const plug = await created(gladys, 'Prise congélateur');
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:a101`), 1);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:a102`), 60);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:a103`), 333); // 3000 K in mireds
  assert.equal(gladys.fake.lastState(`${radiator.external_id}:a161`), 19.5);
  assert.equal(gladys.fake.lastState(`${radiator.external_id}:a162`), 20);
  assert.equal(gladys.fake.lastState(`${plug.external_id}:a123`), 312.4);
  const badge = gladys.fake.transports
    .filter((e) => e.device_external_id === lamp.external_id)
    .at(-1);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
});

test('"turn everything off" reaches only the light and the plain switch, never a plug, a lock, a valve, a siren, a door or a heating', async (t) => {
  const { gladys } = await setup(t);
  const switchable = gladys.fake.discoveredDevices
    .flatMap((d) => d.features.map((f) => ({ device: d.name, ...f })))
    .filter((f) => [C.SWITCH, C.LIGHT].includes(f.category) && f.type === 'binary' && !f.read_only);
  assert.deepEqual(switchable.map((f) => f.device).sort(), ['Interrupteur cuisine', 'Plafonnier']);
  for (const name of ['Prise congélateur', 'Radiateur électrique', 'Serrure entrée', 'Sirène']) {
    const device = named(gladys, name);
    for (const f of device.features) {
      assert.ok(
        f.read_only || f.category === C.BUTTON || f.category === C.THERMOSTAT,
        `${name}: ${f.category}/${f.type} is only a button`,
      );
    }
  }
  const lock = named(gladys, 'Serrure entrée');
  assert.equal(featureOf(lock, 'a151').category, C.LOCK);
  assert.equal(featureOf(lock, 'a151').type, TY.LOCK.STATE);
  assert.equal(featureOf(lock, 'a151').read_only, true);
  assert.equal(featureOf(lock, 'a151-unlock').type, TY.BUTTON.PUSH);
});

test('live attributes reach Gladys at once', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const sensor = await created(gladys, 'Détecteur couloir');
  const window = await created(gladys, 'Fenêtre salon');
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${window.external_id}:a201`), 1, 'closed');
  box.emit(211, 1);
  box.emit(201, 1);
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${sensor.external_id}:a211`), 1);
  assert.equal(gladys.fake.lastState(`${window.external_id}:a201`), 0, 'open');
});

test('a light: on/off, brightness and colour temperature sent as PUTs', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const lamp = await created(gladys, 'Plafonnier');
  let ack = await command(gladys, tick, lamp, 'a101', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 10, attr: 101, value: 0 });
  ack = await command(gladys, tick, lamp, 'a102', 30);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 10, attr: 102, value: 30 });
  ack = await command(gladys, tick, lamp, 'a103', 250);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 10, attr: 103, value: 4000 });
  ack = await command(gladys, tick, lamp, 'a101', '');
  assert.equal(ack.success, false, "'' is not 0");
  assert.equal(box.puts.length, 3);
});

test('a shutter: open, stop, position (homee counts closed from 0 to 100)', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const shutter = await created(gladys, 'Volet salon');
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${shutter.external_id}:a131`), -1, 'closed');
  assert.equal(gladys.fake.lastState(`${shutter.external_id}:a132`), 0, '0 % open');
  await command(gladys, tick, shutter, 'a131', 1);
  assert.deepEqual(box.puts.at(-1), { node: 13, attr: 131, value: 0 });
  await command(gladys, tick, shutter, 'a131', 0);
  assert.deepEqual(box.puts.at(-1), { node: 13, attr: 131, value: 2 });
  await command(gladys, tick, shutter, 'a132', 75);
  assert.deepEqual(box.puts.at(-1), { node: 13, attr: 132, value: 25 });
});

test('every sensitive command is refused while its option is off, and nothing is sent', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const cases = [
    ['Prise congélateur', 'a121-off', 1, T.denied.plugOff],
    ['Radiateur électrique', 'a241-off', 1, T.denied.heatingOff],
    ['Radiateur chambre', 'a162', 22, T.denied.heatingOff],
    ["Ballon d'eau chaude", 'a172', 50, T.denied.heatingOff],
    ['Serrure entrée', 'a151-unlock', 1, T.denied.lockOff],
    ['Serrure entrée', 'a151-open', 1, T.denied.lockOff],
    ['Porte de garage', 'a141-open', 1, T.denied.doorOff],
    ["Vanne d'arrivée d'eau", 'a181-close', 1, T.denied.valveOff],
    ['Sirène', 'a191-on', 1, T.denied.sirenOff],
    ['Sirène', 'a191-off', 1, T.denied.sirenOff],
    ['Maison', 'a1', 'away', T.denied.alarmOff],
  ];
  for (const [name, key, value, refusal] of cases) {
    const device = await created(gladys, name);
    const ack = await command(gladys, tick, device, key, value);
    assert.equal(ack.success, false, `${name} ${key}`);
    assert.equal(ack.error, refusal.fr, `${name} ${key}`);
  }
  assert.equal(box.puts.length, 0);
  assert.ok(!box.sent().some((m) => m.startsWith('GET:nodes')), 'not even read');
});

test('a plug allowed: decided on the state read just before, nothing sent when already there', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL);
  const plug = await created(gladys, 'Prise congélateur');
  let ack = await command(gladys, tick, plug, 'a121-on', 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(box.puts.length, 0, 'already on: nothing sent');
  assert.ok(box.sent().includes('GET:nodes/12/attributes/121'));
  ack = await command(gladys, tick, plug, 'a121-off', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 12, attr: 121, value: 0 });
  ack = await command(gladys, tick, plug, 'a121-off', 0);
  assert.equal(ack.success, false, 'only a press (1) acts');
});

test('the option is checked again just before the request leaves', async (t) => {
  const { gladys, app, box, tick } = await setup(t, ALLOW_ALL);
  const lock = await created(gladys, 'Serrure entrée');
  box.onRead = () => {
    app.config = { ...app.config, allowLock: false };
  };
  const ack = await command(gladys, tick, lock, 'a151-unlock', 1);
  assert.equal(ack.success, false);
  assert.equal(ack.error, T.denied.lockOff.fr);
  assert.equal(box.puts.length, 0);
});

test('a state that cannot be read just now refuses the command, never the memory', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL);
  const lock = await created(gladys, 'Serrure entrée');
  box.silent.add(151);
  const ack = await command(gladys, tick, lock, 'a151-unlock', 1);
  assert.equal(ack.success, false);
  assert.equal(ack.error, T.denied.unknownState.fr);
  assert.equal(box.puts.length, 0);
});

test('a lock allowed: unlocked; locking again is protective, sent at once even while it moves', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      b.slow = 5000;
    },
  });
  const lock = await created(gladys, 'Serrure entrée');
  let ack = await command(gladys, tick, lock, 'a151-unlock', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 15, attr: 151, value: 0 });
  // The motor has not reported yet: unlatching waits (moving)…
  ack = await command(gladys, tick, lock, 'a151-open', 1);
  assert.equal(ack.error, T.denied.moving.fr);
  // …but locking is never refused.
  ack = await command(gladys, tick, lock, 'a151-lock', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 15, attr: 151, value: 1 });
  assert.equal(box.puts.length, 2);
});

test('a command the box does not echo is told "sent, without confirmation"', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL, {
    prepare: (b) => {
      b.noEcho = true;
    },
  });
  const siren = await created(gladys, 'Sirène');
  const ack = await command(gladys, tick, siren, 'a191-on', 1);
  assert.equal(ack.success, false);
  assert.equal(ack.error, T.denied.sentUnconfirmed.fr);
  assert.deepEqual(box.puts.at(-1), { node: 19, attr: 191, value: 1 });
});

test('a garage door: refused while moving, stop allowed then', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL);
  const door = await created(gladys, 'Porte de garage');
  box.emit(141, 3); // opening
  let ack = await command(gladys, tick, door, 'a141-close', 1);
  assert.equal(ack.success, false);
  assert.equal(ack.error, T.denied.moving.fr);
  ack = await command(gladys, tick, door, 'a141-stop', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 14, attr: 141, value: 2 });
  box.emit(141, 1); // closed again
  ack = await command(gladys, tick, door, 'a141-open', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 14, attr: 141, value: 0 });
});

test('setpoints: heating stepped, hot water capped at 55 °C by default and never above 60 °C', async (t) => {
  const { gladys, app, box, tick } = await setup(t, ALLOW_ALL);
  const radiator = await created(gladys, 'Radiateur chambre');
  const tank = await created(gladys, "Ballon d'eau chaude");
  let ack = await command(gladys, tick, radiator, 'a162', 21.3);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 16, attr: 162, value: 21.5 });
  ack = await command(gladys, tick, tank, 'a172', 58);
  assert.equal(ack.error, T.denied.tooHot.fr);
  ack = await command(gladys, tick, tank, 'a172', 52);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: 17, attr: 172, value: 52 });
  await app.configUpdated({ ...ALLOW_ALL, water_heater_max: 90 });
  await settle();
  assert.equal(app.config.waterHeaterMax, 60);
  ack = await command(gladys, tick, tank, 'a172', 61);
  assert.equal(ack.error, T.denied.tooHot.fr);
  assert.equal(featureOf(tank, 'a172').max, 60);
});

test('the homee mode: a list behind its option, never a switch', async (t) => {
  const { gladys, box, tick } = await setup(t, ALLOW_ALL);
  const home = await created(gladys, 'Maison');
  const select = featureOf(home, 'a1');
  assert.equal(select.type, TY.TEXT.SELECT);
  assert.deepEqual(
    select.supported_options.map((o) => o.value),
    ['home', 'sleeping', 'away', 'vacation'],
  );
  const ack = await command(gladys, tick, home, 'a1', 'away');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(box.puts.at(-1), { node: -1, attr: 1, value: 2 });
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${home.external_id}:a1-state`), 'Absent');
});

test('refused credentials: stopped, persisted, tried again after 1 h then 2 h, never in a loop', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const wrong = { ...CONFIG, password: 'wrong' };
  const { gladys, box, tick } = await setup(t, wrong, { store });
  assert.equal(box.tokenCalls.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(gladys.fake.connectionStatus.message.en, T.refused(TIMINGS.authRetryMin).en);
  assert.ok(store.refusalOf({ host: CONFIG.host, username: CONFIG.username, password: 'wrong' }));
  assert.ok(!JSON.stringify(store.data).includes('wrong'), 'never the password in the store');
  await tick(TIMINGS.authRetryMin - 1000);
  assert.equal(box.tokenCalls.length, 1);
  await tick(1000);
  assert.equal(box.tokenCalls.length, 2);
  await tick(2 * TIMINGS.authRetryMin - 1000);
  assert.equal(box.tokenCalls.length, 2);
  await tick(1000);
  assert.equal(box.tokenCalls.length, 3);
});

test('a restart keeps the refusal: no new try before it is due', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const wrong = { ...CONFIG, password: 'wrong' };
  store.refuse({ host: CONFIG.host, username: CONFIG.username, password: 'wrong' }, 'refused');
  const { box } = await setup(t, wrong, { store });
  assert.equal(box.tokenCalls.length, 0);
});

test('a new configuration is tried at once; the test button too, and it starts again when it works', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const { gladys, box, tick } = await setup(t, { ...CONFIG, password: 'wrong' }, { store });
  assert.equal(box.tokenCalls.length, 1);
  gladys.fake.config = { ...CONFIG };
  await gladys.fake.configUpdated({ ...CONFIG });
  await tick(0);
  assert.equal(box.tokenCalls.length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(
    tested.data.message.en,
    /^Connection OK to Maison at 192\.168\.1\.60: 16 nodes, 15 devices offered in Discovery, 1 left out/,
  );
});

test('a socket refusing a fresh token waits; a token that is not new is renewed once', async (t) => {
  const { app, box, tick } = await setup(t, CONFIG, {
    prepare: (b) => b.refuseSocket(),
  });
  assert.equal(box.tokens, 1);
  await tick(TIMINGS.retryMin);
  assert.equal(box.tokens, 1, 'a fresh token is not asked again');
  // 5 + 10 + 20 + 40 + 80 s: past two minutes, the next refusal drops the token.
  for (const ms of [10_000, 20_000, 40_000, 80_000, 160_000]) {
    await tick(ms);
  }
  assert.ok(box.tokens >= 2 && box.tokens <= 3, `${box.tokens} tokens in 5 minutes`);
  assert.ok(app.failures >= 5);
});

test('a lost websocket is opened again, more and more spaced', async (t) => {
  const { app, box, tick } = await setup(t);
  assert.equal(box.sessions.length, 1);
  box.drop();
  await settle();
  assert.equal(app.online, false);
  box.refuseSocket('connection failed');
  await tick(TIMINGS.retryMin);
  assert.equal(box.sessions.length, 1, 'still refused');
  box.socketFail = undefined;
  await tick(TIMINGS.retryMin); // 10 s after the second failure: not yet
  assert.equal(box.sessions.length, 1);
  await tick(TIMINGS.retryMin);
  assert.equal(box.sessions.length, 2);
  assert.equal(app.online, true);
  assert.equal(box.tokens, 1, 'the token is kept');
});

test('a deaf socket (no answer to the resync) is opened again', async (t) => {
  const { app, box, tick } = await setup(t);
  box.mute = true;
  await tick(TIMINGS.resync);
  await tick(TIMINGS.allTimeout);
  assert.equal(app.online, false);
  box.mute = false;
  await tick(TIMINGS.retryMin);
  assert.equal(app.online, true);
  assert.equal(box.sessions.length, 2);
});

test('a 429 pauses every path, persisted, and is not cleared by a reconnection to Gladys', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const { gladys, app, box, tick } = await setup(t, CONFIG, {
    store,
    prepare: (b) => {
      b.tokenFail = new HomeeError('rate', 'too many requests (HTTP 429)', { retryAfter: 120_000 });
    },
  });
  assert.equal(box.tokenCalls.length, 1);
  assert.ok(store.pausedUntil >= Date.now() + 119_000);
  box.tokenFail = undefined;
  await gladys.connect(); // Gladys came back: 'connected' again
  await settle();
  assert.equal(box.tokenCalls.length, 1, 'the pause holds');
  const tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(tested.data.message.en, T.failure({ kind: 'rate' }).en);
  await tick(120_000);
  assert.equal(app.online, true);
});

test('a reconnection to Gladys publishes the status and the Discovery again', async (t) => {
  const { gladys, box } = await setup(t);
  const before = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.connect(); // Gladys came back: 'connected' again
  await settle();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, before + 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(box.tokens, 1, 'same token, same socket');
  assert.equal(box.sessions.length, 1);
});

test('energy index: a drop or a jump is held, shown on the badge, the last value sent again', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const { gladys, box, tick } = await setup(t, CONFIG, { store });
  const plug = await created(gladys, 'Prise congélateur');
  const id = `${plug.external_id}:a123`;
  await tick(TIMINGS.flushInterval);
  const sent = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);
  for (const value of [0, 0, 5000, 5000]) {
    box.emit(123, value);
    await tick(TIMINGS.flushInterval * 11);
  }
  assert.deepEqual([...new Set(sent())], [312.4], 'only the last accepted value');
  assert.equal(store.indexState(id).held.to, 5000, 'the hold kept in /data');
  const badge = gladys.fake.transports
    .filter((e) => e.device_external_id === plug.external_id)
    .at(-1);
  assert.equal(badge.degraded, true);
  assert.equal(badge.message.fr, T.badge.held([{ direction: 'up', from: 312.4, to: 5000 }]).fr);
  assert.match(badge.message.fr, /^1 index d'énergie retenu \(4687\.6 kWh en attente\)/);
  box.emit(123, 312.6);
  await tick(TIMINGS.flushInterval * 11);
  assert.deepEqual([...new Set(sent())], [312.4, 312.6]);
  assert.equal(store.indexState(id).held, null);
});

test('accept the held index: bounded to the device chosen and the value shown, kWh told', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const plug = await created(gladys, 'Prise congélateur');
  const id = `${plug.external_id}:a123`;
  await tick(TIMINGS.flushInterval);
  box.emit(123, 412.4);
  await tick(TIMINGS.flushInterval * 11);
  let answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD, {});
  assert.equal(answer.data.message.en, T.accept.noDevice.en);
  const lamp = await created(gladys, 'Plafonnier');
  answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD, { device: lamp.external_id });
  assert.equal(answer.data.message.en, T.accept.nothing.en);
  // A save of the configuration or a reconnection accepts nothing.
  await gladys.fake.configUpdated({ ...CONFIG });
  await tick(TIMINGS.flushInterval * 11);
  assert.equal(gladys.fake.lastState(id), 312.4);
  answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD, { device: plug.external_id });
  assert.match(
    answer.data.message.en,
    /^Nothing taken yet\. Held back: .*jump from 312\.4 to 412\.4 kWh \(100 kWh\)/,
  );
  await tick(TIMINGS.flushInterval * 11);
  assert.equal(gladys.fake.lastState(id), 312.4, 'the first click takes nothing');
  answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD, { device: plug.external_id });
  assert.match(answer.data.message.en, /^Accepted: 100 kWh will be counted/);
  await tick(TIMINGS.flushInterval * 11);
  assert.equal(gladys.fake.lastState(id), 412.4);
  // Accepted once: a new jump is held again.
  box.emit(123, 9000);
  await tick(TIMINGS.flushInterval * 11);
  assert.equal(gladys.fake.lastState(id), 412.4);
});

test('a device created again starts its index guard afresh; Gladys holds the reference', async (t) => {
  const store = new StateStore({ dir: null, now: () => Date.now() });
  const { gladys, app, box, tick } = await setup(t, CONFIG, { store });
  const plug = named(gladys, 'Prise congélateur');
  const id = `${plug.external_id}:a123`;
  store.setIndexState(id, {
    last: { value: 9999, at: Date.now() },
    held: { direction: 'up', from: 9999, to: 99_999, threshold: 99_999, at: Date.now() },
  });
  await gladys.fake.deviceCreated(plug);
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(id), 312.4, 'the old state of a deleted device is dropped');
  // Gladys holds 312.4 (last_value): after a restart, a 0 never reaches the index.
  const held = gladys.devices.find((d) => d.external_id === plug.external_id);
  for (const f of held.features) {
    if (f.external_id === id) {
      f.last_value = 312.4;
      f.last_value_changed = new Date().toISOString();
    }
  }
  app.indexGuards.clear();
  store.data.indexes = {};
  box.emit(123, 0);
  await tick(TIMINGS.flushInterval * 11);
  assert.ok(!gladys.fake.states.some((s) => s.device_feature_external_id === id && s.state === 0));
});

test('no lost feature: a feature of the created device missing from a new read is kept', async (t) => {
  const { gladys, app, box } = await setup(t);
  const plug = await created(gladys, 'Prise congélateur');
  box.node(12).attributes = box.node(12).attributes.filter((a) => a.id !== 122);
  await app.rescan();
  await settle();
  const again = named(gladys, 'Prise congélateur');
  assert.deepEqual(
    again.features.map((f) => f.external_id).sort(),
    plug.features.map((f) => f.external_id).sort(),
  );
});

test('a node the box reports unavailable gets an unreachable badge', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const sensor = await created(gladys, 'Détecteur couloir');
  const node = structuredClone(box.node(21));
  node.state = 2;
  box.message('node', node);
  await tick(0);
  const badge = gladys.fake.transports
    .filter((e) => e.device_external_id === sensor.external_id)
    .at(-1);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(badge.message.fr, T.badge.offline.fr);
});

test('the test button with a wrong password records the refusal and says so', async (t) => {
  const { gladys, box } = await setup(t);
  gladys.fake.config = { ...CONFIG, password: 'other' };
  const app2 = new HomeeApp({
    gladys,
    token: box.token,
    live: box.openLive,
    store: new StateStore({ dir: null }),
    logger: createLogger({ level: 'silent' }),
  });
  app2.config = normalizeConfig({ ...CONFIG, password: 'other' });
  const message = await app2.testConnection();
  assert.equal(message.en, T.test.refused.en);
  assert.ok(app2.store.refusalOf({ ...CONFIG, password: 'other' }));
  assert.notEqual(PASSWORD, 'other');
});
