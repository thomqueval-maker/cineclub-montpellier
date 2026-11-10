# Cinéclub Montpellier

Mini-site personnel pour comparer les séances Pathé Odysseum et Pathé Comédie, filtrer sa liste de films, voir les suppléments CinéPass et ouvrir la réservation de la séance choisie.

## Lancer en local

Prérequis : Node.js 18 ou plus récent.

```sh
npm start
```

Le serveur ouvre `http://127.0.0.1:8765` automatiquement. Les données de programmation sont chargées à la demande; la liste de films est conservée dans le stockage local du navigateur.

Sous Windows, il est aussi possible de lancer `start-cineclub.bat`.

## Déployer sur Render

Le fichier `render.yaml` configure un service Node sur Render. Après avoir connecté le dépôt GitHub à Render, créer une Blueprint à partir du dépôt; Render utilise `npm install` puis `npm start`.

## Sources de données

- Séances, versions, formats et références de réservation : API JSON du site Pathé.
- Affiches et notes spectateurs : fiches publiques AlloCiné lorsqu'elles sont accessibles. En cas de blocage, l'application affiche un lien de recherche et n'invente aucune note.
- Suppléments : valeurs indicatives issues de la page tarifs de Pathé Odysseum; le montant de la billetterie Pathé fait foi.

Les appels externes sont mis en cache quelques minutes pour la programmation et jusqu'à une journée pour les données AlloCiné. Pathé et AlloCiné peuvent modifier ou limiter leurs pages et interfaces. Ce projet personnel n'est affilié à aucun des deux.
