// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration), the homee protocol numbers and the tuning of the
// integration.
//
// The protocol numbers (node profiles, attribute types, port, paths, the
// fields of the token request) come from pyHomee 1.4.6 (MIT, Taraman17, see
// THIRD_PARTY_NOTICES.md), the library of the Home Assistant integration.
// -----------------------------------------------------------------------------

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
  ACCEPT_HELD: 'accept_held_index',
};

// --- Plausibility of the energy indexes (the values Gladys bills) -------------------
/** A homee meter or plug never draws more than this on average between two readings. */
export const INDEX_MAX_KW = 25;
/** kWh always accepted on top of INDEX_MAX_KW × hours (rounding, a late reading). */
export const INDEX_SLACK_KWH = 0.5;
/** Index guards kept in /data at most (one per index feature). */
export const INDEX_STATES_MAX = 1000;

/** Languages of the feature names (manifest `language` options). */
export const LANGUAGES = ['fr', 'en'];

/** Bounds of the number fields, mirrored by the manifest. */
export const SENSOR_INTERVAL = { min: 0, max: 300, default: 10 };
/** The hot water setpoint ceiling (°C): 55 by default, never above 60. */
export const WATER_HEATER_MAX = { min: 40, max: 60, default: 55 };

/** The local API of the box (pyHomee: `http://<host>:7681`, `ws://<host>:7681`). */
export const HOMEE = {
  port: 7681,
  tokenPath: '/access_token',
  /** The token travels in the query string: never log this URL. */
  socketPath: '/connection',
  subprotocol: 'v2',
  /** What the box shows in its list of connected devices. */
  deviceName: 'Gladys Assistant',
  /** Stable, so the box keeps one entry for Gladys instead of one per token. */
  hardwareId: 'gladys-assistant',
  /** pyHomee: DeviceOS.LINUX, DeviceType.NONE, DeviceApp.HOMEE. */
  deviceOs: 5,
  deviceType: 0,
  deviceApp: 1,
};

/** Node profiles (pyHomee const.NodeProfile) the mapping looks at. */
export const PROFILE = {
  HOMEE: 1,
  ON_OFF_PLUG: 10,
  DIMMABLE_METERING_SWITCH: 11,
  METERING_SWITCH: 12,
  METERING_PLUG: 13,
  ON_OFF_SWITCH: 16,
  DOUBLE_ON_OFF_SWITCH: 18,
  ON_OFF_SWITCH_WITH_BINARY_INPUT: 29,
  DOUBLE_METERING_SWITCH: 33,
  WIFI_METERING_SWITCH: 46,
  WIFI_ON_OFF_METERING_SWITCH: 47,
  WIFI_ON_OFF_SWITCH: 50,
  DIMMABLE_PLUG: 14,
  DIMMABLE_SWITCH: 15,
  DOUBLE_ON_OFF_PLUG: 28,
  DIMMABLE_METERING_PLUG: 19,
  DIMMABLE_COLOR_METERING_PLUG: 22,
  IMPULSE_PLUG: 42,
  IMPULSE_RELAY: 43,
  WIFI_ON_OFF_METERING_PLUG: 48,
  WIFI_ON_OFF_DIMMABLE_METERING_SWITCH: 49,
  DIMMABLE_COLOR_LIGHT: 1001,
  DIMMABLE_EXTENDED_COLOR_LIGHT: 1002,
  DIMMABLE_COLOR_TEMPERATURE_LIGHT: 1003,
  DIMMABLE_LIGHT: 1004,
  DIMMABLE_LIGHT_WITH_BRIGHTNESS_SENSOR: 1005,
  DIMMABLE_LIGHT_WITH_BRIGHTNESS_AND_PRESENCE_SENSOR: 1006,
  DIMMABLE_LIGHT_WITH_PRESENCE_SENSOR: 1007,
  DIMMABLE_RGBWLIGHT: 1008,
  WIFI_DIMMABLE_RGBWLIGHT: 1009,
  WIFI_DIMMABLE_LIGHT: 1010,
  SHUTTER_POSITION_SWITCH: 2002,
  ELECTRIC_MOTOR_METERING_SWITCH: 2004,
  ELECTRIC_MOTOR_METERING_SWITCH_WITHOUT_SLAT_POSITION: 2006,
  LOCK: 2007,
  ENTRANCE_GATE_OPERATOR: 2010,
  GARAGE_DOOR_OPERATOR: 2012,
  GATE_OPERATOR: 2013,
  INNER_DOOR_OPERATOR: 2014,
  GARAGE_DOOR_IMPULSE_OPERATOR: 2015,
  ENTRANCE_DOOR: 2016,
  WINDOW_MOTOR_SWITCH: 2017,
  WIFI_ELECTRIC_MOTOR_METERING_SWITCH: 2019,
  ROOM_THERMOSTAT: 3003,
  ROOM_THERMOSTAT_WITH_HUMIDITY_SENSOR: 3004,
  RADIATOR_THERMOSTAT: 3006,
  WATER_VALVE: 3011,
  COSI_THERM_CHANNEL: 3018,
  THERMOSTAT_WITH_HEATING_AND_COOLING: 3022,
  ELECTRICAL_HEATING: 3024,
  VALVE_DRIVE: 3025,
  HEATING_SYSTEM: 3028,
  WARM_WATER_CIRCUIT: 3029,
  HEATING_CIRCUIT: 3030,
  WIFI_ROOM_THERMOSTAT: 3032,
  WIFI_RADIATOR_THERMOSTAT: 3033,
  SIREN: 4027,
  SMOKE_DETECTOR_AND_SIREN: 4031,
};

