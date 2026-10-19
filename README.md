# gladys-homee

[Gladys Assistant](https://gladysassistant.com) external integration bridging a
**homee** box (Z-Wave, Zigbee, EnOcean): the nodes paired with the box become
Gladys devices of the Discovery tab, their states follow the box live (its
local websocket), and Gladys controls them through it, on the local network
only. Unofficial, not affiliated with homee.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Development version.** Tested against a simulated box only, never with a
> real homee yet. Feedback and bug reports are welcome in the
> [GitHub issues](https://github.com/LM1LC3N7/gladys-homee/issues).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (HomeeApp) ⇄ src/homee.js ⇄ POST http://<box>:7681/access_token
                                   │                     ⇄ src/live.js  ⇄ ws://<box>:7681/connection (v2)
                                   ├─ src/nodes.js      the JSON of the box -> nodes and attributes (pure)
                                   ├─ src/mapping.js    one node -> features, readers, writers (pure)
                                   ├─ src/devices.js    nodes -> Gladys devices + routing tables (pure)
                                   ├─ src/publisher.js  states within 300/min, sensor throttling
                                   ├─ src/guard.js      IndexGuard: the energy indexes Gladys bills (pure)
                                   └─ src/store.js      /data/state.json: refused credentials, 429 pause, index guards
```

- **Signing in**: the user name and the SHA-512 of the password in HTTP Basic,
  like pyHomee and the homee apps; the token answered is kept in memory only,
  renewed one hour before its end, and when the websocket refuses a token
  older than two minutes (once per try, the tries being spaced). Never
  logged, never in an error message (the websocket URL carries it).
- **Inventory**: `GET:all` on the websocket (nodes, attributes, settings); one
  Gladys device per node, the box itself for its mode. External ids
  `ext:<selector>:homee:<uid>-<node id>` and `…:a<attribute id>[-<command>]`.
- **Changes**: the `attribute` and `node` messages of the websocket, at once;
  `GET:all` again every 10 minutes (the watchdog: no answer within 30 s opens
  the socket again); a lost socket is opened again after 5 s doubling up to
  5 minutes.
- **Commands**: `PUT:nodes/<node>/attributes/<attribute>?target_value=<v>`. One
  at a time per node, sent within 3.5 s of their arrival or refused. The
  sensitive ones (plugs and every device that is not a light nor a plain wall
  relay, heating, locks, doors and gates, valves, sirens, the homee mode) are
  buttons or a list, never switches, each behind an option off by default,
  decided on the attribute read just before (`GET:nodes/…/attributes/…`),
  the option checked again just before sending, the echo of the box awaited
  once the queue is released. Protective commands (lock, close the valve,
  stop, turn off, stop the siren) are never refused for the state.
- **Energy**: each index goes through an `IndexGuard` (never 0, drops and
  jumps held, shown on the badge, taken only by the "Accept the held index"
  action), its state in `/data`.
- **Failures**: credentials refused → stopped, persisted in `/data`, tried
  again after 1 h doubling to 24 h; 429 → pause of every path, persisted;
  unreachable → status message and `unreachable` badges, spaced retries.

## Reused work

- [Taraman17/pyHomee](https://github.com/Taraman17/pyHomee) 1.4.6 (MIT), the
  library of the homee integration of Home Assistant, maintained. It is
  Python and cannot run in this Node container: its protocol is **ported**
  (token request, websocket, messages, node and attribute fields, profile and
  attribute numbers), with its MIT notice in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), copied into the image.
- The homee integration of [Home Assistant](https://github.com/home-assistant/core)
  (Apache-2.0): which attributes are lights, covers, locks, sensors, and the
  meaning of their values.
- [LM1LC3N7/gladys-hubitat](https://github.com/LM1LC3N7/gladys-hubitat), a bridge
  of the same author: the app structure, the state publisher, the test helpers.
- [LM1LC3N7/gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor), of
  the same author: the `IndexGuard` of the energy indexes (`src/guard.js`, taken
  as is, the maximum power a parameter) and its tests.

No JavaScript homee client is maintained on npm; the only runtime dependency
is the Gladys SDK (the WebSocket is the one built into Node.js).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/box.js` builds a `GET:all` answer of 16 nodes of every kind
(written from pyHomee and Home Assistant; not captured on a real box).
`test/helpers/fakeBox.js` serves it to the app tests (mocked timers);
`test/helpers/boxServer.js` is a simulated box on 127.0.0.1 (token over HTTP
and a minimal WebSocket server), against which `test/e2e.test.js` runs the
real client and socket. See TODO.md, "To check on a real box".

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store.

## License

Apache-2.0 (see [LICENSE](LICENSE)); ported logic under MIT and Apache-2.0,
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). homee is a trademark of
homee GmbH; this project is not affiliated with homee.
