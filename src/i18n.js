// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, badges, refusals, feature
// names), in English and French. Never put a password or a token in one.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Feature names ("Node – <label>"), by label key. */
const LABELS = {
  brightness: { en: 'Brightness', fr: 'Luminosité' },
  color: { en: 'Colour', fr: 'Couleur' },
  colorTemperature: { en: 'Colour temperature', fr: 'Température de couleur' },
  position: { en: 'Position', fr: 'Position' },
  door: { en: 'State', fr: 'État' },
  open: { en: 'Open', fr: 'Ouvrir' },
  close: { en: 'Close', fr: 'Fermer' },
  stop: { en: 'Stop', fr: 'Arrêter' },
  impulse: { en: 'Impulse', fr: 'Impulsion' },
  openPartial: { en: 'Open partially', fr: 'Ouvrir partiellement' },
  automaticMode: { en: 'Automatic mode', fr: 'Mode automatique' },
  brieflyOpen: { en: 'Open briefly', fr: 'Ouvrir brièvement' },
  permanentlyOpen: { en: 'Open permanently', fr: 'Ouvrir en permanence' },
  ventilate: { en: 'Ventilate', fr: 'Aérer' },
  lock: { en: 'Lock', fr: 'Verrouiller' },
  unlock: { en: 'Unlock', fr: 'Déverrouiller' },
  unlatch: { en: 'Unlatch (open)', fr: 'Ouvrir (déverrouiller et tirer le pêne)' },
  turnOn: { en: 'Turn on', fr: 'Allumer' },
  turnOff: { en: 'Turn off', fr: 'Éteindre' },
  sirenOn: { en: 'Sound the siren', fr: 'Déclencher la sirène' },
  sirenOff: { en: 'Stop the siren', fr: 'Arrêter la sirène' },
  valvePosition: { en: 'Valve opening (%)', fr: 'Ouverture de la vanne (%)' },
  valveOpen: { en: 'Open the valve', fr: 'Ouvrir la vanne' },
  valveClose: { en: 'Close the valve', fr: 'Fermer la vanne' },
  setpoint: { en: 'Setpoint', fr: 'Consigne' },
  warmWaterSetpoint: { en: 'Hot water setpoint', fr: "Consigne d'eau chaude" },
  heatingMode: { en: 'Heating mode', fr: 'Mode de chauffage' },
  heating_off: { en: 'Off', fr: 'Arrêt' },
  heating_heat: { en: 'Heating', fr: 'Chauffage' },
  heating_eco: { en: 'Eco', fr: 'Éco' },
  heating_boost: { en: 'Boost', fr: 'Boost' },
  heating_manual: { en: 'Manual', fr: 'Manuel' },
  homeeMode: { en: 'Mode', fr: 'Mode' },
  homeeModeCommand: { en: 'Change the mode', fr: 'Changer le mode' },
  temperature: { en: 'Temperature', fr: 'Température' },
  indoorTemperature: { en: 'Indoor temperature', fr: 'Température intérieure' },
  outdoorTemperature: { en: 'Outdoor temperature', fr: 'Température extérieure' },
  floorTemperature: { en: 'Floor temperature', fr: 'Température du sol' },
  externalTemperature: { en: 'External probe', fr: 'Sonde externe' },
  feedTemperature: { en: 'Flow temperature', fr: 'Température de départ' },
  warmWaterTemperature: { en: 'Hot water temperature', fr: "Température de l'eau chaude" },
  deviceTemperature: { en: 'Device temperature', fr: "Température de l'appareil" },
  humidity: { en: 'Humidity', fr: 'Humidité' },
  indoorHumidity: { en: 'Indoor humidity', fr: 'Humidité intérieure' },
  outdoorHumidity: { en: 'Outdoor humidity', fr: 'Humidité extérieure' },
  co2: { en: 'CO2', fr: 'CO2' },
  uv: { en: 'UV index', fr: 'Indice UV' },
  illuminance: { en: 'Illuminance', fr: 'Luminosité ambiante' },
  battery: { en: 'Battery', fr: 'Batterie' },
  batteryLow: { en: 'Low battery', fr: 'Batterie faible' },
  power: { en: 'Power', fr: 'Puissance' },
  totalPower: { en: 'Total power', fr: 'Puissance totale' },
  energy: { en: 'Energy', fr: 'Énergie' },
  totalEnergy: { en: 'Total energy', fr: 'Énergie totale' },
  current: { en: 'Current', fr: 'Courant' },
  totalCurrent: { en: 'Total current', fr: 'Courant total' },
  voltage: { en: 'Voltage', fr: 'Tension' },
  totalVoltage: { en: 'Total voltage', fr: 'Tension totale' },
  opening: { en: 'Opening', fr: 'Ouverture' },
  window: { en: 'Window', fr: 'Fenêtre' },
  flood: { en: 'Flood', fr: 'Inondation' },
  water: { en: 'Water', fr: 'Eau' },
  leak: { en: 'Leak', fr: 'Fuite' },
  smoke: { en: 'Smoke', fr: 'Fumée' },
  co: { en: 'Carbon monoxide', fr: 'Monoxyde de carbone' },
  motion: { en: 'Motion', fr: 'Mouvement' },
  presence: { en: 'Presence', fr: 'Présence' },
  tamper: { en: 'Tamper', fr: 'Sabotage' },
  windSpeed: { en: 'Wind speed', fr: 'Vitesse du vent' },
  rainHour: { en: 'Rain (last hour)', fr: 'Pluie (dernière heure)' },
  rainToday: { en: 'Rain (today)', fr: "Pluie (aujourd'hui)" },
};

