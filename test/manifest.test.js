// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake and a BOM (lesson of the first wave), and
// the docs against an "encrypted" claim.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, LANGUAGES, SENSOR_INTERVAL, WATER_HEATER_MAX } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, version 0.1.0 everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-homee:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'gladys-homee');
  assert.equal(manifest.version, pkg.version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-homee/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`).replace(/\s*\n>?\s*/g, ' ');
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+homee|sans\s+lien\s+avec\s+homee/);
    assert.match(
      docs,
      /never\s+been\s+tested\s+with\s+a\s+real|jamais\s+été\s+testée\s+avec\s+un\s+vrai/,
    );
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('cover.png is a PNG of 800 × 534', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('no mojibake (UTF-8 read as Latin-1) nor BOM in the text files', () => {
  // "Ã©" for "é", "Â " for a no-break space, "â€" for a dash or a quote…
  const mojibake = /[ÂÃ][\u0080-¿€]|â€/;
  for (const path of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'THIRD_PARTY_NOTICES.md',
    'src/i18n.js',
  ]) {
    const text = read(path);
    assert.ok(!text.startsWith('﻿'), `${path} starts with a BOM`);
    const match = mojibake.exec(text);
    assert.equal(match, null, `${path}: mojibake "${match?.[0]}" at ${match?.index}`);
  }
});

test('the MIT notice of pyHomee ships with the code, LICENSE is Apache-2.0 without a name', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Taraman17\/pyHomee/);
  assert.match(notices, /Copyright \(c\) 2025 Karl Moeller, Markus Adrario/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.doesNotMatch(license, /Copyright \d{4} [A-Z][a-z]+ [A-Z]/, 'no person named');
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code; every sensitive option is off by default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    if (fields[key].default !== undefined || value !== '') {
      assert.deepEqual(fields[key].default, value, key);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.ok(field.key in DEFAULTS, `${field.key} has no default in the code`);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.equal(fields.password.type, 'secret', 'the password is never sent back to the browser');
  for (const key of ['host', 'username', 'password']) {
    assert.equal(fields[key].required, true, key);
  }
  assert.deepEqual(
    [fields.sensor_interval.min, fields.sensor_interval.max],
    [SENSOR_INTERVAL.min, SENSOR_INTERVAL.max],
  );
  assert.deepEqual(
    [fields.water_heater_max.min, fields.water_heater_max.max, fields.water_heater_max.default],
    [WATER_HEATER_MAX.min, 65, 65],
  );
  for (const key of [
    'allow_plug_control',
    'allow_heating_control',
    'allow_lock_control',
    'allow_door_control',
    'allow_valve_control',
    'allow_siren_control',
    'allow_alarm_control',
  ]) {
    assert.equal(fields[key].type, 'boolean');
    assert.equal(fields[key].default, false, `${key} is off by default (Louis's rule)`);
  }
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
  }
  assert.ok(intro.links.every((l) => l.url.startsWith('https://')));
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.ok(handlers.includes('onSetValue'), 'the commands go through onSetValue');
  // The test button: token 10 s, socket 10 s, the whole box 30 s.
  assert.equal(manifest.actions.find((a) => a.key === ACTIONS.TEST).timeout_seconds, 60);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the password is never said to be encrypted (Gladys keeps secrets in clear in its database)', () => {
  const password = manifest.config_schema.find((f) => f.key === 'password');
  for (const lang of ['en', 'fr']) {
    assert.doesNotMatch(password.description[lang], /encrypt|chiffr/i);
    assert.match(password.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
    assert.doesNotMatch(read(`docs/${lang}.md`), /encrypt|chiffr/i);
  }
  assert.doesNotMatch(read('README.md'), /encrypt|chiffr/i);
});

test('nothing logs a password, a token or the websocket URL', () => {
  for (const path of ['src/app.js', 'src/homee.js', 'src/live.js', 'src/store.js']) {
    const code = read(path);
    for (const line of code.split('\n').filter((l) => /logger\.(info|warn|error|debug)/.test(l))) {
      assert.doesNotMatch(
        line,
        /password|token\b|\.value|socketUrl|access_token/i,
        `${path}: ${line.trim()}`,
      );
    }
  }
});
