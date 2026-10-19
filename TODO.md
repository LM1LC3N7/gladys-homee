# TODO — homee v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test` (Node
  22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-19): token, websocket, GET:all and live
      messages, mapping of lights, switches, plugs, shutters, thermostats,
      hot water, locks, doors and gates, impulses, water valves, sirens, the
      homee mode and the sensors; safety (no switch for the sensitive kinds,
      seven options off by default, fresh read, option checked again, echo,
      guards); refused credentials and 429 persisted; energy index rules;
      badges; test button; en/fr; docs; cover. Tested against a fake box and a
      simulated box on 127.0.0.1 only.
- [x] **Milestone 1 fixes — review** (2026-10-19): the xhigh review of
      dcae866 (2 blocking, 5 important, 15 minor points), all fixed, each with
      a test (`test/review.test.js` inverts its 15 hostile scenarios;
      `test/guard.test.js` ports the IndexGuard tests of gladys-p1-monitor).
- [ ] **Milestone 2 — real box**: run against a real homee and compare with
      the homee app (see "To check"); turn the answers (anonymized) into
      fixtures.
- [ ] **Milestone 3 — more**: remotes and wall buttons (`BUTTON_STATE`,
      `UP_DOWN_REMOTE` as `button/click` with scene triggers), homeegrams
      (played by a button), heating mode as a list behind the heating option,
      slats (`SHUTTER_SLAT_POSITION`, `SLAT_ROTATION_IMPULSE`), the INOVA
      alarm as read-only texts, `HVAC_MODE` and fans.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real box

- The answer of `/access_token` to wrong credentials (401 expected; 403 is
  handled the same way) and whether the box locks a user after several
  refusals (the retries are already 1 h apart at least).