const MODES = {
  home: { en: 'Home', fr: 'À la maison' },
  sleeping: { en: 'Sleeping', fr: 'Nuit' },
  away: { en: 'Away', fr: 'Absent' },
  vacation: { en: 'Vacation', fr: 'Vacances' },
};

/** The label of a key in a language. */
export function label(key, language = 'fr') {
  return LABELS[key]?.[language] ?? LABELS[key]?.en ?? key;
}

/** The name of a homee mode in a language. */
export const modeName = (key, language = 'fr') => MODES[key]?.[language] ?? MODES[key]?.en ?? key;

/** One text of a { en, fr } pair, in a language. */
export const word = (pair, language = 'fr') => pair?.[language] ?? pair?.en ?? '';

const trim = (text) =>
  text.length > LIMITS.badgeMessage ? `${text.slice(0, LIMITS.badgeMessage - 1)}…` : text;

/** A delay in words ("2 h", "15 min"). */
function delay(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
}

export const T = {
  configError(error) {
    switch (error) {
      case 'empty':
        return {
          en: 'Type the IP address of your homee in the configuration, like 192.168.1.60.',
          fr: "Saisissez l'adresse IP de votre homee dans la configuration, par exemple 192.168.1.60.",
        };
      case 'no-user':
        return {
          en: 'Type the homee user name in the configuration.',
          fr: "Saisissez le nom d'utilisateur homee dans la configuration.",
        };
      case 'no-password':
        return {
          en: 'Type the password of this homee user in the configuration.',
          fr: 'Saisissez le mot de passe de cet utilisateur homee dans la configuration.',
        };
      case 'cloud':
        return {
          en: 'my.hom.ee is the cloud access: type the local IP address of the homee, like 192.168.1.60.',
          fr: "my.hom.ee est l'accès cloud : saisissez l'adresse IP locale du homee, par exemple 192.168.1.60.",
        };
      case 'credentials':
        return {
          en: 'No user name or password in the address: they have their own fields.',
          fr: "Pas d'utilisateur ni de mot de passe dans l'adresse : ils ont leurs propres champs.",
        };
      case 'local-name':
        return {
          en: 'Names ending in .local cannot be reached from the integration: type the IP address of the homee.',
          fr: "Les noms en .local ne sont pas joignables depuis l'intégration : saisissez l'adresse IP du homee.",
        };
      default:
        return {
          en: 'The address of the homee is not valid: type its IP address, like 192.168.1.60.',
          fr: "L'adresse du homee n'est pas valide : saisissez son adresse IP, par exemple 192.168.1.60.",
        };
    }
  },
  connecting: { en: 'Connecting to the homee…', fr: 'Connexion au homee…' },
  connected(devices, name) {
    return {
      en: `Connected to ${name}: ${plural(devices, 'device', 'devices')} in Discovery. Live states on.`,
      fr: `Connecté à ${name} : ${plural(devices, 'appareil', 'appareils')} dans Découverte. États en direct actifs.`,
    };
  },
  /** Refused credentials: stopped, retried later (spaced), or by the test button. */
  refused(retryInMs) {
    return {
      en: `The homee refused the user name or the password: check them in the configuration (the "Test the connection" button tries at once). Next try by itself in ${delay(retryInMs)}.`,
      fr: `Le homee a refusé le nom d'utilisateur ou le mot de passe : vérifiez-les dans la configuration (le bouton « Tester la connexion » essaie aussitôt). Prochain essai automatique dans ${delay(retryInMs)}.`,
    };
  },
  /** The status of a failed connection. */
  failure(err) {
    switch (err?.kind) {
      case 'rate':
        return {
          en: 'The homee asks to slow down (too many requests): the integration pauses before trying again.',
          fr: "Le homee demande de ralentir (trop de requêtes) : l'intégration fait une pause avant de réessayer.",
        };
      case 'refused':
        return {
          en: 'The homee closed the live connection: a new token is asked at the next try, in a few seconds.',
          fr: 'Le homee a fermé la connexion en direct : un nouveau jeton est demandé au prochain essai, dans quelques secondes.',
        };
      case 'format':
      case 'api':
        return {
          en: `The homee gave an unexpected answer (${err.message}): is it the IP address of your homee? Retrying in a few minutes.`,
          fr: `Le homee a donné une réponse inattendue (${err.message}) : est-ce bien l'adresse IP de votre homee ? Nouvel essai dans quelques minutes.`,
        };
      default:
        return {
          en: `The homee is unreachable: ${err?.message ?? 'unknown error'}. Check its IP address (not localhost) and that it is on. Retrying, more and more spaced.`,
          fr: `Le homee est injoignable : ${err?.message ?? 'erreur inconnue'}. Vérifiez son adresse IP (pas localhost) et qu'il est allumé. Nouvel essai, de plus en plus espacé.`,
        };
    }
  },
  test: {
    ok: ({ host, name, nodes, devices, empty }) => ({
      en:
        `Connection OK to ${name} at ${host}: ${plural(nodes, 'node', 'nodes')}, ` +
        `${plural(devices, 'device', 'devices')} offered in Discovery` +
        (empty > 0 ? `, ${empty} left out (nothing Gladys can show yet).` : '.'),
      fr:
        `Connexion OK à ${name} (${host}) : ${plural(nodes, 'nœud', 'nœuds')}, ` +
        `${plural(devices, 'appareil proposé', 'appareils proposés')} dans Découverte` +
        (empty > 0
          ? `, ${empty} écarté${empty === 1 ? '' : 's'} (rien que Gladys sache afficher pour l'instant).`
          : '.'),
    }),
    refused: {
      en: 'The homee refused the user name or the password: check them (the user of the homee app, not the cloud account).',
      fr: "Le homee a refusé le nom d'utilisateur ou le mot de passe : vérifiez-les (l'utilisateur de l'app homee, pas le compte cloud).",
    },
  },
  badge: {
    offline: {
      en: 'homee reports this device unavailable.',
      fr: 'homee indique que cet appareil est indisponible.',
    },
    unconfirmed: {
      en: 'State not confirmed after the last command: the device did not report it.',
      fr: "État non confirmé après la dernière commande : l'appareil ne l'a pas signalé.",
    },
  },
  /** Refusals of a command, by key. */
  denied: {
    notConnected: {
      en: 'The homee is not connected: the command was not sent.',
      fr: "Le homee n'est pas connecté : la commande n'a pas été envoyée.",
    },
    notCommand: {
      en: 'This feature cannot be controlled.',
      fr: 'Cette fonctionnalité ne peut pas être pilotée.',
    },
    badValue: { en: 'This value cannot be sent.', fr: 'Cette valeur ne peut pas être envoyée.' },
    plugOff: {
      en: 'Plugs are read-only: turn on "Allow plug control" in the configuration of the integration.',
      fr: "Les prises sont en lecture seule : activez « Autoriser le pilotage des prises » dans la configuration de l'intégration.",
    },
    heatingOff: {
      en: 'Heating is read-only: turn on "Allow heating control" in the configuration of the integration.',
      fr: "Le chauffage est en lecture seule : activez « Autoriser le pilotage du chauffage » dans la configuration de l'intégration.",
    },
    lockOff: {
      en: 'Locks are read-only: turn on "Allow lock control" in the configuration of the integration.',
      fr: "Les serrures sont en lecture seule : activez « Autoriser le pilotage des serrures » dans la configuration de l'intégration.",
    },
    doorOff: {
      en: 'Doors, gates and window motors are read-only: turn on "Allow door and gate control" in the configuration of the integration.',
      fr: "Portes, portails et moteurs de fenêtre sont en lecture seule : activez « Autoriser le pilotage des portes et portails » dans la configuration de l'intégration.",
    },
    valveOff: {
      en: 'Valves are read-only: turn on "Allow valve control" in the configuration of the integration.',
      fr: "Les vannes sont en lecture seule : activez « Autoriser le pilotage des vannes » dans la configuration de l'intégration.",
    },
    sirenOff: {
      en: 'Sirens are read-only: turn on "Allow siren control" in the configuration of the integration.',
      fr: "Les sirènes sont en lecture seule : activez « Autoriser le pilotage des sirènes » dans la configuration de l'intégration.",
    },
    alarmOff: {
      en: 'The homee mode is read-only: turn on "Allow changing the homee mode" in the configuration of the integration.',
      fr: "Le mode du homee est en lecture seule : activez « Autoriser le changement de mode du homee » dans la configuration de l'intégration.",
    },
    unknownState: {
      en: 'Refused: the state of the device could not be read just now. The command was not sent.',
      fr: "Refusé : l'état de l'appareil n'a pas pu être lu à l'instant. La commande n'a pas été envoyée.",
    },
    moving: {
      en: 'Refused: the device is moving or busy. The command was not sent.',
      fr: "Refusé : l'appareil est en mouvement ou occupé. La commande n'a pas été envoyée.",
    },
    tooLate: {
      en: 'Refused: the homee took too long, the command was not sent.',
      fr: "Refusé : le homee a mis trop de temps, la commande n'a pas été envoyée.",
    },
    busy: {
      en: 'Refused: a command is already in progress on this device; wait until it reports its new state.',
      fr: "Refusé : une commande est déjà en cours sur cet appareil ; attendez qu'il signale son nouvel état.",
    },
    tooHot: {
      en: 'Refused: this hot water setpoint is above the ceiling set in the configuration (55 °C by default, never above 60 °C).',
      fr: "Refusé : cette consigne d'eau chaude dépasse le plafond réglé dans la configuration (55 °C par défaut, jamais plus de 60 °C).",
    },
    paused: {
      en: 'Refused: the homee asked to slow down, the integration is paused.',
      fr: "Refusé : le homee a demandé de ralentir, l'intégration est en pause.",
    },
    sentUnconfirmed: {
      en: 'Command sent, without confirmation from the homee yet: check the device in a moment.',
      fr: "Commande envoyée, sans confirmation du homee pour l'instant : vérifiez l'appareil dans un instant.",
    },
  },
};

export { trim };
