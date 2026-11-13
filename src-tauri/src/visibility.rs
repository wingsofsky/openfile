//! Quiet macOS background operation; hiding never stops a session.
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    window.hide().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn show_main(app: &AppHandle) -> tauri::Result<()> {
    app.set_activation_policy(tauri::ActivationPolicy::Regular)?;
    app.show()?; // Also undo a native Cmd+H, which hides the application itself.
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::{cell::RefCell, ptr::NonNull};
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_app_kit::NSApplicationDidHideNotification;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};

    // Cocoa owns the copied callback; retain its registration for the app lifetime.
    // Both installation and notification delivery occur on the main thread.
    thread_local! {
        static HIDE_OBSERVER: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
    }
    pub fn setup(app: &tauri::AppHandle) {
        let app = app.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
                eprintln!("[openfile] 无法隐藏 Dock 图标: {error}");
            }
        });
        // Native Hide (Cmd+H / application menu) bypasses the window-close command.
        // The callback captures only a Send + Sync AppHandle; no Cocoa objects cross threads.
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSApplicationDidHideNotification), None, None, &block,
            )
        };
        HIDE_OBSERVER.with(|slot| *slot.borrow_mut() = Some(observer));
    }
}

pub fn setup(_app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::setup(_app);
}
