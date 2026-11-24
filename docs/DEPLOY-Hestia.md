# Deploy ARU CRM v4 di VPS Hestia

Domain: https://internal-crm.aruraharja.co.id/

> **Jangan menaruh data akun atau laporan di GitHub maupun Hestia public_html.**
> Source di repo ini; data tetap di `/var/lib/aru-internal-crm/data.json`.

## 1. Verifikasi instalasi lama (SSH sebagai root)

```bash
systemctl cat aru-internal-crm.service
test -f /opt/apps/aru-internal-crm/server.js && echo "Backend ditemukan"
test -f /opt/apps/aru-internal-crm/index.html && echo "Frontend ditemukan"
test -f /var/lib/aru-internal-crm/data.json && echo "Data JSON ditemukan"
curl -sS http://127.0.0.1:3215/api/auth/me
```

Jika path atau service berbeda (misalnya file sebelumnya diunggah langsung ke direktori domain Hestia), **jangan langsung menimpa public_html**. Temukan lokasi backend aktif dahulu:

```bash
systemctl status aru-internal-crm --no-pager
find /home -maxdepth 6 -type d -name 'internal-crm.aruraharja.co.id' 2>/dev/null
```

Skrip deploy melakukan preflight dan tidak mengubah instalasi jika path yang diharapkan tidak ditemukan.

## 2. Ambil source dari GitHub

```bash
if [ -d /opt/apps/aru-crm-source/.git ]; then
  git -C /opt/apps/aru-crm-source pull --ff-only
else
  git clone https://github.com/RioBithub/Aru-CRM.git /opt/apps/aru-crm-source
fi
```

## 3. Jalankan update dan health-check

```bash
bash /opt/apps/aru-crm-source/deploy-hestia.sh
systemctl status aru-internal-crm --no-pager
curl -fsS http://127.0.0.1:3215/api/auth/me
```

Skrip akan membuat backup ke `/root/backup-internal-crm-git/`, mengganti hanya `index.html` dan `server.js`, lalu restart service. `data.json` lama tetap dipertahankan. Jika health-check gagal, kode akan dikembalikan dari backup.

Jika halaman belum berubah di browser, lakukan hard refresh (desktop Ctrl+Shift+R; HP tutup dan buka kembali tab atau bersihkan cache situs).

## Penting

- **Repo saat ini Public.** Jangan push password, token, data profil pegawai, laporan kunjungan, chat WhatsApp, tanda tangan, bukti foto, atau backup JSON.
- Domain Hestia/Nginx tetap memakai konfigurasi lama; kode ini bukan aplikasi statis yang cukup diunggah ke `public_html`.
- Untuk instalasi baru, tetapkan password awal administrator yang kuat lewat environment `CRM_INITIAL_ADMIN_PASSWORD` (minimal 12 karakter). Untuk upgrade lama dengan data admin yang sudah ada, tidak perlu reset password.
- Jika instalasi lama memang menggunakan lokasi atau service berbeda, sesuaikan setelah pemeriksaan konfigurasi aktif; jangan menebak path.
