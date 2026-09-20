# PayCivo Demo — Expo / React Native

Version mobile de démonstration préparée à partir du projet PayCivo fourni.

## Démo
- Code: **1234**
- Solde initial fictif: 25 000 FCFA
- Recharge et transfert: simulations locales uniquement
- Historique: stocké localement sur le téléphone
- Aucun paiement réel, aucun SMS réel, aucun compte réel

## Build cloud Android avec EAS
Expo EAS Build permet de produire un APK dans le cloud.

1. Installer/ouvrir Node.js + EAS CLI sur une machine ou un environnement terminal:
   `npm install --global eas-cli`
2. Se connecter:
   `eas login`
3. Depuis ce dossier:
   `eas build --platform android --profile preview`
4. EAS fournit ensuite un lien vers l'APK.

Le profil `preview` est configuré en `android.buildType: apk` et `distribution: internal` pour permettre l'installation directe sur Android.

## Production
Le profil `production` est configuré en AAB pour Google Play. Ne pas utiliser la version démo pour des paiements réels.
