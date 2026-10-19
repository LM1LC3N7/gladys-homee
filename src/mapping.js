// -----------------------------------------------------------------------------
// One homee node -> Gladys features, readers and writers (pure).
//
// A homee node has a profile (what it is: "dimmable light", "metering plug",
// "radiator thermostat", "lock"…) and attributes (one value each: on/off,
// dimming level, temperature…), with their type, range, unit and whether
// they can be set. The profile groups and the meaning of the values follow
// pyHomee 1.4.6 (MIT, Taraman17) and the Home Assistant homee integration
// (Apache-2.0), see THIRD_PARTY_NOTICES.md.
//
// `mapNode` returns:
//   features  the Gladys features; key `a<attribute id>` for the feature of
//             an attribute, `a<id>-<command>` for its command buttons (part
//             of the external id: never change a key),
//   readers   [{ key, attr, read(attribute) -> { state } | { text } | null, meter? }]
//   writers   { [key]: writer }, a writer being either
//               { attr, write(value, attribute) -> target }           direct
//               { attr, kind, plan(attribute, value, ctx) -> plan,
//                 confirm?, protective?, directional?, impulse? }    sensitive
//             `kind` names the option that allows it (src/config.js
//             OPTION_OF_KIND); a plan is computed on the attribute read just
//             before, and is { already: true } or { target, done?(attribute) }.
//             `protective` (lock, close the valve, stop, turn off, stop the
//             siren): never refused for the state, always sent, planned on
//             the attribute known. `confirm`: the state asked for is awaited
//             (badge). `directional`: needs the direction of the attribute
//             (reverse_control_ui) known and unchanged. `impulse`: debounced.
//   throttled the keys of the measurements (spaced by the sensor interval).
//
// Safety: only lights and the plain wall relays of RELAY_PROFILES get a
// switch. A lock, a door, a gate, a valve, a siren, a heating, a plug, a
// metering relay or any other profile never does ("turn everything off" of
// Google Home, Alexa, HomeKit, MCP or a scene must never reach them): their
// state is read only and their commands are buttons, refused unless the
// matching option is on.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  ATTR,
  BUTTON_PUSH,
  FIRST_UNAVAILABLE_ATTRIBUTE_STATE,
  HOMEE_MODES,
  PROFILE as P,
  WATER_HEATER_MAX,
} from './constants.js';
import { label, modeName } from './i18n.js';

// Value enums of the Gladys core (server/utils/constants.js), not in the SDK.
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const LOCK_STATE = { UNLOCKED: 0, LOCKED: 1, ACTIVITY: 2, ERROR: 3 };

/** Open/close attribute of a cover or a door (Home Assistant HomeeCoverState). */
export const HOMEE_COVER = { OPEN: 0, CLOSED: 1, STOPPED: 2, OPENING: 3, CLOSING: 4 };

const LIGHT_PROFILES = new Set([
  P.DIMMABLE_COLOR_LIGHT,
  P.DIMMABLE_COLOR_METERING_PLUG,
  P.DIMMABLE_COLOR_TEMPERATURE_LIGHT,
  P.DIMMABLE_EXTENDED_COLOR_LIGHT,
  P.DIMMABLE_LIGHT,
  P.DIMMABLE_LIGHT_WITH_BRIGHTNESS_SENSOR,
  P.DIMMABLE_LIGHT_WITH_BRIGHTNESS_AND_PRESENCE_SENSOR,
  P.DIMMABLE_LIGHT_WITH_PRESENCE_SENSOR,
  P.DIMMABLE_METERING_SWITCH,
  P.DIMMABLE_METERING_PLUG,
  P.DIMMABLE_PLUG,
  P.DIMMABLE_RGBWLIGHT,
  P.DIMMABLE_SWITCH,
  P.WIFI_DIMMABLE_RGBWLIGHT,
  P.WIFI_DIMMABLE_LIGHT,
  P.WIFI_ON_OFF_DIMMABLE_METERING_SWITCH,
]);
/**
 * The only on/off that get a switch outside the lights: plain wall relays.
 * Every other on/off (plugs, metering relays, cameras, washers, ventilation,
 * profiles unknown) is read only, with buttons behind the plug option: the
 * load is unknown, "turn everything off" must not reach it.
 */
export const RELAY_PROFILES = new Set([
  P.ON_OFF_SWITCH,
  P.DOUBLE_ON_OFF_SWITCH,
  P.ON_OFF_SWITCH_WITH_BINARY_INPUT,
  P.WIFI_ON_OFF_SWITCH,
]);
/** Attributes that make a node a heating, whatever its profile. */
const HEATING_ATTRIBUTES = [
  ATTR.TARGET_TEMPERATURE,
  ATTR.WARM_WATER_TARGET_TEMPERATURE,
  ATTR.WARM_WATER_TEMPERATURE,
  ATTR.HEATING_MODE,
];
/** Doors and gates whose Open / Close / Stop buttons are offered in v1 (Home Assistant's covers). */
export const DOOR_COMMAND_PROFILES = new Set([P.ENTRANCE_GATE_OPERATOR, P.GARAGE_DOOR_OPERATOR]);
const COVER_PROFILES = new Set([
  P.SHUTTER_POSITION_SWITCH,
  P.ELECTRIC_MOTOR_METERING_SWITCH,
  P.ELECTRIC_MOTOR_METERING_SWITCH_WITHOUT_SLAT_POSITION,
  P.WIFI_ELECTRIC_MOTOR_METERING_SWITCH,
]);
/** What opens a way in: garage doors, gates, doors, window motors, impulse relays. */
const DOOR_PROFILES = new Set([
  P.ENTRANCE_GATE_OPERATOR,
  P.GARAGE_DOOR_OPERATOR,
  P.GATE_OPERATOR,
  P.INNER_DOOR_OPERATOR,
  P.GARAGE_DOOR_IMPULSE_OPERATOR,
  P.ENTRANCE_DOOR,
  P.WINDOW_MOTOR_SWITCH,
  P.IMPULSE_PLUG,
  P.IMPULSE_RELAY,
]);
const HEATING_PROFILES = new Set([
  P.ROOM_THERMOSTAT,
  P.ROOM_THERMOSTAT_WITH_HUMIDITY_SENSOR,
  P.RADIATOR_THERMOSTAT,
  P.COSI_THERM_CHANNEL,
  P.THERMOSTAT_WITH_HEATING_AND_COOLING,
  P.ELECTRICAL_HEATING,
  P.VALVE_DRIVE,
  P.HEATING_SYSTEM,
  P.WARM_WATER_CIRCUIT,
  P.HEATING_CIRCUIT,
  P.WIFI_ROOM_THERMOSTAT,
  P.WIFI_RADIATOR_THERMOSTAT,
]);
const SIREN_PROFILES = new Set([P.SIREN, P.SMOKE_DETECTOR_AND_SIREN]);
/** Impulse attributes: each press moves a door, a gate or a window. */
const IMPULSES = new Set([
  ATTR.IMPULSE,
  ATTR.OPEN_PARTIAL_IMPULSE,
  ATTR.AUTOMATIC_MODE_IMPULSE,
  ATTR.BRIEFLY_OPEN_IMPULSE,
  ATTR.PERMANENTLY_OPEN_IMPULSE,
  ATTR.VENTILATE_IMPULSE,
]);

