// -----------------------------------------------------------------------------
// What must outlive a restart of the container, kept in /data/state.json:
//   - the credentials the box refused: never the user name nor the password,
//     only a salted scrypt fingerprint (enough to recognize them, costly to
//     guess from), the reason, the number of refusals and when to try again
//     (spaced retries, never a loop);
//   - the end of a 429 pause (bounded when read back).
// /data is the only writable place of the container.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMINGS } from './constants.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** The fingerprint of the credentials for a box (salted, slow on purpose). */
export function fingerprint(salt, host, username, password) {
  return scryptSync(`${host}\n${username}\n${password}`, Buffer.from(salt, 'hex'), 16, SCRYPT)
    .toString('hex')
    .slice(0, 32);
}

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

export class StateStore {
  /**
   * @param {{ dir?: string|null, now?: () => number, logger?: object }} options
   *   dir null: kept in memory only (tests)
   */
  constructor({ dir = process.env.HOMEE_DATA_DIR ?? '/data', now = Date.now, logger } = {}) {
    this.dir = dir;
    this.now = now;
    this.logger = logger;
    this.data = { salt: undefined, refused: undefined, pausedUntil: 0 };
    this.cache = new Map();
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
