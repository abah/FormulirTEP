# Tim Ekspedisi Patriot 2026 — Formulir Pendaftaran

Formulir pendaftaran resmi bergaya premium untuk **Tim Ekspedisi Patriot 2026 Kementerian Transmigrasi Republik Indonesia**. Desain dibuat dari awal — bukan tiruan Google Forms — dengan identitas visual kementerian (navy + antique gold), tipografi dual (Fraunces serif + Plus Jakarta Sans), dan micro-interaction yang halus.

## Struktur

```
FormulirTEP/
├── index.html   — markup, 5 halaman, logo & stepper
├── styles.css   — design system lengkap (tokens + komponen)
├── script.js    — navigasi stepper, validasi, drag-drop file
├── logo.png     — logo resmi Kementerian Transmigrasi
└── README.md
```

## Highlight Desain

- **Sidebar sticky** dengan hero serif italic besar, meta program (50+ kawasan, 10 PT mitra), stepper 5-langkah vertikal (status active / done / upcoming), dan support box.
- **Pola topografi** (SVG garis kontur) pada background — nuansa "ekspedisi".
- **Palet**: Navy `#081531` → `#122B5C` dan Gold `#D4A853` — sesuai palet logo kementerian.
- **Tipografi**: *Fraunces* italic untuk display, *Plus Jakarta Sans* untuk body (font Indonesia-made, resmi bersahabat).
- **Kartu form** bersih dengan shadow halus, input modern `border + focus ring` (bukan underline Google Forms).
- **Chip grid** untuk daftar Perguruan Tinggi (click-to-select, single row responsive).
- **Tile besar** untuk Jenis Kelamin & Posisi Dilamar (check-mark di pojok kanan saat dipilih).
- **Size chart T-Shirt** di card navy dengan gradient gold-accent yang premium.
- **Dropzone file upload** dengan drag & drop penuh, preview nama & ukuran file, tombol ganti.
- **Callout** (accordion) untuk 8 kriteria anggota — dengan nomor bergaya serif italic.
- **Notice/warning** untuk informasi sanksi.
- **Agreement checkbox** besar dengan kartu yang jelas saat di-check.
- **Sticky floating navbar** (pill) dengan progress bar gradient navy→gold, tombol gradient, dan step counter.
- **Success screen** dengan badge animasi `pop`, kode pendaftaran unik, dan timestamp lokal (WIB).
- **Responsive**: desktop split-screen → tablet/mobile stacked dengan ukuran elemen yang dikompresi secara proporsional.
- **Aksesibilitas**: role=radiogroup, aria-label, fokus ring, dukungan `prefers-reduced-motion`.

## Halaman

1. **Data Diri** — 17 field (email, nama, PT mitra/asal, jenjang, KTP, tempat/tgl lahir, jenis kelamin, alamat, asal, suku, WA, email aktif, ukuran kemeja + celana dengan size chart).
2. **Posisi Dilamar** — tile besar "Anggota Tim Ekspedisi Patriot 2026".
3. **Profil Anggota** — nama + gelar, status pendidikan, program studi & PT, dan 5 unggahan PDF (ijazah, 2 portofolio, 3 surat) via dropzone drag-drop.
4. **Kontak Darurat** — nama, hubungan, telepon/WA, alamat.
5. **Pernyataan & Persetujuan** — 2 checkbox wajib, callout sanksi, tombol kirim.

## Fitur Teknis

- **Multi-step wizard** dengan validasi per-halaman; ke halaman berikutnya hanya jika field wajib sudah diisi valid.
- **Navigasi via stepper** di sidebar (klik untuk mundur bebas, klik ke depan memvalidasi halaman sebelumnya).
- **Drag & drop file upload** (PDF only, max 10 MB) dengan preview nama/ukuran file.
- **"Lainnya"** support untuk radio group (Perguruan Tinggi Asal, Ukuran Kemeja, Ukuran Celana) — input teks muncul dinamis.
- **Enter to advance** — keyboard shortcut untuk lanjut di field input.
- **Kode pendaftaran unik** dihasilkan saat submit berhasil.
- **Serialisasi payload** (console.log untuk debugging; tinggal diganti `fetch` ke backend Anda).
- **Validasi email** regex + visual feedback merah di field yang invalid.

