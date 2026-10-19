// -----------------------------------------------------------------------------
// The integration: one homee box, its nodes turned into Gladys devices, the
// websocket feeding the states, and the commands sent back. index.js only
// wires the SDK handlers to it.
//
// Lifecycle: start -> a token (src/homee.js, kept in memory only, renewed
// before its end, never in a loop) -> the websocket (src/live.js) -> GET:all
// (the whole box) -> every change comes as a message; GET:all again every
// 10 minutes, which also proves the socket alive (no answer in 30 s: the
// socket is opened again). A lost socket is opened again after a growing
// delay (5 s doubling to 5 min). Refused credentials stop the integration:
// persisted in /data, tried again after 1 h, doubling to 24 h, or at once by
// the test button or a new configuration. A 429 pauses every path,
// persisted in /data.
//
// Commands: one at a time per node, sent within 3.5 s of their arrival or
// refused. The sensitive ones (plugs, heating, locks, doors and gates,
// valves, sirens, the homee mode) only when their option is on, decided on
// the attribute read just before, the option checked again just before the
// request, then the echo of the box awaited ("sent, without confirmation"
// when it does not come). Locks, doors and valves are then guarded until they
// report the state asked for.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { OPTION_OF_KIND, normalizeConfig } from './config.js';
import { HOMEE, NODE_STATE, TIMINGS, WARNING } from './constants.js';
import { buildModel, emptyModel } from './devices.js';
import { HomeeError, requestToken } from './homee.js';
import { LiveError, openSocket } from './live.js';
import { T, word } from './i18n.js';
import { usable } from './mapping.js';
import { attributeOf, mergeNode, nodeOf, nodesOf, settingsOf, withAttribute } from './nodes.js';
import { StatePublisher } from './publisher.js';
import { StateStore } from './store.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const credentialsOf = (c) => JSON.stringify([c.host, c.username, c.password]);

/** A number for a PUT: no exponent, at most 4 decimals. */
export const formatNumber = (n) => String(Number(Number(n).toFixed(4)));

/** The refusal key of a sensitive kind whose option is off. */
const OFF_REFUSAL = {
  plug: 'plugOff',
  heating: 'heatingOff',
  lock: 'lockOff',
  door: 'doorOff',
  valve: 'valveOff',
  siren: 'sirenOff',
  alarm: 'alarmOff',
};

