# AI Team — daftar tugas yang dikerjakan bot QA / Engineer / DevOps / UI/UX

Aplikasi pribadi untuk menugaskan pekerjaan nyata ke empat rekan kerja AI senior. Anda menulis tugas, memilih bot, dan tugas itu langsung dikerjakan di mesin ini. Anda membaca hasilnya per tugas, me-review, atau mengopernya ke bot lain.

| Bot | Yang dia kerjakan | Hasil yang Anda baca |
|---|---|---|
| **QA Engineer** | Menguji lewat Chromium (buka, klik, isi form, unggah berkas, baca console) | tab **Live** untuk menonton langsung · `report.md` + screenshot bukti di tab **Laporan** |
| **Software Engineer** | Mengubah kode di `WORKSPACE_DIR`, menjalankan test | Transcript + tab **Perubahan** (git status & diff) |
| **DevOps Engineer** | Inspeksi server, rencana + rollback, eksekusi setelah Anda setujui | Transcript + kartu persetujuan per perintah |
| **UI/UX Designer** | Mengaudit tampilan, alur, aksesibilitas, dan responsif lewat Chromium; tidak mengubah kode | tab **Live** · `report.md` berisi temuan + spesifikasi untuk Engineer di tab **Laporan** |

Bot berjalan dengan **akun AI milik app**: login Claude (langganan Pro/Max) dan/atau login Google untuk Gemini, ditambahkan
di **Pengaturan → Akun AI** dan terpisah dari `claude` maupun `agy` di terminal. Mesin mengikuti akun: hanya akun Claude
berarti hanya Claude, tambah akun Gemini berarti keduanya. Lihat [Akun AI](#akun-ai).

Bot Claude memakai `@anthropic-ai/claude-agent-sdk` tanpa `ANTHROPIC_API_KEY`. Bot Gemini memakai Antigravity CLI, dipilih
per bot, per tugas, dan saat oper. Lihat [Mesin Gemini (Antigravity)](#mesin-gemini-antigravity), termasuk risikonya bagi akun.

## Jalankan

```bash
bun install
cp .env.example .env     # sesuaikan WORKSPACE_DIR dan TARGET_URL
bun run check:auth       # bukti akun Claude app terpakai (apiKeySource: none) — setelah login di Pengaturan
bun run check:browser    # bukti Playwright + Chromium siap
bun run check:mcp        # bukti tool browser & tim terdaftar
bun run start   # http://127.0.0.1:4320
```

Setelah server hidup, buka **Pengaturan → Akun AI** dan tambahkan akun Claude dan/atau Gemini. Sebelum ada akun,
tombol **+ Tugas** nonaktif dan banner di atas halaman menjelaskan kenapa.

Pengembangan UI (hot reload di 4321, API tetap 4320): `bun run dev`.
Pindahkan laporan dari versi lama (kalau ada `data/reports/`): `bun run migrate:v1`.

### Alias domain lokal (`http://ai-team.localhost`)

Supaya tidak mengetik `127.0.0.1:4320`: nginx yang sudah ada di port 80 meneruskan nama `ai-team.localhost`
(dan nama lama `ai-team.local`) ke server aplikasi. Berkas vhost-nya ada di `deploy/nginx/ai-team.local.conf`:
header `Upgrade` diteruskan untuk WebSocket `/api/ws`, dan buffering dimatikan supaya Live MJPEG tidak tertahan.
Pasang sekali:

```bash
sudo cp deploy/nginx/ai-team.local.conf /etc/nginx/sites-available/ai-team.local
sudo ln -s /etc/nginx/sites-available/ai-team.local /etc/nginx/sites-enabled/ai-team.local
sudo nginx -t && sudo systemctl reload nginx
```

Browser sendiri mengarahkan `*.localhost` ke mesin ini, jadi baris `/etc/hosts` tidak perlu.

**Pakai `ai-team.localhost`, bukan `ai-team.local`.** Browser hanya menganggap HTTPS, `localhost`, `127.0.0.1`,
dan `*.localhost` sebagai *secure context*. Di `http://ai-team.local` browser memblokir notifikasi tanpa pernah
bertanya, dan setelan situs pun tidak bisa membukanya. Izin notifikasi berlaku per alamat, jadi klik
**Izinkan notifikasi** sekali lagi setelah pindah alamat.

Sudah memasang versi lama (tanpa `map $http_upgrade` atau tanpa `ai-team.localhost` di `server_name`)? Salin ulang
berkasnya lalu `sudo nginx -t && sudo systemctl reload nginx`. Tanpa `map $http_upgrade`, halaman tetap terbuka
tapi tidak menerima pembaruan live (penanda *terputus* menyala).

`127.0.0.1:4320` tetap bisa dipakai; `ai-team.service` tidak perlu di-restart. Alias ini hanya untuk
build produksi — UI dev `bun run dev` tetap di port Vite 4321.

Nama lama `ai-team.local` masih dilayani, tapi server hanya mempercayainya kalau `/etc/hosts` mengarahkannya ke
loopback (`127.0.0.1 ai-team.local`). Tanpa baris itu nama `.local` dijawab mDNS dan bisa diklaim perangkat lain di
LAN (DNS rebinding). `/etc/hosts` dibaca lebih dulu daripada mDNS (`nsswitch: files mdns4_minimal`), jadi baris
itu aman walau Avahi aktif.

### Auto-start (systemd user service)

Supaya server hidup sendiri setelah login — tanpa `nohup bun server/main.ts` lagi:

```bash
kill $(ss -ltnp | sed -nE 's/.*127\.0\.0\.1:4320.*pid=([0-9]+).*/\1/p')   # matikan instance manual
mkdir -p ~/.config/systemd/user
cp deploy/ai-team.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-team.service
```

Unit-nya ada di `deploy/ai-team.service`. Dua barisnya tidak boleh diubah sembarangan:
`WorkingDirectory` (karena `.env` dibaca dari cwd dan `DATA_DIR=./data`) dan `Environment=PATH`
(karena Agent SDK memanggil `claude` dari PATH — tanpa `~/.local/bin` server tampak sehat tapi
semua tugas gagal start; `GET /api/health/auth` adalah cara tercepat memeriksanya — 200 kalau ada akun siap, 503 kalau
belum, dengan status tiap akun).

Operasi harian:

```bash
systemctl --user restart ai-team               # setelah ubah kode server
bun run build && systemctl --user restart ai-team   # setelah ubah UI (web/)
journalctl --user -u ai-team -f                # log (data/server.log hanya untuk run manual)
systemctl --user status ai-team                # status + PID
```

Service ini mulai saat Anda login dan berhenti saat logout; tugas yang tertunda dilanjutkan
otomatis saat start berikutnya. Kalau ingin hidup sejak boot tanpa login: `loginctl enable-linger jae`
— unit-nya tidak perlu diubah. Server berjalan di Bun (`~/.bun/bin/bun`); setelah `bun upgrade`, cukup
`systemctl --user restart ai-team`.

## Aplikasi desktop (Linux)

AI Team juga bisa dibuka sebagai aplikasi desktop: jendela native dengan ikon tray, yang ditulis dengan Rust
([Tauri v2](https://v2.tauri.app), kodenya di `src-tauri/`). Aplikasinya **jendela tipis**: ia tidak menjalankan
server sendiri, tetapi membuka layanan yang sudah berjalan di atas (`http://127.0.0.1:4320`). Jadi data, akun AI,
dan tugasnya sama persis dengan versi web, dan perubahan UI tetap dirilis dengan `bun run build` + restart layanan.

Build lewat Docker. Selain Docker tidak ada yang perlu dipasang: Rust dan pustaka dev Tauri ada di dalam image
(`src-tauri/Dockerfile`, Ubuntu 22.04). Hanya proses build yang berjalan di kontainer; aplikasinya berjalan langsung
di desktop memakai WebKitGTK sistem.

```bash
bun run desktop:docker:check   # cargo check + clippy
bun run desktop:docker:dev     # build debug, lalu buka jendelanya
bun run desktop:docker:build   # paket .deb di src-tauri/target/release/bundle/deb/
sudo apt install ./src-tauri/target/release/bundle/deb/AI\ Team_*_amd64.deb   # menu aplikasi: "AI Team"
```

Build pertama membuat image (~2,5 GB) dan mengompilasi semua crate, jadi butuh beberapa menit; build berikutnya
inkremental. Cache cargo kontainer disimpan di `src-tauri/target/docker-home/`. Dengan Rust di mesin sendiri:
`bun run desktop:dev` / `bun run desktop:build`.

- **Layanan belum jalan?** Jendela menampilkan halaman "Belum tersambung" dengan tombol **Jalankan layanan**
  (`systemctl --user start ai-team`) dan **Coba lagi**. Halaman itu juga memeriksa ulang sendiri tiap beberapa
  detik, lalu pindah ke UI begitu layanan menjawab.
- **Alamat lain**: env `AI_TEAM_URL`, mis. `AI_TEAM_URL=http://ai-team.localhost ai-team`. Hanya `http://` ke
  `127.0.0.1`, `localhost`, atau `ai-team.localhost` yang diterima; nilai lain diabaikan dan halaman splash
  menampilkan alasannya.
- **Menutup jendela tidak menutup aplikasi.** Jendelanya disembunyikan ke tray supaya notifikasi tetap muncul.
  Menu tray: **Buka AI Team**, **Muat ulang** (kembali ke halaman yang sama setelah tersambung lagi), dan
  **Keluar**. Membuka aplikasi lagi memunculkan jendela yang sama, jadi desktop tanpa tray (GNOME tanpa
  ekstensi AppIndicator) tetap bisa memakainya. Layanan AI Team sendiri tidak pernah ikut berhenti.
- **Notifikasi** dikirim sebagai notifikasi desktop, tanpa izin per situs. Pengaturan menampilkannya sebagai
  "Notifikasi desktop". Badge `(2) AI Team` ikut tampil di judul jendela.
- **Tautan** ke situs lain dan tautan `target="_blank"` (lampiran, bukti, halaman login akun AI) dibuka di
  browser sistem. Unduhan masuk ke folder Unduhan.
- **Rilis UI baru ikut sendiri.** Setelah `bun run build` + restart, setiap halaman yang terbuka (jendela desktop
  maupun tab browser) memeriksa ulang `index.html` begitu tersambung lagi. Halaman yang tidak sedang dilihat
  langsung dimuat ulang; halaman yang sedang dipakai menampilkan bilah "Versi baru AI Team sudah dirilis" dengan
  tombol **Muat ulang**, dan ikut dimuat ulang begitu disembunyikan. Draf chat tetap tersimpan
  (`web/version.ts`).
- **Tab Live** membaca aliran yang sama lewat `fetch` (`web/lib/mjpeg.ts`, endpoint `…/live?raw=1`), bukan
  `<img>`. WebKitGTK menampilkan MJPEG di `<img>`, tetapi tidak pernah menutup sambungannya, sehingga screencast
  bot tidak akan berhenti. Pemisah frame-nya diuji `bun run check:mjpeg`.
- Paket dari `desktop:docker:build` dibangun di Ubuntu 22.04, jadi jalan di 22.04 dan rilis sesudahnya.

## Akun AI

**Pengaturan → Akun AI** memuat satu kartu per penyedia (satu akun per penyedia):

| Status | Arti |
|---|---|
| Terhubung | Akun siap; email, paket, dan jumlah model tampil di kartu. |
| Gagal diperiksa | Pemeriksaan terakhir gagal karena hal lain (mis. jaringan). Bot tetap boleh jalan. |
| Perlu login ulang | Login ditolak penyedianya. Bot di mesin itu tidak dijalankan sampai Anda login lagi. |
| Belum ditambahkan | Mesin itu tidak bisa dipilih di mana pun. |
| Belum tersedia | Program yang dibutuhkan belum terpasang (`agy`, atau `dbus-daemon`/`gnome-keyring-daemon` untuk Gemini). |

**Menambahkan akun.** Tekan **Tambah akun**, lalu **Buka halaman login ↗**. Masuk di tab baru; halaman akhirnya
menampilkan kode (Claude) atau membuka halaman Antigravity (Gemini). Tempel kode itu, atau alamat lengkap halaman
Antigravity, di dialog lalu tekan **Kirim kode**. Batas waktunya 10 menit. Dialog boleh ditutup: login tetap berjalan di
server, dan tombol **Lanjutkan login** membukanya lagi.

Di belakangnya server menjalankan alur login resmi CLI-nya sebagai proses milik app: `claude auth login --claudeai` dan
`agy acp --login`. App tidak punya OAuth sendiri. URL login, kode, dan output CLI tidak pernah ditulis ke log.

**Periksa** membaca ulang status login dan daftar model. **Keluar** menjalankan `claude auth logout` (Claude), atau
mencabut sesi `agy` lalu membuang keyring pribadinya (Gemini). Riwayat tugas tetap ada; tugas yang memakai mesin itu
menunggu sampai Anda login lagi.

**Terpisah dari terminal.**

- Claude: semua proses Claude milik app memakai `CLAUDE_CONFIG_DIR=data/accounts/claude`. Kredensial, `.claude.json`,
  dan transkrip sesi bot ada di sana; `~/.claude` tidak disentuh.
- Gemini: `agy` menyimpan token Google di keyring desktop lewat D-Bus, dan folder data saja tidak memisahkannya.
  Karena itu app menjalankan `dbus-daemon` dan `gnome-keyring-daemon` miliknya sendiri. Keyring-nya ada di
  `data/accounts/gemini/keyring/`, dikunci kata sandi acak di `keyring.secret` (0600). Semua proses `agy` milik app
  diarahkan ke bus itu, jadi `agy` di terminal tetap memakai login Anda sendiri. Keyring ini dimulai saat pertama
  dipakai dan berhenti bersama server.

**Tanpa akun yang siap:**

- tugas baru dan oper ke mesin itu ditolak (409) dengan alasannya;
- pesan dan review "perlu perbaikan" ke tugas di mesin itu juga ditolak;
- tugas yang sedang berjalan saat server mati tidak dilanjutkan. Statusnya menjadi "perlu dibaca" dengan catatan, dan
  pesan berikutnya setelah akun siap melanjutkannya;
- panel Tanya hanya bisa memilih mesin yang akunnya siap, dan kurator memori pindah ke mesin lain yang siap. Tanpa akun
  sama sekali, keduanya tidak berjalan dan alasannya tampil di panel/laporan project;
- login yang ditolak saat tugas berjalan menandai akun "Perlu login ulang".

**Pindah dari login laptop.** Setelah akun Claude pertama kali terhubung, transkrip sesi yang dirujuk tugas disalin
sekali dari `~/.claude/projects/` ke folder akun app, supaya tugas lama tetap bisa dilanjutkan. Hanya sesi milik tugas
yang disalin, dan `~/.claude` tidak diubah. Kredensial laptop sengaja tidak diimpor: token refresh yang berputar akan
saling membatalkan, jadi login sekali di app. Folder `data/antigravity/` versi sebelumnya dipindah ke
`data/accounts/gemini/`, dan akun Gemini perlu login sekali di app.

> **Hanya untuk dipakai sendiri.** Login langganan ini milik Anda dan hanya untuk app di mesin Anda sendiri. Jangan
> bagikan app atau folder `data/` beserta loginnya ke orang lain.

Bot tidak bisa membaca atau mengubah akun. `data/accounts/` dan `data/accounts.json` ditolak untuk semua mesin. Perintah
yang menyebut `CLAUDE_CONFIG_DIR` atau `.credentials.json`, yang menjalankan `claude auth`/`claude setup-token`,
`agy --login`/`--logout`, atau yang memakai alat keyring/D-Bus (`secret-tool`, `gdbus`, `busctl`, …) selalu ditolak.

## Model & penalaran per bot

**Pengaturan → Bot** memuat satu baris per bot plus kurator memori dan panel Tanya, dengan kolom Mesin, Model, Penalaran,
dan Mode:

- Daftar model diambil dari akunnya sendiri (Claude Code `supportedModels()`; untuk Gemini, daftar model `agy`).
- Model atau penalaran yang dikosongkan memakai `.env` (`MODEL_*`, `EFFORT_*`).
- Mesin tanpa akun siap tidak bisa dipilih. Kalau hanya satu akun yang ada, kolom Mesin cukup berupa teks.
- Baris **Kurator memori** dan **Panel Tanya** juga punya kolom Mesin (bawaan Claude), tanpa Mode. Kalau akun mesin
  pilihannya belum siap, keduanya sementara memakai mesin lain yang siap. Baris Panel Tanya hanya bawaan: di panel,
  mesin dan model bisa diganti per pertanyaan.

Pilihan ini berlaku untuk tugas dan operan baru. Form **+ Tugas** dan **Oper ke…** bisa menggantinya per penugasan, juga
untuk Claude. Model dicatat di penugasan (`assignments[].model`), jadi mengubah Pengaturan tidak mengubah tugas yang
sudah jalan.

## Cara kerja

1. **+ Tugas** → project, judul, instruksi, bot, dan (untuk QA dan UI/UX) URL yang diuji. Tugas langsung masuk antrean.
2. Maksimal `MAX_CONCURRENT_AGENTS` tugas berjalan bersamaan (default 2). Tugas **Engineer/DevOps** saling menunggu hanya kalau **workspace-nya sama** — dua project dengan folder berbeda boleh menulis bersamaan; tugas QA dan UI/UX selalu boleh paralel. Selama bot menunggu keputusan Anda, slotnya dipakai tugas lain, tapi folder kerjanya tetap terkunci sampai turn itu selesai — termasuk setelah Stop, sampai proses Claude benar-benar berhenti.
3. Saat bot minta izin menjalankan sesuatu, muncul **kartu persetujuan**: *Izinkan*, *Izinkan & ingat*, atau *Tolak* dengan alasan. Agen berhenti sampai Anda memutuskan, dan alasan penolakan dibacanya.
4. Setelah selesai, status jadi **perlu dibaca**. Buka tab **Laporan** (QA, UI/UX) atau **Perubahan** (kode), lalu **Review**: *Setuju* menutup tugas; *Perlu perbaikan* mengirim komentar Anda ke bot yang sama dan tugas kembali dikerjakan.
   - Tab **Laporan** punya tiga bagian. **Report utama** menampilkan verdict terkini dan `report.md` per putaran (laporan awal, perbaikan, uji ulang), yang terbaru di atas, plus galeri bukti. **Temuan** berisi temuan terbuka per severity beserta detail dari laporan; temuan yang belum dikurasi berlabel *belum masuk register*. **Resolved** berisi temuan yang sudah ditangani: *menunggu uji ulang*, *terverifikasi*, *diperbaiki*, *tidak diperbaiki*, atau *bukan masalah*. Isinya memuat ulang sendiri, dan tombol **Download temuan** mengunduh temuan tugas itu.
   - Status temuan berubah saat bot melapor: Engineer/DevOps lewat `finding_report_fixed` (pindah ke Resolved, menunggu uji ulang), QA lewat `finding_retest` (lolos jadi terverifikasi; gagal kembali ke Temuan dengan tanda regresi). Hanya QA yang bisa memverifikasi. UI/UX melaporkan temuan lewat `report.md` dan tidak mengubah statusnya.
   - Berkas lain di folder tugas — laporan tambahan `.md`, bukti data `.tsv`/`.txt`, patch, skrip uji, berkas uji unggahan di `uploads/`, dan hasil ekspor yang diunduh bot saat menguji di `downloads/` — tampil di tab **Lampiran**: daftar berkas di kiri, isinya dirender di kanan (`.md` sebagai markdown, teks lain apa adanya, berkas biner seperti xlsx/pdf cukup dengan tombolnya), dengan tombol **Unduh** per berkas. Tidak perlu lagi membuka `data/tasks/` dari terminal.
5. Tab **Kerja** hanya ikut turun kalau Anda memang sedang berada di dasar. Begitu Anda scroll ke atas untuk membaca chat lama, tampilan diam walau agen terus menulis; yang muncul cuma tombol **Pesan baru ↓** (berubah kuning jadi **Menunggu keputusan Anda ↓** kalau ada kartu persetujuan). Kembali ke dasar — lewat tombol itu atau scroll sendiri — membuatnya mengikuti lagi.
6. **Oper ke…** memindahkan tugas ke bot lain. Bot baru menerima instruksi asli, **ringkasan serah terima** bot sebelumnya, catatan operan Anda, dan daftar bukti yang sudah ada. Riwayatnya tampil sebagai `QA → Engineer → QA`.
7. Bot bisa **mengusulkan** operan sendiri (`suggest_handoff`); usulan muncul sebagai tombol satu-klik, tidak pernah jalan tanpa Anda.
8. **Menghapus tugas** hanya bisa dari tab **Setelan** (paling kanan di deretan tab), di kotak **Zona berbahaya**: dialognya baru mengizinkan hapus setelah Anda mengetik ID tugasnya (mis. `T-015`). Tugas yang masih antre, berjalan, atau menunggu keputusan harus di-**Batalkan** dulu.
   - Yang terhapus permanen: seluruh folder `data/tasks/<id>/` — transcript, `report.md`, screenshot bukti, lampiran, berkas `uploads/`/`downloads/`, dan catatan Anda. Agen, browser QA, dan panel Tanya tugas itu ikut ditutup.
   - Yang tetap: register temuan, cakupan uji, dan log kurasi project. Di **Report project**, rujukan ke tugas itu tampil dicoret dengan label *dihapus* (tanpa tautan), dan barisnya di *Lampiran: laporan per tugas* tetap ada dengan verdict, ringkasan, dan daftar temuan terakhir sebelum dihapus. "Download report lengkap" ikut menandainya `(dihapus)`.
   - Catatannya disimpan di `data/deleted-tasks.json`, sehingga ID tugas yang dihapus tidak pernah dipakai ulang. Alamat lama tugas itu menampilkan kartu "sudah dihapus", dan tab lain yang sedang membukanya ikut berganti ke kartu itu.

Contoh tugas:

```
QA        Uji alur login staging. Sertakan screenshot tiap langkah dan periksa error console.
Engineer  Perbaiki bypass password kosong yang ditemukan QA, tambahkan test, jalankan npm test.
DevOps    Periksa kenapa container api restart terus. Jangan ubah apa pun sebelum saya setujui rencananya.
```

## Alamat (routing)

Posisi Anda tersimpan di alamat, jadi refresh — termasuk setelah `systemctl --user restart ai-team` — mengembalikan Anda ke tempat yang sama, dan tombol Back/Forward browser bekerja seperti biasa.

```
/                                 daftar; langsung membuka tugas teratas
/tasks/T-015                      tab bawaan (Kerja), atau Live kalau browser QA sedang hidup
/tasks/T-015/report               tab: work · live · report · docs · notes · diff · settings
/tasks/T-015/report?section=findings   bagian laporan: findings · resolved (bawaan: Report utama)
/tasks/T-015/docs?doc=audit.md    lampiran yang sedang dibaca
/tasks/T-015/notes?view=preview   catatan pribadi Anda untuk tugas itu
/projects/ews-local               halaman project; ?tab=context|memory|tasks|settings
/memory, /settings                memori global & pengaturan
?project=ews-local&role=qa        filter daftar; ikut terbawa saat pindah tugas
```

Satu tugas atau satu lampiran bisa di-bookmark. Alamat tugas yang sudah tidak ada memberi kartu "tidak ditemukan", bukan memuat selamanya. Ganti filter dan ganti berkas lampiran memakai `replace`, jadi riwayat browser tidak penuh oleh keduanya.

## Sidebar

Tombol **«** di sebelah judul — atau **Ctrl+B** (Cmd+B di Mac) dari mana saja — melipat sidebar jadi rel sempit; isi tugas memakai ruang yang kosong itu. Di rel masih tersedia **»** untuk membuka lagi, tombol **+** untuk tugas baru, dan pengganti tema. Pilihannya tersimpan di browser Anda, jadi bertahan setelah muat ulang.

Status akun AI ada di Pengaturan → Akun AI. Kalau belum ada akun yang siap sama sekali, sebuah banner muncul dengan tautan ke sana.

## Tema

Tampilannya memakai palet bergaya Notion: abu hangat, teks `#37352f`, aksen biru `#2383e2` — tanpa ungu. Tersedia **terang**, **gelap** (`#191919`), dan **ikut sistem**; tombolnya ada di pojok kiri bawah sidebar dan pilihannya tersimpan di browser Anda.

Semua warna komponen memakai token semantik (`bg-page`, `bg-panel`, `text-ink`, `text-muted`, `border-line`, `bg-accent`, `bg-tag-*`) yang didefinisikan sekali di `web/styles.css`. Untuk mengubah palet, sunting variabel di `:root` dan `[data-theme="dark"]` — tidak perlu menyentuh satu pun komponen.

## Menonton QA bekerja (Live)

Tab **Live** di panel tugas menampilkan isi browser QA saat itu juga — halaman yang sedang dibuka, form yang sedang diisi, pesan error yang muncul. Di bawahnya tertulis aksi browser terakhir, dan di daftar tugas ada titik merah `● live` untuk tugas yang browsernya sedang hidup.

- Panel menyala sendiri begitu QA membuka halaman; tugas yang live-nya aktif langsung membuka tab Live saat dipilih.
- **Aksi bot terlihat** di atas gambar: kursor meluncur ke elemen yang disentuh, riak saat klik, kotak sorot pada elemen target, dan keterangan di pojok kiri bawah ("Mengklik “Masuk”", "Mengisi “Email”: …", tombol keyboard yang ditekan, kilat saat screenshot). Isi field password selalu tampil sebagai `••••••`.
  Overlay ini digambar di UI, bukan di halaman, jadi screenshot bukti dan `snapshot`/`inspect` bot tidak ikut berubah. Posisi elemen hanya diukur selama ada yang membuka tab Live (topik WebSocket `live:<id>`); tanpa penonton tool browser bekerja persis seperti sebelumnya.
- **Ambil alih** — tombol di kanan atas tab Live menyerahkan browser bot ke Anda: klik, gulung, ketik, dan paste langsung di gambar (mis. untuk login 2FA, captcha, atau menunjukkan langkah). Selama itu setiap tool browser bot **menunggu** (paling lama 10 menit; Stop membatalkannya), tanpa menginterupsi modelnya. **Serahkan ke bot** mengembalikannya, dan hasil tool bot berikutnya diawali ringkasan seperti *"Owner sempat mengambil alih browser selama 1m20s. Aksi owner: klik “Masuk”; mengetik 12 karakter di “Email”"*.
  - Isi ketikan Anda **tidak pernah** dikirim ke bot, ditulis ke transcript, atau dicatat — hanya jumlah karakter dan nama field-nya.
  - Kendali melekat ke tab browser yang memintanya: menutup tab itu, pindah tugas, atau sambungan putus langsung mengembalikan kendali ke bot. Browser bot juga tidak ditutup idle selama Anda memegangnya.
  - Thread tugas mencatat kapan kendali diambil dan dikembalikan.
- Tombol **Buka di tab baru** menampilkan aliran gambarnya penuh satu layar (`/api/tasks/<id>/live`, MJPEG biasa).
- Setelah sesi browser berakhir, frame terakhir dibiarkan membeku di panel; bukti permanennya tetap screenshot di tab Laporan.

**Bot yang melihat layar.** Selain tool berbasis selector, QA dan UI/UX punya tool seperti computer use: `view` (gambar layar sekarang, diperkecil ke sisi panjang 1280 px supaya tidak diperkecil lagi oleh API) lalu `click_at`, `type_text`, `scroll_at`, `drag`, dan `move` dengan koordinat piksel gambar itu. Dipakai untuk canvas, peta, grafik, slider, drag & drop, atau pemeriksaan visual; untuk form dan tombol biasa bot tetap memakai `snapshot` + `click`/`fill` karena lebih presisi dan lebih hemat. Gambar `view` bukan bukti laporan — bukti tetap `screenshot`.

`bun run check:control` menguji ketiga fitur ini (overlay, ambil alih, tool layar) dengan Chromium sungguhan, tanpa model.

Secara teknis: CDP `Page.startScreencast` → JPEG (lebar 1280, hingga 60 fps — setiap gambar Chromium selama halaman berubah) → MJPEG lewat `multipart/x-mixed-replace`. Header frame berikutnya langsung dikirim di belakang tiap frame, karena Chrome baru menampilkan satu frame MJPEG setelah header frame berikutnya datang. Screencast hanya menyala selama ada yang menonton: tanpa penonton (tab Live tertutup atau tab browser disembunyikan) ia berhenti ±3 detik kemudian supaya Chromium tidak membakar CPU, dan saat tab Live dibuka lagi frame keadaan sekarang datang dalam ±25 ms. Sesi browser yang ditutup tanpa penonton menyimpan satu screenshot penutup, jadi frame yang membeku adalah keadaan akhir halaman. Kalau screencast gagal, fitur ini mati diam-diam dan pengujian tetap berjalan.

## Aksi browser yang melaporkan hasilnya sendiri

Ide terbaik [browser-use](https://github.com/browser-use/browser-use), dibangun ulang di atas Playwright yang sudah ada — tanpa agen kedua, tanpa API key tambahan, dan tanpa kehilangan Live, ambil alih, atau bukti laporan.

- **Sasaran tepat.** `snapshot` memberi setiap elemen yang terlihat sebuah `ref` (`e12`); `click`, `fill`, `hover`, `press`, dan `select_option` menerima ref itu, jadi tombol **Edit** kembar di baris tabel tidak tertukar. `selector`/`text` hanya mengenai elemen yang **terlihat** — duplikat tersembunyi (menu versi mobile, tab tertutup) dilewati.
- **Menunggu halaman tenang, lalu melaporkan yang berubah.** Setiap aksi menunggu request jaringan yang dipicunya selesai dan DOM diam, lalu hasilnya mencantumkan perubahan halaman: `+ alert [ref=e39]: Data tersimpan`, `~ checkbox "Setuju" [checked]`, `− dialog "Hapus data?"`. Bot tidak perlu lagi `wait` 2–3 detik atau screenshot hanya untuk melihat hasil klik. Long-polling, telemetri, dan animasi JS tidak ditunggu; halaman yang sangat besar (ribuan baris) dilewati ringkasannya supaya aksi tetap cepat.
- **Kegagalan dijelaskan.** Elemen yang tertutup modal/overlay disebut penutupnya — sengaja tidak diklik lewat JavaScript, karena pengguna pun tidak bisa mengkliknya. Teks yang hanya cocok dengan elemen tersembunyi gagal dalam 2 detik (dulu 10), ref basi menyuruh snapshot ulang, dan opsi `<select>` yang tidak ada disebutkan pilihan yang tersedia.
- **Unduhan dan ekspor** disimpan ke `downloads/` di folder tugas dan tampil di tab Lampiran. Hasil aksinya menyebut nama, ukuran, jenis berkas dari isinya (ekspor "xlsx" yang ternyata halaman error ketahuan), dan cuplikan isi CSV/teks. Dulu `open` ke URL ekspor gagal dengan "Download is starting".
- **Detail kecil:** `fill` membaca ulang isinya (maxlength atau mask yang diam-diam memotong isian ketahuan), saran autocomplete dan tooltip/menu hover yang ditunda diberi waktu muncul, `press` menyebut elemen yang fokus sesudahnya (audit urutan Tab), tab baru dilaporkan lalu ditutup, dan isi field password disamarkan di setiap snapshot.

`bun run check:actions` menguji semuanya dengan Chromium sungguhan dan halaman uji lokal, tanpa model.

## Mode otonomi

Tiap tugas berjalan dalam salah satu dari tiga mode. Bawaannya diatur per bot di halaman **Pengaturan** (bukan `.env`, tanpa restart), dan tiap tugas bisa diubah sendiri lewat pemilih **Mode** di header tugas — termasuk saat tugas sedang berjalan.

| Mode | Artinya |
|---|---|
| **Auto** | Agen menjalankan perintahnya sendiri. Classifier Claude Code menilai tiap perintah; pagar keras di bawah tetap berlaku. |
| **Minta approval** | Perilaku bawaan: perintah di luar daftar aman memunculkan kartu persetujuan. |
| **Hanya baca** | Agen hanya boleh menyelidiki dan menyusun rencana; perubahan apa pun tertahan. |

**Pagar keras berlaku di semua mode**, lewat `PreToolUse` hook yang membaca string perintah secara utuh — termasuk isi `ssh host '…'`, yang tidak bisa dijangkau aturan allow/deny biasa:

- **Ditolak, tanpa bisa disetujui:** `rm -rf` pada direktori sistem, `mkfs`, `dd of=/dev/…`, `shutdown`/`reboot`, fork bomb, `DROP DATABASE`.
- **Selalu minta persetujuan, walau mode Auto:** service & container (`systemctl restart`, `docker compose down`, `pm2 restart`) · data & database (`TRUNCATE`, migrasi, `pg_restore`, `docker volume rm`) · kredensial, firewall & akses (`ufw`, `iptables`, `ssh-keygen`, tulis `.env`) · hapus berkas & instalasi paket (`rm` di luar area kerja, `apt install`) · perintah yang isinya tidak bisa dinilai (`sudo` di dalam `ssh`, `curl … | sh`).

Polanya ada di `server/policy.ts` sebagai tabel data, dan `bun run check:policy` menguji 37 kasus tanpa biaya model. Alasan penolakan atau permintaan izin ditulis di kartu, mis. *"Perlu persetujuan owner · hapus berkas & paket: mengubah paket sistem."*

## Notifikasi browser

Agen yang berhenti menunggu keputusan tidak lagi terlewat. Di **Pengaturan** Anda menyalakan izin notifikasi dan memilih pemicunya: kartu persetujuan, agen bertanya, tugas selesai & perlu dibaca, dan tugas gagal. Bawaannya notifikasi hanya muncul saat AI Team **tidak sedang dilihat**: tabnya tersembunyi, atau jendelanya tidak fokus (mis. tertutup jendela lain). Saat Anda sedang melihatnya, kartunya sudah terlihat sendiri.

Notifikasi hanya jalan di alamat aman: `http://ai-team.localhost`, `http://localhost:4320`, atau HTTPS. Di `http://ai-team.local` browser memblokirnya, dan Pengaturan menampilkan tautan ke alamat yang aman.

Jumlah tugas yang menunggu keputusan selalu tampil di judul tab, mis. `(2) AI Team`. Notifikasi berlaku lintas tugas, jadi tetap muncul walau Anda sedang membuka tugas lain atau halaman Pengaturan. Stop yang Anda tekan sendiri tidak memunculkan notifikasi (tugasnya jadi *perlu dibaca*, bukan *gagal*).

Semua pembaruan live — thread, status, tab Live, laporan, rekap project, panel Tanya, dan notifikasi — lewat **satu WebSocket per tab** (`/api/ws`), tanpa polling. Kalau sambungannya putus (mis. server di-restart), penanda *terputus* menyala, lalu tab menyambung sendiri dan server mengirim ulang event yang terlewat.

## Tanya (chat incognito)

Tombol **Tanya** di header tugas — atau **Ctrl+K** — membuka panel di sisi kanan: sesi Claude atau Gemini terpisah yang tahu seluk-beluk tugas itu dan bisa Anda tanyai tanpa mengotori percakapan utama.

Yang ia **tidak** lakukan: tidak menulis satu baris pun ke `thread.jsonl`, tidak dibaca bot yang mengerjakan tugas, tidak menyimpan sesi Claude (`persistSession: false`), tidak pernah memunculkan kartu persetujuan, dan tidak bisa mengubah apa pun, dengan `notes.md` dan kredensial tetap ditolak:

- di Claude hanya `Read`/`Grep`/`Glob`, tanpa Bash/Edit/Write;
- di Gemini hanya `read_file` dan perintah yang membaca (`ls`, `cat`, `grep`, `git log`, …), dinilai pagar yang sama dengan mode *Hanya baca*. Menulis, web, subagen, dan `ask_question` ditolak.

Yang ia **lihat**: instruksi tugas, status, ringkasan serah terima, 40 kejadian terakhir percakapan, konteks & memori project, plus path transcript penuh/laporan/lampiran/workspace supaya bisa membuka sendiri kalau perlu.

- Panel tetap terbuka saat Anda berpindah tab (Kerja → Laporan → Lampiran), ditutup dengan **Esc**, tombol **✕**, atau Ctrl+K lagi.
- Pemilih per pertanyaan di bawah kolom tanya: **Claude / Gemini**, lalu model apa pun dari daftar model akun itu. Mesin tanpa akun siap tidak bisa dipilih, dan daftarnya ikut berubah saat Anda login atau keluar.
- Pilihan awalnya dari baris **Panel Tanya** di Pengaturan → Bot (bawaan Claude dengan `MODEL_ASK`, yang bawaannya sama dengan `MODEL_QA`; Gemini tanpa model terpilih memakai model bawaan akun agy). Opsi *Bawaan Tanya* mengikuti baris itu. Pilihan di panel diingat selama tab terbuka, juga saat pindah tugas.
- Ganti model di mesin yang sama melanjutkan sesi yang sama; ganti mesin memulai sesi baru yang tetap membawa riwayat panel. Mesin dan model yang menjawab tertulis kecil di bawah tiap jawaban.
- Percakapannya hidup **di memori server**: bertahan saat refresh halaman, hilang saat `systemctl --user restart ai-team` atau saat Anda menekan **Hapus percakapan**.
- Biayanya dicatat terpisah (`askCostUsd` di `task.json`) dan tampil di kaki panel, jadi angka biaya di daftar tugas tetap berarti "biaya bot". Jawaban Gemini tidak membawa biaya, karena `agy` tidak melaporkannya.

## Catatan per tugas

Tab **Catatan** di tiap tugas berisi satu berkas Markdown (`data/tasks/<id>/notes.md`) yang **hanya milik Anda**: kesimpulan sementara, daftar yang perlu dicek ulang, dugaan penyebab, pertanyaan yang belum terjawab.

- **Tidak pernah dikirim ke bot.** Isinya tidak ikut ke konteks agen, dan karena folder tugas memang boleh dibaca agen, ada deny eksplisit `Read(//<DATA_DIR>/tasks/**/notes.md)` untuk ketiga role.
- Punya tab **Tulis** dan **Pratinjau** seperti konteks project, dan alamat sendiri (`/tasks/T-015/notes`).
- **Tersimpan sendiri** saat Anda berpindah tab atau menutup halaman, jadi catatan setengah jadi tidak hilang; tombol **Simpan** tetap ada.
- Tidak ikut tampil di tab Lampiran, dan titik kecil di tab menandakan tugas itu sudah punya catatan.

## Project (induk tugas)

Setiap tugas berada di dalam sebuah **project**, dan project itulah yang memegang konteks bersama. Pemilihnya ada di atas daftar tugas (bisa dicari; pilihannya tersimpan di alamat sebagai `?project=…`), dan ikon ⚙ di sebelahnya membuka halaman project.

Satu project menyimpan empat hal:

| Isi | Siapa yang menulis | Dipakai untuk |
|---|---|---|
| **Konteks project** (`context.md`) | Anda, di tab **Konteks** | ditempel ke konteks setiap bot di project itu, sebelum instruksi tugas |
| **Memori project** (`memory.md`) | bot, lewat tool `remember` | fakta lintas tugas: akun uji, prosedur, cacat yang belum diperbaiki |
| **URL target bawaan** | Anda, di tab **Setelan** | mengisi sendiri kolom target saat membuat tugas QA |
| **Folder workspace** | Anda, di tab **Setelan** | folder yang dipegang Engineer & DevOps di project itu |

Yang membuat tugas tidak lagi bekerja sendirian: setiap bot juga menerima **daftar tugas sebelah** di project yang sama (id, bot, status, judul, ringkasan serah terima satu baris). Kalau butuh lengkapnya, ia memanggil `project_task("T-015")` — instruksi asli, semua ringkasan, path laporan, dan daftar lampiran tugas itu. Tugas di project lain ditolak, jadi project sekaligus menjadi batas konteks: bot yang menguji EWS tidak lagi menerima kredensial staging RDMS.

Memindahkan tugas antar project: halaman Project → tab **Tugas** → pemilih "pindah ke…". Project yang masih punya tugas tidak bisa dihapus (boleh diarsipkan).

**Folder workspace per project** diperiksa sebelum disimpan: harus folder yang ada, bukan folder sistem (`/etc`, `/usr`, `/var/lib`, …), bukan folder `data/` aplikasi ini, dan bukan folder yang memuat sesi login Claude (`~/.claude`). Aturan deny QA (`Edit(//<workspace>/**)`) dan pagar perintah shell ikut memakai workspace project tugas itu, bukan satu folder global.

## Memori global

`data/memory.md` dibaca **setiap** tugas di **semua** project — isinya hal yang benar-benar berlaku di mana saja (mis. "jangan mengubah berkas di luar workspace"). Panel **Memori global** di sidebar menyuntingnya.

Hal yang hanya berlaku di satu proyek masuk ke konteks/memori project, bukan ke sini. Karena konteks itu, tugas QA cukup ditulis "uji alur login" — akun uji dan URL-nya diambil sendiri oleh bot.

## Konteks & sesi

Tiap **penugasan** punya sesi Claude sendiri (atau sesi agy untuk penugasan Gemini; `task.json` → `assignments[].sessionId`), jadi konteks antar tugas tidak tercampur dan dua tugas QA bisa jalan bersamaan. Sesi disimpan, sehingga:

- tugas yang menganggur lebih dari `IDLE_SHUTDOWN_MS` (default 10 menit) menutup subprocess-nya, dan pesan berikutnya melanjutkan sesi yang sama;
- tugas yang sedang berjalan saat server mati akan **dilanjutkan otomatis** setelah server hidup lagi.

## Model izin (penting)

Urutan evaluasi Claude Code: **hooks → deny → ask → permission mode → allow → kartu persetujuan**.

- `deny` menang atas segalanya. Pola destruktif (`sudo`, `mkfs`, `dd`, `shutdown`, edit `/etc`, baca kredensial Claude) ditolak untuk semua bot tanpa prompt.
- `allow` berisi perintah yang boleh jalan sendiri: `npm test`, `git status/diff`, `df`, `docker ps`, dan sejenisnya.
- **`ask` sengaja dikosongkan.** `ask` dievaluasi *sebelum* `allow`, jadi menaruh `"Bash"` di sana membuat seluruh allow-list tidak berguna. Perintah di luar allow-list tetap sampai ke kartu persetujuan lewat `canUseTool`.
- QA tidak boleh mengubah kode: ada deny `Edit(//<WORKSPACE_DIR>/**)`. Ia hanya menulis di folder tugasnya.
- Engineer hanya `git commit` kalau Anda memintanya (dijaga hook di `server/policy.ts`), tanpa kartu persetujuan. Pesannya memakai Conventional Commits dalam bahasa Inggris, tanpa atribusi Claude. Kalau tidak diminta, perubahan ditinggal di working tree. `git push` tetap dilarang.

Aturan per bot ada di `server/roles.ts`, persona di `server/prompts/*.md`. Keduanya memang dibuat untuk Anda sunting.

## Mesin Gemini (Antigravity)

Selain Claude, bot bisa dijalankan dengan Gemini lewat Antigravity CLI (`agy acp`, Agent Client Protocol), memakai akun
Google yang Anda tambahkan di **Pengaturan → Akun AI**.

> **Risiko akun.** FAQ Antigravity menyebut pemakaian `agy` di dalam aplikasi lain belum didukung untuk paket pribadi,
> dan Terms-nya (pasal 6) membolehkan Google menangguhkan akun. Peringatan yang sama tampil di UI di setiap pilihan Gemini.

**Menyiapkan**

1. Pasang Antigravity CLI, plus `dbus-daemon` dan `gnome-keyring-daemon` (paket `dbus` dan `gnome-keyring`) untuk
   keyring pribadi app. Login `agy` di terminal tidak dipakai dan tidak berubah.
2. Buka **Pengaturan → Akun AI → Gemini → Tambah akun**, lalu login dengan akun Google. Riwayat, setelan, dan keyring
   `agy` milik AI Team ada di `data/accounts/gemini/`; `~/.gemini` Anda tidak disentuh.
3. Kartu Gemini "Terhubung" berarti login berhasil dan daftar modelnya terbaca. Kalau tidak, alasannya tertulis di
   kartu; tekan **Periksa** setelah memperbaikinya.

**Memilih mesin**

- **Pengaturan → Bot:** mesin, model, dan penalaran bawaan per bot, untuk Claude maupun Gemini.
- **+ Tugas** dan **Oper ke…:** mengikuti setelan bot yang dipilih, dan bisa diganti per penugasan. Jadi
  `QA (Gemini) → Engineer (Claude)` bisa terjadi dalam satu tugas; bot berikutnya menerima ringkasan serah terima yang sama.
- Penugasan Gemini ditandai lencana **Gemini** di header tugas dan di daftar tugas.
- Panel **Tanya** bisa memakai Gemini kalau akun Gemini siap, dengan model apa pun dari akun itu. **Kurator memori** memakai mesin di Pengaturan →
  Bot (bawaan Claude), atau Gemini kalau hanya akun itu yang ada. Keduanya berjalan sebagai sesi `agy` *Hanya baca*;
  kurator menulis register lewat server MCP `curator` miliknya, dibuka lewat HTTP seperti tool `team`. Putaran kurator di
  Gemini tercatat tanpa biaya.

**Cara pagarnya bekerja**

`agy` tidak meminta izin untuk membaca atau menulis berkas. Karena itu AI Team memasang hook `PreToolUse` di folder
data `agy` miliknya. Sebelum `agy` memanggil tool apa pun, hook mengirimkannya ke server AI Team
(`server/engines/antigravity/hook-client.ts` → `/api/internal/agy-hook`). Server menilainya dengan aturan yang sama
dengan jalur Claude: `server/policy.ts`, aturan role di `server/roles.ts`, folder terlindung, dan mode otonomi.
Hasilnya salah satu dari tiga:

- diizinkan;
- ditolak dengan alasan, yang dibaca agen sebelum ia melanjutkan;
- kartu persetujuan di UI.

Kalau server tidak bisa dihubungi, hook menolak.

- Bot tidak bisa membaca atau menulis folder akun (`data/accounts/`, termasuk folder data dan keyring `agy`),
  `~/.gemini`, maupun kode `server/engines/antigravity/`.
- Yang selalu ditolak: subagen, swarm, browser bawaan `agy`, dan server MCP selain `team`/`browser`. QA dan UI/UX
  memakai browser AI Team, jadi tab **Live** dan **Ambil alih** tetap jalan.
- "Izinkan & ingat" tidak tersedia untuk Gemini. Setiap perintah di luar allow-list dimintakan persetujuan sendiri.

**Bedanya dengan Claude**

- Tidak ada biaya $. Baris hasil turn menampilkan jumlah token.
- Pertanyaan agen muncul sebagai kartu pertanyaan biasa. Membalas lewat chat juga dihitung sebagai jawaban.
- `agy` tidak mengirim isi hasil tool MCP (browser, team), jadi kartunya hanya bertuliskan "selesai". Isinya terlihat
  di tab Live dan di laporan.
- Perintah panjang bisa dipindah `agy` ke latar. Turn yang dimulai agen sendiri ditandai "dimulai agen sendiri".
- `agy` memperbarui dirinya sendiri. Kalau perilakunya berubah, mulai pemeriksaan dari status di Pengaturan dan
  `bun run check:acp`.

## Konfigurasi (`.env`)

| Variabel | Arti |
|---|---|
| `WORKSPACE_DIR` | Folder kerja **bawaan** Engineer & DevOps, dipakai project yang tidak punya folder sendiri. |
| `TARGET_URL` | URL target **bawaan**, dipakai project yang tidak punya URL sendiri. |
| `MODEL_QA` / `MODEL_ENGINEER` / `MODEL_DEVOPS` / `MODEL_UIUX` / `MODEL_CURATOR` / `MODEL_ASK` | Model Claude **bawaan** per bot, kurator, dan panel Tanya (`MODEL_ASK` kosong = `MODEL_QA`); Pengaturan → Bot menimpanya. |
| `EFFORT_*` | Penalaran **bawaan**, `low` … `max`, termasuk `EFFORT_CURATOR` dan `EFFORT_ASK` (keduanya `medium`). Makin tinggi makin teliti, makin lambat, makin boros kuota. Pengaturan → Bot menimpanya. |
| `MAX_CONCURRENT_AGENTS` | Berapa tugas boleh jalan bersamaan (default 2). |
| `IDLE_SHUTDOWN_MS` | Kapan subprocess tugas yang menganggur ditutup (default 10 menit). |
| `STOP_GRACE_MS` | Batas tunggu turn yang dihentikan dengan Stop (default 20 detik); lewat dari itu proses agen (Claude atau `agy`) ditutup paksa (sesinya tetap bisa dilanjutkan). |
| `ASK_TIMEOUT_MS` | Batas waktu satu jawaban panel Tanya (default 5 menit). |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | Host/Origin tambahan yang boleh membuka API dan WebSocket, dipisah koma. Bawaan: `127.0.0.1`, `localhost`, `::1`, `ai-team.localhost`, plus `ai-team.local` kalau `/etc/hosts` mengarahkannya ke `127.0.0.1` (dicek ulang tiap 30 detik). Permintaan dari situs lain ditolak `403` (anti CSRF dan DNS rebinding). |
| `INCLUDE_USER_SETTINGS` | `1` untuk ikut memuat setelan "user" Claude Code — sekarang dari folder akun app (`data/accounts/claude/`), bukan `~/.claude`. |
| `AGY_BIN` | Perintah Antigravity CLI (default `agy` dari `PATH`). |
| `AGY_DIR` | Folder data dan keyring `agy` milik AI Team (default `data/accounts/gemini`). |
| `AGY_HOOK_TIMEOUT_SEC` | Batas tunggu satu kartu persetujuan Gemini sebelum dianggap ditolak (default 6 jam). |
| `AGY_BACKGROUND_QUIET_MS` | Turn latar dari `agy` dianggap selesai setelah sekian lama tanpa update (default 15 detik). |
| `AGY_TRACE` | Path berkas untuk mencatat lalu lintas ACP mentah. Hanya untuk diagnosis: isinya memuat percakapan. |

## Data

```
data/tasks/T-012/task.json     judul, bot, status, riwayat penugasan, biaya, review
data/tasks/T-012/thread.jsonl  transcript yang ditampilkan di UI
data/tasks/T-012/assets/*.png  bukti screenshot
data/tasks/T-012/report.md     laporan tugas, ditulis bot yang mengerjakannya (tab Laporan)
data/tasks/T-012/notes.md      catatan pribadi Anda (tab Catatan; tidak dibaca bot)
                               (panel Tanya tidak menulis berkas apa pun — hidup di memori)
data/tasks/T-012/downloads/*  berkas yang diunduh bot saat menguji ekspor (tab Lampiran)
data/tasks/T-012/*.md, bukti/*  berkas lain yang ditulis agen (tab Lampiran)
data/memory.md                 memori global (lintas project)
data/projects/<id>/project.json  nama, URL target, folder workspace
data/projects/<id>/context.md    konteks project yang Anda tulis
data/projects/<id>/memory.md     memori project (ditulis bot lewat `remember`)
data/settings.json               Pengaturan: mode, mesin, model & penalaran per bot, notifikasi
data/accounts.json               metadata akun AI (email, paket, daftar model, status) — tanpa rahasia
data/accounts/claude/            CLAUDE_CONFIG_DIR milik app: kredensial Claude + transkrip sesi bot (projects/)
data/accounts/gemini/            riwayat sesi `agy` + config/hooks.json (pagar) + keyring/ dan keyring.secret (login Google)
```

Hapus `data/` untuk mulai dari nol, termasuk login akun AI.

## Batasan yang perlu Anda tahu

- **Aplikasi ini menjalankan perintah sebagai user Anda.** Server hanya bind ke `127.0.0.1` dan tanpa autentikasi. Jangan diekspos ke jaringan.
- **Kuota langganan dibagi** dengan Claude Code harian Anda kalau akun Claude yang Anda tambahkan sama. Satu tugas QA penuh ±$0,25–0,6; satu tugas Engineer dengan test ±$0,7–1,0 setara pemakaian. Biaya per tugas tampil di daftar.
- **Satu workspace per project dipakai bersama** oleh tugas di project itu: tugas kode di project yang sama dijalankan bergantian (kunci per folder workspace), belum ada checkout terpisah per tugas.
- `settingSources: ["project"]` berarti `CLAUDE.md` dan `.claude/` milik workspace ikut termuat; aturan `permissions.allow` milik repo itu ikut berlaku (deny milik aplikasi ini tetap menang). `~/.claude/CLAUDE.md` di laptop **tidak** ikut, karena app memakai folder akunnya sendiri.
- **Tidak ada Artifact (halaman claude.ai).** Tool `Artifact`/`ArtifactComments`/`ArtifactData` dan konektor claude.ai (`mcp__claude_ai_*`, termasuk Claude Docs) selalu ditolak untuk bot, panel Tanya, dan kurator, di mode apa pun termasuk Auto. Tool Artifact juga tidak ditawarkan ke model sama sekali.
- Belum ada: sandbox container, jadwal otomatis, dependensi antar tugas, beberapa bot paralel di dalam **satu** tugas, dan bot yang membuat tugas sendiri tanpa persetujuan.

## Halaman demo

`http://127.0.0.1:4320/demo` disajikan dari `demo/index.html` **di dalam workspace**, supaya alur lengkap bisa dicoba: QA menemukan bug → oper ke Engineer → Engineer memperbaiki di workspace → oper balik ke QA untuk uji ulang.
