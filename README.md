# Pointage du cabinet

Suivi du temps de travail des salariés d'un groupe de cabinets dentaires : pointage quotidien,
agenda type, contrôle des règles légales, rappels par email et exports PDF/CSV.

- **Page** : fichiers statiques publiés par GitHub Pages (`index.html`, `app.js`).
- **Comptes, données, droits** : Supabase (base Postgres, offre gratuite, hébergement à Paris).
- **Emails** : Brevo (société française, offre gratuite de 300 emails par jour) ou Resend.

## Organisation

| Qui | Rôle dans l'outil | Ce qu'il voit et fait |
|---|---|---|
| Administrateur | `admin` sur son profil | Tout. Crée les employeurs, invite les personnes, règle les seuils légaux. |
| Dentiste, gérant de SCM | responsable d'un employeur | Les heures des salariés de cet employeur : suivi, corrections avec motif, contrat, agenda type, exports. |
| Assistant(e), salarié(e) de SCM | salarié d'un employeur | Ses propres heures : pointage, saisie des oublis, absences, historique. |

- **Un employeur** est un cabinet en nom propre, une SCM, ou une autre structure.
- **Une SCM peut avoir plusieurs responsables**, par exemple ses co-gérants.
- **Un dentiste peut être responsable de son cabinet et de la SCM.**
- **Un salarié n'a qu'un employeur actif à la fois.** S'il change d'employeur, on renseigne sa fin
  de contrat, puis on le rattache au nouvel employeur. Son historique est conservé.
- **Un responsable peut aussi être salarié**, par exemple une responsable de secrétariat salariée
  de la SCM. Il pointe alors ses propres heures, mais ne peut pas les corriger lui-même.

## Ce que l'outil garantit

- **L'heure d'un pointage est celle du serveur**, pas celle du téléphone.
- **Chaque saisie est horodatée par le serveur avec son auteur.** Une heure ajoutée après coup est
  marquée « saisi après coup », avec la date et l'heure de saisie.
- **Rien n'est effacé ni écrasé.** Une correction d'un responsable annule l'heure fautive avec un
  motif obligatoire, puis ajoute la bonne. Les deux restent visibles.
- **Un journal d'audit** recopie chaque écriture. Personne ne peut le modifier depuis l'application.
- **Chaque salarié voit tout son historique**, y compris les corrections et leurs motifs.
- **Un responsable ne voit que les salariés de ses employeurs.**
- **Ces règles sont appliquées par la base de données** et pas seulement par l'interface : elles
  tiennent même si quelqu'un appelle la base directement.

