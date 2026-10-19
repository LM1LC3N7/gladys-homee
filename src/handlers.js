// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the devices are published at each read; Scan reads the box again.
  gladys.onScanRequest(() => app.rescan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  // An update (a rename) keeps the index guards; only a creation resets them.
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.ACCEPT_HELD, (fields) => app.acceptHeldIndex(fields));

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys): a
  // reconnection keeps the token, the socket, a 429 pause and refused
  // credentials, and publishes the status, Discovery and badges again.
  gladys.on('connected', async () => {
    try {
      await app.resume(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
