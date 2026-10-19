// The answer of a simulated homee to GET:all, in the shape pyHomee reads
// (nodes with their attributes, settings with the uid). Names and units are
// URL-encoded like the box sends them. Built in code to stay readable.

export const UID = '0123456789AB';

/** One attribute as the box sends it. */
export function attr(id, nodeId, type, current, options = {}) {
  const {
    min = 0,
    max = 1,
    unit = 'n%2Fa',
    editable = 0,
    step = 1,
    instance = 0,
    target = current,
    state = 1,
  } = options;
  return {
    id,
    node_id: nodeId,
    instance,
    minimum: min,
    maximum: max,
    current_value: current,
    target_value: target,
    last_value: current,
    unit,
    step_value: step,
    editable,
    type,
    state,
    last_changed: 1760000000,
    changed_by: 1,
    changed_by_id: 0,
    based_on: 1,
    data: '',
    name: '',
  };
}

const C = '%C2%B0C';

/** One node as the box sends it. */
export function node(id, name, profile, attributes, { state = 1 } = {}) {
  return {
    id,
    name: encodeURIComponent(name),
    profile,
    image: 'default',
    favorite: 0,
    order: id,
    protocol: 1,
    routing: 0,
    state,
    state_changed: 1760000000,
    added: 1750000000,
    history: 1,
    cube_type: 1,
    note: '',
    services: 0,
    phonetic_name: '',
    owner: 2,
    security: 0,
    attributes,
  };
}

export function allBody() {
  return {
    settings: {
      uid: UID,
      homee_name: 'Maison',
      version: '2.41.0',
      language: 'fr',
      remote_access: 1,
    },
    nodes: [
      node(-1, 'homee', 1, [attr(1, -1, 205, 0, { max: 3, unit: '', editable: 1 })]),
      node(10, 'Plafonnier', 1003, [
        attr(101, 10, 1, 1, { editable: 1 }),
        attr(102, 10, 2, 60, { max: 100, unit: '%25', editable: 1 }),
        attr(103, 10, 42, 3000, { min: 2700, max: 6500, unit: 'K', editable: 1 }),
      ]),
      node(11, 'Interrupteur cuisine', 16, [attr(111, 11, 1, 0, { editable: 1 })]),
      node(12, 'Prise congélateur', 13, [
        attr(121, 12, 1, 1, { editable: 1 }),
        attr(122, 12, 3, 85.5, { max: 3600, unit: 'W' }),
        attr(123, 12, 4, 312.4, { max: 1e6, unit: 'kWh' }),
      ]),
      node(13, 'Volet salon', 2004, [
        attr(131, 13, 135, 1, { max: 4, editable: 1 }),
        attr(132, 13, 15, 100, { max: 100, unit: '%25', editable: 1 }),
      ]),
      node(14, 'Porte de garage', 2012, [attr(141, 14, 14, 1, { max: 4, editable: 1 })]),
      node(15, 'Serrure entrée', 2007, [attr(151, 15, 232, 1, { max: 2, editable: 1 })]),
      node(16, 'Radiateur chambre', 3006, [
        attr(161, 16, 5, 19.5, { min: -20, max: 60, unit: C }),
        attr(162, 16, 6, 20, { min: 4, max: 28, step: 0.5, unit: C, editable: 1 }),
        attr(163, 16, 18, 30, { max: 100, unit: '%25' }),
        attr(164, 16, 8, 80, { max: 100, unit: '%25' }),
      ]),
      node(17, "Ballon d'eau chaude", 3029, [
        attr(171, 17, 31, 48, { max: 100, unit: C }),
        attr(172, 17, 32, 50, { min: 30, max: 70, unit: C, editable: 1 }),
      ]),
      node(18, "Vanne d'arrivée d'eau", 3011, [
        attr(181, 18, 18, 100, { max: 100, unit: '%25', editable: 1 }),
      ]),
      node(19, 'Sirène', 4027, [attr(191, 19, 13, 0, { editable: 1 })]),
      node(20, 'Fenêtre salon', 2000, [
        attr(201, 20, 14, 0),
        attr(202, 20, 8, 90, { max: 100, unit: '%25' }),
      ]),
      node(21, 'Détecteur couloir', 4015, [
        attr(211, 21, 25, 0),
        attr(212, 21, 5, 21, { min: -20, max: 60, unit: C }),
        attr(213, 21, 11, 120, { max: 100000, unit: 'lx' }),
      ]),
      node(22, 'Détecteur de fumée', 4012, [attr(221, 22, 16, 0), attr(222, 22, 69, 0)]),
      node(23, 'Télécommande', 26, [attr(231, 23, 40, 0, { max: 2 })]),
      node(24, 'Radiateur électrique', 3024, [
        attr(241, 24, 1, 1, { editable: 1 }),
        attr(242, 24, 3, 1500, { max: 3000, unit: 'W' }),
      ]),
    ],
    groups: [],
    relationships: [],
    homeegrams: [],
    users: [],
    devices: [],
  };
}

/** The devices offered: every node but the remote (nothing to show yet). */
export const OFFERED = 15;
