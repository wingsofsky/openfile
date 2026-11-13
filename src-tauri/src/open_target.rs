//! 「以 Openfile 打开」：操作系统交来的路径 → 工作区（当文库打开）+ 要打开的文档。
//!
//! 只在这里实现一份：首次启动的参数、单实例转发的第二次启动参数（Windows 的「打开方式」、
//! 目录右键「用 Openfile 打开」、`openfile open`）、macOS Finder 的 `RunEvent::Opened`、
//! 欢迎页拖入（暂存的系统拖放路径）都走 `queue_paths`。
//!
//! 路径来源都是操作系统（argv / Apple Event / 窗口拖放），等同原生选择器；前端拿不到往这里塞
//! 任意路径的命令（`open_dropped` 只取 Rust 自己暂存的拖放路径）。推断结果排队，前端收到
//! `open-target` 事件或启动时调 `take_open_targets` 取走，再走它现有的切库与开标签——挂文库仍只有一条路。
//!
//! 工作区推断：文件夹就是它自己；文件从所在目录往上找第一个含 `.git`（目录或 worktree 的文件）
//! 或 `.openfile/` 的祖先，找不到用所在目录。找到的是盘符根、UNC 共享根或用户主目录时也退回
//! 所在目录（整个盘 / 整个主目录当文库，索引和快照都吃不消）。
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenTarget {
    /// 工作区根（普通路径形式，与 LibraryInfo.root 同口径）
    pub root: String,
    /// 要打开的文档（库内相对路径，`/` 分隔）；打开的是文件夹时为 None
    pub rel: Option<String>,
}

#[derive(Default)]
pub struct OpenState {
    pending: Mutex<Vec<OpenTarget>>,
}

fn plain(p: &Path) -> String {
    dunce::simplified(p).to_string_lossy().into_owned()
}

/// 不能当工作区的祖先：盘符根 / UNC 共享根 / 文件系统根 / 用户主目录
fn too_broad(dir: &Path, home: Option<&Path>) -> bool {
    let mut comps = dunce::simplified(dir).components();
    let first = comps.next();
    let rest = comps.filter(|c| !matches!(c, std::path::Component::RootDir)).count();
    let is_root = matches!(first, Some(std::path::Component::Prefix(_)) | Some(std::path::Component::RootDir)) && rest == 0;
    is_root || home.is_some_and(|h| dunce::simplified(h) == dunce::simplified(dir))
}

/// 路径 → 工作区与文档。纯文件系统查询，可测；`home` 由调用方给（测试里换成临时目录）。
pub fn infer_workspace(path: &Path, home: Option<&Path>) -> Result<OpenTarget, String> {
    let p = dunce::canonicalize(path).map_err(|e| format!("路径不可访问: {e}"))?;
    if p.is_dir() {
        return Ok(OpenTarget { root: plain(&p), rel: None });
    }
    if !p.is_file() {
        return Err("不是文件或文件夹".into());
    }
    let dir = p.parent().ok_or("文件没有所在目录")?;
    // 主目录也要取规范路径再比：它本身经过链接（macOS 的 /var → /private/var、Windows 的 8.3 短名）时，原样比永远不等
    let home = home.map(|h| dunce::canonicalize(h).unwrap_or_else(|_| h.to_path_buf()));
    let marked = dir
        .ancestors()
        .find(|d| d.join(".git").exists() || d.join(".openfile").is_dir())
        .filter(|d| !too_broad(d, home.as_deref()));
    let root = marked.unwrap_or(dir);
    let rel = p
        .strip_prefix(root)
        .map_err(|_| "文件不在推断出的工作区里")?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Ok(OpenTarget { root: plain(root), rel: Some(rel) })
}

