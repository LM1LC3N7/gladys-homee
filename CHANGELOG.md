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
  tab: lights (on/off, brightness, colour temperature), wall switches and
  dimmers, plugs with power and energy, roller shutters (open, close, stop,
  position), thermostats and radiator heads (temperature, setpoint, valve
  opening, heating mode), hot water (temperature, setpoint), locks, garage
  doors, gates, window motors, impulse relays, water valves, sirens, the
  homee mode, and contact, window, motion, presence, leak, smoke, CO, tamper
  and low battery sensors, temperature, humidity, illuminance, CO2, UV, wind,
  rain, current and voltage.
- The local connection of the box: a token (`POST /access_token`, kept in
  memory, renewed before its end, never in a loop; a refused websocket is
  told from a network failure by a probe of the port), the websocket with the
  live states, the whole box read again every 10 minutes (no answer in 30 s:
  the connection is opened again; a read pending is shared), a lost
  connection opened again after 5 s doubling to 5 minutes.
- Safety: only lights and plain wall relays get a switch. Plugs, metering
  relays, any other device, heating, locks, doors and gates, valves, sirens
  and the homee mode never do ("turn everything off" never reaches them):
  their state is read-only and their commands are buttons (a list for the
  mode), each behind its own option, all off by default. Each such command
  is decided on the state read just before, refused when it is unknown or
  moving, the option checked again just before sending, the echo of the box
  awaited ("sent, without confirmation" otherwise). The protective commands
  (lock, close the valve, stop, turn off, stop the siren) are never refused
  for the state, and a command never waits behind the echo of another. Doors:
  Open / Close / Stop on garage doors and entrance gates only, refused when
  the direction of the door is unknown or changed. The INOVA alarm is read
  only.
- Hot water setpoint capped at 55 °C by default, never above 60 °C, also on
  warm water circuits; every setpoint refused outside the range published.
- Refused credentials stop the integration, persisted in `/data` (a salted
  fingerprint only), tried again after 1 h doubling to 24 h, or at once by
  the test button or a new configuration (the count of refusals kept). A
  429 pauses every path, persisted.
- Energy indexes guarded like gladys-p1-monitor: never 0, a drop or a jump
  held (the last value sent again, the kWh waiting on the badge and in the
  log, kept in `/data`), taken only by the new action "Accept the held
  index" for the device chosen, which tells the kWh counted. The total of an
  energy meter is a plain value, so the energy of the plugs is never counted
  twice.
- Transport badges (box unreachable, node unavailable, state not confirmed,
  energy index held), a "Test the connection" button that reuses the
  connection in use, English and French texts.

[Unreleased]: https://github.com/LM1LC3N7/gladys-homee/commits/main
