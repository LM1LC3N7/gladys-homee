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
// Commands: one at a time per node while they are decided and sent (the
// queue is released as soon as the PUT left), sent within 3.5 s of their
// arrival or refused. The sensitive ones (plugs, heating, locks, doors and
// gates, valves, sirens, the homee mode) only when their option is on,
// decided on the attribute read just before, the option checked again just
// before the request, then the echo of the box awaited ("sent, without
// confirmation" when it does not come). The protective ones (lock, close the
// valve, stop, turn off, stop the siren) are never refused for the state.
// Nothing blocks a device after a command: the state asked for is awaited,
// and a "state not confirmed" badge shows when it does not come.
//
// Energy indexes go through an IndexGuard each (src/guard.js): a drop or a
// jump is held, shown on the badge and in the log, kept in /data, and taken
// only by the "Accept the held index" action.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { OPTION_OF_KIND, normalizeConfig } from './config.js';
import { HOMEE, INDEX_MAX_KW, LIMITS, NODE_STATE, TIMINGS, WARNING } from './constants.js';
import { buildModel, emptyModel } from './devices.js';
import { IndexGuard } from './guard.js';
import { HomeeError, requestToken } from './homee.js';
import { LiveError, openSocket } from './live.js';
import { T, word } from './i18n.js';
import { usable } from './mapping.js';
import {
  attributeOf,
  mergeNode,
  nodeOf,
  nodesOf,
  settingsOf,
  withAttribute,
  withDirection,
} from './nodes.js';
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

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(devices, featureId) {
  for (const device of devices ?? []) {
    const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
    if (feature) {
      const value = Number(feature.last_value);
      const at = Date.parse(feature.last_value_changed ?? '');
      return feature.last_value !== null &&
        feature.last_value !== undefined &&
        Number.isFinite(value) &&
        Number.isFinite(at)
        ? { value, at }
        : undefined;
    }
  }
  return undefined;
}

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
    /** the pending GET:all, shared by whoever asks meanwhile: { promise, resolve, reject, timer, since } */
    this.allWaiter = undefined;
    /** "<node>:<attribute>" -> Set of callbacks (attribute | undefined) */
    this.waiters = new Map();
    /** "<node>:<attribute>" -> until when its fresh reads are not trusted (a late answer) */
    this.quarantine = new Map();
    /** node id -> the tail of its command chain */
    this.chains = new Map();
    /** node id -> { attr, done, timer }: the state a command asked for, awaited */
    this.pending = new Map();
    /** node id -> the attribute whose state was not confirmed (badge) */
    this.unconfirmed = new Map();
    /** impulse feature id -> when it was last sent (debounce) */
    this.impulses = new Map();
    /** "<node>:<attribute>" -> the direction (reverse_control_ui) first seen */
    this.directions = new Map();
    /** index feature id -> IndexGuard; and the last state saved of each */
    this.indexGuards = new Map();
    this.savedIndexes = new Map();
    /** feature id -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** device id -> last badge published (JSON) */
    this.transports = new Map();
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
    if (refusal && refusal.retryAt > this.now()) {
      // Refused before (maybe before a restart): tried again only when due.
      this.blocked = refusal;
      const wait = refusal.retryAt - this.now();
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
   * keeps in memory only (status, Discovery, badges), the box online or not;
   * another configuration starts again.
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
    await this.rebuild({ force: true });
    if (this.online) {
      await this.connectedStatus();
    } else if (this.blocked) {
      await this.setStatus(false, T.refused(Math.max(0, this.blocked.retryAt - this.now())));
    } else {
      await this.setStatus(false, this.lastError ? T.failure(this.lastError) : T.connecting);
    }
    await this.publishAllTransports();
  }

  /**
   * The configuration was saved by the user: one try at once, even after a
   * refusal, which keeps its count (the next refusal waits longer). It never
   * accepts a held energy index.
   */
  async configUpdated(raw = {}) {
    this.logger.info('Configuration updated: reconnecting to the homee');
    const next = normalizeConfig(raw);
    if (!next.error) {
      this.store.allowTry(next);
    }
    await this.start(raw);
  }

  stop() {
    this.generation += 1;
    this.running = false;
    for (const timer of [this.timer, this.resyncTimer, this.modelTimer, ...this.readBackTimers]) {
      this.timers.clearTimeout(timer);
    }
    for (const pending of this.pending.values()) {
      this.timers.clearTimeout(pending.timer);
    }
    this.pending.clear();
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

  /**
   * Asks the whole box (GET:all); resolves when it came. A GET:all already
   * pending is shared (a Scan during the resync waits for the same answer).
   */
  readAll(generation) {
    if (this.allWaiter && this.allWaiter.session === this.session) {
      return this.allWaiter.promise;
    }
    const session = this.session;
    if (!session) {
      return Promise.reject(new LiveError('closed', 'no websocket'));
    }
    const waiter = { since: this.seq, generation, session };
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    waiter.timer = this.timers.setTimeout(() => {
      if (this.allWaiter === waiter) {
        this.allWaiter = undefined;
        waiter.reject(new LiveError('timeout', 'no answer of the box within 30 s'));
      }
    }, TIMINGS.allTimeout);
    this.allWaiter = waiter;
    if (!session.send('GET:all')) {
      this.allWaiter = undefined;
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new LiveError('closed', 'the websocket is closed'));
    }
    return waiter.promise;
  }

  rejectAll() {
    const waiter = this.allWaiter;
    if (waiter) {
      this.allWaiter = undefined;
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new LiveError('closed', 'the websocket is closed'));
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
      for (const fn of [...set]) {
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
      // The box answers but refused the websocket with a token that is not
      // new: one new token at the next try (a new token refused too only
      // waits for the growing delay). A network failure keeps the token.
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
          for (const raw of body.slice(0, LIMITS.nodes)) {
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
      this.directions.clear();
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
      if (node.attributes.size >= LIMITS.attributesPerNode) {
        return;
      }
      this.scheduleModel(generation);
    }
    const updated = withAttribute(node, attribute);
    this.nodes.set(node.id, updated);
    const known = updated.attributes.get(attribute.id);
    this.applyAttribute(node.id, known);
    this.checkPending(node.id, known);
    this.notify(node.id, known);
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
      this.checkPending(node.id, attribute);
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
    const key = `${nodeId}:${attribute.id}`;
    if (attribute.reversed !== undefined && !this.directions.has(key)) {
      this.directions.set(key, attribute.reversed);
    }
    for (const reader of this.model.readers.get(key) ?? []) {
      let value;
      try {
        value = reader.read(attribute);
      } catch (err) {
        this.warnOnce(`read:${reader.featureId}`, `${reader.featureId}: ${err.message}`);
        continue;
      }
      if (!value) {
        continue;
      }
      if (reader.meter) {
        this.indexValue(nodeId, reader.featureId, value.state);
      } else {
        this.record(reader.featureId, value);
      }
    }
  }

  // --- Energy indexes ----------------------------------------------------------------

  /** The guard of an index feature: the value Gladys holds, and the state kept in /data. */
  indexGuard(featureId) {
    let guard = this.indexGuards.get(featureId);
    if (!guard) {
      guard = new IndexGuard(
        lastValueOf(this.gladys.devices, featureId),
        this.store.indexState(featureId),
        this.now(),
        INDEX_MAX_KW,
      );
      this.indexGuards.set(featureId, guard);
    }
    return guard;
  }

  /**
   * A reading of an energy index. Only for a device created in Gladys (the
   * reference is what Gladys holds). Taken by the guard: published. Held:
   * the last accepted value is sent again (no delta for the core), the hold
   * logged and shown on the badge.
   */
  indexValue(nodeId, featureId, state) {
    if (!this.created.has(featureId)) {
      return;
    }
    const guard = this.indexGuard(featureId);
    const wasHeld = Boolean(guard.held);
    const ok = guard.accept(state, this.now());
    this.saveIndex(featureId, guard);
    if (ok) {
      this.record(featureId, { state });
    } else {
      const held = guard.held;
      if (held) {
        this.warnOnce(
          `held:${featureId}:${held.direction}:${held.from}:${held.threshold}`,
          `${featureId}: energy index ${held.direction === 'down' ? 'drop' : 'jump'} held back (${held.from} -> ${held.to} kWh): the "Accept the held index" action takes it`,
        );
      }
      if (guard.last) {
        this.record(featureId, { state: guard.last.value });
      }
    }
    if (wasHeld !== Boolean(guard.held)) {
      this.publishTransportOf(nodeId);
    }
  }

  /** Keeps a guard in /data when its reference or its value held changed. */
  saveIndex(featureId, guard) {
    const state = guard.state();
    const key = JSON.stringify([
      state.last,
      state.held && {
        direction: state.held.direction,
        from: state.held.from,
        threshold: state.held.threshold,
      },
    ]);
    if (this.savedIndexes.get(featureId) === key) {
      return;
    }
    this.savedIndexes.set(featureId, key);
    this.store.setIndexState(featureId, state);
  }

  /** The guards of a device's indexes. */
  guardsOf(deviceId) {
    return [...this.indexGuards.entries()].filter(([id]) => id.startsWith(`${deviceId}:`));
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
    const held = this.guardsOf(deviceId).find(([, guard]) => guard.held);
    if (held) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: T.badge.held(held[1].held),
      };
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

  /** A device created (or updated) by the user: its values, its badge. */
  async deviceCreated(device, { fresh = true } = {}) {
    this.refreshCreated();
    const deviceId = device?.external_id;
    this.transports.delete(deviceId);
    if (deviceId && fresh) {
      // A new device: no index reference yet (nor a value held in /data for a
      // deleted device of the same id); its indexes start again from the box.
      for (const [id] of this.guardsOf(deviceId)) {
        this.indexGuards.delete(id);
        this.savedIndexes.delete(id);
      }
      this.store.dropIndexStates(deviceId);
    }
    for (const f of device?.features ?? []) {
      const value = this.lastValues.get(f.external_id);
      if (value) {
        this.publisher.push(f.external_id, value);
      }
    }
    const nodeId = this.model.deviceIds.get(deviceId);
    const node = this.nodes.get(nodeId);
    if (node) {
      // The indexes are read now, through their new guard.
      this.applyNode(node);
    }
    if (deviceId) {
      await this.publishTransport(deviceId).catch(() => {});
    }
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device, { fresh: false });
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

  /**
   * Reads one attribute just now (GET), or refuses: never the value in
   * memory. A read that timed out puts the attribute in quarantine: its late
   * answer could be taken for the fresh read of the next command.
   */
  readFresh(nodeId, attrId, deadline) {
    const key = `${nodeId}:${attrId}`;
    if ((this.quarantine.get(key) ?? 0) > this.now()) {
      return Promise.reject(this.denied('unknownState'));
    }
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
          this.quarantine.set(key, this.now() + TIMINGS.quarantine);
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

  /**
   * After a lock, door or valve command, the state asked for is awaited (it
   * blocks nothing): not reported in time, the badge says "state not
   * confirmed" until the device reports a state.
   */
  expectState(nodeId, writer, plan) {
    if (!plan.done || !TIMINGS.confirm[writer.confirm]) {
      return;
    }
    const previous = this.pending.get(nodeId);
    this.timers.clearTimeout(previous?.timer);
    const pending = { attr: writer.attr, done: plan.done };
    pending.timer = this.timers.setTimeout(() => {
      if (this.pending.get(nodeId) === pending) {
        this.pending.delete(nodeId);
        this.logger.warn(`Node ${nodeId}: the state asked for was not reported in time`);
        this.unconfirmed.set(nodeId, pending.attr);
        this.publishTransportOf(nodeId);
      }
    }, TIMINGS.confirm[writer.confirm]);
    this.pending.set(nodeId, pending);
  }

  /** A new value: the state awaited came, or a state after an unconfirmed command. */
  checkPending(nodeId, attribute) {
    if (!usable(attribute)) {
      return;
    }
    const pending = this.pending.get(nodeId);
    if (pending && attribute.id === pending.attr && pending.done(attribute)) {
      this.timers.clearTimeout(pending.timer);
      this.pending.delete(nodeId);
    }
    if (!this.pending.has(nodeId) && this.unconfirmed.get(nodeId) === attribute.id) {
      // The device reported its state: known again, the badge cleared.
      this.unconfirmed.delete(nodeId);
      this.publishTransportOf(nodeId);
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
      this.checkBounce(writer, featureId);
      let echo;
      await this.serialized(nodeId, async () => {
        // The option may have changed while the command waited.
        this.checkAllowed(writer.kind);
        if (!this.session || !this.online) {
          throw this.denied('notConnected');
        }
        if (this.now() > deadline) {
          throw this.denied('tooLate');
        }
        this.checkBounce(writer, featureId);
        const plan = await this.planOf(writer, value, deadline);
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
        if (writer.impulse) {
          this.impulses.set(featureId, this.now());
        }
        if (writer.confirm) {
          this.expectState(nodeId, writer, plan);
        }
        if (writer.kind) {
          for (const delay of TIMINGS.readBacks) {
            this.readBack(nodeId, writer.attr, delay);
          }
          // Registered now, awaited after the queue is released: a stop or a
          // protective command never waits behind this echo.
          echo = this.waitEcho(nodeId, writer.attr, plan.target, deadline + TIMINGS.echoSlack);
        }
        this.logger.debug(`Command sent for ${featureId}`);
      });
      if (echo && !(await echo)) {
        throw this.denied('sentUnconfirmed');
      }
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

  /** Two presses of an impulse within the debounce are one: the second is refused. */
  checkBounce(writer, featureId) {
    const last = this.impulses.get(featureId);
    if (writer.impulse && last !== undefined && this.now() - last < TIMINGS.impulseDebounce) {
      throw this.denied('busy');
    }
  }

  /** The plan of a command: on the attribute read just now, or on the memory for the others. */
  async planOf(writer, value, deadline) {
    const { nodeId } = writer;
    const known = this.nodes.get(nodeId)?.attributes.get(writer.attr);
    try {
      if (writer.kind && !writer.protective) {
        const read = await this.readFresh(nodeId, writer.attr, deadline);
        const fresh = withDirection(read, this.nodes.get(nodeId)?.attributes.get(writer.attr));
        const node = this.nodes.get(nodeId);
        if (!usable(fresh) || (nodeId !== -1 && node?.state !== NODE_STATE.AVAILABLE)) {
          throw this.denied('unknownState');
        }
        if (writer.directional) {
          const first = this.directions.get(`${nodeId}:${writer.attr}`);
          if (first !== undefined && fresh.reversed !== undefined && first !== fresh.reversed) {
            throw this.denied('directionChanged');
          }
        }
        const plan = writer.plan(fresh, value, { waterHeaterMax: this.config.waterHeaterMax });
        return { ...plan, start: fresh.current };
      }
      if (writer.kind) {
        // Protective: never refused for the state, planned on what is known.
        return writer.plan(known, value, { waterHeaterMax: this.config.waterHeaterMax });
      }
      if (!known) {
        throw this.denied('unknownState');
      }
      return { target: writer.write(value, known) };
    } catch (err) {
      // A refusal of the mapping (src/mapping.js) gets its text in the user's language.
      if (err?.refusal && !err.localized) {
        throw this.denied(T.denied[err.refusal] ? err.refusal : 'badValue');
      }
      throw err;
    }
  }

  // --- Configuration screen buttons ---------------------------------------------------

  /**
   * "Accept the held index": takes, for each index of the device chosen, the
   * value held as shown now (plus what the device may draw until its next
   * reading, src/guard.js), never anything else. Answers with the kWh counted.
   */
  async acceptHeldIndex(fields = {}) {
    const deviceId = typeof fields?.device === 'string' ? fields.device : '';
    if (!deviceId) {
      return T.accept.noDevice;
    }
    const accepted = [];
    for (const [id, guard] of this.guardsOf(deviceId)) {
      const taken = guard.acceptHeld();
      if (taken) {
        accepted.push(taken);
        this.logger.info(
          `${id}: energy index ${taken.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
        );
      }
    }
    if (accepted.length === 0) {
      return T.accept.nothing;
    }
    // The value held is the one in memory: taken now.
    const node = this.nodes.get(this.model.deviceIds.get(deviceId));
    if (node) {
      this.applyNode(node);
    }
    return T.accept.done(accepted);
  }

  /** The test button: the connection in use when there is one, else a token, the socket, GET:all. */
  async testConnection() {
    const config = this.config;
    if (config.error) {
      return T.configError(config.error);
    }
    if (this.paused()) {
      // A 429 pause covers the test too.
      return T.failure({ kind: 'rate' });
    }
    if (this.online && this.session) {
      try {
        await this.readAll(this.generation);
        return T.test.ok({
          host: config.host,
          name: this.box?.name ?? 'homee',
          nodes: this.nodes.size,
          devices: this.model.devices.length,
          empty: this.model.counts.empty,
        });
      } catch (err) {
        return T.failure(err);
      }
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
