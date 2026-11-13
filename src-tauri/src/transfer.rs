//! 与系统之间搬文件：原生拖出、写系统剪贴板、从系统拖入 / 粘入。
//!
//! 信任边界——**前端永远不能自报一条库外路径**：
//! - 往外（拖出 / 写剪贴板）：前端只给库内 rel，这里用 `resolve_scoped` 出证成 canonical 的库内真实路径
//!   （指向库外的符号链接在此被拒，不会把库外文件「借道」递给别的 app）；
//! - 往里（拖入 / 粘入）：源路径只来自**系统**——窗口的 DragDrop 事件（Rust 侧暂存，一次性、60 秒过期）
//!   或系统剪贴板（Rust 侧读取）。前端只说「放进哪个库内目录」。源永不修改；目标一侧走 fileops 的
//!   出证与「永不覆盖」。落在库内的路径（树内拖动 / 库内拷贝）按库内移动 / 复制处理。

use crate::fileops::{check_canonical_not_protected, check_not_protected, components_of, copy_abs_into, copy_entry_at, move_entry_at, rel_of};
use crate::workspaces::Workspaces;
use crate::scope::resolve_scoped;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

const DROP_TTL: Duration = Duration::from_secs(60);
const MAX_ITEMS: usize = 200;

#[derive(Default)]
pub struct TransferState {
    last_drop: Mutex<Option<(Instant, Vec<PathBuf>)>>,
}

impl TransferState {
    /// lib.rs 的窗口事件钩子调用：系统把文件放到了窗口上。
    pub fn stash_drop(&self, paths: Vec<PathBuf>) {
        if let Ok(mut g) = self.last_drop.lock() {
            *g = Some((Instant::now(), paths));
        }
    }

    /// 一次性取走；过期的不算。
    pub(crate) fn take_drop(&self) -> Vec<PathBuf> {
        match self.last_drop.lock().ok().and_then(|mut g| g.take()) {
            Some((at, paths)) if at.elapsed() <= DROP_TTL => paths,
            _ => Vec::new(),
        }
    }
}

/// 往外递的路径：库内 rel → canonical 真实路径。内部目录不外递——检查跑在出证后的**真名**上
/// （8.3 短名 `OPENFI~1`、大小写变体、指进 .openfile 的库内链接都会被认出来；文库的本机状态不能借道拖出去）。
pub fn resolve_out_paths(root: &Path, rels: &[String]) -> Result<Vec<PathBuf>, String> {
    if rels.is_empty() || rels.len() > MAX_ITEMS {
        return Err("没有可用的文件".into());
    }
    let root_canon = root.canonicalize().map_err(|e| format!("文库根不可访问: {e}"))?;
    rels.iter()
        .map(|rel| {
            let comps = components_of(rel)?;
            if comps.is_empty() {
                return Err("不能对文库根执行此操作".to_string());
            }
            check_not_protected(&comps)?;
            let abs = resolve_scoped(root, &comps.join("/"))?;
            if abs == root_canon {
                return Err("不能对文库根执行此操作".to_string()); // 指回根的库内链接
            }
            check_canonical_not_protected(root, &abs)?;
            Ok(abs)
        })
        .collect()
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 库外来的：复制进来后的新 rel
    pub imported: Vec<String>,
    /// 库内来的且按移动处理：[旧 rel, 新 rel]
    pub moved: Vec<(String, String)>,
    /// 没处理的：[名字, 原因]
    pub skipped: Vec<(String, String)>,
}

/// `sources` 必须来自系统（拖放事件 / 系统剪贴板），调用方负责这一点。
/// internal_move：库内来源是移动（树内拖动）还是复制（粘贴）。
pub fn import_paths_at(root: &Path, sources: &[PathBuf], dest_dir_rel: &str, internal_move: bool) -> Result<ImportReport, String> {
    // 目标先出证一次：目标不合法就整批拒绝，零副作用
    let dest_comps = components_of(dest_dir_rel)?;
    check_not_protected(&dest_comps)?;
    let dest = resolve_scoped(root, &dest_comps.join("/"))?;
    check_canonical_not_protected(root, &dest)?;
    if !dest.is_dir() {
        return Err("目标不是目录".into());
    }
    let root_canon = root.canonicalize().map_err(|e| format!("文库根不可访问: {e}"))?;
    let mut report = ImportReport::default();
    for src in sources.iter().take(MAX_ITEMS) {
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let outcome: Result<(), String> = (|| {
            if !src.is_absolute() {
                return Err("不是绝对路径".into());
            }
            // 父目录 canonical + 叶子原样：判断「在不在库内」时不解引用叶子链接
            let parent = src.parent().ok_or("非法路径")?.canonicalize().map_err(|e| e.to_string())?;
            let real = parent.join(src.file_name().ok_or("非法路径")?);
            if real.starts_with(&root_canon) {
                let rel = rel_of(root, &real)?;
                if internal_move {
                    let to = move_entry_at(root, &rel, dest_dir_rel)?;
                    if to != rel {
                        report.moved.push((rel, to));
                    }
                } else {
                    report.imported.push(copy_entry_at(root, &rel, dest_dir_rel)?);
                }
            } else {
                report.imported.push(copy_abs_into(root, &real, dest_dir_rel)?);
            }
            Ok(())
        })();
        if let Err(e) = outcome {
            report.skipped.push((name, e));
        }
    }
    Ok(report)
}

