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
- **Interrupteurs muraux simples** (profils « interrupteur marche/arrêt »,
  double, avec entrée, Wi-Fi) : marche/arrêt, variateur.
- **Prises, relais avec mesure et tout autre appareil** : état, puissance,
  énergie (index cumulatif), et des boutons « Allumer » / « Éteindre »
  derrière une option (voir plus bas).
- **Volets roulants** : ouvrir, fermer, arrêter, position.
- **Thermostats et têtes thermostatiques** : température, consigne, ouverture
  de la vanne, batterie, mode de chauffage (lecture).
- **Eau chaude** : température, consigne (plafonnée).
- **Capteurs** : ouverture, fenêtre, mouvement, présence, fuite et inondation,
  fumée, monoxyde de carbone, sabotage, batterie faible, température,
  humidité, luminosité, CO2, UV, vent, pluie, courant, tension.
- **Serrures, portes de garage, portails, relais à impulsion, vannes d'eau,
  sirènes, mode du homee** : état en lecture seule, et des boutons (ou une
  liste pour le mode) qui ne fonctionnent que si vous les autorisez. En v1,
  les boutons Ouvrir / Fermer / Arrêter existent seulement pour les portes de
  garage et les portails d'entrée motorisés ; les autres portes et les
  moteurs de fenêtre montrent leur état, leurs boutons d'impulsion restent.
- Les télécommandes et boutons muraux (appuis), les homeegrammes et l'alarme
  INOVA (toujours en lecture seule) ne sont pas encore repris.

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
jamais atteindre une vanne, une serrure, une sirène, un chauffage ni une
charge inconnue. Seuls les lumières et les interrupteurs muraux simples ont
donc un interrupteur dans Gladys ; tous les autres appareils ont un état en
lecture seule et des boutons, refusés tant que l'option correspondante est
désactivée (toutes le sont par défaut) :

| Option                                       | Ce qu'elle autorise                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Autoriser le pilotage des prises             | Boutons Allumer / Éteindre des prises, des relais avec mesure et des autres appareils |
| Autoriser le pilotage du chauffage           | Consignes des thermostats et de l'eau chaude, marche/arrêt des radiateurs électriques |
| Autoriser le pilotage des serrures           | Verrouiller, Déverrouiller, Ouvrir (tirer le pêne)                                    |
| Autoriser le pilotage des portes et portails | Ouvrir, Fermer, Arrêter (portes de garage, portails d'entrée), impulsions             |
| Autoriser le pilotage des vannes             | Ouvrir / Fermer les vannes d'eau                                                      |
| Autoriser le pilotage des sirènes            | Déclencher / Arrêter la sirène                                                        |
| Autoriser le changement de mode du homee     | À la maison, Nuit, Absent, Vacances (une liste)                                       |

Pour chacune de ces commandes, l'intégration relit l'état de l'appareil juste
avant, refuse si cet état est inconnu ou en mouvement (une porte dont la cible
diffère de sa position est en mouvement), vérifie l'option une dernière fois
juste avant l'envoi, et attend que la box confirme. Sans confirmation dans
les temps, Gladys affiche « Commande envoyée, sans confirmation du homee » :
vérifiez l'appareil.

Les commandes **protectrices** — verrouiller, fermer la vanne, arrêter une
porte, éteindre, arrêter la sirène — ne sont jamais refusées à cause de l'état
de l'appareil et partent toujours (une fuite pendant l'ouverture d'une vanne
doit pouvoir la refermer). Aucune commande n'attend derrière la confirmation
d'une autre. Une serrure, une porte ou une vanne qui ne signale pas l'état
demandé à temps (30 s, 90 s, 60 s) affiche « État non confirmé » sur son
badge, jusqu'à ce qu'elle signale un état. Deux appuis sur un bouton
d'impulsion à moins de 2 s comptent pour un seul. Une porte dont le sens
(inversé ou non dans homee) est inconnu ou a changé depuis son ajout refuse
Ouvrir / Fermer. Une commande qui ne peut pas partir dans les 3,5 s est
refusée, jamais envoyée en retard.

La consigne d'eau chaude est plafonnée à **55 °C** par défaut (risque de
brûlure), réglable jusqu'à **60 °C** au plus, y compris la consigne d'un
circuit d'eau chaude. Toute consigne hors de la plage affichée dans Gladys
est refusée. Les vannes des têtes thermostatiques ne sont jamais pilotées
directement : elles suivent leur consigne. Sur une vanne d'eau à marche/arrêt,
le sens de « marche » (ouverte ou fermée) reste à vérifier sur une vraie box :
les boutons s'appellent donc « Allumer » / « Éteindre ».

## Énergie

L'énergie cumulée d'une prise ou d'un compteur est un index que Gladys
facture : chaque hausse est comptée en entier. L'intégration le protège comme
l'intégration P1 Monitor :

- jamais 0 ; une baisse ou un saut improbable (plus de 25 kW en moyenne
  depuis la dernière mesure) est **retenu** : la dernière valeur acceptée est
  renvoyée, le badge de l'appareil affiche les kWh en attente, et le journal
  le signale ; la retenue est gardée dans `/data`, même après un redémarrage ;
- elle n'est jamais confirmée par répétition ni par le temps : seule l'action
  **« Accepter l'index retenu »** de la configuration la prend, **en deux
  clics**. Le premier clic ne prend rien : il liste tous les index retenus de
  l'appareil choisi (fonctionnalité, baisse ou saut, de → à, kWh). Un second
  clic dans les 60 s prend exactement cette liste — chaque valeur affichée,
  plus ce que l'appareil peut consommer d'ici sa prochaine mesure — et répond
  avec les kWh comptés ; si la liste a changé entre-temps, elle est listée à
  nouveau. Le badge de l'appareil résume toutes ses retenues (leur nombre et
  les kWh en jeu). Enregistrer la configuration ou une reconnexion n'accepte
  jamais rien ;
- un appareil ajouté à nouveau repart d'une garde neuve ;
- le **total** d'un compteur d'énergie (qui peut compter aussi les prises de
  la box) est une valeur simple, jamais un index : l'énergie des prises n'est
  pas comptée deux fois.

## Connexion et erreurs

- Un jeton est demandé à la box à la connexion et gardé en mémoire seulement ;
  il est renouvelé avant sa fin, jamais en boucle. Si la box refuse la
  connexion en direct alors que son port répond, un nouveau jeton est demandé
  au prochain essai ; une panne réseau garde le jeton.
- La connexion en direct perdue est rouverte après 5 s, puis 10 s, 20 s…
  jusqu'à 5 minutes entre deux essais. Toute la box est relue toutes les
  10 minutes ; sans réponse en 30 s, la connexion est rouverte.
- **Identifiants refusés** : l'intégration s'arrête et le note dans `/data`
  (sans le nom d'utilisateur ni le mot de passe, seulement une empreinte
  salée). Nouvel essai automatique après 1 h, puis 2 h, 4 h… jusqu'à 24 h ;
  « Tester la connexion » ou un enregistrement de la configuration essaie
  aussitôt (les mêmes identifiants refusés encore attendent plus longtemps).
- Si la box demande de ralentir (HTTP 429), l'intégration fait une pause
  (1 minute à 6 heures), gardée même après un redémarrage.
- « Tester la connexion » réutilise la connexion en cours quand elle existe.

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
- La garde des index d'énergie vient de l'intégration Gladys P1 Monitor
  ([LM1LC3N7/gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor)).