## Cara Pakai

Buka di browser:

```bash
open index.html
```

Atau server statis:

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Backend — Firebase

Form + dashboard sudah terintegrasi langsung ke Firebase project **`formulirtep`**:

| Layanan | Fungsi |
|---|---|
| **Firestore** (`registrations`) | Menyimpan 1 dokumen per pendaftar, doc ID = nomor identitas (NIK/paspor) → otomatis mencegah duplikat. |
| **Cloud Storage** (`uploads/{nomorId}/{field}.pdf`) | Menyimpan 6 berkas PDF per pendaftar (ijazah, portofolio, surat-surat). |
| **Authentication** | Google Sign-In untuk dashboard admin. |
| **Hosting** | Melayani seluruh file statis (`index.html`, `dashboard.html`, asset). |

### Struktur data Firestore

```
registrations/
  3201234567890001         ← doc ID = nomor identitas
    kode: "TEP-2026-ABC123"
    namaLengkap, email, whatsapp, ...
    kampusMitra, kampusAsal, posisi, kawasan, ...
    berkas: {
      ijazah: { path, url, name, size, type },
      portoKarya: { ... }, ...
    }
    status: "pending" | "verified" | "rejected"
    submittedAt: Timestamp
    verifiedAt, verifiedBy

admins/
  nama@domain.com           ← doc ID = email admin
    addedAt: Timestamp
    role: "verifikator"
```

### Setup pertama kali

```bash
# 1. Install Firebase CLI
npm install -g firebase-tools

# 2. Login ke akun Google yang memiliki akses project
firebase login

# 3. Pastikan berada di folder proyek
cd /path/ke/FormulirTEP

# 4. Deploy rules, Firestore config, dan hosting
firebase deploy
```

### Menambahkan admin (verifikator)

Buka [Firebase Console → Firestore](https://console.firebase.google.com/project/formulirtep/firestore)
, lalu buat dokumen di koleksi `admins` dengan doc ID = email Google calon admin:

```
Collection: admins
Document ID: contoh.admin@gmail.com
Fields:
  addedAt: timestamp (now)
  role: "verifikator"
```

Setelah itu admin dapat login di `https://formulirtep.web.app/admin` dengan Google Sign-In.

### Mengaktifkan Google Sign-In

Di Firebase Console → Authentication → **Sign-in method**, aktifkan provider **Google**. Hanya sekali saja.

### Penting: sebelum 20.000 pendaftar

1. **Upgrade ke Blaze plan** (pay-as-you-go) — Spark plan hanya 10 GB hosting bandwidth dan 5 GB storage.
2. **Set budget alert** (mis. Rp 500.000) di Google Cloud Console agar tidak kebobolan.
3. **Aktifkan App Check + reCAPTCHA Enterprise** untuk mencegah bot spam:
   ```js
   // firebase-services.js, setelah initializeApp
   import { initializeAppCheck, ReCaptchaV3Provider } from ".../firebase-app-check.js";
   initializeAppCheck(app, {
     provider: new ReCaptchaV3Provider("<site-key>"),
     isTokenAutoRefreshEnabled: true,
   });
   ```
4. **Indeks composite** (bila nanti dipakai): `status + submittedAt`, `kampusMitra + submittedAt`. Tambahkan di `firestore.indexes.json`.

### Rules yang sudah dipasang

- **Firestore** (`firestore.rules`): publik boleh `create` registrasi dengan validasi, admin-only untuk read/update/delete, uniqueness dijamin via cek `!exists(...)`.
- **Storage** (`storage.rules`): publik boleh upload PDF <10 MB dengan path `uploads/{nomorId}/{field}.pdf`, hanya admin yang boleh read/delete.

### Menjalankan lokal dengan emulator

```bash
firebase emulators:start --only hosting,firestore,storage,auth
# http://localhost:5000
```

## Kredit

- Logo resmi Kementerian Transmigrasi Republik Indonesia.
- Font via Google Fonts (Fraunces, Plus Jakarta Sans).
- Dibangun tanpa framework — HTML/CSS/JS vanilla untuk performa maksimal & portabilitas.
