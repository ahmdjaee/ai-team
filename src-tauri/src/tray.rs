//! Ikon tray: jalan kembali ke jendela yang disembunyikan, muat ulang, dan satu-satunya tempat keluar.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::link::Link;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Buka AI Team", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Muat ulang", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &reload, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main").tooltip("AI Team").menu(&menu).on_menu_event(
        |app, event| match event.id.as_ref() {
            "open" => crate::show_main(app),
            "reload" => {
                crate::show_main(app);
                app.state::<Link>().wake();
            }
            // Layanan AI Team tetap berjalan; yang ditutup hanya jendela ini.
            "quit" => app.exit(0),
            _ => {}
        },
    );
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
