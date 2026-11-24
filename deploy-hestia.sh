#!/usr/bin/env bash
# Deploy kode CRM v4 dari checkout GitHub ke layanan Hestia yang SUDAH terpasang.
# Tidak membuat/menghapus domain, tidak mengubah Nginx, tidak menghapus JSON.
set -Eeuo pipefail
umask 077

APP="/opt/apps/aru-internal-crm"
STATE="/var/lib/aru-internal-crm/data.json"
SERVICE="aru-internal-crm.service"
PORT=3215
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: Jalankan sebagai root: sudo bash deploy-hestia.sh" >&2
  exit 1
fi

for cmd in node systemctl curl grep cp install mktemp date; do
  command -v "$cmd" >/dev/null || { echo "ERROR: $cmd belum tersedia" >&2; exit 1; }
done

if [[ ! -f "$APP/server.js" || ! -f "$APP/index.html" || ! -f "$STATE" ]]; then
  echo "ERROR: Instalasi CRM Hestia belum ditemukan pada path yang diharapkan." >&2
  echo "Diperlukan: $APP/index.html, $APP/server.js, $STATE" >&2
  echo "Tidak ada perubahan yang dilakukan." >&2
  exit 1
fi

if ! systemctl cat "$SERVICE" >/dev/null 2>&1; then
  echo "ERROR: Service $SERVICE tidak ditemukan. Tidak ada perubahan." >&2
  exit 1
fi

[[ -f "$SOURCE/index.html" && -f "$SOURCE/server.js" ]] || {
  echo "ERROR: File sumber tidak lengkap." >&2; exit 1;
}

node --check "$SOURCE/server.js"
grep -Fq 'Flexible reports v4' "$SOURCE/index.html" || {
  echo "ERROR: Source index.html tidak dikenali sebagai UI v4." >&2; exit 1;
}

BACKUP="/root/backup-internal-crm-git/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
cp -a "$APP/index.html" "$BACKUP/index.html"
cp -a "$APP/server.js" "$BACKUP/server.js"
cp -a "$STATE" "$BACKUP/data.json"
chmod 600 "$BACKUP/data.json"
echo "Backup kode dan JSON privat tersimpan di $BACKUP"

restore_code() {
  echo "ERROR: Deploy gagal; mengembalikan KODE lama (data JSON tetap dipertahankan)." >&2
  cp -a "$BACKUP/index.html" "$APP/index.html"
  cp -a "$BACKUP/server.js" "$APP/server.js"
  systemctl restart "$SERVICE" || true
  echo "Backup: $BACKUP" >&2
}
trap restore_code ERR

install -o root -g root -m 0644 "$SOURCE/index.html" "$APP/index.html"
install -o root -g root -m 0644 "$SOURCE/server.js" "$APP/server.js"
systemctl restart "$SERVICE"

OK=0
for n in $(seq 1 12); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/auth/me" | grep -q '"user":null'; then
    OK=1
    break
  fi
  sleep 1
done
[[ "$OK" -eq 1 ]] || { echo "ERROR: Backend tidak lolos health-check" >&2; false; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl -fsS --max-time 5 -o "$TMP" "http://127.0.0.1:${PORT}/"
grep -Fq 'Flexible reports v4' "$TMP" || { echo "ERROR: Halaman HTML v4 belum terlayani" >&2; false; }
trap - ERR
echo
echo "SUKSES: CRM v4 aktif, akun dan data lama dipertahankan."
echo "URL: https://internal-crm.aruraharja.co.id/"
echo "Backup: $BACKUP"
echo "Cek: systemctl status $SERVICE --no-pager"