/** The option kind of the buttons of an on/off, by node kind (other: the unknown load). */
const BUTTON_KIND = {
  other: 'plug',
  cover: 'plug',
  heating: 'heating',
  lock: 'lock',
  door: 'door',
  valve: 'valve',
  siren: 'siren',
};

/**
 * What a node is, for the safety rules:
 * alarm | box | lock | door | valve | siren | heating | light | cover | relay | other.
 * `other` is every node whose on/off may drive an unknown load (plugs,
 * metering relays, any profile not listed): read only, buttons behind the
 * plug option.
 */
export function kindOf(node) {
  const types = new Set([...node.attributes.values()].map((a) => a.type));
  if (node.profile >= 5000 && node.profile < 6000) {
    // The INOVA alarm system (its sirens included): read only, never commanded.
    return 'alarm';
  }
  if (node.id === -1 || node.profile === P.HOMEE) {
    return 'box';
  }
  if (node.profile === P.LOCK || types.has(ATTR.LOCK_STATE)) {
    return 'lock';
  }
  if (DOOR_PROFILES.has(node.profile)) {
    return 'door';
  }
  if (node.profile === P.WATER_VALVE) {
    return 'valve';
  }
  if (SIREN_PROFILES.has(node.profile) || types.has(ATTR.SIREN)) {
    return 'siren';
  }
  if (HEATING_PROFILES.has(node.profile) || HEATING_ATTRIBUTES.some((t) => types.has(t))) {
    return 'heating';
  }
  if (LIGHT_PROFILES.has(node.profile)) {
    return 'light';
  }
  if (COVER_PROFILES.has(node.profile)) {
    return 'cover';
  }
  if (RELAY_PROFILES.has(node.profile)) {
    return 'relay';
  }
  return 'other';
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const cut = (s, max = 100) => String(s ?? '').slice(0, max);
const near = (a, b) => Math.abs(a - b) < 1e-6;

/** A command value: a finite number (or a plain decimal text); null, '' and booleans are not 0. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export const refusal = (key) => Object.assign(new Error(key), { refusal: key });

/** An attribute the box says is unavailable (or a node in trouble) reads as nothing. */
export const usable = (attribute) =>
  attribute !== undefined && attribute.state < FIRST_UNAVAILABLE_ATTRIBUTE_STATE;

/** A value rounded to the step of an attribute, inside its range. */
export function stepped(value, attribute) {
  const step = attribute.step > 0 ? attribute.step : 1;
  const n = attribute.min + Math.round((value - attribute.min) / step) * step;
  return round(clamp(n, attribute.min, attribute.max), 4);
}

/** 0…100 % <-> the range of an attribute. */
const toPercent = (attribute) =>
  attribute.max > attribute.min
    ? clamp(
        Math.round(((attribute.current - attribute.min) / (attribute.max - attribute.min)) * 100),
        0,
        100,
      )
    : 0;
const fromPercent = (percent, attribute) =>
  stepped(
    attribute.min + (clamp(percent, 0, 100) / 100) * (attribute.max - attribute.min),
    attribute,
  );

// --- Units -------------------------------------------------------------------------

/** °C or °F from the unit of a temperature attribute; undefined when it is something else. */
export function scaleOf(unit) {
  const u = String(unit ?? '').replace(/\s/g, '');
  if (/^°?C$/i.test(u)) {
    return 'C';
  }
  if (/^°?F$/i.test(u)) {
    return 'F';
  }
  return undefined;
}
export const toCelsius = (value, scale) => round(scale === 'F' ? ((value - 32) * 5) / 9 : value);
export const fromCelsius = (value, scale) => (scale === 'F' ? (value * 9) / 5 + 32 : value);

/** Gladys colour temperatures in mireds (homee: kelvins). */
export const kelvinToMireds = (k) => (k > 0 ? Math.round(1e6 / k) : undefined);
export const miredsToKelvin = (m) => (m > 0 ? Math.round(1e6 / m) : undefined);

// --- Specs -------------------------------------------------------------------------

const sensor = (category, type, min, max, unit) => ({ category, type, min, max, unit });

const binarySensor = (category, type = T.SENSOR.BINARY) => ({
  category,
  type,
  min: 0,
  max: 1,
});

/** Read-only measurements: attribute type -> [label key, spec, unit check, value]. */
const MEASURES = {
  [ATTR.RELATIVE_HUMIDITY]: [
    'humidity',
    sensor(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, 0, 100, U.PERCENT),
    '%',
  ],
  [ATTR.INDOOR_RELATIVE_HUMIDITY]: [
    'indoorHumidity',
    sensor(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, 0, 100, U.PERCENT),
    '%',
  ],
  [ATTR.OUTDOOR_RELATIVE_HUMIDITY]: [
    'outdoorHumidity',
    sensor(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, 0, 100, U.PERCENT),
    '%',
  ],
  [ATTR.CO2LEVEL]: ['co2', sensor(C.CO2_SENSOR, T.SENSOR.DECIMAL, 0, 100_000, U.PPM), 'ppm'],
  [ATTR.UV]: ['uv', sensor(C.UV_SENSOR, T.UV_SENSOR.INTEGER, 0, 20, U.UV_INDEX), null],
};

const TEMPERATURES = {
  [ATTR.TEMPERATURE]: ['temperature', T.SENSOR.DECIMAL],
  [ATTR.INDOOR_TEMPERATURE]: ['indoorTemperature', T.SENSOR.DECIMAL],
  [ATTR.OUTDOOR_TEMPERATURE]: ['outdoorTemperature', T.SENSOR.DECIMAL],
  [ATTR.FLOOR_TEMPERATURE]: ['floorTemperature', T.TEMPERATURE_SENSOR.PROBE],
  [ATTR.EXTERNAL_TEMPERATURE]: ['externalTemperature', T.TEMPERATURE_SENSOR.PROBE],
  [ATTR.FEED_TEMPERATURE]: ['feedTemperature', T.TEMPERATURE_SENSOR.PROBE],
  [ATTR.WARM_WATER_TEMPERATURE]: ['warmWaterTemperature', T.TEMPERATURE_SENSOR.PROBE],
};

/** Alarms read as binary sensors: attribute type -> [label key, spec]. */
const ALARMS = {
  [ATTR.FLOOD_ALARM]: ['flood', binarySensor(C.LEAK_SENSOR)],
  [ATTR.WATER_ALARM]: ['water', binarySensor(C.LEAK_SENSOR)],
  [ATTR.LEAK_ALARM]: ['leak', binarySensor(C.LEAK_SENSOR)],
  [ATTR.SMOKE_ALARM]: ['smoke', binarySensor(C.SMOKE_SENSOR)],
  [ATTR.COALARM]: ['co', binarySensor(C.CO_SENSOR)],
  [ATTR.MOTION_ALARM]: ['motion', binarySensor(C.MOTION_SENSOR)],
  [ATTR.PRESENCE_ALARM]: ['presence', binarySensor(C.PRESENCE_SENSOR)],
  [ATTR.TAMPER_ALARM]: ['tamper', binarySensor(C.TAMPER, T.TAMPER.BINARY)],
  [ATTR.BATTERY_LOW_ALARM]: ['batteryLow', binarySensor(C.BATTERY_LOW, T.BATTERY_LOW.BINARY)],
};

const POWER_UNITS = { w: 1, kw: 1000 };
const ENERGY_UNITS = { kwh: 1, wh: 0.001 };

const BUTTON = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
};

