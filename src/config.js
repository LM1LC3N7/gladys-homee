// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { LANGUAGES, SENSOR_INTERVAL, WATER_HEATER_MAX } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  host: '',
  username: '',
  password: '',
  language: 'fr',
  sensor_interval: SENSOR_INTERVAL.default,
  water_heater_max: WATER_HEATER_MAX.default,
  allow_plug_control: false,
  allow_heating_control: false,
  allow_lock_control: false,
  allow_door_control: false,
  allow_valve_control: false,
  allow_siren_control: false,
  allow_alarm_control: false,
};

/** The options that allow a kind of sensitive command (all off by default). */
export const OPTION_OF_KIND = {
  plug: 'allowPlug',
  heating: 'allowHeating',
  lock: 'allowLock',
  door: 'allowDoor',
  valve: 'allowValve',
  siren: 'allowSiren',
  alarm: 'allowAlarm',
};

/**
 * The host of the box from what the user typed: "192.168.1.60",
 * "http://192.168.1.60:7681/", "homee-1a2b3c" (a local DNS name).
 * @returns {{ host: string } | { error: 'empty' | 'invalid' | 'credentials' | 'cloud' | 'local-name' }}
 */
export function parseHost(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { error: 'empty' };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname) {
    return { error: 'invalid' };
  }
  if (url.username || url.password) {
    return { error: 'credentials' };
  }
  if (/(^|\.)hom\.ee$/i.test(url.hostname)) {
    // my.hom.ee is the cloud access of homee: local only.
    return { error: 'cloud' };
  }
  if (/\.local$/i.test(url.hostname)) {
    // mDNS names do not resolve in the container (bridge network).
    return { error: 'local-name' };
  }
  // The port of the box is always 7681: only the host is kept.
  return { host: url.hostname.replace(/^\[|\]$/g, '') };
}

const bounded = (raw, { min, max, default: fallback }) => {
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** Only `true` (or "true") allows: anything else keeps a sensitive option off. */
const allowed = (raw) => raw === true || raw === 'true';

/**
 * @returns {{ host?: string, username: string, password: string, error?: string,
 *   language: 'fr'|'en', sensorInterval: number, waterHeaterMax: number,
 *   allowPlug: boolean, allowHeating: boolean, allowLock: boolean, allowDoor: boolean,
 *   allowValve: boolean, allowSiren: boolean, allowAlarm: boolean }}
 */
export function normalizeConfig(raw = {}) {
  const given = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
  const c = { ...DEFAULTS, ...given };
  const target = parseHost(c.host);
  const username = String(c.username ?? '').trim();
  // A password is taken as typed: spaces may be part of it.
  const password = typeof c.password === 'string' ? c.password : String(c.password ?? '');
  let error = target.error;
  if (!error && username === '') {
    error = 'no-user';
  }
  if (!error && password === '') {
    error = 'no-password';
  }
  return {
    host: target.host,
    username,
    password,
    error,
    language: LANGUAGES.includes(c.language) ? c.language : DEFAULTS.language,
    sensorInterval: Math.round(bounded(c.sensor_interval, SENSOR_INTERVAL)),
    waterHeaterMax: Math.floor(bounded(c.water_heater_max, WATER_HEATER_MAX)),
    // Louis's rule: every sensitive command stays off unless allowed.
    allowPlug: allowed(c.allow_plug_control),
    allowHeating: allowed(c.allow_heating_control),
    allowLock: allowed(c.allow_lock_control),
    allowDoor: allowed(c.allow_door_control),
    allowValve: allowed(c.allow_valve_control),
    allowSiren: allowed(c.allow_siren_control),
    allowAlarm: allowed(c.allow_alarm_control),
  };
}
