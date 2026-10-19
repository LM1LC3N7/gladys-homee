// The mapping of homee nodes to Gladys features (pure), on the fixture and on
// hand-made nodes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { buildModel } from '../src/devices.js';
import {
  COVER_STATE,
  LOCK_STATE,
  kindOf,
  mapNode,
  scaleOf,
  stepped,
  strictNumber,
} from '../src/mapping.js';
import { attributeOf, decode, nodeOf, nodesOf, settingsOf } from '../src/nodes.js';
import { allBody, attr, node } from './fixtures/box.js';

const nodes = nodesOf(allBody().nodes);
const mapped = (id) => mapNode(nodes.get(id), { language: 'en' });
const feature = (m, key) => m.features.find((f) => f.key === key);
const reader = (m, key) => m.readers.find((r) => r.key === key);

test('nodes and attributes are read strictly from the JSON of the box', () => {
  assert.equal(decode('Prise%20cong%C3%A9lateur'), 'Prise congélateur');
  assert.equal(decode('100%'), '100%', 'a lone % never throws');
  assert.equal(decode('a\u0000b'), 'a b');
  assert.equal(attributeOf({ id: 1, node_id: 2, type: 1 }), undefined, 'no value');
  assert.equal(attributeOf({ id: 1, node_id: 2, type: 1, current_value: null }), undefined);
  assert.equal(attributeOf({ id: '1', node_id: 2, type: 1, current_value: '1.5' }).current, 1.5);
  const n = nodeOf(
    JSON.parse(
      '{"id":3,"name":"x","attributes":[{"__proto__":{"x":1},"id":4,"node_id":3,"type":1,"current_value":1}]}',
    ),
  );
  assert.equal(n.attributes.get(4).current, 1);
  assert.equal({}.x, undefined);
  assert.equal(
    nodeOf({ id: 3, attributes: [{ id: 4, node_id: 9, type: 1, current_value: 1 }] }).attributes
      .size,
    0,
    'an attribute of another node',
  );
  assert.equal(settingsOf({ uid: 'bad uid!' }).uid, undefined);
  assert.equal(settingsOf({ uid: '0123456789AB', homee_name: 'Maison' }).uid, '0123456789ab');
});

test('kinds: what decides the safety rules', () => {
  const kinds = Object.fromEntries([...nodes.values()].map((n) => [n.name, kindOf(n)]));
  assert.deepEqual(kinds, {
    homee: 'box',
    Plafonnier: 'light',
    'Interrupteur cuisine': 'relay',
    'Prise congélateur': 'other',
    'Volet salon': 'cover',
    'Porte de garage': 'door',
    'Serrure entrée': 'lock',
    'Radiateur chambre': 'heating',
    "Ballon d'eau chaude": 'heating',
    "Vanne d'arrivée d'eau": 'valve',
    Sirène: 'siren',
    'Fenêtre salon': 'other',
    'Détecteur couloir': 'other',
    'Détecteur de fumée': 'other',
    Télécommande: 'other',
    'Radiateur électrique': 'heating',
  });
});

test('a light: binary, brightness 0-100 from the range, colour temperature in mireds', () => {
  const m = mapped(10);
  assert.deepEqual(
    m.features.map((f) => [f.key, f.category, f.type, f.read_only]),
    [
      ['a101', C.LIGHT, T.LIGHT.BINARY, false],
      ['a102', C.LIGHT, T.LIGHT.BRIGHTNESS, false],
      ['a103', C.LIGHT, T.LIGHT.TEMPERATURE, false],
    ],
  );
  assert.deepEqual([feature(m, 'a103').min, feature(m, 'a103').max], [154, 370]);
  assert.equal(m.writers.a102.write(50, nodes.get(10).attributes.get(102)), 50);
  assert.throws(() => m.writers.a101.write(null), /badValue/);
  assert.throws(() => m.writers.a101.write(2), /badValue/);
});

test('a plug: never a switch; read-only state, buttons behind the plug option; energy as an index', () => {
  const m = mapped(12);
  assert.deepEqual(feature(m, 'a121'), {
    key: 'a121',
    name: 'Prise congélateur',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  });
  assert.equal(feature(m, 'a121-on').type, T.BUTTON.PUSH);
  assert.equal(m.writers['a121-on'].kind, 'plug');
  assert.equal(m.writers['a121-off'].kind, 'plug');
  assert.equal(feature(m, 'a122').category, C.ENERGY_SENSOR);
  assert.equal(feature(m, 'a123').type, T.ENERGY_SENSOR.INDEX);
  assert.equal(feature(m, 'a123').unit, 'kilowatt-hour');
  assert.equal(reader(m, 'a123').meter, true);
});