/** The read-only state of an on/off the user may not switch (lot 6 lesson: unknown/binary). */
const READ_ONLY_ON_OFF = { category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 };

// --- The node ----------------------------------------------------------------------

class NodeMapper {
  constructor(node, { language = 'fr' } = {}) {
    this.node = node;
    this.language = language;
    this.kind = kindOf(node);
    this.name = node.name;
    this.features = [];
    this.readers = [];
    this.writers = {};
    this.throttled = new Set();
    this.hasSwitch = false;
  }

  nameOf(key, attribute, ...args) {
    const suffix = attribute?.instance > 0 ? ` ${attribute.instance}` : '';
    return cut(`${this.name} – ${label(key, this.language, ...args)}${suffix}`);
  }

  /**
   * One feature.
   * @param {string} key part of the external id: never change it
   */
  add(
    key,
    name,
    spec,
    {
      read,
      attr,
      write,
      plan,
      kind,
      confirm,
      protective,
      directional,
      impulse,
      throttle = false,
      meter,
      text,
    } = {},
  ) {
    if (this.features.some((f) => f.key === key)) {
      return;
    }
    const writable = Boolean(write || plan);
    const feature = {
      key,
      name: cut(name),
      category: spec.category,
      type: spec.type,
      min: spec.min ?? 0,
      max: spec.max ?? 1,
      read_only: !writable,
      has_feedback: writable && Boolean(read),
      keep_history: spec.category !== C.BUTTON && spec.category !== C.TEXT,
    };
    if (spec.unit) {
      feature.unit = spec.unit;
    }
    if (spec.supported_options) {
      feature.supported_options = spec.supported_options;
    }
    this.features.push(feature);
    if (read) {
      this.readers.push({
        key,
        attr,
        read,
        ...(meter ? { meter } : {}),
        ...(text ? { text } : {}),
      });
    }
    if (write) {
      this.writers[key] = { attr, write };
    } else if (plan) {
      this.writers[key] = {
        attr,
        kind,
        plan,
        ...(confirm ? { confirm } : {}),
        ...(protective ? { protective: true } : {}),
        ...(directional ? { directional: true } : {}),
        ...(impulse ? { impulse: true } : {}),
      };
    }
    if (throttle) {
      this.throttled.add(key);
    }
  }

  /** A press of a command button: only BUTTON_PUSH.PRESSED acts. */
  static pressed(value) {
    if (strictNumber(value) !== BUTTON_PUSH.PRESSED) {
      throw refusal('badValue');
    }
  }

  /**
   * Buttons for a sensitive on/off: on decided on the state read just
   * before; off is protective (it stops the load, the heating, the siren):
   * never refused, always sent.
   */
  onOffButtons(a, kind, labels = ['turnOn', 'turnOff']) {
    const [onLabel, offLabel] = labels;
    const confirm = ['lock', 'door', 'valve'].includes(kind) ? kind : undefined;
    this.add(`a${a.id}-on`, this.nameOf(onLabel, a), BUTTON, {
      attr: a.id,
      kind,
      confirm,
      plan: (fresh, value) => {
        NodeMapper.pressed(value);
        if (!near(fresh.current, 0) && !near(fresh.current, 1)) {
          throw refusal('unknownState');
        }
        if (near(fresh.current, 1) && near(fresh.target, 1)) {
          return { already: true };
        }
        return { target: 1, done: (x) => near(x.current, 1) };
      },
    });
    this.add(`a${a.id}-off`, this.nameOf(offLabel, a), BUTTON, {
      attr: a.id,
      kind,
      confirm,
      protective: true,
      plan: (_known, value) => {
        NodeMapper.pressed(value);
        return { target: 0, done: (x) => near(x.current, 0) };
      },
    });
  }

