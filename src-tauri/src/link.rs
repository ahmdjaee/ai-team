//! Sambungan ke layanan AI Team: alamat target, status untuk splash, dan thread yang memeriksa
//! layanan lalu mengarahkan jendela ke UI-nya. Aplikasi ini tidak menjalankan server sendiri.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};

use crate::MAIN;

/// Layanan systemd `ai-team` (lihat README) mendengar di sini.
pub const DEFAULT_URL: &str = "http://127.0.0.1:4320/";
/// Nama host yang boleh jadi target; harus sama dengan `capabilities/server-ui.json`.
const ALLOWED_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "ai-team.localhost"];
const RETRY_EVERY: Duration = Duration::from_secs(3);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Connecting,
    Offline,
    Online,
}

#[derive(Clone, Serialize)]
pub struct Status {
    pub phase: Phase,
    /// Alamat layanan yang dibuka, untuk ditampilkan di splash.
    pub url: String,
    /// Alasan terakhir gagal tersambung (kosong kalau tidak ada).
    pub detail: String,
    /// Galat dari setelan `AI_TEAM_URL` yang diabaikan.
    pub warning: String,
}

pub struct Link {
    pub target: Url,
    status: Mutex<Status>,
    wake: Mutex<Sender<()>>,
    waker: Mutex<Option<Receiver<()>>>,
    pub splash_url: Mutex<Option<Url>>,
    /// Halaman UI yang dibuka lagi setelah "Muat ulang" (rute tugas yang sedang dilihat).
    resume_url: Mutex<Option<Url>>,
    pub hide_hint_shown: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `AI_TEAM_URL` kalau valid, selain itu alamat bawaan beserta alasan penolakannya.
fn resolve_target() -> (Url, String) {
    let default = || Url::parse(DEFAULT_URL).expect("DEFAULT_URL valid");
    let Some(raw) = std::env::var("AI_TEAM_URL").ok().filter(|value| !value.trim().is_empty()) else {
        return (default(), String::new());
    };
    match Url::parse(raw.trim()) {
        Ok(url) if url.scheme() == "http" && ALLOWED_HOSTS.contains(&url.host_str().unwrap_or("")) => (url, String::new()),
        Ok(_) => (
            default(),
            format!("AI_TEAM_URL={raw} diabaikan: hanya http:// ke {} yang didukung.", ALLOWED_HOSTS.join(", ")),
        ),
        Err(error) => (default(), format!("AI_TEAM_URL={raw} diabaikan: {error}.")),
    }
}

impl Link {
    pub fn new() -> Self {
        let (target, warning) = resolve_target();
        if !warning.is_empty() {
            eprintln!("ai-team: {warning}");
        }
        let (sender, receiver) = mpsc::channel();
        Self {
            status: Mutex::new(Status {
                phase: Phase::Connecting,
                url: target.as_str().trim_end_matches('/').to_string(),
                detail: String::new(),
                warning,
            }),
            target,
            wake: Mutex::new(sender),
            waker: Mutex::new(Some(receiver)),
            splash_url: Mutex::new(None),
            resume_url: Mutex::new(None),
            hide_hint_shown: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> Status {
        lock(&self.status).clone()
    }

    fn set(&self, phase: Phase, detail: impl Into<String>) {
        let detail = detail.into();
        let mut status = lock(&self.status);
        if status.phase != phase || status.detail != detail {
            eprintln!("ai-team: {} {}", serde_json::to_string(&phase).unwrap_or_default(), detail);
        }
        status.phase = phase;
        status.detail = detail;
    }

    /// Halaman ini milik layanan target (skema, host, dan port sama)?
    pub fn is_target(&self, url: &Url) -> bool {
        crate::same_origin(url, &self.target)
    }

    /// Bangunkan thread sambungan: periksa sekarang juga (dari splash), atau kembali ke splash lalu
    /// sambung ulang kalau UI sedang terbuka (menu tray "Muat ulang").
    pub fn wake(&self) {
        let _ = lock(&self.wake).send(());
    }
}

/// Cukup ada server HTTP yang menjawab; status apa pun dianggap hidup.
fn probe(target: &Url) -> Result<(), String> {
    let host = target.host_str().unwrap_or("127.0.0.1");
    let port = target.port_or_known_default().unwrap_or(80);
    let addresses: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Nama {host} tidak bisa diresolusi: {error}"))?
        .collect();
    let mut last = format!("{host}:{port} tidak punya alamat");
    for address in addresses {
        match TcpStream::connect_timeout(&address, PROBE_TIMEOUT) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
                let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
                let request = format!("HEAD / HTTP/1.0\r\nHost: {host}:{port}\r\n\r\n");
                let mut head = [0u8; 5];
                return match stream.write_all(request.as_bytes()).and_then(|_| stream.read_exact(&mut head)) {
                    Ok(()) if &head == b"HTTP/" => Ok(()),
                    Ok(()) => Err(format!("{host}:{port} menjawab, tetapi bukan server HTTP")),
                    Err(error) => Err(format!("{host}:{port} tidak menjawab: {error}")),
                };
            }
            Err(error) => last = format!("Tidak bisa tersambung ke {host}:{port}: {error}"),
        }
    }
    Err(last)
}

pub fn navigate(app: &AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.navigate(url);
    }
}

fn to_splash(app: &AppHandle, link: &Link) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    if let Ok(current) = window.url() {
        if link.is_target(&current) {
            *lock(&link.resume_url) = Some(current);
        }
    }
    if let Some(splash) = lock(&link.splash_url).clone() {
        let _ = window.navigate(splash);
    }
}

/// Jalankan sekali saat start-up. Thread-nya hidup selama aplikasi hidup.
pub fn start(app: AppHandle) {
    let Some(receiver) = lock(&app.state::<Link>().waker).take() else { return };
    let spawned = thread::Builder::new().name("ai-team-link".into()).spawn(move || run(&app, &receiver));
    if let Err(error) = spawned {
        eprintln!("ai-team: thread sambungan gagal dibuat: {error}");
    }
}

fn run(app: &AppHandle, wake: &Receiver<()>) {
    let link = app.state::<Link>();
    loop {
        link.set(Phase::Connecting, "");
        loop {
            match probe(&link.target) {
                Ok(()) => break,
                Err(detail) => {
                    link.set(Phase::Offline, detail);
                    // Coba lagi tiap beberapa detik, atau segera kalau splash meminta.
                    if matches!(wake.recv_timeout(RETRY_EVERY), Err(RecvTimeoutError::Disconnected)) {
                        return;
                    }
                }
            }
        }
        link.set(Phase::Online, "");
        let resume = lock(&link.resume_url).take();
        navigate(app, resume.unwrap_or_else(|| link.target.clone()));

        // UI terbuka. Sambungan putus ditangani UI-nya sendiri; thread ini menunggu "Muat ulang".
        if wake.recv().is_err() {
            return;
        }
        while wake.try_recv().is_ok() {}
        to_splash(app, &link);
    }
}