test('locks, doors, valves, sirens, heaters: read-only states and buttons of their kind', () => {
  const lock = mapped(15);
  assert.equal(feature(lock, 'a151').read_only, true);
  assert.deepEqual(
    Object.entries(lock.writers).map(([k, w]) => [k, w.kind, w.confirm, w.protective === true]),
    [
      ['a151-lock', 'lock', 'lock', true],
      ['a151-unlock', 'lock', 'lock', false],
      ['a151-open', 'lock', 'lock', false],
    ],
  );
  const door = mapped(14);
  assert.equal(feature(door, 'a141').category, C.OPENING_SENSOR);
  assert.deepEqual(Object.keys(door.writers), ['a141-stop', 'a141-open', 'a141-close']);
  assert.ok(Object.values(door.writers).every((w) => w.kind === 'door'));
  assert.equal(door.writers['a141-stop'].protective, true);
  assert.equal(door.writers['a141-close'].directional, true);
  const valve = mapped(18);
  assert.deepEqual(Object.keys(valve.writers), ['a181-open', 'a181-close']);
  assert.equal(valve.writers['a181-close'].kind, 'valve');
  assert.equal(valve.writers['a181-close'].protective, true);
  assert.equal(valve.writers['a181-open'].protective, undefined);
  const radiator = mapped(16);
  assert.deepEqual(
    Object.keys(radiator.writers),
    ['a162'],
    'the radiator valve follows its thermostat',
  );
  assert.equal(radiator.writers.a162.kind, 'heating');
  assert.equal(feature(radiator, 'a162').unit, 'celsius');
  const siren = mapped(19);
  assert.equal(feature(siren, 'a191').category, C.SIREN);
  assert.equal(feature(siren, 'a191').read_only, true);
  assert.equal(siren.writers['a191-on'].kind, 'siren');
  const heater = mapped(24);
  assert.equal(feature(heater, 'a241').read_only, true);
  assert.equal(heater.writers['a241-off'].kind, 'heating');
  assert.equal(feature(heater, 'a242').category, C.ENERGY_SENSOR, 'no switch: power on a sensor');
});

test('plans decided on the fresh attribute: lock, door, hot water, mode', () => {
  const lockAttr = nodes.get(15).attributes.get(151);
  const lock = mapped(15).writers;
  // Locking is protective: always sent, even when already locked.
  assert.equal(lock['a151-lock'].plan(lockAttr, 1).target, 1);
  assert.deepEqual(lock['a151-unlock'].plan({ ...lockAttr, current: 0, target: 0 }, 1), {
    already: true,
  });
  const plan = lock['a151-unlock'].plan(lockAttr, 1);
  assert.equal(plan.target, 0);
  assert.throws(() => lock['a151-unlock'].plan({ ...lockAttr, target: 0 }, 1), /moving/);
  assert.throws(
    () => lock['a151-unlock'].plan({ ...lockAttr, current: 7, target: 7 }, 1),
    /unknownState/,
  );
  assert.throws(() => lock['a151-unlock'].plan(lockAttr, 0), /badValue/);
  assert.equal(lock['a151-open'].plan(lockAttr, 1).target, 2);

  const tank = mapped(17).writers.a172;
  const tankAttr = nodes.get(17).attributes.get(172);
  assert.throws(() => tank.plan(tankAttr, 56, { waterHeaterMax: 55 }), /tooHot/);
  assert.throws(() => tank.plan(tankAttr, 61, { waterHeaterMax: 90 }), /tooHot/);
  assert.equal(tank.plan(tankAttr, 55, { waterHeaterMax: 55 }).target, 55);
  assert.throws(() => tank.plan(tankAttr, '', { waterHeaterMax: 55 }), /badValue/);
  assert.throws(() => tank.plan(tankAttr, null, { waterHeaterMax: 55 }), /badValue/);

  const mode = mapped(-1).writers.a1;
  const modeAttr = nodes.get(-1).attributes.get(1);
  assert.equal(mode.kind, 'alarm');
  assert.equal(mode.plan(modeAttr, 'vacation').target, 3);
  assert.deepEqual(mode.plan(modeAttr, 'home'), { already: true });
  assert.throws(() => mode.plan(modeAttr, 'disarmed'), /badValue/);
});

