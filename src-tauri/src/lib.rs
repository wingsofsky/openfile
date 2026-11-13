//! 桌面宿主：文库读写、索引、监听、快照、会话进程都在 Node 运行时 sidecar 里（见 sidecar.rs），
//! 前端经 `rpc_call` 调它。Rust 只留原生的部分：sidecar 监管、系统对话框、废纸篓、在文件管理器中显示、拖放与剪贴板、
//! 打开入口（双击 / 右键 / 第二实例）、窗口显隐。
mod fileops;
mod locale;
mod open_target;
mod procs;
mod scope;
mod sidecar;
#[cfg(test)]
pub(crate) mod test_links;
mod transfer;
mod visibility;
mod workspaces;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 第二次启动（「打开方式」、目录右键、openfile open）把参数转给已开的实例。插件必须最先注册。
    // 只在发行版注册：插件只按 identifier 认实例，开发版（pnpm tauri dev）与已装的正式版同名，
    // 不分开的话正式版开着时开发版一启动就把参数转过去、自己退出
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        open_target::on_second_instance(app, &argv, &cwd);
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar::Sidecar::default())
        .manage(workspaces::Workspaces::default())
        .manage(transfer::TransferState::default())
        .manage(open_target::OpenState::default())
        // 系统把文件放到窗口上——路径只在 Rust 侧暂存，前端拿不到自报库外路径的口子
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                window.state::<transfer::TransferState>().stash_drop(paths.clone());
            }
            // 窗口没了：运行时关掉它的文库与会话进程，Rust 摘掉它的库根
            tauri::WindowEvent::Destroyed => {
                let app = window.app_handle().clone();
                let ws = window.label().to_string();
                app.state::<workspaces::Workspaces>().close(&app, &ws);
                tauri::async_runtime::spawn_blocking(move || {
                    app.state::<sidecar::Sidecar>().notify(&app, "library.closeWindow", serde_json::json!({ "ws": ws }));
                });
            }
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            visibility::setup(&handle);
            // 先把运行时拉起来（第一次拉起时挂上主窗口的文库：OPENFILE_LIBRARY 优先，否则上次的），
            // 窗口加载期间它已经在建索引；登录 shell 环境首次要问 shell，放阻塞线程
            {
                let handle = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(e) = handle.state::<sidecar::Sidecar>().call(&handle, "library.recents", serde_json::json!({})) {
                        eprintln!("[openfile] 运行时启动失败：{e}");
                    }
                });
            }
            // 首次启动带的路径（双击文档、目录右键）：排队等前端启动后取走
            let args: Vec<String> = std::env::args().collect();
            if let Ok(cwd) = std::env::current_dir() {
                open_target::queue_paths(&handle, &open_target::paths_from_args(&args, &cwd));
            }
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::rpc_call,
            workspaces::pick_library,
            workspaces::open_library_window,
            fileops::trash_entry,
            fileops::reveal_entry,
            transfer::start_drag_out,
            transfer::copy_files_to_clipboard,
            transfer::import_dropped,
            transfer::paste_clipboard_files,
            locale::set_locale,
            visibility::hide_main_window,
            open_target::take_open_targets,
            open_target::open_dropped,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            if let tauri::RunEvent::Exit = _event {
                _app.state::<sidecar::Sidecar>().shutdown();
            }
            // Finder / Spotlight reopening restores a regular foreground app and its window.
            // Hiding leaves sessions alive without a Dock item.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Err(error) = visibility::show_main(_app) { eprintln!("[openfile] 无法重新打开窗口: {error}"); }
            }
            // Finder 双击 / 拖到 Dock 图标：文档以 Apple Event 交来，不走 argv
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let paths: Vec<_> = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
                open_target::queue_paths(_app, &paths);
            }
        });
}
