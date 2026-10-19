// -----------------------------------------------------------------------------
// The homee nodes -> Gladys devices and routing tables (pure).
//
// One Gladys device per node of the box. External ids:
//   device  ext:<selector>:homee:<box uid>-<node id>   (the box itself: <uid>-box)
//   feature <device>:a<attribute id>[-<command>]     (src/mapping.js)
// The uid of the box and the ids of its nodes and attributes do not change
// while a device stays paired: the external ids stay stable. A node paired
// again gets a new id, so a new device.
//
// No lost feature (lot 6 lesson): the features of a device already created in
// Gladys that a new build lacks are published again as they are, so the core
// never sees a structure change that "Update" would turn into lost history.
// -----------------------------------------------------------------------------

import { LIMITS, PROFILE } from './constants.js';
import { mapNode } from './mapping.js';

export const platformIdOf = (uid, nodeId) => (nodeId === -1 ? `${uid}-box` : `${uid}-${nodeId}`);

/** The fields of a feature that Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

const declared = (feature) =>
  Object.fromEntries(
    DECLARED.filter((k) => feature[k] !== undefined && feature[k] !== null).map((k) => [
      k,
      feature[k],
    ]),
  );

const paramsOf = (node, uid) =>
  [
    { name: 'HOMEE_UID', value: uid },
    { name: 'HOMEE_NODE_ID', value: node.id },
    { name: 'HOMEE_PROFILE', value: node.profile },
  ].map((p) => ({ name: p.name, value: String(p.value).slice(0, 255) }));

export function emptyModel() {
  return {
    devices: [],
    /** "<node id>:<attribute id>" -> [{ featureId, read, meter, text }] */
    readers: new Map(),
    /** feature id -> writer (src/mapping.js) with its node id */
    writers: new Map(),
    throttled: new Set(),
    /** Gladys device id -> node id */
    deviceIds: new Map(),
    /** node id -> Gladys device id */
    nodeDevices: new Map(),
    counts: { nodes: 0, empty: 0, overflow: 0 },
  };
}

/**
 * @param {(platformId: string) => { device: string, feature: (key: string) => string }} idsOf
 *   the external ids of one device (gladys.externalIds('homee', platformId))
 * @param {Iterable<object>} nodes see src/nodes.js
 * @param {{ uid: string, name?: string }} box from the settings of the box
 * @param {{ language?: 'fr'|'en', created?: object[] }} [options]
 *   created: the devices already created in Gladys (gladys.devices)
 */
export function buildModel(idsOf, nodes, box, { language = 'fr', created = [] } = {}) {
  const model = emptyModel();
  const createdById = new Map((created ?? []).map((d) => [d?.external_id, d]));
  for (const node of nodes) {
    model.counts.nodes += 1;
    const mapped = mapNode(node, { language });
    if (mapped.features.length === 0) {
      model.counts.empty += 1;
      continue;
    }
    if (model.devices.length >= LIMITS.devices) {
      model.counts.overflow += 1;
      continue;
    }
    const ids = idsOf(platformIdOf(box.uid, node.id));
    const features = mapped.features.map(({ key, ...feature }) => ({
      ...feature,
      external_id: ids.feature(key),
    }));
    const known = new Set(features.map((f) => f.external_id));
    for (const old of createdById.get(ids.device)?.features ?? []) {
      if (old?.external_id && !known.has(old.external_id)) {
        features.push(declared(old));
        known.add(old.external_id);
      }
    }
    const name = node.id === -1 || node.profile === PROFILE.HOMEE ? box.name || 'homee' : node.name;
    model.devices.push({
      name: String(name).slice(0, 100),
      external_id: ids.device,
      should_poll: false,
      params: paramsOf(node, box.uid),
      features,
    });
    model.deviceIds.set(ids.device, node.id);
    model.nodeDevices.set(node.id, ids.device);
    for (const reader of mapped.readers) {
      const key = `${node.id}:${reader.attr}`;
      const list = model.readers.get(key) ?? [];
      list.push({
        featureId: ids.feature(reader.key),
        read: reader.read,
        meter: reader.meter === true,
        text: reader.text === true,
      });
      model.readers.set(key, list);
    }
    for (const [key, writer] of Object.entries(mapped.writers)) {
      model.writers.set(ids.feature(key), { ...writer, nodeId: node.id });
    }
    for (const key of mapped.throttled) {
      model.throttled.add(ids.feature(key));
    }
  }
  return model;
}
