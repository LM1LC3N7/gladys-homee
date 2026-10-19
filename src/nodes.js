// -----------------------------------------------------------------------------
// The nodes and attributes of the box, from its JSON, into plain records
// (pure). Only the known fields are read, as numbers or bounded strings; an
// attribute without a usable id, type or value is left out. The names are
// URL-encoded by the box (pyHomee unquotes them).
//
// node      { id, name, profile, state, protocol, attributes: Map<id, attribute> }
// attribute { id, nodeId, instance, type, min, max, current, target, step,
//             unit, editable, state, reversed, data, at }
// `at` numbers the message that last changed the attribute (src/app.js).
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** decodeURIComponent that never throws (a lone "%" leaves the text as it is). */
function unescaped(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** A text of the box, decoded, without control characters, bounded. */
export function decode(text, max = 100) {
  const raw = typeof text === 'string' ? text : '';
  return unescaped(raw)
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, max);
}

const finite = (v) => {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
    return Number(v);
  }
  return undefined;
};

const int = (v) => {
  const n = finite(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};

/** One attribute of the JSON, or undefined. */
export function attributeOf(raw, at = 0) {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const id = int(raw.id);
  const nodeId = int(raw.node_id);
  const type = int(raw.type);
  const current = finite(raw.current_value);
  if (id === undefined || nodeId === undefined || type === undefined || current === undefined) {
    return undefined;
  }
  const min = finite(raw.minimum);
  const max = finite(raw.maximum);
  const options = raw.options && typeof raw.options === 'object' ? raw.options : undefined;
  return {
    id,
    nodeId,
    instance: int(raw.instance) ?? 0,
    type,
    min: min ?? 0,
    max: max !== undefined && max >= (min ?? 0) ? max : (min ?? 0) + 1,
    current,
    target: finite(raw.target_value) ?? current,
    step: finite(raw.step_value) ?? 1,
    unit: decode(raw.unit, 20),
    editable: raw.editable === 1 || raw.editable === true,
    state: int(raw.state) ?? 1,
    reversed: options?.reverse_control_ui === true || options?.reverse_control_ui === 1,
    data: decode(raw.data, 200),
    at,
  };
}

/** One node of the JSON, or undefined. */
export function nodeOf(raw, at = 0) {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const id = int(raw.id);
  if (id === undefined) {
    return undefined;
  }
  const attributes = new Map();
  const list = Array.isArray(raw.attributes) ? raw.attributes : [];
  for (const entry of list.slice(0, LIMITS.attributesPerNode)) {
    const attribute = attributeOf(entry, at);
    if (attribute && attribute.nodeId === id && !attributes.has(attribute.id)) {
      attributes.set(attribute.id, attribute);
    }
  }
  return {
    id,
    name: decode(raw.name) || `homee ${id}`,
    profile: int(raw.profile) ?? 0,
    state: int(raw.state) ?? 1,
    protocol: int(raw.protocol) ?? 0,
    attributes,
  };
}

/** The nodes of an "all" or a "nodes" message: id -> node. */
export function nodesOf(list, at = 0) {
  const nodes = new Map();
  if (!Array.isArray(list)) {
    return nodes;
  }
  for (const raw of list.slice(0, LIMITS.nodes)) {
    const node = nodeOf(raw, at);
    if (node && !nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  }
  return nodes;
}

/** The box itself, from the settings of "all": { uid, name, version }. */
export function settingsOf(raw) {
  const uid = typeof raw?.uid === 'string' ? raw.uid.trim() : '';
  return {
    uid: /^[A-Za-z0-9]{6,32}$/.test(uid) ? uid.toLowerCase() : undefined,
    name: decode(raw?.homee_name) || 'homee',
    version: decode(raw?.version, 40),
  };
}

/** The node with one attribute replaced (records are replaced, never mutated). */
export function withAttribute(node, attribute) {
  const attributes = new Map(node.attributes);
  attributes.set(attribute.id, attribute);
  return { ...node, attributes };
}

/**
 * A node read again, merged with the one known: an attribute a message
 * changed after `since` keeps that value (a full read may be older).
 */
export function mergeNode(known, fresh, since) {
  if (!known) {
    return fresh;
  }
  const attributes = new Map();
  for (const [id, attribute] of fresh.attributes) {
    const before = known.attributes.get(id);
    attributes.set(id, before && before.at > since ? before : attribute);
  }
  return { ...fresh, attributes };
}

/** The first attribute of a type (and instance, when given) of a node. */
export function attributeByType(node, type, instance) {
  for (const attribute of node.attributes.values()) {
    if (attribute.type === type && (instance === undefined || attribute.instance === instance)) {
      return attribute;
    }
  }
  return undefined;
}
