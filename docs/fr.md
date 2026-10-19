# homee

Cette intégration relie votre box **homee** (Z-Wave, Zigbee, EnOcean, selon
ses cubes) à Gladys Assistant, en local : les appareils appairés à la box
deviennent des appareils Gladys, leurs états suivent la box en direct et
Gladys les pilote à travers elle.

> Intégration non officielle, sans lien avec homee GmbH. Elle n'a **jamais été
> testée avec un vrai homee** : elle a été écrite d'après la bibliothèque
> pyHomee et l'intégration homee de Home Assistant, et testée contre une box
> simulée. Vos retours sont les bienvenus.

## Ce qui est pris en charge

- **Lumières** : marche/arrêt, luminosité, température de couleur.
- **Interrupteurs** (relais muraux) : marche/arrêt, variateur.
- **Prises** : état, puissance, énergie (index cumulatif), et des boutons
  « Allumer » / « Éteindre » derrière une option (voir plus bas).
- **Volets roulants** : ouvrir, fermer, arrêter, position.
- **Thermostats et têtes thermostatiques** : température, consigne, ouverture
  de la vanne, batterie, mode de chauffage (lecture).
- **Eau chaude** : température, consigne (plafonnée).
- **Capteurs** : ouverture, fenêtre, mouvement, présence, fuite et inondation,
  fumée, monoxyde de carbone, sabotage, batterie faible, température,
  humidité, luminosité, CO2, UV, vent, pluie, courant, tension.
- **Serrures, portes de garage, portails, moteurs de fenêtre, relais à
  impulsion, vannes d'eau, sirènes, mode du homee** : état en lecture seule,
  et des boutons (ou une liste pour le mode) qui ne fonctionnent que si vous
  les autorisez.
- Les télécommandes et boutons muraux (appuis), les homeegrammes et l'alarme
  INOVA ne sont pas encore repris.

## Configuration

1. Dans l'app homee, créez de préférence un **utilisateur dédié** à Gladys.
2. Notez l'**adresse IP locale** de la box (Réglages → homee, ou votre box
   internet). Donnez-lui une adresse fixe.
3. Dans Gladys, Intégrations → homee : saisissez l'adresse IP, le nom
   d'utilisateur et le mot de passe, puis **Tester la connexion**.
4. Dans l'onglet **Découverte**, ajoutez les appareils voulus.

Le mot de passe est un champ secret : il est gardé par Gladys dans sa base,
jamais réaffiché, et envoyé seulement à votre homee (sous la forme de son
empreinte SHA-512, comme le font les apps homee). L'intégration n'utilise que
la connexion locale de la box (port 7681), jamais my.hom.ee.

## Sécurité : ce qui reste en lecture seule

Un « tout éteindre » (Google Home, Alexa, HomeKit, MCP, une scène) ne doit
jamais atteindre une vanne, une serrure, une sirène, un chauffage ni la charge
inconnue d'une prise. Ces appareils n'ont donc **jamais d'interrupteur** dans
Gladys : leur état est en lecture seule et leurs commandes sont des boutons,
refusés tant que l'option correspondante est désactivée (toutes le sont par
défaut) :

| Option                                       | Ce qu'elle autorise                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Autoriser le pilotage des prises             | Boutons Allumer / Éteindre des prises                                                 |
| Autoriser le pilotage du chauffage           | Consignes des thermostats et de l'eau chaude, marche/arrêt des radiateurs électriques |
| Autoriser le pilotage des serrures           | Verrouiller, Déverrouiller, Ouvrir (tirer le pêne)                                    |
| Autoriser le pilotage des portes et portails | Ouvrir, Fermer, Arrêter, impulsions                                                   |
| Autoriser le pilotage des vannes             | Ouvrir / Fermer les vannes d'eau                                                      |
| Autoriser le pilotage des sirènes            | Déclencher / Arrêter la sirène                                                        |
| Autoriser le changement de mode du homee     | À la maison, Nuit, Absent, Vacances (une liste)                                       |

Pour chacune de ces commandes, l'intégration relit l'état de l'appareil juste
avant, refuse si cet état est inconnu ou en mouvement, vérifie l'option une
dernière fois juste avant l'envoi, et attend que la box confirme. Sans
confirmation dans les temps, Gladys affiche « Commande envoyée, sans
confirmation du homee » : vérifiez l'appareil. Une serrure, une porte ou une
vanne est ensuite protégée jusqu'à ce qu'elle signale l'état demandé (30 s,
90 s ou 60 s au plus). Une commande qui ne peut pas partir dans les 3,5 s est
refusée, jamais envoyée en retard.

La consigne d'eau chaude est plafonnée à **55 °C** par défaut (risque de
brûlure), réglable jusqu'à **60 °C** au plus. Les vannes des têtes
thermostatiques ne sont jamais pilotées directement : elles suivent leur
consigne.

## Connexion et erreurs

- Un jeton est demandé à la box à la connexion et gardé en mémoire seulement ;
  il est renouvelé avant sa fin, jamais en boucle.
- La connexion en direct perdue est rouverte après 5 s, puis 10 s, 20 s…
  jusqu'à 5 minutes entre deux essais. Toute la box est relue toutes les
  10 minutes ; sans réponse en 30 s, la connexion est rouverte.
- **Identifiants refusés** : l'intégration s'arrête et le note dans `/data`
  (sans le nom d'utilisateur ni le mot de passe, seulement une empreinte
  salée). Nouvel essai automatique après 1 h, puis 2 h, 4 h… jusqu'à 24 h ;
  « Tester la connexion » ou un enregistrement de la configuration essaie
  aussitôt.
- Si la box demande de ralentir (HTTP 429), l'intégration fait une pause
  (1 minute à 6 heures), gardée même après un redémarrage.

## Limites connues

- Jamais testée avec un vrai homee (voir plus haut) : les profils et la
  signification de certaines valeurs viennent de pyHomee et de Home
  Assistant.
- Les noms des fonctionnalités sont fixés à l'ajout de l'appareil.
- Les appuis des télécommandes, les homeegrammes, les groupes et l'alarme
  INOVA ne sont pas encore pris en charge.

## Crédits

- [pyHomee](https://github.com/Taraman17/pyHomee) (MIT), la bibliothèque de
  l'intégration homee de Home Assistant, dont le protocole est repris.
- L'intégration homee de [Home Assistant](https://github.com/home-assistant/core)
  (Apache-2.0), pour la signification des profils et des valeurs.
