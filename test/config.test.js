import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost } from '../src/config.js';

test('the host: an IP, a name, a URL; never the cloud, credentials or .local', () => {
  assert.deepEqual(parseHost('192.168.1.60'), { host: '192.168.1.60' });
  assert.deepEqual(parseHost(' http://192.168.1.60:7681/ '), { host: '192.168.1.60' });
  assert.deepEqual(parseHost('homee-box'), { host: 'homee-box' });
  assert.deepEqual(parseHost('[fe80::1]'), { host: 'fe80::1' });
  assert.deepEqual(parseHost(''), { error: 'empty' });
  assert.deepEqual(parseHost('my.hom.ee'), { error: 'cloud' });
  assert.deepEqual(parseHost('http://user:pw@192.168.1.60'), { error: 'credentials' });
  assert.deepEqual(parseHost('homee.local'), { error: 'local-name' });
  assert.deepEqual(parseHost('ftp://x'), { error: 'invalid' });
});

test('the configuration: required fields, bounds, sensitive options only on true', () => {
  assert.equal(normalizeConfig({}).error, 'empty');
  assert.equal(normalizeConfig({ host: '1.2.3.4' }).error, 'no-user');
  assert.equal(normalizeConfig({ host: '1.2.3.4', username: 'u' }).error, 'no-password');
  const c = normalizeConfig({ host: '1.2.3.4', username: ' u ', password: ' p ' });
  assert.equal(c.error, undefined);
  assert.equal(c.username, 'u');
  assert.equal(c.password, ' p ', 'a password is taken as typed');
  assert.equal(c.waterHeaterMax, 55);
  for (const key of [
    'allowPlug',
    'allowHeating',
    'allowLock',
    'allowDoor',
    'allowValve',
    'allowSiren',
    'allowAlarm',
  ]) {
    assert.equal(c[key], false, `${key} off by default`);
  }
  assert.equal(normalizeConfig({ allow_lock_control: 'yes' }).allowLock, false);
  assert.equal(normalizeConfig({ allow_lock_control: 1 }).allowLock, false);
  assert.equal(normalizeConfig({ allow_lock_control: true }).allowLock, true);
  assert.equal(normalizeConfig({ water_heater_max: 90 }).waterHeaterMax, 60);
  assert.equal(normalizeConfig({ water_heater_max: 20 }).waterHeaterMax, 40);
  assert.equal(normalizeConfig({ water_heater_max: true }).waterHeaterMax, 55);
  assert.equal(normalizeConfig({ sensor_interval: 'x' }).sensorInterval, 10);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});
