# Claude Sessions

Extension VS Code qui liste **toutes** tes conversations Claude Code, quel que soit le dossier ou
le worktree où tu les as ouvertes, et les reprend d'un clic. Fini de chercher « c'était dans quel
dossier déjà ? » quand tu as plusieurs instances de Claude ouvertes.

- Panneau dans la barre latérale, bouton **Conversations** dans la barre d'état, `Ctrl+Alt+C`
  pour une recherche rapide.
- Pour chaque conversation : titre, dossier, branche git, date.
- **Qui t'attend ?** Pour chaque conversation ouverte, l'extension sait si Claude travaille, s'il
  attend ta réponse ou ton feu vert (**orange**, jusqu'à ce que tu répondes), ou s'il a terminé
  (**vert**, jusqu'à ce que tu cliques dessus ou sur l'onglet de son terminal). Elles remontent en
  tête du panneau, avec un badge sur l'icône et un compteur dans la barre d'état.
- Cliquer sur une conversation ouverte **va à son terminal** au lieu d'en relancer une copie.
- Vue **par date** ou **par projet** (un dépôt, puis ses worktrees).
- Recherche dans les titres, dossiers, branches, étiquettes et messages, et en option dans tout
  le contenu.
- ☆ **Favoris**, **étiquettes** (`#à reprendre`, `#bloqué`… ou les tiennes), **archives** pour
  ranger ce qui est fini, et **renommer** une conversation (double-clic sur le titre).
- **Lire** une conversation sans la reprendre : elle s'ouvre comme une discussion dans un onglet,
  avec sa propre recherche (`Ctrl+F`, Entrée / Maj+Entrée pour passer d'un résultat à l'autre).
- Clic sur une conversation : un terminal s'ouvre dans son dossier et lance `claude --resume`.

L'extension ne fait que lire `~/.claude/projects` sur ta machine. Rien ne part sur Internet.

## Installer : le plus simple, demande à ton IA

Colle ceci à Claude Code (ou à n'importe quel assistant capable de lancer des commandes) :

> Installe l'extension VS Code https://github.com/gonith/claude-sessions en suivant la section
> « Instructions pour l'IA » de son README.

---

## Instructions pour l'IA

Tu installes cette extension sur la machine de l'utilisateur. Suis les étapes dans l'ordre et
vérifie le résultat de chacune avant de passer à la suivante. Ne modifie rien dans
`~/.claude/projects` : l'extension le lit, elle ne doit jamais y écrire.

### 1. Prérequis

Vérifie que ces commandes répondent :

```
git --version
node --version     # Node 18 ou plus récent
code --version     # le lanceur en ligne de commande de VS Code
```

- Si `code` est introuvable :
  - **macOS** : demande à l'utilisateur d'ouvrir VS Code, puis `Cmd+Shift+P` →
    *Shell Command: Install 'code' command in PATH*, puis d'ouvrir un nouveau terminal.
  - **Windows** : `code` est installé avec VS Code (option « Ajouter à PATH ») ; sinon, le
    chemin habituel est `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`.
  - **Linux** : `code` vient avec le paquet VS Code.
  - Si l'utilisateur se sert d'un dérivé (Cursor, VSCodium…), le lanceur s'appelle autrement
    (`cursor`, `codium`) ; utilise celui-là à la place de `code`.
- Si Node est absent, demande à l'utilisateur de l'installer (https://nodejs.org) ; ne l'installe
  pas toi-même sans son accord.
- Vérifie que `~/.claude/projects` existe : c'est là que Claude Code range les conversations.
  S'il n'existe pas, l'extension fonctionnera mais n'affichera rien tant que Claude Code n'aura
  pas été utilisé.

### 2. Récupérer et empaqueter

Place le dépôt dans un dossier stable de l'utilisateur (pas un dossier temporaire), par exemple
son dossier de projets :

```
git clone https://github.com/gonith/claude-sessions.git
cd claude-sessions
npx --yes @vscode/vsce package
```

Résultat attendu : `DONE  Packaged: …/claude-sessions-<version>.vsix`. L'extension n'a aucune
dépendance npm, il n'y a pas de `npm install` à faire.

### 3. Installer

```
code --install-extension claude-sessions-<version>.vsix --force
```

Remplace `<version>` par le nom exact du fichier produit à l'étape 2. Résultat attendu :
`Extension '…vsix' was successfully installed.`

Vérifie :

```
code --list-extensions | grep claude-sessions        # macOS / Linux
code --list-extensions | findstr claude-sessions     # Windows (cmd / PowerShell)
```

### 4. Terminer

Tu ne peux pas recharger VS Code toi-même. Dis à l'utilisateur :

1. `Ctrl+Shift+P` (`Cmd+Shift+P` sur macOS) → **Developer: Reload Window**.
2. Une icône de bulles apparaît dans la barre d'activité, à gauche, et un bouton
   **Conversations** en bas à gauche. `Ctrl+Alt+C` ouvre la recherche rapide.

### Mettre à jour plus tard

```
cd claude-sessions
git pull
npx --yes @vscode/vsce package
code --install-extension claude-sessions-<version>.vsix --force
```

Puis **Developer: Reload Window**.

### Désinstaller

```
code --uninstall-extension gonith.claude-sessions
```

Les favoris et les noms donnés aux conversations restent dans
`~/.claude/claude-sessions-favoris.json` et `~/.claude/claude-sessions-noms.json` ; supprime-les
seulement si l'utilisateur le demande.

### En cas de problème

- **Le panneau reste sur « Chargement… »** : `~/.claude/projects` est vide ou absent.
- **Cliquer ne reprend rien** : la commande `claude` doit être accessible dans le terminal
  intégré de VS Code (`claude --version`).
- **« dossier supprimé »** sur une conversation : le dossier où elle a été ouverte n'existe plus ;
  elle ne peut pas être reprise depuis l'extension.

## Réglages

Dans les paramètres de VS Code, section **Claude Sessions** :

| Réglage | Défaut | Effet |
|---|---|---|
| `claudeSessions.openOnStartup` | `true` | Ouvre le panneau au démarrage de VS Code |
| `claudeSessions.maxSessions` | `300` | Nombre de conversations récentes listées (les favoris s'y ajoutent) |
| `claudeSessions.notifications` | `autorisations` | Notifier quand Claude attend ton feu vert (`autorisations`), aussi quand il termine (`toutes`), ou jamais (`aucune`) |
| `claudeSessions.activeMinutes` | `3` | Anciennes versions de Claude Code seulement : délai sous lequel une conversation est considérée comme en cours |

## Comment l'extension sait qui t'attend

Claude Code tient un registre de ses sessions ouvertes dans `~/.claude/sessions/` : pour chacune,
son processus et son statut (travaille, attend, a fini). L'extension le lit, et relie chaque
session à son onglet de terminal en remontant l'arbre des processus. Ce registre est un détail
interne de Claude Code : s'il change de format, l'extension continue de fonctionner mais perd les
couleurs d'état. VS Code ne permet pas à une extension de changer la couleur d'un onglet de
terminal déjà ouvert : les couleurs sont donc dans le panneau.
