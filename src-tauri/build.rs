fn main() {
    // Perintah aplikasi didaftarkan supaya izinnya (allow-<perintah>) bisa dibagi per capability:
    // halaman splash lokal dan UI dari layanan AI Team mendapat perintah yang berbeda.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["status", "retry", "start_service", "notify", "browse"]),
    ))
    .expect("tauri-build gagal");
}