  // --- Lights and switches --------------------------------------------------------

  onOff(a) {
    const read = (x) => (usable(x) ? { state: x.current > 0 ? 1 : 0 } : null);
    const name = cut(`${this.name}${a.instance > 0 ? ` ${a.instance}` : ''}`);
    const write = (value) => {
      const v = strictNumber(value);
      if (v !== 0 && v !== 1) {
        throw refusal('badValue');
      }
      return v;
    };
    if (this.kind === 'light' && a.editable) {
      this.add(
        `a${a.id}`,
        name,
        { category: C.LIGHT, type: T.LIGHT.BINARY, min: 0, max: 1 },
        { attr: a.id, read, write },
      );
      this.hasSwitch = true;
      return;
    }
    if (this.kind === 'relay' && a.editable) {
      this.add(
        `a${a.id}`,
        name,
        { category: C.SWITCH, type: T.SWITCH.BINARY, min: 0, max: 1 },
        { attr: a.id, read, write },
      );
      this.hasSwitch = true;
      return;
    }
    // Anything else (a plug, a metering relay, an unknown profile, a heating,
    // a valve, a siren, a lock, a door, the alarm): the state read only, and
    // buttons behind the option of the kind.
    this.add(`a${a.id}`, name, READ_ONLY_ON_OFF, { attr: a.id, read });
    const kind = BUTTON_KIND[this.kind];
    if (a.editable && kind) {
      this.onOffButtons(a, kind);
    }
  }

  dimming(a) {
    const light = this.kind === 'light';
    const spec = light
      ? { category: C.LIGHT, type: T.LIGHT.BRIGHTNESS, min: 0, max: 100 }
      : { category: C.SWITCH, type: T.SWITCH.DIMMER, min: 0, max: 100 };
    // Same list as the on/off: a dimmer of an unknown load is read only.
    const writable = a.editable && (light || this.kind === 'relay');
    this.add(`a${a.id}`, this.nameOf('brightness', a), spec, {
      attr: a.id,
      read: (x) => (usable(x) ? { state: toPercent(x) } : null),
      write: writable
        ? (value, x) => {
            const v = strictNumber(value);
            if (v === undefined) {
              throw refusal('badValue');
            }
            return fromPercent(v, x);
          }
        : undefined,
    });
  }

  color(a) {
    this.add(
      `a${a.id}`,
      this.nameOf('color', a),
      { category: C.LIGHT, type: T.LIGHT.COLOR, min: 0, max: 0xffffff },
      {
        attr: a.id,
        read: (x) => (usable(x) ? { state: clamp(Math.round(x.current), 0, 0xffffff) } : null),
        write: a.editable
          ? (value) => {
              const v = strictNumber(value);
              if (v === undefined) {
                throw refusal('badValue');
              }
              return clamp(Math.round(v), 0, 0xffffff);
            }
          : undefined,
      },
    );
  }

  colorTemperature(a) {
    const low = kelvinToMireds(a.max);
    const high = kelvinToMireds(a.min);
    if (!low || !high || low >= high) {
      return;
    }
    this.add(
      `a${a.id}`,
      this.nameOf('colorTemperature', a),
      { category: C.LIGHT, type: T.LIGHT.TEMPERATURE, min: low, max: high },
      {
        attr: a.id,
        read: (x) =>
          usable(x) && x.current > 0
            ? { state: clamp(kelvinToMireds(x.current), low, high) }
            : null,
        write: a.editable
          ? (value, x) => {
              const v = strictNumber(value);
              if (v === undefined || v <= 0) {
                throw refusal('badValue');
              }
              return stepped(miredsToKelvin(clamp(v, low, high)), x);
            }
          : undefined,
      },
    );
  }

  // --- Covers (shutters, blinds) ---------------------------------------------------

  coverState(a) {
    const read = (x) => {
      if (!usable(x) || x.reversed === undefined) {
        return null;
      }
      const open = x.reversed ? HOMEE_COVER.CLOSED : HOMEE_COVER.OPEN;
      const opening = x.reversed ? HOMEE_COVER.CLOSING : HOMEE_COVER.OPENING;
      const v = Math.round(x.current);
      if (v === open || v === opening) {
        return { state: COVER_STATE.OPEN };
      }
      if (v === HOMEE_COVER.STOPPED) {
        return { state: COVER_STATE.STOP };
      }
      return [
        HOMEE_COVER.OPEN,
        HOMEE_COVER.CLOSED,
        HOMEE_COVER.OPENING,
        HOMEE_COVER.CLOSING,
      ].includes(v)
        ? { state: COVER_STATE.CLOSE }
        : null;
    };
    this.add(
      `a${a.id}`,
      cut(this.name),
      { category: C.SHUTTER, type: T.SHUTTER.STATE, min: -1, max: 1 },
      {
        attr: a.id,
        read,
        write: a.editable
          ? (value, x) => {
              const v = strictNumber(value);
              if (v === COVER_STATE.STOP) {
                return HOMEE_COVER.STOPPED;
              }
              if (x.reversed === undefined) {
                throw refusal('directionUnknown');
              }
              if (v === COVER_STATE.OPEN) {
                return x.reversed ? HOMEE_COVER.CLOSED : HOMEE_COVER.OPEN;
              }
              if (v === COVER_STATE.CLOSE) {
                return x.reversed ? HOMEE_COVER.OPEN : HOMEE_COVER.CLOSED;
              }
              throw refusal('badValue');
            }
          : undefined,
      },
    );
  }

