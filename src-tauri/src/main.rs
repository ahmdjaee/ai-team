//! Jendela desktop AI Team. Aplikasi ini tipis: ia tidak menjalankan server sendiri, tetapi membuka
//! layanan AI Team yang sudah berjalan (bawaan `http://127.0.0.1:4320`, systemd `ai-team`), jadi data,
//! akun AI, dan tugasnya sama dengan versi web. Tambahannya: tray, notifikasi desktop, tautan luar di
//! browser sistem, dan unduhan ke folder Unduhan.

mod commands;
mod link;
mod tray;

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use link::Link;

pub const MAIN: &str = "main";
const TITLE: &str = "AI Team";

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Halaman yang boleh dimuat di jendela: splash bawaan dan UI dari layanan target. `dev_origin` =
/// server dev bawaan `tauri dev` yang melayani splash; di biner hasil build splash memakai `tauri://`.
fn is_app_url(url: &Url, link: &Link, dev_origin: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" => link.is_target(url) || dev_origin.is_some_and(|origin| same_origin(url, origin)),
        _ => false,
    }
}

fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn unique(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..1000)
        .map(|n| path.with_file_name(format!("{stem} ({n}){extension}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(path)
}

/// WebKitGTK tidak selalu memberi nama berkas; kalau kosong, ambil dari `?path=` atau ujung URL.
fn download_target(dir: &Path, url: &Url, suggested: &Path) -> PathBuf {
    let from_query = || {
        url.query_pairs()
            .find(|(key, _)| key == "path")
            .and_then(|(_, value)| Path::new(value.as_ref()).file_name().map(|n| n.to_string_lossy().into_owned()))
    };
    let from_path = || {
        url.path_segments()
            .and_then(|mut segments| segments.next_back().map(str::to_owned))
            .filter(|segment| !segment.is_empty() && segment != "raw")
    };
    let name = suggested
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .or_else(from_query)
        .or_else(from_path)
        .unwrap_or_else(|| "unduhan".to_string());
    unique(dir.join(name))
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let for_navigation = app.clone();
    let for_new_window = app.clone();
    let for_download = app.clone();
    let dev_origin = if tauri::is_dev() { app.config().build.dev_url.clone() } else { None };

    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .inner_size(1360.0, 860.0)
        .min_inner_size(900.0, 600.0)
        // Tanpa ini Tauri menelan drop berkas, dan lampiran tidak bisa diseret ke kotak chat.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if is_app_url(url, &for_navigation.state::<Link>(), dev_origin.as_ref()) {
                return true;
            }
            // Situs lain dibuka di browser sistem; jendela ini tetap di AI Team.
            open_outside(&for_navigation, url);
            false
        })
        // Cadangan untuk `target="_blank"`/`window.open` yang tidak ditangkap web/desktop.ts.
        .on_new_window(move |url, _features| {
            open_outside(&for_new_window, &url);
            NewWindowResponse::Deny
        })
        // Badge "(2) AI Team" dari UI ikut tampil di judul jendela dan taskbar.
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(if title.trim().is_empty() { TITLE } else { title.as_str() });
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let Ok(dir) = for_download.path().download_dir() else { return false };
                    let _ = std::fs::create_dir_all(&dir);
                    *destination = download_target(&dir, &url, destination);
                }
                DownloadEvent::Finished { path, success, .. } => {
                    let name = path
                        .as_deref()
                        .and_then(Path::file_name)
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let (title, body) = if success {
                        ("Unduhan selesai", format!("{name} tersimpan di folder Unduhan."))
                    } else {
                        ("Unduhan gagal", name)
                    };
                    let _ = for_download.notification().builder().title(title).body(body).show();
                }
                _ => {}
            }
            true
        })
        .build()?;

    *app.state::<Link>().splash_url.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = window.url().ok();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Harus plugin pertama: membuka aplikasi lagi cukup memunculkan jendela yang sudah ada.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::retry,
            commands::start_service,
            commands::notify,
            commands::browse,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Link::new());
            create_window(&handle)?;
            if let Err(error) = tray::create(&handle) {
                eprintln!("ai-team: ikon tray tidak tersedia: {error}");
            }
            link::start(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else { return };
            // Menutup jendela hanya menyembunyikannya, supaya notifikasi bot tetap muncul.
            // Keluar total lewat menu tray.
            api.prevent_close();
            let _ = window.hide();
            let app = window.app_handle();
            let Some(link) = app.try_state::<Link>() else { return };
            if !link.hide_hint_shown.swap(true, Ordering::SeqCst) {
                let _ = app
                    .notification()
                    .builder()
                    .title("AI Team tetap terbuka di tray")
                    .body("Notifikasi bot tetap muncul. Buka lagi lewat ikon tray atau menu aplikasi; pilih Keluar di tray untuk menutup jendela ini sepenuhnya. Layanan AI Team sendiri tidak ikut berhenti.")
                    .show();
            }
        })
        .run(tauri::generate_context!())
        .expect("AI Team gagal dimulai");
}