/** Attribute types (pyHomee const.AttributeType) the mapping reads. */
export const ATTR = {
  ON_OFF: 1,
  DIMMING_LEVEL: 2,
  CURRENT_ENERGY_USE: 3,
  ACCUMULATED_ENERGY_USE: 4,
  TEMPERATURE: 5,
  TARGET_TEMPERATURE: 6,
  RELATIVE_HUMIDITY: 7,
  BATTERY_LEVEL: 8,
  WINDOW_POSITION: 10,
  BRIGHTNESS: 11,
  FLOOD_ALARM: 12,
  SIREN: 13,
  OPEN_CLOSE: 14,
  POSITION: 15,
  SMOKE_ALARM: 16,
  CURRENT_VALVE_POSITION: 18,
  CO2LEVEL: 20,
  COLOR: 23,
  MOTION_ALARM: 25,
  TAMPER_ALARM: 30,
  WARM_WATER_TEMPERATURE: 31,
  WARM_WATER_TARGET_TEMPERATURE: 32,
  COLOR_TEMPERATURE: 42,
  TOTAL_VOLTAGE: 51,
  LEAK_ALARM: 68,
  BATTERY_LOW_ALARM: 69,
  PRESENCE_ALARM: 76,
  WATER_ALARM: 80,
  FEED_TEMPERATURE: 89,
  DEVICE_TEMPERATURE: 92,
  OUTDOOR_RELATIVE_HUMIDITY: 95,
  INDOOR_RELATIVE_HUMIDITY: 96,
  OUTDOOR_TEMPERATURE: 97,
  INDOOR_TEMPERATURE: 98,
  COALARM: 132,
  UP_DOWN: 135,
  WIND_SPEED: 146,
  RAIN_FALL_LAST_HOUR: 168,
  RAIN_FALL_TODAY: 169,
  UV: 173,
  CURRENT: 193,
  VOLTAGE: 195,
  HOMEE_MODE: 205,
  LOCK_STATE: 232,
  TOTAL_CURRENT_ENERGY_USE: 239,
  TOTAL_ACCUMULATED_ENERGY_USE: 240,
  HEATING_MODE: 258,
  TOTAL_CURRENT: 272,
  IMPULSE: 304,
  OPEN_PARTIAL_IMPULSE: 306,
  EXTERNAL_TEMPERATURE: 315,
  FLOOR_TEMPERATURE: 316,
  AUTOMATIC_MODE_IMPULSE: 326,
  BRIEFLY_OPEN_IMPULSE: 327,
  PERMANENTLY_OPEN_IMPULSE: 328,
  VENTILATE_IMPULSE: 378,
};

