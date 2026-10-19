// -----------------------------------------------------------------------------
// What must outlive a restart of the container, kept in /data/state.json:
//   - the credentials the box refused: never the user name nor the password,
//     only a salted scrypt fingerprint (enough to recognize them, costly to
//     guess from), the reason, the number of refusals and when to try again
//     (spaced retries, never a loop);
//   - the end of a 429 pause (bounded when read back);
//   - the state of each energy index guard (src/guard.js): its reference and
//     the value held, validated and bounded when read back (only our own
//     feature ids, 1000 at most), so that a restart never forgets a jump the
//     user has not accepted.
// /data is the only writable place of the container.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_STATES_MAX, TIMINGS } from './constants.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** The fingerprint of the credentials for a box (salted, slow on purpose). */
export function fingerprint(salt, host, username, password) {
  return scryptSync(`${host}\n${username}\n${password}`, Buffer.from(salt, 'hex'), 16, SCRYPT)
    .toString('hex')
    .slice(0, 32);
}

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

const point = (p) =>
  p && Number.isFinite(p.value) && p.value > 0 && Number.isFinite(p.at)
    ? { value: p.value, at: p.at }
    : null;

const heldOf = (h) =>
  h &&
  (h.direction === 'up' || h.direction === 'down') &&
  [h.from, h.to, h.threshold, h.at].every(Number.isFinite)
    ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
    : null;

/** The index states of the file: bounded, validated, only our own feature ids. */
function indexesOf(raw) {
  const indexes = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return indexes;
  }
  for (const [id, state] of Object.entries(raw).slice(0, INDEX_STATES_MAX)) {
    if (typeof id !== 'string' || id.length > 255 || !/^ext:[^:]+:homee:/.test(id)) {
      continue;
    }
    const last = point(state?.last);
    if (last) {
      indexes[id] = { last, held: heldOf(state?.held) };
    }
  }
  return indexes;
}

export class StateStore {
  /**
   * @param {{ dir?: string|null, now?: () => number, logger?: object }} options
   *   dir null: kept in memory only (tests)
   */
  constructor({ dir = process.env.HOMEE_DATA_DIR ?? '/data', now = Date.now, logger } = {}) {
    this.dir = dir;
    this.now = now;
    this.logger = logger;
    /** indexes: feature external id -> { last, held } of its IndexGuard (src/guard.js) */
    this.data = { salt: undefined, refused: undefined, pausedUntil: 0, indexes: {} };
    this.cache = new Map();
    /** index states changed in memory, not written yet */
    this.dirty = false;
    this.load();
    if (!this.data.salt) {
      this.data.salt = randomBytes(16).toString('hex');
    }
  }

  load() {
    if (!this.dir) {
      return;
    }
    try {
      const json = JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8'));
      if (typeof json?.salt === 'string' && HEX(32).test(json.salt)) {
        this.data.salt = json.salt;
      }
      const refused = json?.refused;
      if (refused && typeof refused.key === 'string' && HEX(32).test(refused.key)) {
        const count = Number(refused.count);
        const retryAt = Number(refused.retryAt);
        this.data.refused = {
          key: refused.key,
          reason: typeof refused.reason === 'string' ? refused.reason.slice(0, 200) : '',
          count: Number.isInteger(count) && count > 0 ? Math.min(count, 1000) : 1,
          // A date far in the future (a clock that jumped) is bounded.
          retryAt: Number.isFinite(retryAt)
            ? Math.min(retryAt, this.now() + TIMINGS.authRetryMax)
            : this.now() + TIMINGS.authRetryMin,
        };
      }
      const until = Number(json?.pausedUntil);
      if (Number.isFinite(until) && until > 0) {
        this.data.pausedUntil = Math.min(until, this.now() + TIMINGS.rateLimitMax);
      }
      this.data.indexes = indexesOf(json?.indexes);
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  save() {
    if (!this.dir) {
      return;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, 'state.json');
      writeFileSync(`${file}.tmp`, JSON.stringify(this.data));
      renameSync(`${file}.tmp`, file);
      this.dirty = false;
    } catch (err) {
      this.logger?.warn(`Cannot write ${this.dir}/state.json: ${err.code ?? 'error'}`);
    }
  }

  keyOf(host, username, password) {
    const id = `${host}\n${username}\n${password}`;
    if (!this.cache.has(id)) {
      this.cache.clear();
      this.cache.set(id, fingerprint(this.data.salt, host, username, password));
    }
    return this.cache.get(id);
  }

  /** The refusal of these credentials at this box, if they were refused. */
  refusalOf({ host, username, password }) {
    const refused = this.data.refused;
    return refused && refused.key === this.keyOf(host, username, password) ? refused : undefined;
  }

  /** The box refused these credentials: when to try again (spaced, doubling). */
  refuse({ host, username, password }, reason) {
    const previous = this.refusalOf({ host, username, password });
    const count = (previous?.count ?? 0) + 1;
    const delay = Math.min(TIMINGS.authRetryMax, TIMINGS.authRetryMin * 2 ** (count - 1));
    this.data.refused = {
      key: this.keyOf(host, username, password),
      reason: String(reason ?? '').slice(0, 200),
      count,
      retryAt: this.now() + delay,
    };
    this.save();
    return this.data.refused;
  }

  clearRefusal() {
    if (this.data.refused) {
      this.data.refused = undefined;
      this.save();
    }
  }

  /**
   * A gesture of the user (configuration saved): one try now. The same
   * credentials keep their count of refusals (the next one waits longer);
   * other credentials have no refusal to clear.
   */
  allowTry(creds) {
    const refused = this.refusalOf(creds);
    if (refused && refused.retryAt > this.now()) {
      refused.retryAt = this.now();
      this.save();
    }
  }

  /** The state kept for an energy index (src/guard.js), or undefined. */
  indexState(featureId) {
    return Object.hasOwn(this.data.indexes, featureId) ? this.data.indexes[featureId] : undefined;
  }

  /** `write: false`: kept in memory until the next `flush()` (grouped writes). */
  setIndexState(featureId, state, { write = true } = {}) {
    if (
      !Object.hasOwn(this.data.indexes, featureId) &&
      Object.keys(this.data.indexes).length >= INDEX_STATES_MAX
    ) {
      return;
    }
    this.data.indexes[featureId] = { last: point(state?.last), held: heldOf(state?.held) };
    if (write) {
      this.save();
    } else {
      this.dirty = true;
    }
  }

  /** Writes what `setIndexState(…, { write: false })` kept in memory. */
  flush() {
    if (this.dirty) {
      this.save();
    }
  }

  dropIndexStates(prefix) {
    let changed = false;
    for (const id of Object.keys(this.data.indexes)) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        delete this.data.indexes[id];
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  get pausedUntil() {
    return this.data.pausedUntil;
  }

  pauseUntil(until) {
    const bounded = Math.min(until, this.now() + TIMINGS.rateLimitMax);
    if (bounded > this.data.pausedUntil) {
      this.data.pausedUntil = bounded;
      this.save();
    }
  }
}
