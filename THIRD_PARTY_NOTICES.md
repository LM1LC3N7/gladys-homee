# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below, under their own licences.

## pyHomee

- Project: [Taraman17/pyHomee](https://github.com/Taraman17/pyHomee), version
  1.4.6 (tag `v1.4.6`, 2026-10-02), the Python library of the homee
  integration of Home Assistant.
- What is ported (rewritten in JavaScript in `src/homee.js`, `src/live.js`,
  `src/nodes.js`, `src/constants.js` and `src/mapping.js`): the token request
  (`POST /access_token` on port 7681, HTTP Basic with the SHA-512 of the
  password, the `device_*` form fields, the query-string answer with
  `access_token` and `expires`), the websocket (`/connection?access_token=`,
  subprotocol `v2`, the `GET:all`, `GET:nodes/…/attributes/…` and
  `PUT:nodes/…/attributes/…?target_value=` messages, the one-key JSON
  messages `all`, `attribute`, `node`, `nodes`, `warning`), the fields of
  nodes, attributes and settings (names URL-encoded), and the numbers of the
  node profiles, attribute types, node states and warning codes (learn mode).
- Licence: MIT.

```
MIT License

Copyright (c) 2025 Karl Moeller, Markus Adrario

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, homee integration

- Project: [home-assistant/core](https://github.com/home-assistant/core),
  `homeassistant/components/homee` (read at commit `07b62c8`, 2026-10-19), by
  the Home Assistant contributors.
- What is ported (rewritten in JavaScript in `src/mapping.js`): the profile
  groups of lights and thermostats, which attribute types are sensors, binary
  sensors, switches, buttons, locks, sirens and valves, the meaning of their
  values (cover states 0 open, 1 closed, 2 stopped, 3 opening, 4 closing and
  `reverse_control_ui`; the position counted from open; the lock unlatch value
  2 or -1; window positions; heating modes; units such as klx), and the rule
  that an attribute state from 5 on is unavailable.
- Licence: Apache License 2.0, the licence of this integration (full text in
  `LICENSE`).
