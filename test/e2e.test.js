// -----------------------------------------------------------------------------
// The whole integration, real HTTP token request and real WebSocket, against
// the simulated homee of test/helpers/boxServer.js on 127.0.0.1 (never the
// network), with the SDK's fake Gladys. Real time: a few hundred ms.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HomeeApp } from '../src/app.js';
import { ACTIONS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { StateStore } from '../src/store.js';
import { OFFERED } from './fixtures/box.js';
import { boxServer, waitFor } from './helpers/boxServer.js';
import { PASSWORD, USER } from './helpers/fakeBox.js';

test('a homee, end to end: token, websocket, devices, live states, commands, test', async (t) => {
  const sim = await boxServer();
  const gladys = createFakeGladys({
    config: { host: '127.0.0.1', username: USER, password: PASSWORD, allow_lock_control: true },
  });
  const app = new HomeeApp({
    gladys,
    port: sim.port,
    store: new StateStore({ dir: null }),
    logger: createLogger({ level: 'silent' }),
  });
  registerHandlers(gladys, app);
  t.after(async () => {
    app.stop();
    await sim.close();
  });
  await gladys.connect();
  await waitFor(() => app.online);
  assert.equal(gladys.fake.discoveredDevices.length, OFFERED);
  assert.equal(sim.tokenRequests.length, 1);
  assert.equal(sim.tokenRequests[0].ok, true);
  assert.deepEqual(sim.tokenRequests[0].body, {
    device_name: 'Gladys Assistant',
    device_hardware_id: 'gladys-assistant',
    device_os: '5',
    device_type: '0',
    device_app: '1',
  });
  assert.deepEqual(sim.received, ['GET:all']);

  const lamp = gladys.fake.discoveredDevices.find((d) => d.name === 'Plafonnier');
  await gladys.fake.deviceCreated(lamp);
  sim.emit(101, 0);
  await waitFor(async () => {
    await app.publisher.flush();
    return gladys.fake.lastState(`${lamp.external_id}:a101`) === 0;
  });

  const level = lamp.features.find((f) => f.external_id.endsWith(':a102'));
  let ack = await gladys.fake.setValue(lamp, level, 30);
  assert.equal(ack.success, true, ack.error);
  await waitFor(() => sim.received.includes('PUT:nodes/10/attributes/102?target_value=30'));

  const lock = gladys.fake.discoveredDevices.find((d) => d.name === 'Serrure entrée');
  const unlock = lock.features.find((f) => f.external_id.endsWith(':a151-unlock'));
  ack = await gladys.fake.setValue(lock, unlock, 1);
  assert.equal(ack.success, true, ack.error);
  const read = sim.received.indexOf('GET:nodes/15/attributes/151');
  assert.ok(read >= 0, 'read just before');
  assert.equal(sim.received[read + 1], 'PUT:nodes/15/attributes/151?target_value=0');

  const tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(
    tested.data.message.en,
    /^Connection OK to Maison at 127\.0\.0\.1: 16 nodes, 15 devices offered in Discovery/,
  );

  sim.drop();
  await waitFor(() => !app.online);
  await waitFor(() => app.online, 8000); // opened again after 5 s
  assert.equal(sim.tokenRequests.length, 2, 'the app, the test; the token kept on reconnection');
  assert.equal(sim.refusedUpgrades, 0);
});
