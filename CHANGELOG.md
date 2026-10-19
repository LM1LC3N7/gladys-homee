# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The nodes of a homee box (Z-Wave, Zigbee, EnOcean), offered in the Discovery
  tab: lights (on/off, brightness, colour temperature), switches and dimmers,
  plugs with power and energy, roller shutters (open, close, stop, position),
  thermostats and radiator heads (temperature, setpoint, valve opening,
  heating mode), hot water (temperature, setpoint), locks, garage doors,
  gates, window motors, impulse relays, water valves, sirens, the homee mode,
  and contact, window, motion, presence, leak, smoke, CO, tamper and low
  battery sensors, temperature, humidity, illuminance, CO2, UV, wind, rain,
  current and voltage.
- The local connection of the box: a token (`POST /access_token`, kept in
  memory, renewed before its end, never in a loop), the websocket with the
  live states, the whole box read again every 10 minutes (no answer in 30 s:
  the connection is opened again), a lost connection opened again after 5 s
  doubling to 5 minutes.
- Safety: plugs, heating, locks, doors and gates, valves, sirens and the homee
  mode never get a switch ("turn everything off" never reaches them); their
  state is read-only and their commands are buttons (a list for the mode),
  each behind its own option, all off by default. Each such command is
  decided on the state read just before, refused when it is unknown or
  moving, the option checked again just before sending, the echo of the box
  awaited ("sent, without confirmation" otherwise); locks, doors and valves
  are then guarded until they report the state asked for.
- Hot water setpoint capped at 55 °C by default, never above 60 °C.
- Refused credentials stop the integration, persisted in `/data` (a salted
  fingerprint only), tried again after 1 h doubling to 24 h, or at once by
  the test button or a new configuration. A 429 pauses every path, persisted.
- Energy index protected against drops and implausible jumps.
- Transport badges (box unreachable, node unavailable, state not confirmed),
  a "Test the connection" button, English and French texts.

[Unreleased]: https://github.com/LM1LC3N7/gladys-homee/commits/main
