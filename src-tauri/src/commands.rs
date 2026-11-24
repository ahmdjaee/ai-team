//! Perintah yang boleh dipanggil halaman. Izinnya dibagi di `capabilities/`:
//! `status`, `retry`, `start_service` untuk splash; `notify`, `browse` untuk UI dari layanan AI Team.

use std::process::Command;

use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::link::{Link, Phase, Status};

#[tauri::command]
pub fn status(link: State<'_, Link>) -> Status {
    link.status()
}

#[tauri::command]
pub fn retry(link: State<'_, Link>) {
    if link.status().phase != Phase::Online {
        link.wake();
    }
}

/// Jalankan layanan systemd milik pengguna (`systemctl --user start ai-team`, lihat README),
/// lalu langsung periksa lagi.
#[tauri::command]
pub async fn start_service(link: State<'_, Link>) -> Result<(), String> {
    let output = tauri::async_runtime::spawn_blocking(|| {
        Command::new("systemctl").args(["--user", "start", "ai-team"]).output()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("systemctl tidak bisa dijalankan: {error}"))?;
    link.wake();
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("systemctl keluar dengan {}", output.status) } else { stderr })
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browse(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("hanya tautan http(s) yang dibuka".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|error| error.to_string())
}
