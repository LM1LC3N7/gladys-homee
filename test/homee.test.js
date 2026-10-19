// The token request and the websocket, against the simulated box on 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HomeeError, hashPassword, parseToken, requestToken, retryAfterMs } from '../src/homee.js';
import { LiveError, openSocket, parseMessage, socketUrl } from '../src/live.js';
import { TOKEN, boxServer, waitFor } from './helpers/boxServer.js';
import { PASSWORD, USER } from './helpers/fakeBox.js';

test('the password travels as its SHA-512, like the homee apps', () => {
  assert.equal(hashPassword('abc').length, 128);
  assert.equal(
    hashPassword('abc').slice(0, 16),
    'ddaf35a193617aba', // SHA-512("abc"), FIPS 180-2
  );
});

test('the answer of /access_token, and what is not one', () => {
  assert.deepEqual(parseToken(`access_token=${TOKEN}&user_id=2&device_id=7&expires=31536000`), {
    token: TOKEN,
    expiresIn: 31_536_000,
  });
  assert.throws(
    () => parseToken('<html>'),
    (err) => err.kind === 'format',
  );
  assert.throws(
    () => parseToken('access_token=a%20b&expires=1'),
    (err) => err.kind === 'format',
  );
  assert.equal(parseToken(`access_token=${TOKEN}`).expiresIn, 3600);
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(retryAfterMs('soon'), undefined);
});

test('a token from the simulated box; refused credentials are an auth error', async (t) => {
  const sim = await boxServer();
  t.after(() => sim.close());
  const ok = await requestToken({
    host: '127.0.0.1',
    port: sim.port,
    username: USER,
    password: PASSWORD,
  });
  assert.equal(ok.token, TOKEN);
  await assert.rejects(
    requestToken({ host: '127.0.0.1', port: sim.port, username: USER, password: 'nope' }),
    (err) => err instanceof HomeeError && err.kind === 'auth' && !err.message.includes('nope'),
  );
});

test('statuses: 429 with Retry-After, 5xx, network, timeout, an answer too long', async (t) => {
  let mode = '429';
  const server = http.createServer((req, res) => {
    if (mode === '429') {
      res.writeHead(429, { 'Retry-After': '90' }).end();
    } else if (mode === '503') {
      res.writeHead(503).end();
    } else if (mode === 'long') {
      res.writeHead(200).end('x'.repeat(20_000));
    }
    // 'hang': no answer
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const port = server.address().port;
  const ask = (timeout) =>
    requestToken({ host: '127.0.0.1', port, username: 'u', password: 'p', timeout });
  await assert.rejects(ask(), (err) => err.kind === 'rate' && err.retryAfter === 90_000);
  mode = '503';
  await assert.rejects(ask(), (err) => err.kind === 'server');
  mode = 'long';
  await assert.rejects(ask(), (err) => err.kind === 'format');
  mode = 'hang';
  await assert.rejects(ask(200), (err) => err.kind === 'timeout');
  await assert.rejects(
    requestToken({ host: '127.0.0.1', port: 1, username: 'u', password: 'p' }),
    (err) => err.kind === 'network',
  );
});

test('the websocket: subprotocol v2, the token in the query, messages both ways', async (t) => {
  const sim = await boxServer();
  t.after(() => sim.close());
  const messages = [];
  let closed;
  const session = await openSocket({
    host: '127.0.0.1',
    port: sim.port,
    token: TOKEN,
    onMessage: (m) => messages.push(m),
    onClose: (reason) => {
      closed = reason;
    },
  });
  assert.equal(session.send('GET:all'), true);
  await waitFor(() => messages.length > 0);
  assert.equal(messages[0].kind, 'all');
  assert.equal(messages[0].body.nodes.length, 16);
  sim.drop();
  await waitFor(() => closed !== undefined);
  assert.equal(session.send('GET:all'), false);
});

test('a refused token fails the opening, without the token in the error', async (t) => {
  const sim = await boxServer();
  t.after(() => sim.close());
  await assert.rejects(
    openSocket({ host: '127.0.0.1', port: sim.port, token: 'wrongtoken123' }),
    (err) => err instanceof LiveError && err.kind === 'refused' && !err.message.includes('wrong'),
  );
  assert.ok(sim.refusedUpgrades >= 1);
  assert.equal(sim.upgrades, 0);
});

test('messages: one key, bounded, never anything else', () => {
  assert.deepEqual(parseMessage('{"attribute":{"id":1}}'), { kind: 'attribute', body: { id: 1 } });
  assert.equal(parseMessage('{"a":1,"b":2}'), undefined);
  assert.equal(parseMessage('[1]'), undefined);
  assert.equal(parseMessage('not json'), undefined);
  assert.equal(parseMessage(Buffer.from('{}')), undefined);
  const polluted = parseMessage('{"__proto__":{"polluted":1}}');
  assert.equal({}.polluted, undefined);
  assert.equal(polluted?.kind, '__proto__');
  assert.equal(socketUrl('fe80::1', 'abc'), 'ws://[fe80::1]:7681/connection?access_token=abc');
});