// ---------- Tauri 命令 ----------

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    ws: String,
    expected_root: Option<String>,
    f: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Workspaces>().with_write_root(&ws, expected_root.as_deref(), f))
        .await
        .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 拖影用应用图标（drag crate 要求给一张图）
const DRAG_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// 从文库树发起一次**原生**拖动：可以丢进网页上传框、别的 app、访达。对外一律是「复制」语义——
/// 文件不会因为拖出去而离开文库。丢回本窗口的树上则由 import_dropped 按库内移动处理。
#[tauri::command]
pub async fn start_drag_out(app: AppHandle, window: WebviewWindow, rels: Vec<String>, expected_root: Option<String>) -> Result<(), String> {
    let paths = blocking(app, window.label().to_string(), expected_root, move |root| resolve_out_paths(root, &rels)).await?;
    // 拖到别的 app / 资源管理器的是普通形式（不认 `\\?\`）
    let paths: Vec<PathBuf> = paths.iter().map(|p| crate::scope::plain_path(p)).collect();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let r = drag::start_drag(
                &win,
                drag::DragItem::Files(paths),
                drag::Image::Raw(DRAG_ICON.to_vec()),
                |_result, _cursor| {},
                drag::Options { skip_animatation_on_cancel_or_failure: false, mode: drag::DragMode::Copy },
            )
            .map_err(|e| format!("无法开始拖动: {e}"));
            let _ = tx.send(r);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

/// 把库内文件放上系统剪贴板（文件引用，不是内容）：去别的 app / 网页里 ⌘V 就是这些文件。
#[tauri::command]
pub async fn copy_files_to_clipboard(app: AppHandle, window: WebviewWindow, rels: Vec<String>, expected_root: Option<String>) -> Result<(), String> {
    use clipboard_rs::{Clipboard, ClipboardContext};
    let paths = blocking(app.clone(), window.label().to_string(), expected_root, move |root| resolve_out_paths(root, &rels)).await?;
    let files: Vec<String> = paths.iter().map(|p| crate::scope::plain_path(p).to_string_lossy().into_owned()).collect();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let r = ClipboardContext::new()
            .and_then(|ctx| ctx.set_files(files))
            .map_err(|e| format!("无法写入系统剪贴板: {e}"));
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

/// 系统刚把文件放到窗口上（路径在 Rust 侧暂存）；前端只告诉我们放进哪个库内目录。
#[tauri::command]
pub async fn import_dropped(app: AppHandle, window: WebviewWindow, dest_dir: String, expected_root: Option<String>) -> Result<ImportReport, String> {
    let sources = app.state::<TransferState>().take_drop();
    if sources.is_empty() {
        return Err("没有待放入的文件（拖放已过期）".into());
    }
    blocking(app, window.label().to_string(), expected_root, move |root| import_paths_at(root, &sources, &dest_dir, true)).await
}

/// 把系统剪贴板里的文件粘进库内目录（访达里 ⌘C 过来的，或本应用 ⌘C 的库内文件）。一律复制。
#[tauri::command]
pub async fn paste_clipboard_files(app: AppHandle, window: WebviewWindow, dest_dir: String, expected_root: Option<String>) -> Result<ImportReport, String> {
    use clipboard_rs::{Clipboard, ClipboardContext};
    let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();
    app.run_on_main_thread(move || {
        let files = ClipboardContext::new().and_then(|ctx| ctx.get_files()).unwrap_or_default();
        let _ = tx.send(files);
    })
    .map_err(|e| e.to_string())?;
    let files = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or_default())
        .await
        .map_err(|e| e.to_string())?;
    let sources: Vec<PathBuf> = files
        .iter()
        .map(|f| PathBuf::from(f.strip_prefix("file://").unwrap_or(f)))
        .collect();
    if sources.is_empty() {
        return Err("系统剪贴板里没有文件".into());
    }
    blocking(app, window.label().to_string(), expected_root, move |root| import_paths_at(root, &sources, &dest_dir, false)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn lib() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempdir().unwrap();
        let root = t.path().join("lib");
        let outside = t.path().join("outside");
        fs::create_dir_all(root.join("docs/sub")).unwrap();
        fs::create_dir_all(root.join(".openfile")).unwrap();
        fs::create_dir_all(outside.join("pack")).unwrap();
        fs::write(root.join("docs/a.md"), "A").unwrap();
        fs::write(root.join(".openfile/auth-state.json"), "TOKENS").unwrap();
        fs::write(outside.join("secret.txt"), "S").unwrap();
        fs::write(outside.join("pack/x.txt"), "X").unwrap();
        (t, root, outside)
    }

    #[test]
    fn out_paths_are_scoped() {
        let (_t, root, outside) = lib();
        let ok = resolve_out_paths(&root, &["docs/a.md".into()]).unwrap();
        assert!(ok[0].ends_with("docs/a.md") && ok[0].is_absolute());
        let abs = outside.join("secret.txt").to_string_lossy().into_owned();
        for bad in ["../outside/secret.txt", abs.as_str(), "docs/a\0.md", "", ".", ".openfile/auth-state.json", "nope.md"] {
            assert!(resolve_out_paths(&root, &[bad.to_string()]).is_err(), "{bad:?}");
        }
        assert!(resolve_out_paths(&root, &[]).is_err());
        // 一批里有一个坏的就整批拒绝
        assert!(resolve_out_paths(&root, &["docs/a.md".into(), "../x".into()]).is_err());
    }

    #[test]
    fn out_paths_never_hand_over_outside_files_via_symlink() {
        use crate::test_links::{link_dir, link_file};
        let (_t, root, outside) = lib();
        if link_file(&outside.join("secret.txt"), &root.join("leak")) {
            assert!(resolve_out_paths(&root, &["leak".into()]).is_err());
        }
        if link_file(&root.join("docs/a.md"), &root.join("AGENTS.md")) {
            // 库内链接：递出去的是它指向的库内真实文件
            assert!(resolve_out_paths(&root, &["AGENTS.md".into()]).unwrap()[0].ends_with("docs/a.md"));
        }
        link_dir(&outside, &root.join("escape"));
        assert!(resolve_out_paths(&root, &["escape/secret.txt".into()]).is_err());
        assert!(resolve_out_paths(&root, &["escape".into()]).is_err());
        // 库内目录链接：递出去的是库内真实目录
        link_dir(&root.join("docs"), &root.join("docs-alias"));
        assert!(resolve_out_paths(&root, &["docs-alias/a.md".into()]).unwrap()[0].ends_with("docs/a.md"));
    }

    /// 文库的本机状态不能借道外递：大小写变体、指进 .openfile 的库内链接、指回根的链接、8.3 短名
    #[test]
    fn out_paths_and_import_destinations_check_real_names() {
        use crate::test_links::link_dir;
        let (_t, root, outside) = lib();
        link_dir(&root.join(".openfile"), &root.join("cfg"));
        link_dir(&root, &root.join("docs/up"));
        for bad in [".OPENFILE/auth-state.json", ".OpenFile", "cfg/auth-state.json", "cfg", "docs/up/.openfile/auth-state.json", "docs/up"] {
            assert!(resolve_out_paths(&root, &[bad.to_string()]).is_err(), "{bad:?}");
        }
        for bad in [".OPENFILE", "cfg", "docs/up/.openfile"] {
            assert!(import_paths_at(&root, &[outside.join("secret.txt")], bad, true).is_err(), "{bad:?}");
        }
        assert!(!root.join(".openfile/secret.txt").exists());
        // 库内的内部文件经链接当来源：照样不搬
        let r = import_paths_at(&root, &[root.join("cfg").join("auth-state.json")], "docs", false).unwrap();
        assert_eq!(r.skipped.len(), 1, "{r:?}");
        assert!(!root.join("docs/auth-state.json").exists());
        #[cfg(windows)]
        {
            if std::fs::symlink_metadata(root.join("OPENFI~1")).is_ok() {
                assert!(resolve_out_paths(&root, &["OPENFI~1/auth-state.json".into()]).is_err());
                assert!(resolve_out_paths(&root, &["OPENFI~1".into()]).is_err());
                assert!(import_paths_at(&root, &[outside.join("secret.txt")], "OPENFI~1", true).is_err());
                let r = import_paths_at(&root, &[root.join("OPENFI~1").join("auth-state.json")], "docs", false).unwrap();
                assert_eq!(r.skipped.len(), 1, "{r:?}");
            } else {
                eprintln!("skip: 卷上没有 8.3 短名，跳过短名别名断言");
            }
        }
        assert_eq!(fs::read_to_string(root.join(".openfile/auth-state.json")).unwrap(), "TOKENS");
    }

    #[test]
    fn import_copies_in_and_never_touches_the_source() {
        let (_t, root, outside) = lib();
        let r = import_paths_at(&root, &[outside.join("secret.txt"), outside.join("pack")], "docs", true).unwrap();
        assert_eq!(r.imported, vec!["docs/secret.txt", "docs/pack"]);
        assert!(r.moved.is_empty() && r.skipped.is_empty());
        assert_eq!(fs::read_to_string(root.join("docs/pack/x.txt")).unwrap(), "X");
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "S", "源原地不动");
        // 再来一次：撞名走副本序列，不覆盖
        let again = import_paths_at(&root, &[outside.join("secret.txt")], "docs", true).unwrap();
        assert_eq!(again.imported, vec!["docs/secret 副本.txt"]);
    }

    #[test]
    fn import_rejects_bad_destination_with_zero_side_effects() {
        let (_t, root, outside) = lib();
        let src = [outside.join("secret.txt")];
        let abs = outside.to_string_lossy().into_owned();
        for bad in ["../outside", abs.as_str(), ".openfile", "docs/a.md", "nope", "docs\0"] {
            assert!(import_paths_at(&root, &src, bad, true).is_err(), "{bad:?}");
        }
        assert!(!outside.join("secret 副本.txt").exists());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 2);
    }

    #[test]
    fn import_refuses_escape_destination_and_skips_symlink_sources() {
        use crate::test_links::{link_dir, link_file};
        let (_t, root, outside) = lib();
        link_dir(&outside, &root.join("escape"));
        assert!(import_paths_at(&root, &[outside.join("pack")], "escape", true).is_err());
        // 来源是链接：一律跳过不搬（目录链接哪都跑；文件链接 Windows 无开发者模式时不建）
        link_dir(&outside.join("pack"), &outside.join("linkdir"));
        let mut sources = vec![outside.join("linkdir"), PathBuf::from("relative.txt")];
        if link_file(&outside.join("secret.txt"), &outside.join("link")) {
            sources.push(outside.join("link"));
        }
        let r = import_paths_at(&root, &sources, "docs", true).unwrap();
        assert!(r.imported.is_empty(), "{r:?}");
        assert_eq!(r.skipped.len(), sources.len());
        assert!(!root.join("docs/link").exists() && !root.join("docs/linkdir").exists());
        assert_eq!(fs::read_to_string(outside.join("pack/x.txt")).unwrap(), "X", "源原地不动");
    }

    #[test]
    fn library_paths_are_moved_or_copied_inside_never_reimported() {
        let (_t, root, _) = lib();
        let moved = import_paths_at(&root, &[root.join("docs/a.md")], "docs/sub", true).unwrap();
        assert_eq!(moved.moved, vec![("docs/a.md".to_string(), "docs/sub/a.md".to_string())]);
        assert!(!root.join("docs/a.md").exists());
        let copied = import_paths_at(&root, &[root.join("docs/sub/a.md")], "docs", false).unwrap();
        assert_eq!(copied.imported, vec!["docs/a.md"]);
        assert!(root.join("docs/sub/a.md").exists());
        // 库内的内部目录照样受保护
        let internal = import_paths_at(&root, &[root.join(".openfile/auth-state.json")], "docs", false).unwrap();
        assert_eq!(internal.skipped.len(), 1);
        assert!(!root.join("docs/auth-state.json").exists());
    }

    #[test]
    fn dropped_paths_are_one_shot() {
        let st = TransferState::default();
        assert!(st.take_drop().is_empty());
        st.stash_drop(vec![PathBuf::from("/tmp/x")]);
        assert_eq!(st.take_drop().len(), 1);
        assert!(st.take_drop().is_empty(), "取走即清空：同一次拖放不能被重放");
    }
}