  coverPosition(a) {
    // homee: 0 open … 100 closed; Gladys: the percentage open.
    this.add(
      `a${a.id}`,
      this.nameOf('position', a),
      { category: C.SHUTTER, type: T.SHUTTER.POSITION, min: 0, max: 100 },
      {
        attr: a.id,
        read: (x) => (usable(x) ? { state: 100 - toPercent(x) } : null),
        write: a.editable
          ? (value, x) => {
              const v = strictNumber(value);
              if (v === undefined) {
                throw refusal('badValue');
              }
              return fromPercent(100 - v, x);
            }
          : undefined,
      },
    );
  }

  // --- Doors, gates, window motors (read only unless allowed) ---------------------

  doorState(a) {
    const homeeOpen = (x) => (x.reversed ? HOMEE_COVER.CLOSED : HOMEE_COVER.OPEN);
    const homeeClosed = (x) => (x.reversed ? HOMEE_COVER.OPEN : HOMEE_COVER.CLOSED);
    // Moving: opening, closing, or a target the door has not reached yet.
    const moving = (x) =>
      [HOMEE_COVER.OPENING, HOMEE_COVER.CLOSING].includes(Math.round(x.current)) ||
      !near(x.current, x.target);
    this.add(`a${a.id}`, this.nameOf('door', a), binarySensor(C.OPENING_SENSOR), {
      attr: a.id,
      read: (x) => {
        if (
          !usable(x) ||
          x.reversed === undefined ||
          !Number.isInteger(x.current) ||
          x.current < 0 ||
          x.current > 4
        ) {
          return null;
        }
        return {
          state:
            x.current === homeeClosed(x) ? OPENING_SENSOR_STATE.CLOSE : OPENING_SENSOR_STATE.OPEN,
        };
      },
    });
    if (!a.editable || !DOOR_COMMAND_PROFILES.has(this.node.profile)) {
      // v1: Open / Close / Stop only on garage doors and entrance gates.
      return;
    }
    const known = (x) => Number.isInteger(x.current) && x.current >= 0 && x.current <= 4;
    // Stop is protective: never refused, always sent (2 is the same both ways).
    this.add(`a${a.id}-stop`, this.nameOf('stop', a), BUTTON, {
      attr: a.id,
      kind: 'door',
      protective: true,
      plan: (_known, value) => {
        NodeMapper.pressed(value);
        return { target: HOMEE_COVER.STOPPED, done: (x) => !moving(x) };
      },
    });
    for (const [suffix, labelKey] of [
      ['open', 'open'],
      ['close', 'close'],
    ]) {
      this.add(`a${a.id}-${suffix}`, this.nameOf(labelKey, a), BUTTON, {
        attr: a.id,
        kind: 'door',
        confirm: 'door',
        directional: true,
        plan: (fresh, value) => {
          NodeMapper.pressed(value);
          if (fresh.reversed === undefined) {
            throw refusal('directionUnknown');
          }
          if (!known(fresh)) {
            throw refusal('unknownState');
          }
          if (moving(fresh)) {
            throw refusal('moving');
          }
          const target = suffix === 'open' ? homeeOpen(fresh) : homeeClosed(fresh);
          if (fresh.current === target) {
            return { already: true };
          }
          return { target, done: (x) => Math.round(x.current) === target };
        },
      });
    }
  }

  impulse(a) {
    // A press moves the door, gate or window one step: no state to decide
    // on. Two presses within 2 s are one bounce (src/app.js); the second
    // press after that, often the stop, is sent.
    this.add(`a${a.id}`, this.nameOf(IMPULSE_LABELS[a.type] ?? 'impulse', a), BUTTON, {
      attr: a.id,
      kind: 'door',
      impulse: true,
      plan: (_fresh, value) => {
        NodeMapper.pressed(value);
        return { target: 1 };
      },
    });
  }

  // --- Locks (read only unless allowed) --------------------------------------------

  lock(a) {
    // Home Assistant: the unlatch value is 2 on most locks, -1 on the Hörmann SmartKey.
    const openValue = near(a.max, 2) ? 2 : near(a.min, -1) ? -1 : undefined;
    this.add(
      `a${a.id}`,
      cut(this.name),
      { category: C.LOCK, type: T.LOCK.STATE, min: 0, max: 3 },
      {
        attr: a.id,
        read: (x) => {
          if (!usable(x)) {
            return null;
          }
          if (!near(x.current, x.target)) {
            return { state: LOCK_STATE.ACTIVITY };
          }
          if (near(x.current, 1)) {
            return { state: LOCK_STATE.LOCKED };
          }
          if (near(x.current, 0) || (openValue !== undefined && near(x.current, openValue))) {
            return { state: LOCK_STATE.UNLOCKED };
          }
          return { state: LOCK_STATE.ERROR };
        },
      },
    );
    if (!a.editable) {
      return;
    }
    // Locking is protective: never refused, always sent.
    this.add(`a${a.id}-lock`, this.nameOf('lock', a), BUTTON, {
      attr: a.id,
      kind: 'lock',
      confirm: 'lock',
      protective: true,
      plan: (_known, value) => {
        NodeMapper.pressed(value);
        return { target: 1, done: (x) => near(x.current, 1) && near(x.target, 1) };
      },
    });
    const commands = [['unlock', 0, 'unlock']];
    if (openValue !== undefined) {
      commands.push(['open', openValue, 'unlatch']);
    }
    const known = (x) =>
      near(x.current, 0) ||
      near(x.current, 1) ||
      (openValue !== undefined && near(x.current, openValue));
    for (const [suffix, target, labelKey] of commands) {
      this.add(`a${a.id}-${suffix}`, this.nameOf(labelKey, a), BUTTON, {
        attr: a.id,
        kind: 'lock',
        confirm: 'lock',
        plan: (fresh, value) => {
          NodeMapper.pressed(value);
          if (!near(fresh.current, fresh.target)) {
            throw refusal('moving');
          }
          if (!known(fresh)) {
            throw refusal('unknownState');
          }
          // Unlatching is never "already done": it is a momentary action.
          if (suffix !== 'open' && near(fresh.current, target)) {
            return { already: true };
          }
          return { target, done: (x) => near(x.current, target) && near(x.target, target) };
        },
      });
    }
  }

  // --- Sirens (read only unless allowed) -------------------------------------------

