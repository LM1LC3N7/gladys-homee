// A fake homee behind the token request of src/homee.js and the websocket of
// src/live.js: the nodes of the fixture, GET:all, the attribute reads, the
// PUTs with their echo (target first, then the value), failures and
// refusals. Never the network; its delays use the (mocked) timers.

import { HomeeError } from '../../src/homee.js';
import { LiveError } from '../../src/live.js';
import { allBody } from '../fixtures/box.js';

export const HOST = '192.168.1.60';
export const USER = 'gladys';
export const PASSWORD = 'correct horse battery';
export const CONFIG = { host: HOST, username: USER, password: PASSWORD };

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export function fakeBox() {
  const box = {
    all: allBody(),
    tokens: 0,
    /** every token request: { host, username } (never the password) */
    tokenCalls: [],
    /** an error the token request throws */
    tokenFail: undefined,
    /** an error the websocket opening throws */
    socketFail: undefined,
    /** sessions: { options, closed, sent: [text] } */
    sessions: [],
    /** GET:all left unanswered */
    mute: false,
    /** attribute ids whose reads are left unanswered */
    silent: new Set(),
    /** PUTs not echoed at all */
    noEcho: false,
    /** ms before the value follows the target (a motor); 0: at once */
    slow: 0,
    /** the PUTs received: { node, attr, value } */
    puts: [],
    /** called on each attribute read (a test changes an option there) */
    onRead: undefined,
  };

  box.node = (id) => box.all.nodes.find((n) => n.id === id);
  box.attribute = (id) => {
    for (const n of box.all.nodes) {
      const a = n.attributes.find((x) => x.id === id);
      if (a) {
        return a;
      }
    }
    return undefined;
  };
  box.live = () => box.sessions.find((s) => !s.closed);
  box.sent = () => box.sessions.flatMap((s) => s.sent);

  const deliver = (kind, body) => {
    for (const session of box.sessions.filter((s) => !s.closed)) {
      session.options.onMessage?.({ kind, body: structuredClone(body) });
    }
  };

  /** An attribute changes on the box: sent to every open socket. */
  box.emit = (id, current, { target = current, state } = {}) => {
    const a = box.attribute(id);
    a.current_value = current;
    a.target_value = target;
    if (state !== undefined) {
      a.state = state;
    }
    deliver('attribute', a);
  };

  /** A raw message from the box. */
  box.message = (kind, body) => deliver(kind, body);

  /** The box drops the websocket. */
  box.drop = (reason = 'connection closed') => {
    for (const session of box.sessions.filter((s) => !s.closed)) {
      session.closed = true;
      session.options.onClose?.(reason);
    }
  };

  box.token = async ({ host, username, password }) => {
    box.tokenCalls.push({ host, username });
    if (box.tokenFail) {
      throw box.tokenFail;
    }
    if (username !== USER || password !== PASSWORD) {
      throw new HomeeError('auth', 'user name or password refused (HTTP 401)', { status: 401 });
    }
    box.tokens += 1;
    return { token: `token${box.tokens}abcdef`, expiresIn: 31_536_000 };
  };

  function handle(session, text) {
    if (text === 'GET:all') {
      if (!box.mute) {
        Promise.resolve().then(
          () =>
            !session.closed &&
            session.options.onMessage({ kind: 'all', body: structuredClone(box.all) }),
        );
      }
      return;
    }
    let match = /^GET:nodes\/(-?\d+)\/attributes\/(\d+)$/.exec(text);
    if (match) {
      const id = Number(match[2]);
      box.onRead?.(id);
      if (!box.silent.has(id)) {
        const a = box.attribute(id);
        Promise.resolve().then(
          () =>
            !session.closed &&
            a &&
            session.options.onMessage({ kind: 'attribute', body: structuredClone(a) }),
        );
      }
      return;
    }
    match = /^PUT:nodes\/(-?\d+)\/attributes\/(\d+)\?target_value=(-?[\d.]+)$/.exec(text);
    if (match) {
      const [node, attrId, value] = [Number(match[1]), Number(match[2]), Number(match[3])];
      box.puts.push({ node, attr: attrId, value });
      if (box.noEcho) {
        return;
      }
      const a = box.attribute(attrId);
      Promise.resolve().then(() => {
        // The box answers with the target at once, the value follows.
        box.emit(attrId, a.current_value, { target: value });
        const settleValue = () => box.emit(attrId, value, { target: value });
        if (box.slow > 0) {
          setTimeout(settleValue, box.slow);
        } else {
          Promise.resolve().then(settleValue);
        }
      });
    }
  }

  box.openLive = async (options) => {
    if (box.socketFail) {
      throw box.socketFail;
    }
    const session = { options, closed: false, sent: [] };
    session.send = (text) => {
      if (session.closed) {
        return false;
      }
      session.sent.push(text);
      handle(session, text);
      return true;
    };
    session.close = () => {
      session.closed = true;
    };
    box.sessions.push(session);
    return session;
  };

  box.refuseSocket = (message = 'the box closed the websocket') => {
    box.socketFail = new LiveError('refused', message);
  };

  return box;
}
