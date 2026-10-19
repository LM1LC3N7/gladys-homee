// -----------------------------------------------------------------------------
// The websocket of the box: ws://<host>:7681/connection?access_token=<token>,
// subprotocol "v2" (pyHomee Homee.open_ws). Text messages both ways:
//   client -> box  "GET:all", "GET:nodes/12/attributes/34",
//                  "PUT:nodes/12/attributes/34?target_value=1"
//   box -> client  one JSON object whose only key is the kind of message:
//                  {"all":{…}}, {"attribute":{…}}, {"node":{…}}, {"nodes":[…]},
//                  {"warning":{…}}, {"groups":…}, …
// The token is in the URL: this URL is never logged nor put in an error.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { HOMEE, LIMITS, TIMINGS } from './constants.js';
import { hostForUrl } from './homee.js';

export class LiveError extends Error {
  /** @param {'timeout'|'closed'|'network'|'refused'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'LiveError';
    this.kind = kind;
  }
}

/** The websocket URL (holds the token: never log it). */
export const socketUrl = (host, token, port = HOMEE.port) =>
  `ws://${hostForUrl(host)}:${port}${HOMEE.socketPath}?access_token=${encodeURIComponent(token)}`;

/** One message of the box, parsed: { kind, body }, or undefined when not one. */
export function parseMessage(data) {
  if (typeof data !== 'string' || data.length > LIMITS.messageBytes) {
    return undefined;
  }
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return undefined;
  }
  const keys = Object.keys(json);
  if (keys.length !== 1) {
    return undefined;
  }
  return { kind: keys[0], body: json[keys[0]] };
}

/**
 * Opens the websocket; resolves once it is open with { send(text), close() }.
 * Messages reach `onMessage({ kind, body })`; `onClose(reason)` is called once
 * when an open socket is lost (never after `close()`).
 * @param {{ host: string, token: string, port?: number, WebSocket?: typeof WebSocket,
 *   timers?: object, timeout?: number, onMessage?: Function, onClose?: Function }} options
 * @returns {Promise<{ send(text: string): boolean, close(): void }>}
 */
export function openSocket({
  host,
  token,
  port = HOMEE.port,
  WebSocket = globalThis.WebSocket,
  timers = globalThis,
  timeout = TIMINGS.socketTimeout,
  onMessage = () => {},
  onClose = () => {},
  probe = probePort,
}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new LiveError('network', 'no WebSocket in this Node.js'));
      return;
    }
    let ws;
    try {
      ws = new WebSocket(socketUrl(host, token, port), [HOMEE.subprotocol]);
    } catch {
      reject(new LiveError('network', 'cannot open the websocket'));
      return;
    }
    let ready = false;
    let done = false;

    function finish(reason, error, { notify = true } = {}) {
      if (done) {
        return;
      }
      done = true;
      timers.clearTimeout(openTimer);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      if (!ready) {
        reject(error ?? new LiveError('closed', reason));
      } else if (notify) {
        onClose(reason);
      }
    }

    const openTimer = timers.setTimeout(() => {
      finish(
        'timeout',
        new LiveError(
          'timeout',
          `the websocket did not open within ${Math.round(timeout / 1000)} s`,
        ),
      );
    }, timeout);

    ws.addEventListener('open', () => {
      if (done) {
        return;
      }
      ready = true;
      timers.clearTimeout(openTimer);
      resolve({
        send(text) {
          if (done) {
            return false;
          }
          try {
            ws.send(text);
            return true;
          } catch {
            return false;
          }
        },
        close() {
          finish('closed', undefined, { notify: false });
        },
      });
    });
    ws.addEventListener('message', (event) => {
      if (!ready || done) {
        return;
      }
      const message = parseMessage(event?.data);
      if (message) {
        onMessage(message);
      }
    });
    /**
     * A failure before the opening: Node's WebSocket tells a refused token (an
     * HTTP 401 to the upgrade) and an unreachable box the same way (code
     * 1006). A TCP probe of the port tells them apart: the port answers, the
     * box refused the websocket ("refused": the token may be renewed); it does
     * not, a network failure (the token is kept).
     */
    const failed = () => {
      if (done || ready) {
        finish(ready ? 'connection lost' : 'connection failed');
        return;
      }
      done = true;
      timers.clearTimeout(openTimer);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      Promise.resolve(probe({ host, port }))
        .catch(() => false)
        .then((reachable) =>
          reject(
            reachable
              ? new LiveError('refused', 'the box refused the websocket')
              : new LiveError('network', 'cannot reach the websocket of the box'),
          ),
        );
    };
    ws.addEventListener('close', failed);
    ws.addEventListener('error', failed);
  });
}

/** Whether the port of the box accepts a TCP connection (a few seconds at most). */
export function probePort({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const end = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(TIMINGS.probeTimeout, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}