  siren(a) {
    this.add(`a${a.id}`, cut(this.name), binarySensor(C.SIREN, T.SIREN.BINARY), {
      attr: a.id,
      read: (x) => (usable(x) ? { state: near(x.current, 1) ? 1 : 0 } : null),
    });
    if (a.editable && this.kind === 'siren') {
      this.onOffButtons(a, 'siren', ['sirenOn', 'sirenOff']);
    }
  }

  // --- Valves (read only unless allowed) -------------------------------------------

  valvePosition(a) {
    this.add(
      `a${a.id}`,
      this.nameOf('valvePosition', a),
      { category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 100 },
      {
        attr: a.id,
        read: (x) => (usable(x) ? { state: clamp(Math.round(x.current), 0, 100) } : null),
        throttle: true,
      },
    );
    if (!a.editable || this.kind !== 'valve') {
      // A radiator valve is moved by its thermostat, never directly.
      return;
    }
    this.add(`a${a.id}-open`, this.nameOf('valveOpen', a), BUTTON, {
      attr: a.id,
      kind: 'valve',
      confirm: 'valve',
      plan: (fresh, value) => {
        NodeMapper.pressed(value);
        const target = fresh.max;
        if (!near(fresh.current, fresh.target)) {
          throw refusal('moving');
        }
        if (near(fresh.current, target)) {
          return { already: true };
        }
        return { target, done: (x) => near(x.current, target) };
      },
    });
    // Closing the water is protective: never refused (a leak), always sent.
    this.add(`a${a.id}-close`, this.nameOf('valveClose', a), BUTTON, {
      attr: a.id,
      kind: 'valve',
      confirm: 'valve',
      protective: true,
      plan: (known, value) => {
        NodeMapper.pressed(value);
        const target = known?.min ?? a.min;
        return { target, done: (x) => near(x.current, target) };
      },
    });
  }

  // --- Climate (setpoints behind the heating option) ---------------------------------

  temperature(a, labelKey, type) {
    const scale = scaleOf(a.unit);
    if (!scale) {
      return;
    }
    this.add(
      `a${a.id}`,
      this.nameOf(labelKey, a),
      sensor(C.TEMPERATURE_SENSOR, type, -60, 150, U.CELSIUS),
      {
        attr: a.id,
        read: (x) =>
          usable(x) && scaleOf(x.unit) ? { state: toCelsius(x.current, scaleOf(x.unit)) } : null,
        throttle: true,
      },
    );
  }

  setpoint(a, { water }) {
    const scale = scaleOf(a.unit);
    if (!scale) {
      return;
    }
    const min = Math.floor(toCelsius(a.min, scale));
    const max = Math.ceil(toCelsius(a.max, scale));
    const spec = water
      ? sensor(
          C.WATER_HEATER,
          T.WATER_HEATER.TARGET_TEMPERATURE,
          clamp(min, 0, WATER_HEATER_MAX.max),
          clamp(max, 1, WATER_HEATER_MAX.max),
          U.CELSIUS,
        )
      : sensor(
          C.THERMOSTAT,
          T.THERMOSTAT.TARGET_TEMPERATURE,
          clamp(min, -10, 40),
          clamp(max, -9, 40),
          U.CELSIUS,
        );
    if (spec.min >= spec.max) {
      return;
    }
    this.add(`a${a.id}`, this.nameOf(water ? 'warmWaterSetpoint' : 'setpoint', a), spec, {
      attr: a.id,
      read: (x) =>
        usable(x) && scaleOf(x.unit) ? { state: toCelsius(x.current, scaleOf(x.unit)) } : null,
      kind: a.editable ? 'heating' : undefined,
      plan: a.editable
        ? (fresh, value, ctx) => {
            const celsius = strictNumber(value);
            const freshScale = scaleOf(fresh.unit);
            if (celsius === undefined || !freshScale) {
              throw refusal('badValue');
            }
            const ceiling = Math.min(ctx.waterHeaterMax, WATER_HEATER_MAX.max);
            if (water && celsius > ceiling) {
              throw refusal('tooHot');
            }
            // Never outside the range published (the slider), whatever the box allows.
            if (celsius < spec.min || celsius > spec.max) {
              throw refusal('outOfRange');
            }
            const target = stepped(fromCelsius(celsius, freshScale), fresh);
            const sent = toCelsius(target, freshScale);
            if (water && sent > ceiling) {
              throw refusal('tooHot');
            }
            if (sent < spec.min - 0.5 || sent > spec.max + 0.5) {
              throw refusal('outOfRange');
            }
            if (near(fresh.current, target) && near(fresh.target, target)) {
              return { already: true };
            }
            return { target, done: (x) => near(x.current, target) };
          }
        : undefined,
    });
  }

  heatingMode(a) {
    const names =
      a.max - a.min > 1 && a.max - a.min < 5
        ? ['off', 'heat', 'eco', 'boost', 'manual']
        : ['off', 'heat', 'eco'];
    this.add(
      `a${a.id}`,
      this.nameOf('heatingMode', a),
      { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 },
      {
        attr: a.id,
        text: true,
        read: (x) => {
          if (!usable(x)) {
            return null;
          }
          const key = names[Math.round(x.current - x.min)];
          return { text: key ? label(`heating_${key}`, this.language) : String(round(x.current)) };
        },
      },
    );
  }

  // --- The box: its mode (home, sleeping, away, vacation) -----------------------------