- Whether the websocket refuses an expired token with an HTTP 401 (seen by
  Node's WebSocket as a failed opening, "refused") and whether the box closes
  the socket when the token expires.
- The answer to `GET:nodes/<n>/attributes/<a>`: an `attribute` message is
  assumed (pyHomee `update_attribute`).
- The echo of a PUT: an `attribute` message with the new `target_value`
  first, then `current_value` (what Home Assistant's lock relies on).
- The meaning of `OPEN_CLOSE` on a contact sensor (1 open, Home Assistant's
  binary sensor) versus a garage door (0 open, Home Assistant's cover).
- `ON_OFF` on a water valve: whether 1 means open (still to check); the
  buttons are named "Turn on" / "Turn off" until then, "Turn off" being the
  protective one.
- Whether a lone `attribute` message carries `options` (the direction), and
  whether `GET:all` gives `options.reverse_control_ui` for every reversed
  door.
- Whether the box answers a PUT on a moving door (current ≠ target) and
  which value an impulse attribute takes back after a press. The `CURRENT_VALVE_POSITION` buttons
  open (maximum) and close (minimum).
- The size of `GET:all` on a big install (the bound is 16 MB) and whether the
  box answers it every 10 minutes without trouble.
- The unit strings (`%C2%B0C`, `%25`, `lx`, `kWh`, `W`) and the colour
  temperature range (kelvins).

## Decisions

- **Reference reused: pyHomee 1.4.6** (MIT, Taraman17, the library of the
  Home Assistant integration, tag `v1.4.6`, commit `fee93dd`, 2026-10-02),
  cloned read only in `_ref/pyHomee`, its LICENSE checked (MIT). The homee
  component of Home Assistant (Apache-2.0, commit `07b62c8`) read for the
  mapping. Python, so the logic is ported to JavaScript, with the notices in
  `THIRD_PARTY_NOTICES.md` (copied into the image, like `LICENSE`, the
  standard Apache-2.0 text without any name). Neighbour module followed:
  gladys-hubitat (structure, publisher, safety rules, tests).
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json` and the
  manifest (with the `docker_image` tag `ghcr.io/lm1lc3n7/gladys-homee:0.1.0`):
  the one-time exception to "versions belong to the Release workflow"; the
  first patch release gives 0.1.1.
- **Single runtime dependency**: the Gladys SDK. The token through
  `node:http` (no redirect, 10 s deadline, 8 KB read, messages from statuses
  and codes only); the websocket built into Node.js (22 and 24), subprotocol
  `v2`; messages over 16 MB dropped (Node's WebSocket has no frame size
  option: the bound applies once a message is received); only the known
  fields of the JSON read, as numbers or bounded strings, in maps (no
  prototype pollution).
- **Token**: kept in memory only (a secret: never in `/data`), renewed when
  less than one hour remains, and when the socket refuses a token older than
  two minutes; a token younger than that, refused, waits for the growing
  delay (no loop). `setTimeout` bounded to 24.8 days.
- **Refused credentials** (`/access_token` 401/403): stopped, persisted in
  `/data/state.json` as a salted scrypt fingerprint of host, user and
  password (never them), with the reason, the count and the next try (1 h,
  doubling to 24 h). A restart keeps it. A configuration saved by the user
  tries once at once and KEEPS the count when the credentials are the same
  (review M10: the next refusal waits longer); the test button tries at once
  (a test that works starts the integration again). HTTP Basic in latin-1,
  like aiohttp (M11).
- **Websocket failures** (review M7): Node's WebSocket reports a refused
  upgrade (401) and an unreachable box alike (code 1006). A TCP probe of port
  7681 (3 s) tells them apart: the port answers → `refused` (the token may be
  renewed, once per spaced try, never when younger than 2 min); it does not →
  `network` (the token is kept).
- **429**: pause of every path (Retry-After, 1 min to 6 h), persisted and
  bounded when read back; the test button and commands respect it.
- **Reconnection**: 5 s doubling to 5 min; `GET:all` every 10 minutes, no
  answer within 30 s reopens the socket (watchdog). A GET:all pending is
  shared (a Scan, the test button, the learn mode wait for the same answer;
  review M2). A reconnection to Gladys keeps token, socket, pause and
  refusal, and publishes status, Discovery (even with the box offline, M5)
  and badges again. The test button reuses the connection in use (M12).
- **External ids**: `homee:<uid>-<node id>` (`<uid>-box` for the box itself,
  node -1); feature keys `a<attribute id>` and `a<attribute id>-<command>`
  for the buttons. The uid comes from the settings of `GET:all` (lower case);
  without it nothing is published.
- **Kinds and safety** (brief, lot 6 lesson, review B2): only lights (Home
  Assistant's light profiles; dimmable plugs included: dimming implies a
  lamp) and the plain wall relays 16, 18, 29, 50 (`RELAY_PROFILES`) get a
  `switch`/`light` binary and a writable dimmer. The metering relays 12, 33,
  46, 47 are treated like plugs (decision: a relay chosen with metering often
  drives a heater or a boiler, its load is unknown). Every other profile,
  known or not (plugs, cameras, washers, ventilation, perimeter systems…),
  is `other`: its on/off `unknown/binary` read only, with Turn on / Turn off
  buttons behind `allow_plug_control`, its dimmer read only. A node with a
  setpoint, hot water or a heating mode attribute is a heating whatever its
  profile. The INOVA range (5000–5999) is tested first: the whole alarm,
  sirens included, read only, no button (M4). Locks (`lock/state`), doors,
  valves, sirens (`siren/binary`): read only states plus `button/push`
  features, each kind behind its option. The homee mode is a `text/select`
  (home, sleeping, away, vacation) behind `allow_alarm_control`, its state a
  `text/text`.
- **Doors in v1** (review I4): Open / Close / Stop buttons only on the
  entrance gate operator (2010) and the garage door operator (2012), Home
  Assistant's covers; other doors and window motors show their state, their
  impulse buttons stay. An `OPEN_CLOSE` on a valve or a lock is not a
  contact: left out.
- **Direction** (review I3): `reverse_control_ui` is known from a whole node
  (GET:all, a node message; no `options` there = not reversed); a lone
  attribute message without `options` keeps the direction known. A door
  command is refused when the direction is unknown, or differs from the one
  first seen while running ("restart the integration").
- **Moving** (review I2): opening, closing, or a current value different
  from the target (a move asked, not started) is moving. Stop (2) is always
  sent.
- **Command path** (review I1): option → not paused → connected → impulse
  debounce → serialized per node → option again → deadline → plan → option
  again → deadline (3.5 s) → PUT → the queue is RELEASED → echo awaited until
  4.4 s ("sent, without confirmation" otherwise) → read backs at 3 and 15 s.
  The plan of a sensitive command is computed on the attribute read just
  before (refused at the deadline, 300 ms before it; a read that times out
  puts the attribute in quarantine for 5 s, review M6), except the
  protective ones (lock, close the valve, stop, turn off, stop the siren):
  never refused for the state, always sent, planned on the memory. Direct
  commands (lights, switches, shutters) are sent from the memory, without
  waiting for the echo.
- **No guard any more** (review I1): nothing blocks a device after a
  command. Locks (30 s), doors (90 s) and valves (60 s) await the state
  asked for; not reported in time, the badge says "state not confirmed"
  until the device reports a state (review M1). Impulses: two presses within
  2 s are one bounce, the second refused (review M3); the press after is
  sent (often the stop of a gate).
- **Hot water**: `water_heater_max` 40–60, 55 by default; a setpoint above it
  is refused (never clamped up), the slider stops at 60. Every setpoint of a
  warm water circuit (3029), `TARGET_TEMPERATURE` included, is hot water
  (review I5).
- **Setpoints** (review I5): refused outside the minimum and maximum
  published (the slider: −10…40 °C for heating, 0…60 °C for hot water, and
  the range of the attribute); rounded to its step; °F attributes converted.
  Heating mode read only in M1.
- **Covers**: homee position 0 open … 100 closed, Gladys the percentage open;
  states 0 open, 1 closed, 2 stopped, 3 opening, 4 closing, swapped by
  `reverse_control_ui` (Home Assistant).
- **Energy** (review B1): `ACCUMULATED_ENERGY_USE` in kWh (Wh converted) is a
  cumulative index (`switch/energy` on a switch, else `energy-sensor/index`)
  billed by the core. Each such feature has an `IndexGuard` taken AS IS from
  gladys-p1-monitor (`src/guard.js`: margin, follows, acceptHeld,
  withinAccepted; not indexOfTariffs), the maximum power a parameter
  (INDEX_MAX_KW = 25 kW, + 0.5 kWh). Its reference is the value Gladys holds
  (`last_value` / `last_value_changed` of `gladys.devices`) or the state
  kept in `/data/state.json` (`indexes`, validated, bounded to 1000 ids of
  ours, a held value dated at its loading). Never 0; a drop or a jump is
  held, never confirmed by repetition nor time: the last accepted value is
  sent again, the hold is logged and the badge of the device sums up all its
  holds (how many, the kWh at stake, 200 characters at most). Only the action
  "Accept the held index" takes it, in two clicks (approval round 1, like
  gladys-hubitat): the first takes nothing and lists every hold of the device
  chosen (feature, direction, from → to, kWh); a second within 60 s takes
  exactly that set if its fingerprint is the same (featureId plus
  `up:from:threshold` for a jump, `down:from` for a drop: a reset meter that
  counts again stays one hold) and each value is still the one listed (a
  jump between its listed `to` and `to` + 25 kW × time since; a drop at most
  `to` + that margin), else it lists again. It answers with the kWh counted;
  saving the configuration or a reconnection never accepts. A hold is
  written to `/data` at once, a new reference alone at most once a minute;
  the keys of the log and of `/data` use the same identity of a hold (no
  flood during a durable drop). A node message without `options` keeps the
  direction known. A device created again starts its guards afresh. Only
  created devices are guarded (nothing is billed otherwise). Never
  `publishEnergyConsumption`.
- **No double count** (review M9): `TOTAL_ACCUMULATED_ENERGY_USE` (the total
  of an energy meter, which may also count the plugs of the box) is a plain
  `unknown/decimal` value ("kWh" in its name), never an index.
  `TOTAL_CURRENT_ENERGY_USE` stays a power (not billed).
- **Live messages bounded** (review M8): a `nodes` message to 2000 nodes, the
  attributes of a node to 400 (new ones over it ignored). Names decoded like
  Python's unquote: a "+" stays a "+" (M15).
- **Units**: only the core's units for the category; a temperature, power,
  energy, illuminance, wind or rain attribute in another unit is left out.
  Valve opening `unknown/integer` without a unit ("%" in its name).
- **Rates**: states through `publishChangedStates` (30-min heartbeat) within
  250 states a minute, measurements spaced by `sensor_interval` (10 s).
- **Not checked by this session**: the store validator
  (`npx github:GladysAssistant/integration-store .`, run by the pipeline in
  the real terminal), the Docker build (no Docker on this PC), the forum,
  Will_71's list, the core and GitHub for duplicates (done by the pipeline
  before the wave).
