// -----------------------------------------------------------------------------
// The token of the box: POST http://<host>:7681/access_token, like pyHomee
// (Homee.get_access_token): HTTP Basic with the user name and the SHA-512 of
// the password (hexadecimal, what the homee apps send), a form body naming
// the client, and an answer in query-string form:
//   access_token=…&user_id=…&device_id=…&expires=31536000
// `expires` is in seconds. The token then opens the websocket (src/live.js).
//
// Plain node:http on purpose: no redirect followed, a deadline per request,
// the answer read up to a few KB, and error messages built from statuses
// and codes only (never a body, a password, a token nor a URL with it).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import http from 'node:http';
import { HOMEE, LIMITS, TIMINGS } from './constants.js';

export class HomeeError extends Error {
  /**
   * @param {'auth'|'rate'|'server'|'network'|'timeout'|'format'|'api'} kind
   * @param {string} message never a secret
   */
  constructor(kind, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'HomeeError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** The password as the box expects it: its SHA-512, in hexadecimal. */
export const hashPassword = (password) =>
  createHash('sha512').update(String(password), 'utf8').digest('hex');

/** Retry-After (seconds or an HTTP date) -> ms, or undefined. */
export function retryAfterMs(header, now = Date.now()) {
  if (typeof header !== 'string' || header.trim() === '') {
    return undefined;
  }
  if (/^\d{1,9}$/.test(header.trim())) {
    return Number(header.trim()) * 1000;
  }
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The answer of /access_token -> { token, expiresIn (s) }, or a format error. */
export function parseToken(text) {
  const params = new URLSearchParams(String(text ?? '').trim());
  const token = params.get('access_token') ?? '';
  const expires = Number(params.get('expires'));
  if (!/^[A-Za-z0-9._~-]{8,512}$/.test(token)) {
    throw new HomeeError('format', 'the box answered without a usable token');
  }
  return {
    token,
    expiresIn: Number.isFinite(expires) && expires > 0 ? Math.min(expires, 10 * 365 * 86400) : 3600,
  };
}

/** The host for a URL (an IPv6 address gets its brackets). */
export const hostForUrl = (host) => (host.includes(':') ? `[${host}]` : host);

/**
 * Asks the box for a token.
 * @param {{ host: string, username: string, password: string, timeout?: number, port?: number }} options
 * @returns {Promise<{ token: string, expiresIn: number }>}
 */
export function requestToken({
  host,
  username,
  password,
  timeout = TIMINGS.tokenTimeout,
  port = HOMEE.port,
}) {
  const body = new URLSearchParams({
    device_name: HOMEE.deviceName,
    device_hardware_id: HOMEE.hardwareId,
    device_os: String(HOMEE.deviceOs),
    device_type: String(HOMEE.deviceType),
    device_app: String(HOMEE.deviceApp),
  }).toString();
  const basic = Buffer.from(`${username}:${hashPassword(password)}`, 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = http.request(
      {
        host,
        port,
        path: HOMEE.tokenPath,
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.tokenBytes) {
            res.destroy();
            done(reject, new HomeeError('format', 'the answer of the box is too long'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => done(reject, new HomeeError('network', 'connection lost')));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status === 200) {
            try {
              done(resolve, parseToken(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
              done(reject, err);
            }
            return;
          }
          if (status === 401 || status === 403) {
            done(
              reject,
              new HomeeError('auth', `user name or password refused (HTTP ${status})`, { status }),
            );
          } else if (status === 429) {
            done(
              reject,
              new HomeeError('rate', 'too many requests (HTTP 429)', {
                status,
                retryAfter: retryAfterMs(res.headers['retry-after']),
              }),
            );
          } else if (status >= 500) {
            done(reject, new HomeeError('server', `the box failed (HTTP ${status})`, { status }));
          } else {
            done(reject, new HomeeError('api', `unexpected answer (HTTP ${status})`, { status }));
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new HomeeError('timeout', `no answer within ${Math.round(timeout / 1000)} s`));
    }, timeout);
    req.on('error', (err) => {
      const code = typeof err?.code === 'string' ? err.code : 'error';
      done(reject, new HomeeError('network', `cannot reach the box (${code})`));
    });
    req.end(body);
  });
}