export class HomeeApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'homee' }),
    token = requestToken,
    live = openSocket,
    WebSocket = globalThis.WebSocket,
    now = Date.now,
    timers = globalThis,
    store,
    // The box always listens on 7681; the end-to-end tests use another port.
    port = HOMEE.port,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.port = port;
    this.requestToken = (options) => token({ ...options, port: this.port });
    this.openLive = (options) => live({ ...options, port: this.port });
    this.WebSocket = WebSocket;
    this.now = now;
    this.timers = timers;
    this.store = store ?? new StateStore({ now, logger });
    this.raw = {};
    this.config = normalizeConfig();
    /** { value, expiresAt, at } in memory only; never logged */
    this.token = undefined;
    this.session = null;
    /** node id -> node (replaced, never mutated) */
    this.nodes = new Map();
    this.box = undefined;
    this.model = emptyModel();
    /** messages are numbered: a full read keeps the attributes changed after it was asked */
    this.seq = 0;
    this.online = false;
    this.running = false;
    this.learning = false;
    this.blocked = undefined;
    this.failures = 0;
    this.lastError = undefined;
    this.generation = 0;
    this.timer = undefined;
    this.resyncTimer = undefined;
    this.modelTimer = undefined;
    this.readBackTimers = new Set();
    /** the pending GET:all: { resolve, reject, timer, since } */
    this.allWaiter = undefined;
    /** "<node>:<attribute>" -> Set of callbacks (attribute) => consumed? */
    this.waiters = new Map();
    /** node id -> the tail of its command chain */
    this.chains = new Map();
    /** node id -> { attr, done, moving, start, sawMoving, until, timer, impulse } */
    this.guards = new Map();
    this.unconfirmed = new Set();
    /** feature id -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** device id -> last badge published (JSON) */
    this.transports = new Map();
    /** meter feature id -> { value, at, low?, jump?, jumpAt? } (energy index rules) */
    this.meters = new Map();
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.warned = new Set();
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    const previous = this.config;
    this.raw = { ...(raw ?? {}) };
    this.config = normalizeConfig(raw);
    if (credentialsOf(previous) !== credentialsOf(this.config)) {
      this.token = undefined;
    }
    this.refreshCreated();
    // Gladys keeps the status, the Discovery and the badges in memory only.
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.transports.clear();
    this.blocked = undefined;
    if (this.config.error) {
      await this.setStatus(false, T.configError(this.config.error));
      return;
    }
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: this.model.throttled,
    });
    this.running = true;
    this.publisher.start();
    const refusal = this.store.refusalOf(this.config);
    if (refusal) {
      // Refused before (maybe before a restart): tried again only when due.
      this.blocked = refusal;
      const wait = Math.max(0, refusal.retryAt - this.now());
      await this.setStatus(false, T.refused(wait));
      this.schedule(generation, wait, () => this.open(generation));
      return;
    }
    const paused = this.store.pausedUntil - this.now();
    if (paused > 0) {
      // A 429 pause outlives a restart: wait for its end.
      await this.setStatus(false, T.failure({ kind: 'rate' }));
      this.schedule(generation, paused, () => this.open(generation));
      return;
    }
    await this.setStatus(false, T.connecting);
    await this.open(generation);
  }

  /**
   * Gladys (re)connected: the same configuration keeps everything (token,
   * socket, 429 pause, refused credentials) and publishes again what Gladys
   * keeps in memory only (status, Discovery, badges); another one starts again.
   */
  async resume(raw = {}) {
    if (!this.running || !sameConfig(normalizeConfig(raw), this.config)) {
      await this.start(raw);
      return;
    }
    this.raw = { ...(raw ?? {}) };
    this.refreshCreated();
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.transports.clear();
    if (this.online) {
      await this.rebuild();
      await this.connectedStatus();
    } else if (this.blocked) {
      await this.setStatus(false, T.refused(Math.max(0, this.blocked.retryAt - this.now())));
    } else {
      await this.setStatus(false, this.lastError ? T.failure(this.lastError) : T.connecting);
    }
    await this.publishAllTransports();
  }

  /** The configuration was saved by the user: one try at once, even after a refusal. */
  async configUpdated(raw = {}) {
    this.logger.info('Configuration updated: reconnecting to the homee');
    this.store.clearRefusal();
    await this.start(raw);
  }

  stop() {
    this.generation += 1;
    this.running = false;
    for (const timer of [this.timer, this.resyncTimer, this.modelTimer, ...this.readBackTimers]) {
      this.timers.clearTimeout(timer);
    }
    for (const guard of this.guards.values()) {
      this.timers.clearTimeout(guard.timer);
    }
    this.guards.clear();
    this.readBackTimers.clear();
    this.timer = undefined;
    this.resyncTimer = undefined;
    this.modelTimer = undefined;
    this.publisher.stop();
    this.closeSession();
    this.online = false;
    this.failures = 0;
  }

  current(generation) {
    return generation === this.generation;
  }

  paused() {
    return this.now() < this.store.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async connectedStatus() {
    await this.setStatus(true, T.connected(this.model.devices.length, this.box?.name ?? 'homee'));
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /** Runs `fn` after `ms` on the main timer, unless the app was restarted or stopped meanwhile. */
  schedule(generation, ms, fn) {
    this.timers.clearTimeout(this.timer);
    // setTimeout holds at most 2^31 - 1 ms (24.8 days).
    const delay = clamp(ms, 0, 2_147_000_000);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.current(generation)) {
        fn().catch((err) => this.logger.error(`homee loop: ${err.message}`));
      }
    }, delay);
  }

  /** A promise not awaited: its failure is logged. */
  background(promise) {
    promise?.catch?.((err) => this.logger.warn(err.message));
  }

  // --- Connection ----------------------------------------------------------------

  /** The token in memory, or a new one when missing or near its end. */
  async ensureToken() {
    const token = this.token;
    if (token && token.expiresAt - TIMINGS.tokenMargin > this.now()) {
      return token.value;
    }
    const { host, username, password } = this.config;
    const answer = await this.requestToken({ host, username, password });
    this.token = {
      value: answer.token,
      expiresAt: this.now() + answer.expiresIn * 1000,
      at: this.now(),
    };
    this.store.clearRefusal();
    this.blocked = undefined;
    return answer.token;
  }

  async open(generation) {
    try {
      this.closeSession();
      const token = await this.ensureToken();
      if (!this.current(generation)) {
        return;
      }
      const session = await this.openLive({
        host: this.config.host,
        token,
        WebSocket: this.WebSocket,
        timers: this.timers,
        onMessage: (message) => {
          if (this.current(generation)) {
            this.onMessage(generation, message);
          }
        },
        onClose: (reason) => {
          if (this.current(generation) && this.session === session) {
            this.session = null;
            this.background(this.fail(generation, new LiveError('closed', reason)));
          }
        },
      });
      if (!this.current(generation)) {
        session.close();
        return;
      }
      this.session = session;
      await this.readAll(generation);
      if (!this.current(generation)) {
        return;
      }
      this.online = true;
      this.failures = 0;
      this.lastError = undefined;
      this.logger.info(
        `Connected to the homee at ${this.config.host}: ${this.model.devices.length} devices offered`,
      );
      await this.connectedStatus();
      await this.publishAllTransports();
      this.scheduleResync(generation);
    } catch (err) {
      await this.fail(generation, err);
    }
  }

  /** Asks the whole box (GET:all); resolves when it came. */
  readAll(generation) {
    return new Promise((resolve, reject) => {
      const session = this.session;
      if (!session) {
        reject(new LiveError('closed', 'no websocket'));
        return;
      }
      this.rejectAll();
      const waiter = { resolve, reject, since: this.seq, generation };
      waiter.timer = this.timers.setTimeout(() => {
        if (this.allWaiter === waiter) {
          this.allWaiter = undefined;
          reject(new LiveError('timeout', 'no answer of the box within 30 s'));
        }
      }, TIMINGS.allTimeout);
      this.allWaiter = waiter;
      if (!session.send('GET:all')) {
        this.allWaiter = undefined;
        this.timers.clearTimeout(waiter.timer);
        reject(new LiveError('closed', 'the websocket is closed'));
      }
    });
  }

  rejectAll() {
    const waiter = this.allWaiter;
    if (waiter) {
      this.allWaiter = undefined;
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new LiveError('closed', 'superseded'));
    }
  }

  scheduleResync(generation) {
    this.timers.clearTimeout(this.resyncTimer);
    this.resyncTimer = this.timers.setTimeout(async () => {
      this.resyncTimer = undefined;
      if (!this.current(generation) || !this.online) {
        return;
      }
      try {
        await this.readAll(generation);
        await this.connectedStatus();
        this.scheduleResync(generation);
      } catch (err) {
        // No answer: the socket is deaf, open it again.
        await this.fail(generation, err);
      }
    }, TIMINGS.resync);
  }

  closeSession() {
    const session = this.session;
    this.session = null;
    session?.close();
    this.rejectAll();
    for (const set of this.waiters.values()) {
      for (const fn of set) {
        fn(undefined);
      }
    }
    this.waiters.clear();
  }

  /** The delay before the next try after `err` (never called for refused credentials). */
  retryDelay(err) {
    if (err?.kind === 'rate') {
      return clamp(
        err.retryAfter ?? TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMin,
        TIMINGS.rateLimitMax,
      );
    }
    return Math.min(TIMINGS.retryMax, TIMINGS.retryMin * 2 ** Math.max(0, this.failures - 1));
  }

  async fail(generation, err) {
    if (!this.current(generation)) {
      return;
    }
    this.online = false;
    this.closeSession();
    this.timers.clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
    this.lastError = err;
    if (err instanceof HomeeError && err.kind === 'auth') {
      // Never tried again in a loop: stopped, persisted, tried again later.
      this.token = undefined;
      this.blocked = this.store.refuse(this.config, err.message);
      const wait = Math.max(0, this.blocked.retryAt - this.now());
      this.logger.warn(
        `homee: ${err.message}; next try in ${Math.round(wait / 60_000)} min (or the test button)`,
      );
      await this.setStatus(false, T.refused(wait));
      await this.publishAllTransports();
      this.schedule(generation, wait, () => this.open(generation));
      return;
    }
    if (
      err instanceof LiveError &&
      err.kind === 'refused' &&
      this.token &&
      this.now() - this.token.at > TIMINGS.tokenFresh
    ) {
      // The socket refused a token that is not new: one new token at the next
      // try (a new token refused too only waits for the growing delay).
      this.token = undefined;
    }
    this.failures += 1;
    const delay = this.retryDelay(err);
    if (err?.kind === 'rate') {
      this.store.pauseUntil(this.now() + delay);
    }
    if (err instanceof HomeeError || err instanceof LiveError) {
      this.logger.warn(`homee: ${err.message} (retrying in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error(`homee: unexpected failure (${err?.name ?? 'error'})`);
    }
    await this.setStatus(false, T.failure(err));
    await this.publishAllTransports();
    this.schedule(generation, delay, () => this.open(generation));
  }

  // --- Messages of the box ---------------------------------------------------------

  onMessage(generation, { kind, body }) {
    switch (kind) {
      case 'all':
        this.background(this.onAll(generation, body));
        break;
      case 'attribute':
        this.onAttribute(generation, body);
        break;
      case 'node':
        // While learning, the box sends incomplete nodes (pyHomee).
        if (!this.learning) {
          this.onNode(generation, body);
        }
        break;
      case 'nodes':
        if (Array.isArray(body)) {
          for (const raw of body) {
            this.onNode(generation, raw);
          }
        }
        break;
      case 'warning': {
        const code = Number(body?.code);
        if (code === WARNING.LEARN_MODE_STARTED) {
          this.learning = true;
        } else if (code === WARNING.LEARN_MODE_SUCCESSFUL) {
          this.learning = false;
          // A node was paired: read the whole box again.
          if (this.online) {
            this.background(this.readAll(generation).catch(() => {}));
          }
        } else if (Number.isFinite(code)) {
          this.learning = false;
        }
        break;
      }
      default:
        // groups, users, homeegrams, relationships, plans…: not used.
        break;
    }
  }

  async onAll(generation, body) {
    const waiter = this.allWaiter;
    const settings = settingsOf(body?.settings);
    if (!settings.uid) {
      if (waiter) {
        this.allWaiter = undefined;
        this.timers.clearTimeout(waiter.timer);
        waiter.reject(new HomeeError('format', 'the box did not give its id'));
      }
      return;
    }
    if (this.box?.uid && this.box.uid !== settings.uid) {
      // Another box at this address: forget the nodes of the previous one.
      this.logger.warn(
        'Another homee answers at this address: its nodes replace the previous ones',
      );
      this.nodes = new Map();
      this.meters.clear();
    }
    this.box = settings;
    const since = waiter?.since ?? this.seq;
    const fresh = nodesOf(body?.nodes, 0);
    const merged = new Map();
    for (const [id, node] of fresh) {
      merged.set(id, mergeNode(this.nodes.get(id), node, since));
    }
    this.nodes = merged;
    await this.rebuild();
    if (!this.current(generation)) {
      return;
    }
    for (const node of this.nodes.values()) {
      this.applyNode(node);
    }
    if (waiter && this.allWaiter === waiter) {
      this.allWaiter = undefined;
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  onAttribute(generation, body) {
    this.seq += 1;
    const attribute = attributeOf(body, this.seq);
    if (!attribute) {
      return;
    }
    const node = this.nodes.get(attribute.nodeId);
    if (!node) {
      return;
    }
    if (!node.attributes.has(attribute.id)) {
      this.scheduleModel(generation);
    }
    this.nodes.set(node.id, withAttribute(node, attribute));
    this.applyAttribute(node.id, attribute);
    this.checkGuard(node.id, attribute);
    this.notify(node.id, attribute);
  }

  onNode(generation, raw) {
    this.seq += 1;
    const node = nodeOf(raw, this.seq);
    if (!node || node.attributes.size === 0) {
      return;
    }
    const known = this.nodes.get(node.id);
    const shape = (n) => JSON.stringify([n.name, n.profile, [...n.attributes.keys()].sort()]);
    this.nodes.set(node.id, node);
    if (!known || shape(known) !== shape(node)) {
      this.scheduleModel(generation);
    }
    this.applyNode(node);
    for (const attribute of node.attributes.values()) {
      this.checkGuard(node.id, attribute);
      this.notify(node.id, attribute);
    }
  }

  /** Callbacks waiting for an attribute (fresh reads, echoes of commands). */
  notify(nodeId, attribute) {
    const set = this.waiters.get(`${nodeId}:${attribute.id}`);
    if (!set) {
      return;
    }
    for (const fn of [...set]) {
      fn(attribute);
    }
  }

  wait(nodeId, attrId, fn) {
    const key = `${nodeId}:${attrId}`;
    const set = this.waiters.get(key) ?? new Set();
    set.add(fn);
    this.waiters.set(key, set);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.waiters.get(key) === set) {
        this.waiters.delete(key);
      }
    };
  }

  /** The model from the nodes; published when it changed. */
  async rebuild({ force = false } = {}) {
    if (!this.box?.uid) {
      return;
    }
    const model = buildModel((id) => this.idsOf(id), this.nodes.values(), this.box, {
      language: this.config.language,
      created: this.gladys.devices ?? [],
    });
    this.model = model;
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: model.throttled,
    });
    const json = JSON.stringify(model.devices);
    if (force || json !== this.publishedDevices) {
      try {
        await this.gladys.publishDiscoveredDevices(model.devices);
        this.publishedDevices = json;
        this.logger.info(
          `${model.devices.length} devices offered in Discovery (${model.counts.nodes} nodes)`,
        );
      } catch (err) {
        this.logger.error(`Publishing the discovered devices failed: ${err.message}`);
      }
    }
  }

  /** The model again after a burst of changes (a node paired, renamed…). */
  scheduleModel(generation) {
    this.timers.clearTimeout(this.modelTimer);
    this.modelTimer = this.timers.setTimeout(() => {
      this.modelTimer = undefined;
      if (this.current(generation) && this.online) {
        this.background(
          this.rebuild().then(() => {
            for (const node of this.nodes.values()) {
              this.applyNode(node);
            }
          }),
        );
      }
    }, TIMINGS.modelDebounce);
  }

  applyNode(node) {
    for (const attribute of node.attributes.values()) {
      this.applyAttribute(node.id, attribute);
    }
    this.publishTransportOf(node.id);
  }

  /** One attribute: its value to the features that read it. */
  applyAttribute(nodeId, attribute) {
    for (const reader of this.model.readers.get(`${nodeId}:${attribute.id}`) ?? []) {
      let value;
      try {
        value = reader.read(attribute);
      } catch (err) {
        this.warnOnce(`read:${reader.featureId}`, `${reader.featureId}: ${err.message}`);
        continue;
      }
      if (value && (!reader.meter || this.meterOk(reader.featureId, value.state))) {
        this.record(reader.featureId, value);
      }
    }
  }

  /**
   * Energy index rules (the core counts every rise): a lower reading, 0
   * included, is held, and taken only when a later reading is strictly above
   * the low value held (the meter was reset and counts again). A jump higher
   * than a plausible consumption is held too, and taken only when a later
   * reading goes on from it plausibly: repeating it is not enough.
   */
  meterOk(featureId, state) {
    const now = this.now();
    const last = this.meters.get(featureId);
    if (!last) {
      this.meters.set(featureId, { value: state, at: now });
      return true;
    }
    // At most 25 kW since the last reading, plus 1 kWh of rounding.
    const plausible = (at) => 1 + 25 * ((now - at) / 3_600_000);
    if (state < last.value) {
      if (last.low !== undefined && state > last.low) {
        this.meters.set(featureId, { value: state, at: now });
        return true;
      }
      last.low = state;
      this.warnOnce(`drop:${featureId}`, `${featureId}: energy index went down, held`);
      return false;
    }
    last.low = undefined;
    if (state - last.value > plausible(last.at)) {
      if (
        last.jump !== undefined &&
        state > last.jump &&
        state - last.jump <= plausible(last.jumpAt)
      ) {
        this.meters.set(featureId, { value: state, at: now });
        return true;
      }
      if (last.jump === undefined || state !== last.jump) {
        last.jump = state;
        last.jumpAt = now;
      }
      this.warnOnce(`jump:${featureId}`, `${featureId}: energy index jumped, held`);
      return false;
    }
    this.meters.set(featureId, { value: state, at: now });
    return true;
  }

  /** Keeps the value, and sends it when the device exists in Gladys. */
  record(featureId, value) {
    this.lastValues.set(featureId, value);
    if (this.created.has(featureId)) {
      this.publisher.push(featureId, value);
    }
  }

  // --- Inventory -----------------------------------------------------------------

  idsOf(platformId) {
    return this.gladys.externalIds('homee', platformId);
  }

  /** The Scan button of the Discovery tab: the whole box again (never during a 429 pause). */
  async rescan() {
    if (!this.online || !this.session || this.paused()) {
      await this.gladys.publishDiscoveredDevices(this.model.devices);
      return;
    }
    await this.readAll(this.generation);
    await this.rebuild({ force: true });
  }

  // --- Transport badges ----------------------------------------------------------

  transportOf(deviceId) {
    if (!this.online) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    const nodeId = this.model.deviceIds.get(deviceId);
    const node = this.nodes.get(nodeId);
    if (node && node.id !== -1 && node.state !== NODE_STATE.AVAILABLE) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.badge.offline };
    }
    if (this.unconfirmed.has(nodeId)) {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.unconfirmed };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  publishTransportOf(nodeId) {
    const deviceId = this.model.nodeDevices.get(nodeId);
    if (deviceId) {
      this.background(this.publishTransport(deviceId));
    }
  }

  async publishTransport(deviceId) {
    if (!this.createdDevices().has(deviceId)) {
      return;
    }
    const badge = this.transportOf(deviceId);
    const key = JSON.stringify(badge);
    if (this.transports.get(deviceId) === key) {
      return;
    }
    this.transports.set(deviceId, key);
    await this.gladys.publishTransports([{ external_id: deviceId, ...badge }]);
  }

  async publishAllTransports() {
    const entries = [];
    for (const deviceId of this.createdDevices()) {
      const badge = this.transportOf(deviceId);
      const key = JSON.stringify(badge);
      if (this.transports.get(deviceId) !== key) {
        this.transports.set(deviceId, key);
        entries.push({ external_id: deviceId, ...badge });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  // --- Devices created by the user -------------------------------------------------

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const f of device?.features ?? []) {
      const value = this.lastValues.get(f.external_id);
      if (value) {
        this.publisher.push(f.external_id, value);
      }
    }
    if (device?.external_id) {
      await this.publishTransport(device.external_id).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  // --- Commands ------------------------------------------------------------------

  denied(key) {
    const err = new Error(word(T.denied[key], this.config.language));
    err.refusal = key;
    err.localized = true;
    return err;
  }

  /** Runs `task` after the previous task of the same key (a promise chain per key). */
  serialized(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });
    return run;
  }

  /** Refuses a sensitive command whose option is off. */
  checkAllowed(kind) {
    if (kind && !this.config[OPTION_OF_KIND[kind]]) {
      throw this.denied(OFF_REFUSAL[kind] ?? 'notCommand');
    }
  }

  /** Refuses a guarded command while the previous one is not confirmed. */
  checkNotGuarded(nodeId) {
    const guard = this.guards.get(nodeId);
    if (guard && this.now() < guard.until) {
      throw this.denied('busy');
    }
  }

  /** Reads one attribute just now (GET), or refuses: never the value in memory. */
  readFresh(nodeId, attrId, deadline) {
    return new Promise((resolve, reject) => {
      const session = this.session;
      if (!session) {
        reject(this.denied('notConnected'));
        return;
      }
      let release = () => {};
      const timer = this.timers.setTimeout(
        () => {
          release();
          reject(this.denied('unknownState'));
        },
        Math.max(0, deadline - this.now() - 300),
      );
      release = this.wait(nodeId, attrId, (attribute) => {
        release();
        this.timers.clearTimeout(timer);
        if (attribute) {
          resolve(attribute);
        } else {
          reject(this.denied('notConnected'));
        }
      });
      if (!session.send(`GET:nodes/${nodeId}/attributes/${attrId}`)) {
        release();
        this.timers.clearTimeout(timer);
        reject(this.denied('notConnected'));
      }
    });
  }

  /** Waits for the box to echo the target asked for, until `until`: true when it did. */
  waitEcho(nodeId, attrId, target, until) {
    return new Promise((resolve) => {
      let release = () => {};
      const timer = this.timers.setTimeout(
        () => {
          release();
          resolve(false);
        },
        Math.max(0, until - this.now()),
      );
      release = this.wait(nodeId, attrId, (attribute) => {
        if (!attribute) {
          release();
          this.timers.clearTimeout(timer);
          resolve(false);
          return;
        }
        if (near(attribute.target, target) || near(attribute.current, target)) {
          release();
          this.timers.clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  /** After a lock, door or valve command: no other one until it reports the state asked for. */
  setGuard(nodeId, writer, plan) {
    const previous = this.guards.get(nodeId);
    this.timers.clearTimeout(previous?.timer);
    const span = plan.impulse ? TIMINGS.guard.impulse : TIMINGS.guard[writer.guard];
    const guard = {
      attr: writer.attr,
      done: plan.done,
      moving: plan.moving,
      start: plan.start,
      sawMoving: false,
      impulse: plan.impulse === true,
      until: this.now() + span,
    };
    guard.timer = this.timers.setTimeout(() => {
      if (this.guards.get(nodeId) === guard) {
        this.guards.delete(nodeId);
        if (!guard.impulse) {
          // Never confirmed in time: told on the badge until a read shows a state.
          this.logger.warn(`Node ${nodeId}: the state asked for was not reported in time`);
          this.unconfirmed.add(nodeId);
          this.publishTransportOf(nodeId);
        }
      }
    }, span);
    this.guards.set(nodeId, guard);
  }

  /**
   * A new value of a guarded attribute: a move is noted; the guard is lifted
   * only on the state asked for, and on the state it started from only after
   * a move was seen (a late report never lifts it); never on an unknown value.
   */
  checkGuard(nodeId, attribute) {
    const guard = this.guards.get(nodeId);
    if (!guard || guard.impulse || attribute.id !== guard.attr || !usable(attribute)) {
      return;
    }
    if (guard.moving?.(attribute)) {
      guard.sawMoving = true;
      return;
    }
    if (guard.done(attribute) && (!near(attribute.current, guard.start) || guard.sawMoving)) {
      this.timers.clearTimeout(guard.timer);
      this.guards.delete(nodeId);
      if (this.unconfirmed.delete(nodeId)) {
        this.publishTransportOf(nodeId);
      }
    }
  }

  /** Reads an attribute back later, after a sensitive command. */
  readBack(nodeId, attrId, delay) {
    const generation = this.generation;
    const timer = this.timers.setTimeout(() => {
      this.readBackTimers.delete(timer);
      if (this.current(generation) && this.online && this.session && !this.paused()) {
        this.session.send(`GET:nodes/${nodeId}/attributes/${attrId}`);
      }
    }, delay);
    this.readBackTimers.add(timer);
  }

  /** Gladys command (acked within 5 s): sent within 3.5 s of its arrival, or refused. */
  async setValue(_device, feature, value) {
    const deadline = this.now() + TIMINGS.setValueDeadline;
    const featureId = feature?.external_id;
    let sent = false;
    try {
      const writer = this.model.writers.get(featureId);
      if (!writer) {
        throw this.denied('notCommand');
      }
      const { nodeId } = writer;
      this.checkAllowed(writer.kind);
      if (this.paused()) {
        throw this.denied('paused');
      }
      if (!this.session || !this.online) {
        throw this.denied('notConnected');
      }
      if (writer.guard) {
        this.checkNotGuarded(nodeId);
      }
      await this.serialized(nodeId, async () => {
        // The option and the guard may have changed while the command waited.
        this.checkAllowed(writer.kind);
        if (!this.session || !this.online) {
          throw this.denied('notConnected');
        }
        if (this.now() > deadline) {
          throw this.denied('tooLate');
        }
        let plan;
        try {
          if (writer.kind) {
            if (writer.guard) {
              this.checkNotGuarded(nodeId);
            }
            const fresh = await this.readFresh(nodeId, writer.attr, deadline);
            const node = this.nodes.get(nodeId);
            if (!usable(fresh) || (nodeId !== -1 && node?.state !== NODE_STATE.AVAILABLE)) {
              throw this.denied('unknownState');
            }
            plan = writer.plan(fresh, value, { waterHeaterMax: this.config.waterHeaterMax });
            plan.start = fresh.current;
          } else {
            const attribute = this.nodes.get(nodeId)?.attributes.get(writer.attr);
            if (!attribute) {
              throw this.denied('unknownState');
            }
            plan = { target: writer.write(value, attribute) };
          }
        } catch (err) {
          // A refusal of the mapping (src/mapping.js) gets its text in the user's language.
          if (err?.refusal && !err.localized) {
            throw this.denied(T.denied[err.refusal] ? err.refusal : 'badValue');
          }
          throw err;
        }
        if (plan.already) {
          return;
        }
        // The option is checked once more just before the request leaves.
        this.checkAllowed(writer.kind);
        if (this.now() > deadline) {
          throw this.denied('tooLate');
        }
        const session = this.session;
        const text = `PUT:nodes/${nodeId}/attributes/${writer.attr}?target_value=${formatNumber(plan.target)}`;
        if (!session || !this.online || !session.send(text)) {
          throw this.denied('notConnected');
        }
        sent = true;
        if (writer.guard) {
          this.setGuard(nodeId, writer, plan);
        }
        if (writer.kind) {
          for (const delay of TIMINGS.readBacks) {
            this.readBack(nodeId, writer.attr, delay);
          }
          const echoed = await this.waitEcho(
            nodeId,
            writer.attr,
            plan.target,
            deadline + TIMINGS.echoSlack,
          );
          if (!echoed) {
            throw this.denied('sentUnconfirmed');
          }
        }
        this.logger.debug(`Command sent for ${featureId}`);
      });
    } catch (err) {
      if (!sent) {
        // Gladys shows the value asked for: send the known one again.
        this.gladys.forgetPublishedStates?.(featureId);
        const known = this.lastValues.get(featureId);
        if (known && this.created.has(featureId)) {
          this.publisher.push(featureId, known);
        }
      }
      throw err;
    }
  }

  // --- Configuration screen button ---------------------------------------------------

  /** A token, the websocket, GET:all, with the saved configuration; then a count. */
  async testConnection() {
    const config = this.config;
    if (config.error) {
      return T.configError(config.error);
    }
    if (this.paused()) {
      // A 429 pause covers the test too.
      return T.failure({ kind: 'rate' });
    }
    let session;
    try {
      const answer = await this.requestToken({
        host: config.host,
        username: config.username,
        password: config.password,
      });
      const wasBlocked = Boolean(this.blocked || this.store.refusalOf(config));
      this.store.clearRefusal();
      let resolveAll;
      let rejectAll;
      const all = new Promise((resolve, reject) => {
        resolveAll = resolve;
        rejectAll = reject;
      });
      session = await this.openLive({
        host: config.host,
        token: answer.token,
        WebSocket: this.WebSocket,
        timers: this.timers,
        onMessage: ({ kind, body }) => {
          if (kind === 'all') {
            resolveAll(body);
          }
        },
        onClose: () => rejectAll(new LiveError('closed', 'the websocket was closed')),
      });
      const timer = this.timers.setTimeout(
        () => rejectAll(new LiveError('timeout', 'no answer of the box within 30 s')),
        TIMINGS.allTimeout,
      );
      session.send('GET:all');
      let body;
      try {
        body = await all;
      } finally {
        this.timers.clearTimeout(timer);
      }
      const settings = settingsOf(body?.settings);
      if (!settings.uid) {
        throw new HomeeError('format', 'the box did not give its id');
      }
      const nodes = nodesOf(body?.nodes, 0);
      const model = buildModel((id) => this.idsOf(id), nodes.values(), settings, {
        language: config.language,
      });
      if (wasBlocked && sameConfig(config, this.config)) {
        // The credentials work now: start again without waiting for the retry.
        this.background(this.start(this.raw));
      }
      return T.test.ok({
        host: config.host,
        name: settings.name,
        nodes: nodes.size,
        devices: model.devices.length,
        empty: model.counts.empty,
      });
    } catch (err) {
      if (err instanceof HomeeError && err.kind === 'auth') {
        this.store.refuse(config, err.message);
        return T.test.refused;
      }
      if (err?.kind === 'rate') {
        this.store.pauseUntil(this.now() + this.retryDelay(err));
      }
      if (!(err instanceof HomeeError) && !(err instanceof LiveError)) {
        this.logger.error(`Connection test failed (${err?.name ?? 'error'})`);
      }
      return T.failure(err);
    } finally {
      session?.close();
    }
  }
}
