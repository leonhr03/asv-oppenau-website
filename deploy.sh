#!/usr/bin/env bash
# Kopiert die Seite per SSH (über Tailscale) auf den Server-Laptop.
# Kein Build nötig – die Dateien werden so kopiert, wie sie im Projekt liegen.
#
#   ./deploy.sh            kopieren
#   ./deploy.sh --dry-run  nur anzeigen, was kopiert/gelöscht würde
set -euo pipefail

# ---- Anpassen ----
SERVER_USER="${SERVER_USER:-leon}"                           # Benutzername auf dem Server-Laptop
SERVER_HOST="${SERVER_HOST:-100.79.126.110}"                 # Tailscale-Name oder -IP
SERVER_PATH="${SERVER_PATH:-/home/leon/server/asv-oppenau}"  # Zielordner auf dem Server
# ------------------

cd "$(dirname "$0")"

RSYNC_OPTS=(-avz --delete)
if [[ "${1:-}" == "--dry-run" ]]; then
  RSYNC_OPTS+=(--dry-run)
  echo "==> Probelauf – es wird nichts verändert."
fi

echo "==> Kopiere nach $SERVER_USER@$SERVER_HOST:$SERVER_PATH ..."
ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p '$SERVER_PATH'"

# Ausgeschlossene Dateien werden weder kopiert noch von --delete auf dem Server gelöscht.
# admin/config.php (Passwort-Hash) und admin/backups/ gehören dem Server und bleiben dort erhalten.
# img/uploads/ (Bilder aus dem Admin-Panel) wird kopiert, aber auf dem Server nie gelöscht.
rsync "${RSYNC_OPTS[@]}" \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude '.idea/' \
  --exclude '.firebase/' \
  --exclude '.firebaserc' \
  --exclude 'firebase.json' \
  --exclude '.gitignore' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude 'deploy.sh' \
  --exclude 'deploy-config.sh' \
  --exclude 'scripts/' \
  --exclude 'startServer.sh' \
  --exclude 'admin/config.php' \
  --exclude 'admin/backups/' \
  --filter 'P img/uploads/' \
  ./ "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

echo "==> Fertig!"