  homeeMode(a) {
    this.add(
      `a${a.id}-state`,
      this.nameOf('homeeMode', a),
      { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 },
      {
        attr: a.id,
        text: true,
        read: (x) => {
          if (!usable(x)) {
            return null;
          }
          const key = HOMEE_MODES[Math.round(x.current)];
          return { text: key ? modeName(key, this.language) : String(round(x.current)) };
        },
      },
    );
    if (!a.editable) {
      return;
    }
    const options = HOMEE_MODES.map((key, index) => ({
      value: key,
      label: modeName(key, this.language),
      sort_order: index,
    }));
    this.add(
      `a${a.id}`,
      this.nameOf('homeeModeCommand', a),
      { category: C.TEXT, type: T.TEXT.SELECT, min: 0, max: 0, supported_options: options },
      {
        attr: a.id,
        text: true,
        read: (x) => {
          const key = usable(x) ? HOMEE_MODES[Math.round(x.current)] : undefined;
          return key ? { text: key } : null;
        },
        kind: 'alarm',
        plan: (fresh, value) => {
          const target = typeof value === 'string' ? HOMEE_MODES.indexOf(value) : -1;
          if (target < 0) {
            throw refusal('badValue');
          }
          if (
            !Number.isInteger(fresh.current) ||
            fresh.current < 0 ||
            fresh.current >= HOMEE_MODES.length
          ) {
            throw refusal('unknownState');
          }
          if (fresh.current === target) {
            return { already: true };
          }
          return { target, done: (x) => Math.round(x.current) === target };
        },
      },
    );
  }

  // --- Measurements ----------------------------------------------------------------

  measure(a, labelKey, spec, value = (x) => x.current) {
    this.add(`a${a.id}`, this.nameOf(labelKey, a), spec, {
      attr: a.id,
      read: (x) => {
        if (!usable(x)) {
          return null;
        }
        const v = value(x);
        if (v === undefined || !Number.isFinite(v)) {
          return null;
        }
        if (spec.type === T.BATTERY.INTEGER || spec.type === T.UV_SENSOR.INTEGER) {
          return { state: clamp(Math.round(v), spec.min, spec.max) };
        }
        return { state: round(v, 3) };
      },
      throttle: true,
    });
  }

