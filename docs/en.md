# homee

This integration connects your **homee** box (Z-Wave, Zigbee, EnOcean,
depending on its cubes) to Gladys Assistant, locally: the devices paired with
the box become Gladys devices, their states follow the box live and Gladys
controls them through it.

> Unofficial integration, not affiliated with homee GmbH. It has **never been
> tested with a real homee**: it was written from the pyHomee library and the
> homee integration of Home Assistant, and tested against a simulated box.
> Your feedback is welcome.

## What is supported

- **Lights**: on/off, brightness, colour temperature.
- **Switches** (wall relays): on/off, dimmer.
- **Plugs**: state, power, energy (cumulative index), and "Turn on" / "Turn
  off" buttons behind an option (see below).
- **Roller shutters**: open, close, stop, position.
- **Thermostats and radiator heads**: temperature, setpoint, valve opening,
  battery, heating mode (read).
- **Hot water**: temperature, setpoint (capped).
- **Sensors**: opening, window, motion, presence, leak and flood, smoke,
  carbon monoxide, tamper, low battery, temperature, humidity, illuminance,
  CO2, UV, wind, rain, current, voltage.
- **Locks, garage doors, gates, window motors, impulse relays, water valves,
  sirens, the homee mode**: read-only state, and buttons (or a list for the
  mode) that work only when you allow them.
- Remotes and wall buttons (presses), homeegrams and the INOVA alarm are not
  handled yet.

## Configuration

1. In the homee app, preferably create a **user of its own** for Gladys.
2. Note the **local IP address** of the box (Settings → homee, or your
   router). Give it a fixed address.
3. In Gladys, Integrations → homee: type the IP address, the user name and the
   password, then **Test the connection**.
4. In the **Discovery** tab, add the devices you want.

The password is a secret field: it is kept by Gladys in its database, never
shown again, and sent only to your homee (as its SHA-512 fingerprint, like the
homee apps do). The integration only uses the local connection of the box
(port 7681), never my.hom.ee.

## Safety: what stays read-only

A "turn everything off" (Google Home, Alexa, HomeKit, MCP, a scene) must never
reach a valve, a lock, a siren, a heating or the unknown load of a plug. These
devices therefore **never get a switch** in Gladys: their state is read-only
and their commands are buttons, refused while the matching option is off (all
are off by default):

| Option                        | What it allows                                                 |
| ----------------------------- | -------------------------------------------------------------- |
| Allow plug control            | Turn on / Turn off buttons of plugs                            |
| Allow heating control         | Thermostat and hot water setpoints, on/off of electric heaters |
| Allow lock control            | Lock, Unlock, Unlatch                                          |
| Allow door and gate control   | Open, Close, Stop, impulses                                    |
| Allow valve control           | Open / Close water valves                                      |
| Allow siren control           | Sound / Stop the siren                                         |
| Allow changing the homee mode | Home, Sleeping, Away, Vacation (a list)                        |

For each of these commands, the integration reads the state of the device just
before, refuses when that state is unknown or moving, checks the option one
last time just before sending, and waits for the box to confirm. Without a
confirmation in time, Gladys shows "Command sent, without confirmation from
the homee": check the device. A lock, a door or a valve is then guarded until
it reports the state asked for (30 s, 90 s or 60 s at most). A command that
cannot leave within 3.5 s is refused, never sent late.

The hot water setpoint is capped at **55 °C** by default (scalding risk),
adjustable up to **60 °C** at most. The valves of radiator heads are never
controlled directly: they follow their setpoint.

## Connection and errors

- A token is asked from the box when connecting and kept in memory only; it is
  renewed before its end, never in a loop.
- A lost live connection is opened again after 5 s, then 10 s, 20 s… up to
  5 minutes between two tries. The whole box is read again every 10 minutes;
  without an answer within 30 s, the connection is opened again.
- **Refused credentials**: the integration stops and notes it in `/data`
  (without the user name or the password, only a salted fingerprint). Next
  automatic try after 1 h, then 2 h, 4 h… up to 24 h; "Test the connection"
  or saving the configuration tries at once.
- If the box asks to slow down (HTTP 429), the integration pauses (1 minute to
  6 hours), kept even across a restart.

## Known limits

- Never tested with a real homee (see above): the profiles and the meaning of
  some values come from pyHomee and Home Assistant.
- Feature names are set when the device is added.
- Remote presses, homeegrams, groups and the INOVA alarm are not handled yet.

## Credits

- [pyHomee](https://github.com/Taraman17/pyHomee) (MIT), the library of the
  homee integration of Home Assistant, whose protocol is ported.
- The homee integration of [Home Assistant](https://github.com/home-assistant/core)
  (Apache-2.0), for the meaning of the profiles and values.
