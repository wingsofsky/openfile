//! 每个窗口当前的文库根。文库本身由运行时 sidecar 打开和读写；Rust 只记下运行时
//! 回报的库根，给仍在 Rust 里的原生操作（废纸篓、在文件管理器中显示、拖放与剪贴板）出证，
//! 并管 asset 协议的放行目录。库根只从运行时的 library.get / library.open 结果来，前端不能自报。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, RwLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::scope;

#[derive(Default)]
pub struct Workspaces {
    roots: RwLock<HashMap<String, PathBuf>>,
    /// 原生变更操作串行，期间同一窗口切库会等它（与运行时的写入互不加锁，同外部 CLI）
    writes: Mutex<()>,
    /// 新窗口的编号（label = lib-<n>，capabilities 按 `lib-*` 放行）
    next_window: AtomicU32,
}

fn check_expected_root(root: &Path, expected: Option<&str>) -> Result<(), String> {
    if expected.is_some_and(|e| !scope::same_root(root, e)) {
        return Err("文库已切换，请回到原文库后重试。".into());
    }
    Ok(())
}

impl Workspaces {
    pub fn all(&self) -> Vec<(String, PathBuf)> {
        self.roots.read().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// 变更型原生操作：持写锁与库根读锁直到做完；expected_root 不符即拒（防切库瞬间落到另一个库）
    pub fn with_write_root<T>(&self, ws: &str, expected: Option<&str>, f: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
        let _write = self.writes.lock().map_err(|_| "写入锁不可用")?;
        let guard = self.roots.read().map_err(|_| "文库锁不可用")?;
        let root = guard.get(ws).ok_or("尚未选择文库")?;
        check_expected_root(root, expected)?;
        f(root)
    }

    /// 换掉（或摘掉）一个窗口的库根，同时调整 asset 放行：新库放行；旧库没有别的窗口在用才禁止
    fn set(&self, app: &AppHandle, ws: &str, next: Option<PathBuf>) {
        let mut roots = self.roots.write().unwrap();
        let old = match &next {
            Some(root) => roots.insert(ws.to_string(), root.clone()),
            None => roots.remove(ws),
        };
        let scope = app.asset_protocol_scope();
        if let Some(root) = &next {
            let _ = scope.allow_directory(root, true);
        }
        if let Some(old) = old.filter(|o| Some(o) != next.as_ref() && !roots.values().any(|r| r == o)) {
            let _ = scope.forbid_directory(&old, true);
        }
    }

    pub fn close(&self, app: &AppHandle, ws: &str) {
        self.set(app, ws, None);
    }
}

/// 运行时回报的 LibraryInfo（或 null）→ 记下这个窗口的库根（canonical；拿不到就当没库）
pub fn sync(app: &AppHandle, ws: &str, info: &Value) {
    let root = info.get("root").and_then(Value::as_str).and_then(|r| Path::new(r).canonicalize().ok()).filter(|p| p.is_dir());
    app.state::<Workspaces>().set(app, ws, root);
}

/// 系统对话框选文库，交给运行时打开（与前端的 library.open 同一条路）
#[tauri::command]
pub async fn pick_library(app: AppHandle, window: tauri::WebviewWindow) -> Result<Option<Value>, String> {
    // 明确这是在选"文件夹"——文件在选择器里显示灰色是 macOS 固定行为，
    // 不说清楚，用户会以为文件打不开
    let Some(path) = pick_folder(&app, Some(&window))? else { return Ok(None) };
    let ws = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let info = app
            .state::<crate::sidecar::Sidecar>()
            .call(&app, "library.open", json!({ "ws": ws, "path": scope::plain_path(&path) }))?;
        sync(&app, &ws, &info);
        Ok(Some(info))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pick_folder(app: &AppHandle, parent: Option<&tauri::WebviewWindow>) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title(crate::locale::tr("选择文库文件夹（里面的文档之后在应用内打开）", "Choose a library folder (its documents open inside the app)"));
    if let Some(w) = parent {
        dialog = dialog.set_parent(w);
    }
    match dialog.blocking_pick_folder() {
        Some(fp) => fp.into_path().map(Some).map_err(|e| format!("路径转换失败: {e}")),
        None => Ok(None),
    }
}

/// 在新窗口里打开一个文库（多窗口）：path 为空先弹系统对话框。运行时先用新窗口的 label 把库打开，
/// 再建窗口——新窗口启动时 library.get 拿到的就是它。每个窗口一套文库与会话进程，事件只发给自己（sidecar.rs）。
/// 返回是否开了窗口（对话框取消为 false）。
#[tauri::command]
pub async fn open_library_window(app: AppHandle, window: tauri::WebviewWindow, path: Option<String>) -> Result<bool, String> {
    let picked = match path {
        Some(p) => PathBuf::from(p),
        None => match pick_folder(&app, Some(&window))? {
            Some(p) => p,
            None => return Ok(false),
        },
    };
    let n = app.state::<Workspaces>().next_window.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("lib-{n}");
    let ws = label.clone();
    let app2 = app.clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        app2.state::<crate::sidecar::Sidecar>()
            .call(&app2, "library.open", json!({ "ws": ws, "path": scope::plain_path(&picked) }))
    })
    .await
    .map_err(|e| e.to_string())??;
    sync(&app, &label, &info);
    let name = info.get("name").and_then(Value::as_str).unwrap_or("文库");
    let built = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(format!("{name} — Openfile"))
        .inner_size(1320.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .build();
    if let Err(e) = built {
        // 窗口没建起来：把刚开的库关掉，别留一个没人用的监听
        app.state::<Workspaces>().close(&app, &label);
        let app3 = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app3.state::<crate::sidecar::Sidecar>().notify(&app3, "library.closeWindow", json!({ "ws": label }));
        });
        return Err(format!("无法打开新窗口：{e}"));
    }
    Ok(true)
}