  power(a) {
    if (!POWER_UNITS[a.unit.toLowerCase()]) {
      return;
    }
    const spec = this.hasSwitch
      ? sensor(C.SWITCH, T.SWITCH.POWER, 0, 1e9, U.WATT)
      : sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, -1e9, 1e9, U.WATT);
    this.measure(
      a,
      a.type === ATTR.TOTAL_CURRENT_ENERGY_USE ? 'totalPower' : 'power',
      spec,
      (x) => {
        const factor = POWER_UNITS[x.unit.toLowerCase()];
        return factor ? x.current * factor : undefined;
      },
    );
  }

  energy(a) {
    if (!ENERGY_UNITS[a.unit.toLowerCase()]) {
      return;
    }
    const kwh = (x) => {
      const factor = ENERGY_UNITS[x.unit.toLowerCase()];
      return factor ? round(x.current * factor, 4) : undefined;
    };
    if (a.type === ATTR.TOTAL_ACCUMULATED_ENERGY_USE) {
      // The total of a meter that may also count the plugs paired to the box:
      // as an index it would bill their energy twice. A plain value.
      this.measure(a, 'totalEnergy', sensor(C.UNKNOWN, T.SENSOR.DECIMAL, 0, 1e12, undefined), kwh);
      return;
    }
    // A cumulative meter, what the core bills: through the IndexGuard (src/guard.js, src/app.js).
    const spec = this.hasSwitch
      ? sensor(C.SWITCH, T.SWITCH.ENERGY, 0, 1e12, U.KILOWATT_HOUR)
      : sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, 0, 1e12, U.KILOWATT_HOUR);
    const key = `a${a.id}`;
    this.measure(a, 'energy', spec, kwh);
    const reader = this.readers.find((r) => r.key === key);
    if (reader) {
      reader.meter = true;
    }
  }

  electric(a, labelKey, type, unit, expected) {
    if (a.unit.toUpperCase() !== expected) {
      return;
    }
    this.measure(a, labelKey, sensor(C.ENERGY_SENSOR, type, 0, 100_000, unit));
  }

  // --- The node --------------------------------------------------------------------

  map() {
    const attributes = [...this.node.attributes.values()].sort((x, y) => x.id - y.id);
    const byType = (type) => attributes.filter((x) => x.type === type);
    // Switches first: power and energy go on the switch of a plug when it has one.
    for (const a of byType(ATTR.ON_OFF)) {
      this.onOff(a);
    }
    const openClose =
      byType(ATTR.UP_DOWN).length > 0 ? byType(ATTR.UP_DOWN) : byType(ATTR.OPEN_CLOSE);
    for (const a of attributes) {
      switch (a.type) {
        case ATTR.ON_OFF:
          break;
        case ATTR.DIMMING_LEVEL:
          if (this.kind !== 'cover' && this.kind !== 'door') {
            this.dimming(a);
          }
          break;
        case ATTR.COLOR:
          if (this.kind === 'light') {
            this.color(a);
          }
          break;
        case ATTR.COLOR_TEMPERATURE:
          if (this.kind === 'light') {
            this.colorTemperature(a);
          }
          break;
        case ATTR.UP_DOWN:
        case ATTR.OPEN_CLOSE:
          if (!openClose.includes(a)) {
            break;
          }
          if (this.kind === 'cover') {
            this.coverState(a);
          } else if (this.kind === 'door') {
            this.doorState(a);
          } else if (a.type === ATTR.OPEN_CLOSE && this.kind !== 'valve' && this.kind !== 'lock') {
            // (On a valve or a lock, OPEN_CLOSE is not a contact: left out.)
            // A contact: on (1) is open (Home Assistant's binary sensor).
            this.add(`a${a.id}`, this.nameOf('opening', a), binarySensor(C.OPENING_SENSOR), {
              attr: a.id,
              read: (x) =>
                usable(x)
                  ? {
                      state: x.current > 0 ? OPENING_SENSOR_STATE.OPEN : OPENING_SENSOR_STATE.CLOSE,
                    }
                  : null,
            });
          }
          break;
        case ATTR.WINDOW_POSITION:
          // 0 closed, 1 open, 2 tilted (reversed: 0 open, 1 closed).
          this.add(`a${a.id}`, this.nameOf('window', a), binarySensor(C.OPENING_SENSOR), {
            attr: a.id,
            read: (x) => {
              if (!usable(x)) {
                return null;
              }
              const closed = x.reversed ? 1 : 0;
              return {
                state:
                  Math.round(x.current) === closed
                    ? OPENING_SENSOR_STATE.CLOSE
                    : OPENING_SENSOR_STATE.OPEN,
              };
            },
          });
          break;
        case ATTR.POSITION:
          if (this.kind === 'cover') {
            this.coverPosition(a);
          }
          break;
        case ATTR.LOCK_STATE:
          this.lock(a);
          break;
        case ATTR.SIREN:
          this.siren(a);
          break;
        case ATTR.CURRENT_VALVE_POSITION:
          this.valvePosition(a);
          break;
        case ATTR.TARGET_TEMPERATURE:
          // The setpoint of a warm water circuit is hot water: capped like it.
          this.setpoint(a, { water: this.node.profile === P.WARM_WATER_CIRCUIT });
          break;
        case ATTR.WARM_WATER_TARGET_TEMPERATURE:
          this.setpoint(a, { water: true });
          break;
        case ATTR.HEATING_MODE:
          this.heatingMode(a);
          break;
        case ATTR.HOMEE_MODE:
          if (this.kind === 'box') {
            this.homeeMode(a);
          }
          break;
        case ATTR.CURRENT_ENERGY_USE:
        case ATTR.TOTAL_CURRENT_ENERGY_USE:
          this.power(a);
          break;
        case ATTR.ACCUMULATED_ENERGY_USE:
        case ATTR.TOTAL_ACCUMULATED_ENERGY_USE:
          this.energy(a);
          break;
        case ATTR.CURRENT:
        case ATTR.TOTAL_CURRENT:
          this.electric(
            a,
            a.type === ATTR.CURRENT ? 'current' : 'totalCurrent',
            T.ENERGY_SENSOR.CURRENT,
            U.AMPERE,
            'A',
          );
          break;
        case ATTR.VOLTAGE:
        case ATTR.TOTAL_VOLTAGE:
          this.electric(
            a,
            a.type === ATTR.VOLTAGE ? 'voltage' : 'totalVoltage',
            T.ENERGY_SENSOR.VOLTAGE,
            U.VOLT,
            'V',
          );
          break;
        case ATTR.BATTERY_LEVEL:
          this.measure(a, 'battery', sensor(C.BATTERY, T.BATTERY.INTEGER, 0, 100, U.PERCENT));
          break;
        case ATTR.BRIGHTNESS: {
          const factor = { lx: 1, lux: 1, klx: 1000 }[a.unit.toLowerCase()];
          if (factor) {
            this.measure(
              a,
              'illuminance',
              sensor(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, 0, 200_000, U.LUX),
              (x) => {
                const f = { lx: 1, lux: 1, klx: 1000 }[x.unit.toLowerCase()];
                return f ? x.current * f : undefined;
              },
            );
          }
          break;
        }
        case ATTR.DEVICE_TEMPERATURE: {
          const scale = scaleOf(a.unit);
          if (scale) {
            this.measure(
              a,
              'deviceTemperature',
              sensor(C.DEVICE_TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, -60, 150, U.CELSIUS),
              (x) => (scaleOf(x.unit) ? toCelsius(x.current, scaleOf(x.unit)) : undefined),
            );
          }
          break;
        }
        case ATTR.WIND_SPEED: {
          const unit = { 'm/s': U.METER_PER_SECOND, 'km/h': U.KILOMETER_PER_HOUR }[
            a.unit.toLowerCase()
          ];
          if (unit) {
            this.measure(
              a,
              'windSpeed',
              sensor(C.SPEED_SENSOR, T.SPEED_SENSOR.DECIMAL, 0, 500, unit),
              (x) => (x.unit.toLowerCase() === a.unit.toLowerCase() ? x.current : undefined),
            );
          }
          break;
        }
        case ATTR.RAIN_FALL_LAST_HOUR:
        case ATTR.RAIN_FALL_TODAY:
          if (a.unit.toLowerCase() === 'mm') {
            const hour = a.type === ATTR.RAIN_FALL_LAST_HOUR;
            this.measure(
              a,
              hour ? 'rainHour' : 'rainToday',
              sensor(
                C.PRECIPITATION_SENSOR,
                T.PRECIPITATION_SENSOR.DECIMAL,
                0,
                1000,
                hour ? U.MILLIMETER_PER_HOUR : U.MILLIMETER_PER_DAY,
              ),
              (x) => (x.unit.toLowerCase() === 'mm' ? x.current : undefined),
            );
          }
          break;
        default:
          if (IMPULSES.has(a.type) && a.editable) {
            this.impulse(a);
          } else if (TEMPERATURES[a.type]) {
            this.temperature(a, ...TEMPERATURES[a.type]);
          } else if (MEASURES[a.type]) {
            const [labelKey, spec, unit] = MEASURES[a.type];
            if (unit === null || a.unit.toLowerCase() === unit) {
              this.measure(a, labelKey, spec);
            }
          } else if (ALARMS[a.type]) {
            const [labelKey, spec] = ALARMS[a.type];
            this.add(`a${a.id}`, this.nameOf(labelKey, a), spec, {
              attr: a.id,
              read: (x) => (usable(x) ? { state: x.current > 0 ? 1 : 0 } : null),
            });
          }
      }
    }
    return {
      kind: this.kind,
      features: this.features,
      readers: this.readers,
      writers: this.writers,
      throttled: this.throttled,
    };
  }
}

const IMPULSE_LABELS = {
  [ATTR.IMPULSE]: 'impulse',
  [ATTR.OPEN_PARTIAL_IMPULSE]: 'openPartial',
  [ATTR.AUTOMATIC_MODE_IMPULSE]: 'automaticMode',
  [ATTR.BRIEFLY_OPEN_IMPULSE]: 'brieflyOpen',
  [ATTR.PERMANENTLY_OPEN_IMPULSE]: 'permanentlyOpen',
  [ATTR.VENTILATE_IMPULSE]: 'ventilate',
};

/**
 * One homee node -> features, readers, writers.
 * @param {object} node see src/nodes.js
 * @param {{ language?: 'fr'|'en' }} [options]
 */
export function mapNode(node, options) {
  return new NodeMapper(node, options).map();
}
