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
- `ON_OFF` on a water valve: whether 1 means open; the buttons are named
  "Turn on" / "Turn off" until checked. The `CURRENT_VALVE_POSITION` buttons
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
  doubling to 24 h). A restart keeps it; a configuration saved by the user or
  the test button tries at once (a test that works starts the integration
  again).
- **429**: pause of every path (Retry-After, 1 min to 6 h), persisted and
  bounded when read back; the test button and commands respect it.
- **Reconnection**: 5 s doubling to 5 min; `GET:all` every 10 minutes, no
  answer within 30 s reopens the socket (watchdog). A reconnection to Gladys
  keeps token, socket, pause and refusal, and publishes status, Discovery and
  badges again.
- **External ids**: `homee:<uid>-<node id>` (`<uid>-box` for the box itself,
  node -1); feature keys `a<attribute id>` and `a<attribute id>-<command>`
  for the buttons. The uid comes from the settings of `GET:all` (lower case);
  without it nothing is published.
- **Kinds and safety** (brief, lot 6 lesson): lock, door (garage doors,
  gates, doors, window motors, impulse plugs and relays), valve (water valve
  profile), siren, alarm (INOVA, read only), heating (thermostats, radiator
  heads, electric heating, heating systems and circuits, warm water), plug
  (on/off and metering plugs: the load is unknown). These never get a switch:
  `unknown/binary` (or `lock/state`, `siren/binary`, `opening-sensor/binary`)
  read only, plus `button/push` features, each kind behind its option. The
  homee mode is a `text/select` (home, sleeping, away, vacation) behind
  `allow_alarm_control`, its state a `text/text`. Dimmable plugs are lights
  (Home Assistant's profile groups): dimming implies a lamp.
- **Sensitive command path**: option → not paused → connected → guard →
  serialized per node → option again → fresh read (refused at the deadline,
  300 ms before it) → node and attribute available → plan (already in place:
  nothing sent) → option again → deadline (3.5 s) → PUT → guard → echo
  awaited until 4.4 s ("sent, without confirmation" otherwise) → read backs
  at 3 and 15 s. Direct commands (lights, switches, shutters) are sent from
  the memory, without waiting for the echo.
- **Guards**: lock 30 s, door 90 s, valve 60 s, impulse 10 s (no state to
  wait for; the second press of an impulse is often the stop); a guard not
  lifted in time sets the "state not confirmed" badge.
- **Hot water**: `water_heater_max` 40–60, 55 by default; a setpoint above it
  is refused (never clamped up), the slider stops at 60.
- **Heating setpoints**: rounded to the step of the attribute, inside its
  range; °F attributes converted. Heating mode read only in M1.
- **Covers**: homee position 0 open … 100 closed, Gladys the percentage open;
  states 0 open, 1 closed, 2 stopped, 3 opening, 4 closing, swapped by
  `reverse_control_ui` (Home Assistant).
- **Energy** (lot 6 lesson): `ACCUMULATED_ENERGY_USE` and
  `TOTAL_ACCUMULATED_ENERGY_USE` in kWh (Wh converted) are cumulative indexes
  (`switch/energy` on a switch, else `energy-sensor/index`). A lower reading,
  0 included, is held and taken only when a later one is strictly above it;
  a jump above 1 kWh + 25 kW × the time since the last reading is held and
  taken only when a later reading goes on from it plausibly (a repetition is
  not enough). Never `publishEnergyConsumption`.
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