test('a cover: state -1/0/1 and position (homee 0 open … 100 closed), reversed handled', () => {
  const m = mapped(13);
  const up = nodes.get(13).attributes.get(131);
  assert.deepEqual(reader(m, 'a131').read(up), { state: COVER_STATE.CLOSE });
  assert.deepEqual(reader(m, 'a131').read({ ...up, current: 3 }), { state: COVER_STATE.OPEN });
  assert.deepEqual(reader(m, 'a131').read({ ...up, current: 2 }), { state: COVER_STATE.STOP });
  assert.equal(m.writers.a131.write(1, up), 0);
  assert.equal(m.writers.a131.write(1, { ...up, reversed: true }), 1);
  assert.equal(m.writers.a131.write(-1, up), 1);
  assert.deepEqual(reader(m, 'a132').read({ ...nodes.get(13).attributes.get(132), current: 25 }), {
    state: 75,
  });
});

test('sensors: units checked, temperatures in °C, unavailable attributes read as nothing', () => {
  const motion = mapped(21);
  assert.equal(feature(motion, 'a211').category, C.MOTION_SENSOR);
  assert.equal(feature(motion, 'a212').unit, 'celsius');
  assert.equal(feature(motion, 'a213').category, C.LIGHT_SENSOR);
  const temp = nodes.get(21).attributes.get(212);
  assert.deepEqual(reader(motion, 'a212').read({ ...temp, unit: '°F', current: 68 }), {
    state: 20,
  });
  assert.equal(reader(motion, 'a212').read({ ...temp, state: 7 }), null);
  const smoke = mapped(22);
  assert.equal(feature(smoke, 'a221').category, C.SMOKE_SENSOR);
  assert.equal(feature(smoke, 'a222').category, C.BATTERY_LOW);
  const odd = mapNode(nodeOf(node(50, 'x', 3009, [attr(501, 50, 5, 20, { unit: 'K' })])));
  assert.equal(odd.features.length, 0, 'a temperature in an unknown unit is left out');
  assert.equal(scaleOf('°C'), 'C');
  assert.equal(scaleOf('%'), undefined);
});

test('a lock read: locked, unlocked, moving, unknown', () => {
  const m = mapped(15);
  const a = nodes.get(15).attributes.get(151);
  const read = reader(m, 'a151').read;
  assert.deepEqual(read(a), { state: LOCK_STATE.LOCKED });
  assert.deepEqual(read({ ...a, current: 0, target: 0 }), { state: LOCK_STATE.UNLOCKED });
  assert.deepEqual(read({ ...a, target: 0 }), { state: LOCK_STATE.ACTIVITY });
  assert.deepEqual(read({ ...a, current: 5, target: 5 }), { state: LOCK_STATE.ERROR });
});

test('values: strict numbers and steps', () => {
  assert.equal(strictNumber(''), undefined);
  assert.equal(strictNumber(null), undefined);
  assert.equal(strictNumber(true), undefined);
  assert.equal(strictNumber('1e1'), undefined);
  assert.equal(strictNumber('21.5'), 21.5);
  assert.equal(stepped(21.3, { min: 4, max: 28, step: 0.5 }), 21.5);
  assert.equal(stepped(40, { min: 4, max: 28, step: 0.5 }), 28);
});

test('the model: stable external ids, the features of a created device are never lost', () => {
  const idsOf = (id) => ({ device: `ext:t:homee:${id}`, feature: (k) => `ext:t:homee:${id}:${k}` });
  const box = { uid: '0123456789ab', name: 'Maison' };
  const model = buildModel(idsOf, nodes.values(), box, { language: 'fr' });
  assert.equal(model.devices.length, 15);
  assert.ok(model.deviceIds.has('ext:t:homee:0123456789ab-box'));
  const plug = model.devices.find((d) => d.name === 'Prise congélateur');
  const created = [
    {
      ...plug,
      features: [
        ...plug.features,
        {
          external_id: `${plug.external_id}:a999`,
          name: 'Old',
          category: 'switch',
          type: 'power',
          min: 0,
          max: 1,
          read_only: true,
          has_feedback: false,
          keep_history: true,
          id: 'uuid',
          device_id: 'x',
        },
      ],
    },
  ];
  const again = buildModel(idsOf, nodes.values(), box, { language: 'fr', created });
  const kept = again.devices.find((d) => d.name === 'Prise congélateur').features.at(-1);
  assert.equal(kept.external_id, `${plug.external_id}:a999`);
  assert.equal(kept.id, undefined, 'only the declared fields');
});
