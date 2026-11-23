# Aturan proyek AI Team

## Bot tidak boleh membuat Artifact

- Sesi Claude milik app (empat bot, panel Tanya, kurator, pemberi judul otomatis) tidak boleh memakai tool `Artifact`, `ArtifactComments`,
  `ArtifactData`, maupun konektor claude.ai (`mcp__claude_ai_*`, termasuk Claude Docs).
- Penegaknya `ARTIFACT_TOOLS` dan `DENY_ALWAYS` di `server/roles.ts`, ditambah `disallowedTools` di
  `server/agent/runner.ts`, `server/agent/ask.ts`, `server/agent/curator.ts`, dan `server/agent/titler.ts`. Jangan hapus atau longgarkan;
  sesi baru yang memakai Claude harus ikut memasang keduanya.
- Alasannya: larangan di `~/.claude/CLAUDE.md` laptop tidak terbaca sesi app, karena app memakai folder login sendiri.
- Uji yang menjaganya: `check:roles`, `check:runner` (S2b), dan `check:acp` (F4k).

Asal aturan: permintaan pemilik pada 21 Nov 2026, "tambahkan rule itu di apps ini".

## UI: jangan pakai `<select>` bawaan browser

- Setiap pilihan dropdown memakai komponen `Select` di `web/components/Select.tsx`, baik yang sudah ada maupun yang baru.
  Jangan menulis `<select>`/`<option>` HTML langsung di `web/`.
- Daftar panjang yang perlu dicari (mis. pemilih project) memakai `Combobox` di `web/components/Combobox.tsx`.
- Jangan menambah pustaka UI (Radix, Headless UI, dan sejenisnya) untuk dropdown. Kalau `Select` kurang, perluas
  komponennya.
- Cara pakai:

  ```tsx
  <Select
    value={value}                       // string; "" boleh jadi pilihan, mis. "Bawaan …"
    onChange={(next) => setValue(next)}
    ariaLabel="Saring menurut bot"      // wajib: tombolnya tidak punya label teks sendiri
    options={[{ value: "", label: "semua bot" }, { value: "qa", label: "QA", description: "baris kecil opsional" }]}
    size="md"                           // sm = baris padat, md = form/pengaturan, lg = pemilih utama
    className="w-full"                  // lebar/jarak tombol: w-full, flex-1, ml-1, …
  />
  ```

  - `placeholder` tampil redup kalau `value` tidak ada di `options` (mis. "pindah ke…").
  - `muted` untuk kontrol sekunder di header.
  - `disabled` per pilihan lewat `options[i].disabled`.
- Daftar pilihan dirender di `body` dengan posisi tetap. Ia membuka ke atas kalau ruang di bawah kurang, dan Esc hanya
  menutup daftar itu, tidak ikut menutup dialog atau panel di belakangnya. Jangan bungkus `Select` dengan `<label>`; pakai
  `ariaLabel`.
- Uji Playwright memilih lewat `getByRole("combobox", { name })` lalu `getByRole("option")`, bukan `selectOption`.

Asal aturan: permintaan pemilik pada 21 Nov 2026, "select native akan digantikan ini".