Règles contrôlées (réglables dans l'onglet Administration, communes à tous les employeurs) :

| Règle | Valeur par défaut |
|---|---|
| Repos quotidien | 11 h consécutives |
| Durée maximale par jour | 10 h |
| Pause | 20 min dès 6 h de travail |
| Durée maximale par semaine | 48 h |
| Moyenne sur 12 semaines | 44 h |
| Repos hebdomadaire | 35 h consécutives |
| Heures supplémentaires | au-delà de la durée du contrat (35 h par défaut, réglable par salarié) |
| Écart avec l'agenda type | au-delà de 15 min de plus que prévu |

Une saisie qui dépasse un seuil n'est **jamais bloquée** : elle est signalée. Un outil qui bloque
pousse à déclarer de fausses heures.

**Rappels** (envoyés chaque jour à 7 h, heure de Paris) :

- **Le salarié** reçoit un email le lendemain matin d'un jour non complété. Aucun email n'est
  envoyé le week-end ni pendant une absence (droit à la déconnexion) : un vendredi oublié est
  rappelé le lundi.
- **Les responsables de son employeur** reçoivent un email dès qu'un jour reste non complété 48 h
  après la fin de la journée. Ce même email regroupe les dépassements de règles et les écarts
  avec l'agenda type. Chaque point n'est signalé qu'une fois. Sans responsable, l'email va à
  l'administrateur.

---

## Mise en service

Comptez une heure environ.

### 1. Créer le projet Supabase

1. Créez un compte sur supabase.com, puis un projet. **Région : `West EU (Paris)`**.
2. Dans **SQL Editor**, collez le contenu de `supabase/migrations/0001_schema.sql`, puis cliquez
   sur **Run**.
3. Dans **Authentication > Sign In / Providers**, laissez **Email** activé et **désactivez
   « Allow new users to sign up »**. Les comptes ne se créent que sur invitation.

### 2. Préparer l'envoi des emails (Brevo)

1. Créez un compte sur brevo.com.
2. Dans **Expéditeurs**, ajoutez l'adresse qui enverra les emails et validez-la avec le lien
   reçu.
3. Dans **SMTP & API**, notez les identifiants **SMTP** et créez une **clé API**.
4. Dans Supabase, **Authentication > Emails > SMTP Settings** : activez le SMTP personnalisé avec
   les identifiants Brevo (hôte `smtp-relay.brevo.com`, port `587`). **Sans ce réglage,
   Supabase n'envoie les invitations qu'aux membres de votre équipe Supabase**, et Laura ne
   recevrait rien.

### 3. Publier la page sur GitHub

1. Dans **Project Settings > API** de Supabase, copiez **Project URL** et la clé **anon public**
   dans `config.js`.
2. Créez un dépôt GitHub, par exemple `pointage-cabinet`, et envoyez-y le contenu de ce dossier.
   Il peut être public : il ne contient ni donnée, ni secret, ni adresse email, et la clé
   « anon » est publique par conception.
3. Dans **Settings > Pages**, choisissez **Deploy from a branch**, puis la branche `main` et le
   dossier `/ (root)`. La page est servie à l'adresse `https://<votre-compte>.github.io/pointage-cabinet/`.
4. Dans Supabase, **Authentication > URL Configuration** : mettez cette adresse dans
   **Site URL** et dans **Redirect URLs**.

### 4. Déployer les deux fonctions

Cette étape demande un terminal, avec Node.js installé. Depuis ce dossier :

```bash
npx supabase login
```

```bash
npx supabase link --project-ref <IDENTIFIANT-DU-PROJET>
```

```bash
npx supabase functions deploy rappels --no-verify-jwt
```

```bash
npx supabase functions deploy comptes --no-verify-jwt
```

```bash
npx supabase secrets set CRON_SECRET=<une-longue-chaine-aleatoire> EMAIL_PROVIDER=brevo EMAIL_API_KEY=<cle-api-brevo> EMAIL_FROM=<adresse-validee> EMAIL_FROM_NAME="Pointage du cabinet" APP_URL=https://<votre-compte>.github.io/pointage-cabinet/
```

L'identifiant du projet figure dans l'adresse du projet Supabase, juste après `/project/`.

### 5. Créer le compte administrateur

1. Dans Supabase, **Authentication > Users > Add user > Create new user** : l'adresse de
   l'administrateur, un mot de passe, et **Auto Confirm User** coché.
2. Dans **SQL Editor**, exécutez le script d'amorçage. Il crée le profil administrateur, son
   cabinet et son rattachement. Il contient des adresses email : il est conservé hors de ce
   dépôt.

### 6. Inviter les autres personnes depuis l'application

L'administrateur se connecte, ouvre **Administration**, puis :

1. **Inviter une personne** : nom, email, employeur, rôle (salarié ou responsable), heures au
   contrat. La personne reçoit un email pour choisir son mot de passe.
2. **Ajouter un employeur** pour chaque autre cabinet et pour la SCM, puis y inviter le
   dentiste comme responsable et ses salariés.
3. **Rattacher** une personne qui a déjà un compte à un autre employeur : par exemple un
   dentiste comme co-responsable de la SCM.

Pour chaque salarié, le responsable renseigne ensuite l'onglet **Contrat et agenda**.

### 7. Planifier les rappels

Dans **SQL Editor**, ouvrez `supabase/migrations/0002_planification.sql`, remplacez les deux
valeurs entre chevrons, puis cliquez sur **Run**.

Pour tester sans attendre 7 h (et recevoir les vrais emails s'il y a des jours manquants) :

```bash
curl -X POST https://<VOTRE-PROJET>.supabase.co/functions/v1/rappels -H "x-cron-secret: <CRON_SECRET>" -H "Content-Type: application/json" -d '{"force":true}'
```

### 8. Installer sur le téléphone

Ouvrez l'adresse de la page dans Safari, puis **Partager > Sur l'écran d'accueil**. L'application
s'ouvre ensuite comme une app.

---

## À savoir

- **Expéditeur Gmail.** Envoyer depuis une adresse `@gmail.com` par Brevo fonctionne, mais
  certains emails peuvent arriver en indésirables. Pour plus de fiabilité, utilisez une adresse
  sur un nom de domaine à vous. Vérifiez les indésirables lors du premier test.
- **Mise en veille de l'offre gratuite.** Supabase suspend un projet gratuit resté une semaine
  sans activité. La tâche horaire et l'usage quotidien devraient l'empêcher, mais pendant de
  longues vacances, vérifiez que le projet est actif au retour.
- **Sauvegardes.** L'offre gratuite n'inclut pas de sauvegarde téléchargeable. Exportez le PDF
  et les CSV chaque mois et conservez-les : c'est aussi la meilleure preuve.
- **Conservation.** Les données plus anciennes que la durée réglée (7 ans par défaut) sont purgées
  automatiquement le 1er janvier, et la purge est inscrite au journal.
- **Tests** : `npm test` pour les règles. Les tests des droits d'accès (`npm run test:schema`)
  demandent d'avoir lancé `npm install` au préalable.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html`, `app.js` | La page |
| `config.js` | Adresse et clé publique du projet Supabase |
| `supabase/functions/_shared/regles.js` | Calculs et règles, partagés par la page et les rappels |
| `supabase/functions/rappels/index.ts` | Emails de rappel et d'alerte |
| `supabase/functions/comptes/index.ts` | Invitation des personnes, réservée à l'administrateur |
| `supabase/migrations/0001_schema.sql` | Tables, droits d'accès, traçabilité |
| `supabase/migrations/0002_planification.sql` | Tâche planifiée horaire |
| `tests/` | Tests des règles et des droits d'accès |
