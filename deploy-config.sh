#!/usr/bin/env bash
# Kopiert admin/config.php (Passwort-Hash) einmalig auf den Server-Laptop.
# deploy.sh lässt diese Datei absichtlich aus – sie muss nur einmal rüber
# (oder erneut, wenn das Admin-Passwort geändert wurde).
#
#   ./deploy-config.sh          kopieren (fragt nach, falls die Datei auf dem Server schon existiert)
#   ./deploy-config.sh --force  ohne Nachfrage überschreiben
set -euo pipefail

# ---- Anpassen (gleiche Werte wie in deploy.sh) ----
SERVER_USER="${SERVER_USER:-leon}"
SERVER_HOST="${SERVER_HOST:-100.79.126.110}"
SERVER_PATH="${SERVER_PATH:-/home/leon/server/asv-oppenau}"
# ---------------------------------------------------

cd "$(dirname "$0")"

LOCAL_FILE="admin/config.php"
REMOTE="$SERVER_USER@$SERVER_HOST"
REMOTE_FILE="$SERVER_PATH/admin/config.php"

if [[ ! -f "$LOCAL_FILE" ]]; then
  echo "Fehler: $LOCAL_FILE gibt es lokal nicht (siehe admin/config.example.php)." >&2
  exit 1
fi

# Eine gemeinsame SSH-Verbindung für alle Schritte -> Passwort nur einmal eingeben.
SSH_SOCKET="$(mktemp -d)/ssh.sock"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$SSH_SOCKET" -o ControlPersist=60)
trap 'ssh "${SSH_OPTS[@]}" -O exit "$REMOTE" 2>/dev/null || true; rm -rf "$(dirname "$SSH_SOCKET")"' EXIT

if [[ "${1:-}" != "--force" ]] && ssh "${SSH_OPTS[@]}" "$REMOTE" "test -e '$REMOTE_FILE'"; then
  read -r -p "Auf dem Server liegt schon eine config.php. Überschreiben? [j/N] " answer
  if [[ "$answer" != "j" && "$answer" != "J" ]]; then
    echo "Abgebrochen – nichts verändert."
    exit 0
  fi
fi

echo "==> Kopiere $LOCAL_FILE nach $REMOTE:$REMOTE_FILE ..."
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$SERVER_PATH/admin' && cat > '$REMOTE_FILE'" < "$LOCAL_FILE"

echo "==> Fertig!"
