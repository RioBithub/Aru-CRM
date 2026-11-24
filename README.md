# ARU Visit CRM

CRM internal PT ARU Raharja — versi 4.0 berbasis HTML/CSS/JavaScript dan Node.js tanpa database eksternal. Penggunaan ini cocok untuk **pilot internal**, belum menggantikan sistem enterprise yang diaudit.

## Fitur

- Login pegawai, registrasi mandiri dengan persetujuan admin, pembuatan akun oleh admin
- Profil, divisi/bagian, jabatan, foto profil, dan ganti password
- GPS diperlukan selama aplikasi aktif, check-in lokasi untuk kegiatan fisik
- Laporan aktivitas untuk **vendor, klien, mitra, internal**, dan lainnya
- Kunjungan lapangan, rapat, monitoring pekerjaan, koordinasi WhatsApp, dan tindak lanjut
- Lampiran foto, screenshot WhatsApp, PDF, ekspor chat TXT, tanda tangan pihak yang ditemui
- Timeline perkembangan, status progres, dan ekspor laporan

## Struktur repo

- `index.html` — frontend responsif tema biru ARU, logo resmi diambil dari website ARU
- `server.js` — API Node.js, akun, sesi, laporan, lampiran dan JSON privat
- `deploy-hestia.sh` — update aman untuk server CRM yang **sudah terpasang**
- `.gitignore` — cegah commit data akun, laporan, file upload, dan konfigurasi rahasia

> **Penting:** Repo ini saat dibuat berstatus **Public**. Jangan pernah commit `data.json`, backup, `.env`, dokumen vendor/klien, screenshot WhatsApp, password, atau private key. Untuk aplikasi internal, pertimbangkan mengubah visibilitas repository menjadi Private.

## Update Hestia (CRM v2/v3 sudah terpasang)

Sebelum update, pastikan service `aru-internal-crm.service`, folder `/opt/apps/aru-internal-crm`, dan JSON `/var/lib/aru-internal-crm/data.json` memang ada. Jalankan sebagai `root` di SSH VPS:

```bash
test -f /opt/apps/aru-internal-crm/server.js && test -f /var/lib/aru-internal-crm/data.json && systemctl status aru-internal-crm --no-pager
```

**Pertama kali menggunakan GitHub sebagai sumber:**

```bash
git clone https://github.com/RioBithub/Aru-CRM.git /opt/apps/aru-crm-source
bash /opt/apps/aru-crm-source/deploy-hestia.sh
```

**Untuk update selanjutnya:**

```bash
git -C /opt/apps/aru-crm-source pull --ff-only
bash /opt/apps/aru-crm-source/deploy-hestia.sh
```

Skrip membackup `index.html`, `server.js`, dan `data.json` ke direktori root yang privat sebelum me-restart CRM. Jika health-check gagal, kode dikembalikan; data JSON tidak di-rollback otomatis karena bisa berisi laporan baru. Skrip **tidak** mengedit Nginx/Hestia, SSL, maupun domain lain.

Setelah berhasil: https://internal-crm.aruraharja.co.id/ . Di HP, tutup-buka tab atau bersihkan cache bila masih versi lama.

## Jalankan lokal untuk pengembangan

```bash
node --version   # Node.js 18+
# Untuk inisialisasi data baru, hanya di lingkungan lokal:
CRM_INITIAL_ADMIN_PASSWORD='PASSWORD_KUAT_MINIMAL_12_KARAKTER' node server.js
```

Buka http://127.0.0.1:3215/ . Variabel `CRM_INITIAL_ADMIN_PASSWORD` **hanya diperlukan bila belum ada admin** dalam JSON. Jika data lama sudah memiliki admin, password dan akunnya dipertahankan. Jangan simpan password dalam repo.

## Catatan pengamanan dan keterbatasan

- Data JSON, termasuk hash password dan lampiran, wajib berada di lokasi privat **di luar** `public_html` dan **tidak** masuk GitHub.
- Koordinat GPS dari browser memerlukan izin pengguna/HTTPS dan bukan bukti lokasi yang anti-manipulasi. Browser tidak dapat menjamin GPS menyala saat aplikasi tertutup.
- Bukti WhatsApp diunggah manual; tidak ada integrasi membaca chat.
- Ukuran lampiran terbatas untuk JSON (sekitar 480 KB per berkas). Untuk penggunaan operasional skala besar perlu migrasi database, object storage, backup terjadwal, pengelolaan akses, audit keamanan, dan kebijakan retensi data.