/// argv（首次启动 / 单实例转发）里的路径参数：跳过程序本身和 `-` 开头的开关，相对路径按 cwd 解析
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// 推断并排队；第一个推断得出的路径生效（一次只开一个工作区）。返回是否排上。
pub fn queue_paths(app: &AppHandle, paths: &[PathBuf]) -> bool {
    let home = home_dir();
    let Some(target) = paths.iter().find_map(|p| infer_workspace(p, home.as_deref()).ok()) else {
        return false;
    };
    if let Ok(mut q) = app.state::<OpenState>().pending.lock() {
        q.push(target);
    }
    // 打开入口只交给主窗口（多窗口时别的窗口不抢队列）
    let _ = app.emit_to("main", "open-target", ());
    focus_main(app);
    true
}

/// 单实例插件的回调：带路径就排队，没带（只是又点了一次程序图标）也把已开的窗口叫到前面。
/// 插件只在发行版注册（见 lib.rs）
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn on_second_instance(app: &AppHandle, argv: &[String], cwd: &str) {
    if !queue_paths(app, &paths_from_args(argv, Path::new(cwd))) {
        focus_main(app);
    }
}

fn focus_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = crate::visibility::show_main(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 前端取走排队的打开请求（启动时一次，之后每次收到 `open-target` 事件再取）
#[tauri::command]
pub fn take_open_targets(window: tauri::WebviewWindow, state: tauri::State<OpenState>) -> Vec<OpenTarget> {
    // 只有主窗口取：别的窗口启动时调到也不抢走（它们打开的是自己的库）
    if window.label() != "main" {
        return Vec::new();
    }
    state.pending.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
}

/// 欢迎页拖入：取暂存的系统拖放路径（一次性），当「以 Openfile 打开」处理
#[tauri::command]
pub fn open_dropped(app: AppHandle) -> bool {
    let paths = app.state::<crate::transfer::TransferState>().take_drop();
    queue_paths(&app, &paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join("仓库/.git")).unwrap();
        fs::create_dir_all(r.join("仓库/文档/深处")).unwrap();
        fs::write(r.join("仓库/文档/深处/稿.md"), "x").unwrap();
        fs::create_dir_all(r.join("文库/.openfile")).unwrap();
        fs::write(r.join("文库/笔记.txt"), "x").unwrap();
        fs::create_dir_all(r.join("散文件")).unwrap();
        fs::write(r.join("散文件/a.docx"), "x").unwrap();
        // git worktree：.git 是文件
        fs::create_dir_all(r.join("工作树/src")).unwrap();
        fs::write(r.join("工作树/.git"), "gitdir: ../仓库/.git/worktrees/x").unwrap();
        fs::write(r.join("工作树/src/b.md"), "x").unwrap();
        // 主目录本身是个仓库（dotfiles）：不能把整个主目录当工作区
        fs::create_dir_all(r.join("家/.git")).unwrap();
        fs::create_dir_all(r.join("家/下载")).unwrap();
        fs::write(r.join("家/下载/c.pdf"), "x").unwrap();
        t
    }

    fn canon(p: &Path) -> String {
        plain(&dunce::canonicalize(p).unwrap())
    }

    #[test]
    fn file_climbs_to_repo_or_library_root() {
        let t = tree();
        let r = t.path();
        let got = infer_workspace(&r.join("仓库/文档/深处/稿.md"), None).unwrap();
        assert_eq!(got, OpenTarget { root: canon(&r.join("仓库")), rel: Some("文档/深处/稿.md".into()) });
        let got = infer_workspace(&r.join("文库/笔记.txt"), None).unwrap();
        assert_eq!(got, OpenTarget { root: canon(&r.join("文库")), rel: Some("笔记.txt".into()) });
        let got = infer_workspace(&r.join("工作树/src/b.md"), None).unwrap();
        assert_eq!(got.root, canon(&r.join("工作树")));
        assert_eq!(got.rel.as_deref(), Some("src/b.md"));
    }

    #[test]
    fn unmarked_file_uses_its_directory_and_folders_are_themselves() {
        let t = tree();
        let r = t.path();
        let got = infer_workspace(&r.join("散文件/a.docx"), None).unwrap();
        // 临时目录的祖先里也可能有 .git（开发机把 TEMP 放在仓库里不常见，但无标记时结果必须是所在目录）
        if !r.ancestors().any(|d| d.join(".git").exists() || d.join(".openfile").is_dir()) {
            assert_eq!(got, OpenTarget { root: canon(&r.join("散文件")), rel: Some("a.docx".into()) });
        }
        let got = infer_workspace(&r.join("仓库/文档"), None).unwrap();
        assert_eq!(got, OpenTarget { root: canon(&r.join("仓库/文档")), rel: None });
    }

    #[test]
    fn home_and_drive_roots_are_too_broad() {
        let t = tree();
        let r = t.path();
        let home = r.join("家");
        let got = infer_workspace(&home.join("下载/c.pdf"), Some(&home)).unwrap();
        assert_eq!(got, OpenTarget { root: canon(&home.join("下载")), rel: Some("c.pdf".into()) });
        #[cfg(windows)]
        {
            assert!(too_broad(Path::new(r"C:\"), None));
            assert!(too_broad(Path::new(r"\\?\C:\"), None));
            assert!(too_broad(Path::new(r"\\server\share\"), None));
            assert!(!too_broad(Path::new(r"C:\Users"), None));
        }
        #[cfg(not(windows))]
        {
            assert!(too_broad(Path::new("/"), None));
            assert!(!too_broad(Path::new("/Users"), None));
        }
    }

    #[test]
    fn links_resolve_to_the_real_location() {
        let t = tree();
        let r = t.path();
        // 经目录链接进来的文件按真实位置推断：工作区是链接目标所在的仓库，不是链接所在的目录
        fs::create_dir_all(r.join("外面")).unwrap();
        crate::test_links::link_dir(&r.join("仓库/文档"), &r.join("外面/捷径"));
        let got = infer_workspace(&r.join("外面/捷径/深处/稿.md"), None).unwrap();
        assert_eq!(got, OpenTarget { root: canon(&r.join("仓库")), rel: Some("文档/深处/稿.md".into()) });
        let got = infer_workspace(&r.join("外面/捷径"), None).unwrap();
        assert_eq!(got, OpenTarget { root: canon(&r.join("仓库/文档")), rel: None });
        // 文件链接（Windows 没开开发者模式时建不出来，只跳过这一段）
        if crate::test_links::link_file(&r.join("文库/笔记.txt"), &r.join("散文件/笔记链接.txt")) {
            let got = infer_workspace(&r.join("散文件/笔记链接.txt"), None).unwrap();
            assert_eq!(got, OpenTarget { root: canon(&r.join("文库")), rel: Some("笔记.txt".into()) });
        }
    }

    #[test]
    fn verbatim_input_comes_back_plain_and_missing_is_an_error() {
        let t = tree();
        let r = t.path();
        let real = fs::canonicalize(r.join("文库/笔记.txt")).unwrap(); // Windows 上带 \\?\
        let got = infer_workspace(&real, None).unwrap();
        assert!(!got.root.starts_with(r"\\?\"), "{}", got.root);
        assert!(infer_workspace(&r.join("不存在.md"), None).is_err());
    }

    #[test]
    fn args_skip_program_and_switches_and_resolve_relative() {
        let cwd = Path::new(if cfg!(windows) { r"D:\工作" } else { "/工作" });
        let args = vec!["Openfile.exe".to_string(), "--flag".into(), "相对/a.md".into(), "".into()];
        assert_eq!(paths_from_args(&args, cwd), vec![cwd.join("相对/a.md")]);
        let abs = if cfg!(windows) { r"C:\x\b.md" } else { "/x/b.md" };
        assert_eq!(paths_from_args(&["exe".into(), abs.into()], cwd), vec![PathBuf::from(abs)]);
    }
}