/** Node states (pyHomee const.NodeState): only AVAILABLE is reachable. */
export const NODE_STATE = { AVAILABLE: 1 };
/** Attribute states from this one on are unavailable (Home Assistant's rule). */
export const FIRST_UNAVAILABLE_ATTRIBUTE_STATE = 5;
/** Warning codes (pyHomee const.WarningCode): while learning, the box sends incomplete nodes. */
export const WARNING = { LEARN_MODE_STARTED: 104, LEARN_MODE_SUCCESSFUL: 105 };

/** The homee modes (pyHomee const.HomeeMode), in the order of their values. */
export const HOMEE_MODES = ['home', 'sleeping', 'away', 'vacation'];

/** Gladys value of a pressed button feature (core BUTTON_PUSH.PRESSED). */
export const BUTTON_PUSH = { PRESSED: 1 };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin for the other paths. */
  statesPerMinute: 250,
  /** One websocket message (bytes): the "all" dump of a big install is a few MB. */
  messageBytes: 16 * 1024 * 1024,
  /** The answer of the token request (bytes): a few hundred in practice. */
  tokenBytes: 8 * 1024,
  /** Nodes and attributes read (a box holds a few hundred nodes at most). */
  nodes: 2000,
  attributesPerNode: 400,
  /** Devices published at once (publishDiscoveredDevices). */
  devices: 2000,
  /** Characters of a transport badge message (SDK limit). */
  badgeMessage: 200,
};

export const TIMINGS = {
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
  /** The token request. */
  tokenTimeout: 10_000,
  /** Opening the websocket. */
  socketTimeout: 10_000,
  /** The answer to GET:all (the whole box). */
  allTimeout: 30_000,
  /** The whole box is read again this often (missed messages, renames, new nodes). */
  resync: 10 * 60_000,
  /** Reconnection after a lost socket or a failure: this delay, doubled up to the max. */
  retryMin: 5000,
  retryMax: 5 * 60_000,
  /** A token younger than this that the socket refuses is not renewed at once (no loop). */
  tokenFresh: 2 * 60_000,
  /** A token is renewed before its end by this margin. */
  tokenMargin: 60 * 60_000,
  /** Refused credentials: tried again after this delay, doubled up to the max. */
  authRetryMin: 60 * 60_000,
  authRetryMax: 24 * 60 * 60_000,
  /** Bounds of the pause after a 429 (Retry-After, or the minimum without it). */
  rateLimitMin: 60_000,
  rateLimitMax: 6 * 60 * 60_000,
  /** A burst of node messages (learn mode): wait for it to end before publishing. */
  modelDebounce: 2000,
  /**
   * Gladys acks a set_value within 5 s: a command not sent within 3.5 s of
   * its arrival is refused, never sent late.
   */
  setValueDeadline: 3500,
  /** After the deadline, the echo of a sensitive command is awaited this long more. */
  echoSlack: 900,
  /** A read back of an attribute after a sensitive command (ms after it). */
  readBacks: [3000, 15_000],
  /**
   * After a lock, door, gate or valve command, the state asked for is awaited
   * this long (never blocking another command): not reported in time, the
   * badge says "state not confirmed" until the device reports a state.
   */
  confirm: { lock: 30_000, door: 90_000, valve: 60_000 },
  /** Two presses of an impulse closer than this are one (a bounce): the second is refused. */
  impulseDebounce: 2000,
  /** A read that came too late: no fresh read of that attribute is trusted for this long. */
  quarantine: 5000,
  /** A TCP probe telling a refused token from a network failure of the websocket. */
  probeTimeout: 3000,
};
