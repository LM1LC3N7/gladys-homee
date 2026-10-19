# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/mapping.test.js          # one file
node --test --test-name-pattern "lock"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        HomeeApp: lifecycle, token, messages, commands, badges
src/homee.js                      the token request (POST /access_token, node:http, errors by kind)
src/live.js                       ws://<box>:7681/connection, subprotocol v2, the messages
src/nodes.js                      the JSON of the box -> nodes and attributes (pure)
src/mapping.js                    one node -> features, readers, writers (pure), the safety kinds
src/devices.js                    nodes -> Gladys devices + routing tables (pure), no lost feature
src/publisher.js                  states within 300/min, sensor throttling
src/guard.js                      IndexGuard (from gladys-p1-monitor): the energy indexes billed
src/store.js                      /data/state.json: refused credentials (fingerprint), 429 pause,
                                  index guards
src/config.js                     DEFAULTS (mirrors the manifest defaults) + normalization
src/i18n.js                       texts in English and French
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys, a fake box and a
                                  simulated box on 127.0.0.1 (never the network)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Safety rules of this integration

- Only lights and the plain wall relays of `RELAY_PROFILES` (16, 18, 29, 50)
  get a `switch`/`light` binary feature or a writable dimmer. A plug, a
  metering relay, any other profile, a heating, a lock, a door or gate, a
  valve, a siren or the alarm never does: "turn everything off" (Google Home,
  Alexa, HomeKit, MCP, scenes) must never reach them.
- Energy indexes (`ACCUMULATED_ENERGY_USE`) go through `src/guard.js`
  (IndexGuard of gladys-p1-monitor, taken as is): never 0, drops and jumps
  held, accepted only by the `accept_held_index` action. A meter's total is a
  plain value (no double count).
- Protective commands (lock, close the valve, stop, turn off, stop the
  siren) are never refused for the state; the command queue of a node is
  released as soon as its PUT left (the echo is awaited outside). Their state is
  read-only (`unknown/binary`, `lock/state`, `siren/binary`…) and their
  commands are `button/push` features (a `text/select` for the homee mode).
- Each such command has a `kind` whose option (`allow_*_control`) is off by
  default; only `true` allows it. The option is checked when the command
  arrives, when it gets its turn and just before the PUT leaves.
- A sensitive command is decided on the attribute read just before
  (`GET:nodes/<n>/attributes/<a>`), never on the memory; refused when that
  read does not come, the attribute or the node is unavailable, the value is
  unknown or moving. Its echo is awaited: without it, "sent, without
  confirmation", never "not sent".
- Nothing blocks a device after a command: locks, doors and valves await
  the state asked for, a "state not confirmed" badge until a state is
  reported; two presses of an impulse within 2 s are one.
- Hot water setpoint ≤ `water_heater_max` (55 °C by default), never above
  60 °C. Radiator valves are never commanded.
- Refused credentials: stopped, persisted, retried spaced (1 h doubling to
  24 h); never a loop. A token refused by the socket is renewed at most once
  per (spaced) try, and not when it is younger than two minutes.
- A reconnection to Gladys (`connected`) must not clear a 429 pause, a
  refusal, the token nor the socket (`app.resume`); it publishes the status,
  the Discovery and the badges again.
- Never log the password, the token, nor the websocket URL (it holds the
  token). The store keeps a salted scrypt fingerprint, never the credentials.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (here `<box uid>-<node id>`), never a label.
  Gladys keys devices, their history, scenes and dashboards on them:
  changing one creates a new device and orphans the old one. The same goes
  for every key users store: manifest `config_schema`, `actions`, feature
  keys (`a<attribute id>[-<command>]`).
- **No lost feature.** A device republished keeps the features of the device
  created in Gladys (`gladys.devices`) that a new build lacks.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together. A `secret` field is never said to be encrypted: Gladys keeps it
  in clear in its database.
- **Units**: only those the core lists for the category
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY` of `server/utils/constants.js`).
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
