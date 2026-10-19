// A simulated homee on 127.0.0.1 (never the network): POST /access_token
// (HTTP Basic with the SHA-512 of the password, a form body, an answer in
// query-string form) and the websocket /connection?access_token=… with the
// "v2" subprotocol, answering GET:all, attribute reads and PUTs like the box.
// The frame code is written apart from the client on purpose: the client is
// not checked against itself.

import { createHash } from 'node:crypto';
import http from 'node:http';
import { allBody } from '../fixtures/box.js';
import { PASSWORD, USER } from './fakeBox.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** One server text frame (not masked). */
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** The client frames of a buffer (masked, as a client must): [{ opcode, text }], and the rest. */
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let head = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      head = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      head = 10;
    }
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    const total = head + (masked ? 4 : 0) + length;
    if (buffer.length - offset < total) break;
    const mask = masked ? buffer.subarray(offset + head, offset + head + 4) : null;
    const payload = Buffer.from(buffer.subarray(offset + head + (masked ? 4 : 0), offset + total));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, text: payload.toString('utf8') });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export async function boxServer() {
  const sim = {
    all: allBody(),
    /** token requests: { authorization ok, body } */
    tokenRequests: [],
    /** messages received on the websocket */
    received: [],
    sockets: [],
    upgrades: 0,
    /** upgrades refused (a wrong token) */
    refusedUpgrades: 0,
  };
  sim.attribute = (id) => {
    for (const n of sim.all.nodes) {
      const a = n.attributes.find((x) => x.id === id);
      if (a) return a;
    }
    return undefined;
  };
  const send = (kind, body) => {
    const text = frame(JSON.stringify({ [kind]: body }));
    for (const socket of sim.sockets.filter((s) => !s.destroyed)) {
      socket.write(text);
    }
  };
  sim.emit = (id, current) => {
    const a = sim.attribute(id);
    a.current_value = current;
    a.target_value = current;
    send('attribute', a);
  };
  sim.drop = () => {
    for (const socket of sim.sockets) socket.destroy();
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/access_token') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const expected = Buffer.from(
        `${USER}:${createHash('sha512').update(PASSWORD).digest('hex')}`,
      ).toString('base64');
      const ok = req.headers.authorization === `Basic ${expected}`;
      const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      sim.tokenRequests.push({ ok, body });
      if (!ok) {
        res.writeHead(401).end('Unauthorized');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`access_token=${TOKEN}&user_id=2&device_id=7&expires=31536000`);
    });
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://box');
    if (url.pathname !== '/connection' || url.searchParams.get('access_token') !== TOKEN) {
      sim.refusedUpgrades += 1;
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    sim.upgrades += 1;
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${GUID}`)
      .digest('base64');
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(protocols.includes('v2') ? ['Sec-WebSocket-Protocol: v2'] : []),
        '',
        '',
      ].join('\r\n'),
    );
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 8) {
          socket.end();
          return;
        }
        if (f.opcode !== 1) continue;
        sim.received.push(f.text);
        if (f.text === 'GET:all') {
          socket.write(frame(JSON.stringify({ all: sim.all })));
          continue;
        }
        const put = /^PUT:nodes\/(-?\d+)\/attributes\/(\d+)\?target_value=(-?[\d.]+)$/.exec(f.text);
        if (put) {
          const a = sim.attribute(Number(put[2]));
          if (a) {
            a.target_value = Number(put[3]);
            send('attribute', a);
            setTimeout(() => sim.emit(a.id, Number(put[3])), 20);
          }
          continue;
        }
        const get = /^GET:nodes\/(-?\d+)\/attributes\/(\d+)$/.exec(f.text);
        if (get) {
          const a = sim.attribute(Number(get[2]));
          if (a) socket.write(frame(JSON.stringify({ attribute: a })));
        }
      }
    });
    sim.sockets.push(socket);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  sim.port = server.address().port;
  sim.close = () =>
    new Promise((resolve) => {
      sim.drop();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return sim;
}

/** Waits for a condition (real time), up to `ms`. */
export async function waitFor(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
