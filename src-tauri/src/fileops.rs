//! 文件管理：文库树里的新建文件夹 / 重命名 / 移动 / 复制 / 属性 / 移到废纸篓。
//!
//! 与读写出证的关键差别——这里操作的是**目录项本身**，叶子处的符号链接绝不跟随：
//! `resolve_scoped` 会把 `AGENTS.md -> CLAUDE.md` 解成 CLAUDE.md，拿它去删/改名就动错了对象。
//! 所以出证分两半：父目录走 `resolve_scoped`（canonical、必在根内），叶子只接受一个普通成分，
//! 拼在已出证的父目录上（`resolve_entry`）。新目标同理（`resolve_new_child`），且**永不覆盖**。
//!
//! JS 侧同语义实现在 packages/runtime/src/lib/file-ops.mjs；两边分叉时以本文件为准并回修 JS。
//! 桌面端的新建 / 重命名 / 移动 / 复制 / 属性走运行时（JS 那份），这里只有废纸篓、在文件管理器中显示、
//! 拖放与粘贴导入还在用；其余保留为参照实现与攻击测试的对象（所以整个模块允许未使用）。
#![allow(dead_code)]
//! 已知边界：存在性检查与 rename 之间不是原子的（同 write_bound 的基线比较，不是跨进程锁）。

use crate::scope::{is_bad_windows_name, rel_components, rel_components_of, resolve_scoped, SKIP_DIRS};
use serde::Serialize;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 内部目录：不在文件树里管理（.openfile 放文库自己的本机状态）。
const PROTECTED_TOP: &[&str] = &[".openfile"];
/// 属性统计的遍历上限（超出即标 truncated，不让一个 node_modules 卡死界面）。
const INFO_WALK_CAP: u64 = 200_000;

/// 库内相对路径 → 成分（校验与 scope::rel_components 同一份：Windows 上 `\` 是分隔符、拒非法文件名）。
pub(crate) fn components_of(rel: &str) -> Result<Vec<String>, String> {
    Ok(rel_components(rel)?
        .into_iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect())
}

/// 文库根下的内部目录名。ASCII 大小写不敏感：Windows 与默认（大小写不敏感的）APFS 上
/// `.OPENFILE`、`.Git` 就是 `.openfile`、`.git`。
pub(crate) fn is_protected_top(name: &str) -> bool {
    PROTECTED_TOP.iter().chain(SKIP_DIRS.iter()).any(|p| p.eq_ignore_ascii_case(name))
}

pub(crate) fn check_not_protected(comps: &[String]) -> Result<(), String> {
    match comps.first() {
        Some(first) if is_protected_top(first) => Err("内部目录不在此处管理".into()),
        _ => Ok(()),
    }
}

/// 同一检查跑在**真名**上：出证后的 canonical 路径相对 canonical 根的首段。原始成分能被
/// 8.3 短名（`OPENFI~1` → `.openfile`）、大小写变体、指进内部目录或指回根的库内目录链接绕过。
pub(crate) fn check_canonical_not_protected(root: &Path, abs: &Path) -> Result<(), String> {
    let root_canon = root.canonicalize().map_err(|e| format!("文库根不可访问: {e}"))?;
    check_not_protected(&rel_components_of(&root_canon, abs)?)
}

/// 新名字只能是单个普通成分。
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("名称不能为空".into());
    }
    if name.contains('\0') || name.contains('/') || name.contains('\\') {
        return Err("名称不能包含路径分隔符".into());
    }
    if name.len() > 255 {
        return Err("名称过长".into());
    }
    if name.trim() != name {
        return Err("名称首尾不能有空白".into());
    }
    if is_protected_top(name) {
        return Err("该名称保留给内部目录".into());
    }
    if cfg!(windows) && is_bad_windows_name(OsStr::new(name)) {
        return Err("非法文件名".into());
    }
    Ok(())
}

/// 叶子在磁盘上的真名，**不跟随叶子处的链接**：普通项交给 canonicalize（还原大小写与 8.3 短名）；
/// 链接只能按目录列表找（先逐字，再忽略大小写）——列表里根本没有这个名字的（短名别名）一律拒绝。
fn leaf_true_name(parent: &Path, leaf: &str) -> Result<String, String> {
    let target = parent.join(leaf);
    let meta = fs::symlink_metadata(&target).map_err(|e| format!("路径不可访问: {e}"))?;
    if !meta.file_type().is_symlink() {
        if let Ok(real) = target.canonicalize() {
            if real.parent() == Some(parent) {
                if let Some(name) = real.file_name() {
                    return Ok(name.to_string_lossy().into_owned());
                }
            }
        }
    }
    let wanted = leaf.to_lowercase();
    let mut folded = None;
    for ent in fs::read_dir(parent).map_err(|e| format!("路径不可访问: {e}"))?.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name == leaf {
            return Ok(name);
        }
        if folded.is_none() && name.to_lowercase() == wanted {
            folded = Some(name);
        }
    }
    folded.ok_or_else(|| "请使用完整的文件名（不接受短名别名）".to_string())
}

/// 已存在目录项的出证：父目录 canonical 且在根内，叶子不跟随符号链接。拒绝文库根本身。
pub fn resolve_entry(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let comps = components_of(rel)?;
    check_not_protected(&comps)?;
    let Some((leaf, parents)) = comps.split_last() else {
        return Err("不能对文库根执行此操作".into());
    };
    let parent = resolve_scoped(root, &parents.join("/"))?;
    let target = parent.join(leaf);
    fs::symlink_metadata(&target).map_err(|e| format!("路径不可访问: {e}"))?;
    // 真名复查：父目录已 canonical；父目录就是文库根时（含经指回根的链接），叶子自己就是首段
    let root_canon = root.canonicalize().map_err(|e| format!("文库根不可访问: {e}"))?;
    let mut real = rel_components_of(&root_canon, &parent)?;
    if real.is_empty() {
        real.push(leaf_true_name(&parent, leaf)?);
    }
    check_not_protected(&real)?;
    Ok(target)
}

/// 新目录项的出证：目标目录必须已存在且在根内；名字合法；**目标处不能已有任何东西**。
pub fn resolve_new_child(root: &Path, dir_rel: &str, name: &str) -> Result<PathBuf, String> {
    validate_name(name)?;
    let comps = components_of(dir_rel)?;
    check_not_protected(&comps)?;
    let dir = resolve_scoped(root, &comps.join("/"))?;
    check_canonical_not_protected(root, &dir)?;
    if !dir.is_dir() {
        return Err("目标不是目录".into());
    }
    let target = dir.join(name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err("目标已存在同名项".into());
    }
    Ok(target)
}

pub(crate) fn rel_of(root: &Path, abs: &Path) -> Result<String, String> {
    let root_canon = root.canonicalize().map_err(|e| format!("文库根不可访问: {e}"))?;
    let tail = abs.strip_prefix(&root_canon).map_err(|_| "路径越出文库范围".to_string())?;
    let parts: Vec<String> = tail
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    Ok(parts.join("/"))
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}
/// Windows：不跟随叶子链接地判断「目标已存在」其实就是源自己（只改大小写的重命名）——
/// 同一个 canonical 父目录、名字只差大小写，且两侧看到的元数据逐项相同。最后一条防大小写敏感的目录
/// （WSL 启用的那种）里 readme.md 与 README.md 是两个文件：那时 rename 会覆盖另一个文件。
#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    let (Some(pa), Some(pb), Some(na), Some(nb)) = (a.parent(), b.parent(), a.file_name(), b.file_name()) else {
        return false;
    };
    let same_dir = matches!((pa.canonicalize(), pb.canonicalize()), (Ok(x), Ok(y)) if x == y);
    if !same_dir || na.to_string_lossy().to_lowercase() != nb.to_string_lossy().to_lowercase() {
        return false;
    }
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => {
            x.file_type() == y.file_type()
                && x.len() == y.len()
                && x.modified().ok() == y.modified().ok()
                && x.created().ok() == y.created().ok()
        }
        _ => false,
    }
}

pub fn create_dir_at(root: &Path, dir_rel: &str, name: &str) -> Result<String, String> {
    let target = resolve_new_child(root, dir_rel, name)?;
    fs::create_dir(&target).map_err(|e| format!("创建目录失败: {e}"))?;
    rel_of(root, &target)
}

pub fn rename_entry_at(root: &Path, rel: &str, new_name: &str) -> Result<String, String> {
    let src = resolve_entry(root, rel)?;
    validate_name(new_name)?;
    let parent = src.parent().ok_or("非法路径")?;
    let dest = parent.join(new_name);
    if dest == src {
        return rel_of(root, &src);
    }
    // 大小写不敏感的卷上，只改大小写时「目标已存在」其实就是它自己
    if fs::symlink_metadata(&dest).is_ok() && !same_file(&src, &dest) {
        return Err("目标已存在同名项".into());
    }
    fs::rename(&src, &dest).map_err(|e| format!("重命名失败: {e}"))?;
    rel_of(root, &dest)
}

fn leaf_name(p: &Path) -> Result<String, String> {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "非法路径".to_string())
}

/// 目录不能移进/复制进它自己或它的子孙（否则 rename 报错含糊、copy 无限递归）。
/// 比较跑在真名上：src 的叶子是调用方给的原样名字（Windows / APFS 上 `DOCS` 就是 `docs`，还可能是
/// 8.3 短名）。src 是真目录（不是链接），canonicalize 不会跟随任何东西。
fn check_not_into_self(src: &Path, dest_dir: &Path) -> Result<(), String> {
    let is_real_dir = fs::symlink_metadata(src).map(|m| m.is_dir()).unwrap_or(false);
    if !is_real_dir {
        return Ok(());
    }
    let src_real = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let dest_real = dest_dir.canonicalize().unwrap_or_else(|_| dest_dir.to_path_buf());
    if dest_real.starts_with(&src_real) || dest_dir.starts_with(src) {
        return Err("不能把文件夹放进它自己里面".into());
    }
    Ok(())
}

pub fn move_entry_at(root: &Path, rel: &str, dest_dir_rel: &str) -> Result<String, String> {
    let src = resolve_entry(root, rel)?;
    let name = leaf_name(&src)?;
    if src.parent() == Some(resolve_scoped(root, &components_of(dest_dir_rel)?.join("/"))?.as_path()) {
        return rel_of(root, &src); // 原地：不动
    }
    let dest = resolve_new_child(root, dest_dir_rel, &name)?;
    check_not_into_self(&src, dest.parent().ok_or("非法路径")?)?;
    fs::rename(&src, &dest).map_err(|e| format!("移动失败: {e}"))?;
    rel_of(root, &dest)
}

/// 「名字 副本.ext」「名字 副本 2.ext」……（目录不拆扩展名）
fn copy_name(name: &str, is_dir: bool, n: u32) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if !is_dir && i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    if n <= 1 {
        format!("{stem} 副本{ext}")
    } else {
        format!("{stem} 副本 {n}{ext}")
    }
}

/// 递归复制，**不跟随也不复制符号链接**（链接可能指向库外；跳过比搬运一条逃逸链接安全）。
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir(dest).map_err(|e| format!("复制失败: {e}"))?;
        for ent in fs::read_dir(src).map_err(|e| format!("复制失败: {e}"))? {
            let ent = ent.map_err(|e| format!("复制失败: {e}"))?;
            copy_tree(&ent.path(), &dest.join(ent.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dest).map(|_| ()).map_err(|e| format!("复制失败: {e}"))
    }
}

pub fn copy_entry_at(root: &Path, rel: &str, dest_dir_rel: &str) -> Result<String, String> {
    let src = resolve_entry(root, rel)?;
    copy_abs_into(root, &src, dest_dir_rel)
}

/// 把一个**已确定来源**的绝对路径复制进库内目录（目标一侧照常出证、永不覆盖、不碰源）。
/// 库内复制传 resolve_entry 的结果；库外导入只传系统拖放 / 系统剪贴板给出的路径。
pub(crate) fn copy_abs_into(root: &Path, src: &Path, dest_dir_rel: &str) -> Result<String, String> {
    let src = src.to_path_buf();
    let meta = fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("不复制符号链接".into());
    }
    let name = leaf_name(&src)?;
    // 先按原名；撞名就走「副本」序列
    let mut dest = None;
    for n in 0..1000u32 {
        let candidate = if n == 0 { name.clone() } else { copy_name(&name, meta.is_dir(), n) };
        match resolve_new_child(root, dest_dir_rel, &candidate) {
            Ok(p) => {
                dest = Some(p);
                break;
            }
            Err(e) if e == "目标已存在同名项" => continue,
            Err(e) => return Err(e),
        }
    }
    let dest = dest.ok_or("同名副本过多")?;
    check_not_into_self(&src, dest.parent().ok_or("非法路径")?)?;
    if let Err(e) = copy_tree(&src, &dest) {
        // 半截副本清掉（dest 是本次新建的，出证过，不会碰到别人的东西）
        let _ = if dest.is_dir() { fs::remove_dir_all(&dest) } else { fs::remove_file(&dest) };
        return Err(e);
    }
    rel_of(root, &dest)
}

/// 移到废纸篓。真正的「丢」由调用方注入（桌面端 = 系统废纸篓；测试 = 记录器），
/// 使出证逻辑处于单测之下而不污染开发者的废纸篓。
pub fn trash_entry_with(
    root: &Path,
    rel: &str,
    trasher: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let target = resolve_entry(root, rel)?;
    trasher(&target)
}

pub fn system_trash(path: &Path) -> Result<(), String> {
    let path = trash_target(path)?;
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // macOS 默认走 Finder AppleScript（要「自动化」授权、还会拉 osascript）；NSFileManager 无授权、无子进程
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(&path).map_err(|e| format!("移到废纸篓失败: {e}"))
}

/// Windows：交给回收站的路径必须能**无歧义**写成普通形式——Shell 不认 `\\?\`，trash 内部会无条件剥掉前缀，
/// 剥不了的（尾点/空格、保留名、超长）经 Win32 规范化可能落到另一个文件上（`a.` 会被当成 `a`）。
/// 网络位置（`\\?\UNC\…`）同样拒绝：那里没有回收站，Shell 会直接永久删除。其它平台原样放行。
fn trash_target(path: &Path) -> Result<PathBuf, String> {
    let simple = dunce::simplified(path);
    if simple.as_os_str().as_encoded_bytes().starts_with(br"\\?\") {
        return Err("该位置无法安全移到回收站（网络位置、超长路径或特殊文件名），请在资源管理器中处理".into());
    }
    Ok(simple.to_path_buf())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub name: String,
    pub rel: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub link_target: Option<String>,
    /// 文件 = 自身大小；目录 = 递归合计（不跟随符号链接）
    pub size: u64,
    /// 目录内的项目数（递归）；文件为 None
    pub items: Option<u64>,
    pub created: Option<i64>,
    pub mtime: i64,
    pub readonly: bool,
    /// 目录太大、统计在上限处停了
    pub truncated: bool,
}

fn secs(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

pub fn entry_info_at(root: &Path, rel: &str) -> Result<EntryInfo, String> {
    let target = resolve_entry(root, rel)?;
    let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    let is_symlink = meta.file_type().is_symlink();
    let (mut size, mut items, mut truncated) = (meta.len(), None, false);
    if meta.is_dir() {
        let (mut total, mut count) = (0u64, 0u64);
        for ent in walkdir::WalkDir::new(&target).min_depth(1).follow_links(false) {
            let Ok(ent) = ent else { continue };
            count += 1;
            if count > INFO_WALK_CAP {
                truncated = true;
                break;
            }
            if let Ok(m) = ent.metadata() {
                if m.is_file() {
                    total += m.len();
                }
            }
        }
        size = total;
        items = Some(count.min(INFO_WALK_CAP));
    }
    Ok(EntryInfo {
        name: leaf_name(&target)?,
        rel: rel.to_string(),
        is_dir: meta.is_dir(),
        is_symlink,
        link_target: if is_symlink {
            // 联接的目标读出来带 `\\?\`：给界面看的还原成普通形式
            fs::read_link(&target).ok().map(|p| crate::scope::plain_path(&p).to_string_lossy().into_owned())
        } else {
            None
        },
        size,
        items,
        created: secs(meta.created()),
        mtime: secs(meta.modified()).unwrap_or(0),
        readonly: meta.permissions().readonly(),
        truncated,
    })
}

/// 「在访达中显示」用：只出证，不触盘。
pub fn reveal_path_at(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if components_of(rel)?.is_empty() {
        return root.canonicalize().map_err(|e| e.to_string());
    }
    resolve_entry(root, rel)
}

// ---------- Tauri 命令 ----------
// 全部 async + spawn_blocking：同步命令跑在主线程，大目录的复制 / 属性统计会把窗口卡死。

use crate::workspaces::Workspaces;
use tauri::{AppHandle, Manager, WebviewWindow};

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    window: WebviewWindow,
    expected_root: Option<String>,
    f: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let ws = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Workspaces>().with_write_root(&ws, expected_root.as_deref(), f)
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[tauri::command]
pub async fn trash_entry(app: AppHandle, window: WebviewWindow, rel: String, expected_root: Option<String>) -> Result<(), String> {
    blocking(app, window, expected_root, move |root| trash_entry_with(root, &rel, system_trash)).await
}

/// 在访达 / 资源管理器里显示：路径先出证，再交给 opener 插件（不自己拉进程）。
#[tauri::command]
pub async fn reveal_entry(app: AppHandle, window: WebviewWindow, rel: String, expected_root: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = blocking(app.clone(), window, expected_root, move |root| reveal_path_at(root, &rel)).await?;
    app.opener().reveal_item_in_dir(crate::scope::plain_path(&target)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use tempfile::tempdir;

    /// 库 + 库外目录；库里有 docs/a.md、docs/sub/b.md
    fn lib() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempdir().unwrap();
        let root = t.path().join("lib");
        let outside = t.path().join("outside");
        fs::create_dir_all(root.join("docs/sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("docs/a.md"), "A").unwrap();
        fs::write(root.join("docs/sub/b.md"), "B").unwrap();
        fs::write(outside.join("secret.txt"), "S").unwrap();
        (t, root, outside)
    }

    fn snapshot(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn rejects_traversal_absolute_and_nul_with_zero_side_effects() {
        let (t, root, outside) = lib();
        let before = snapshot(t.path());
        let abs = outside.join("secret.txt").to_string_lossy().into_owned();
        for bad in ["../outside/secret.txt", "docs/../../outside/secret.txt", abs.as_str(), "docs/a\0.md"] {
            assert!(rename_entry_at(&root, bad, "x").is_err(), "rename {bad:?}");
            assert!(move_entry_at(&root, bad, "docs").is_err(), "move {bad:?}");
            assert!(copy_entry_at(&root, bad, "docs").is_err(), "copy {bad:?}");
            assert!(entry_info_at(&root, bad).is_err(), "info {bad:?}");
            assert!(trash_entry_with(&root, bad, |_| panic!("不该走到 trasher")).is_err());
            // 目标目录一侧
            assert!(move_entry_at(&root, "docs/a.md", bad).is_err(), "move→{bad:?}");
            assert!(copy_entry_at(&root, "docs/a.md", bad).is_err(), "copy→{bad:?}");
            assert!(create_dir_at(&root, bad, "n").is_err(), "mkdir in {bad:?}");
        }
        assert_eq!(before, snapshot(t.path()));
    }

    #[test]
    fn rejects_bad_names() {
        let (t, root, _) = lib();
        let before = snapshot(t.path());
        for bad in ["", ".", "..", "a/b", "a\\b", "../x", "x\0", " x", ".openfile", ".git"] {
            assert!(rename_entry_at(&root, "docs/a.md", bad).is_err(), "rename→{bad:?}");
            assert!(create_dir_at(&root, "docs", bad).is_err(), "mkdir {bad:?}");
        }
        assert_eq!(before, snapshot(t.path()));
    }

    #[test]
    fn refuses_library_root_and_internal_dirs() {
        let (t, root, _) = lib();
        fs::create_dir_all(root.join(".openfile/notes")).unwrap();
        fs::write(root.join(".openfile/notes/t.md"), "x").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        for rel in ["", "."] {
            assert!(rename_entry_at(&root, rel, "x").is_err());
            assert!(trash_entry_with(&root, rel, |_| panic!("根不能丢")).is_err());
        }
        assert!(trash_entry_with(&root, ".openfile", |_| panic!()).is_err());
        assert!(rename_entry_at(&root, ".openfile/notes/t.md", "y.md").is_err());
        assert!(move_entry_at(&root, "docs/a.md", ".openfile/notes").is_err());
        assert!(copy_entry_at(&root, ".openfile/notes/t.md", "docs").is_err());
        // 大小写变体（Windows 与默认 APFS 上就是同一个目录）：哪个平台都必须拒绝
        let before = snapshot(t.path());
        for alias in [".OPENFILE", ".OpenFile", ".Git", ".GIT"] {
            assert!(trash_entry_with(&root, alias, |_| panic!("{alias} 不能丢")).is_err(), "{alias}");
            assert!(rename_entry_at(&root, alias, "x").is_err(), "{alias}");
            assert!(move_entry_at(&root, alias, "docs").is_err(), "{alias}");
            assert!(copy_entry_at(&root, alias, "docs").is_err(), "{alias}");
            assert!(entry_info_at(&root, alias).is_err(), "{alias}");
        }
        assert!(rename_entry_at(&root, ".OPENFILE/tasks/t.md", "y.md").is_err());
        assert!(trash_entry_with(&root, ".OPENFILE/tasks/t.md", |_| panic!()).is_err());
        assert!(move_entry_at(&root, "docs/a.md", ".OPENFILE/tasks").is_err());
        assert!(copy_entry_at(&root, ".OPENFILE/tasks/t.md", "docs").is_err());
        assert!(create_dir_at(&root, ".OPENFILE", "n").is_err());
        for name in [".OPENFILE", ".Git", "Node_Modules"] {
            assert!(create_dir_at(&root, "docs", name).is_err(), "{name}");
            assert!(rename_entry_at(&root, "docs/a.md", name).is_err(), "{name}");
        }
        assert_eq!(before, snapshot(t.path()));
    }

    /// 名字检查跑在真名上：库内目录链接指进 .openfile、指回文库根，8.3 短名——都绕不过去
    #[test]
    fn internal_dirs_cannot_be_reached_through_aliases() {
        let (t, root, _) = lib();
        fs::create_dir_all(root.join(".openfile/notes")).unwrap();
        fs::write(root.join(".openfile/notes/t.md"), "x").unwrap();
        crate::test_links::link_dir(&root.join(".openfile"), &root.join("cfg"));
        crate::test_links::link_dir(&root, &root.join("docs/up"));
        let before = snapshot(t.path());
        for rel in ["cfg/tasks/t.md", "cfg/tasks", "docs/up/.openfile", "docs/up/.OPENFILE", "docs/up/cfg/tasks/t.md"] {
            assert!(trash_entry_with(&root, rel, |_| panic!("{rel} 不能丢")).is_err(), "{rel}");
            assert!(rename_entry_at(&root, rel, "x").is_err(), "{rel}");
            assert!(move_entry_at(&root, rel, "docs").is_err(), "{rel}");
            assert!(copy_entry_at(&root, rel, "docs").is_err(), "{rel}");
            assert!(entry_info_at(&root, rel).is_err(), "{rel}");
        }
        for dir in ["cfg", "cfg/tasks", "docs/up/.openfile"] {
            assert!(move_entry_at(&root, "docs/a.md", dir).is_err(), "move→{dir}");
            assert!(copy_entry_at(&root, "docs/a.md", dir).is_err(), "copy→{dir}");
            assert!(create_dir_at(&root, dir, "n").is_err(), "mkdir in {dir}");
        }
        assert_eq!(before, snapshot(t.path()));
        // 链接本身是用户的目录项，可以照常管理（丢的是链接，不是 .openfile）
        let seen = RefCell::new(None);
        trash_entry_with(&root, "cfg", |p| {
            *seen.borrow_mut() = Some(p.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert!(seen.into_inner().unwrap().ends_with("cfg"));
        #[cfg(windows)]
        {
            if fs::symlink_metadata(root.join("OPENFI~1")).is_ok() {
                for rel in ["OPENFI~1", "OPENFI~1/tasks/t.md", "openfi~1/tasks"] {
                    assert!(trash_entry_with(&root, rel, |_| panic!("{rel} 不能丢")).is_err(), "{rel}");
                    assert!(rename_entry_at(&root, rel, "x").is_err(), "{rel}");
                    assert!(copy_entry_at(&root, rel, "docs").is_err(), "{rel}");
                }
                assert!(move_entry_at(&root, "docs/a.md", "OPENFI~1/tasks").is_err());
                assert!(create_dir_at(&root, "OPENFI~1", "n").is_err());
                assert_eq!(before, snapshot(t.path()));
            } else {
                eprintln!("skip: 卷上没有 8.3 短名，跳过短名别名断言");
            }
        }
    }

    #[test]
    fn escape_symlink_dir_is_rejected_on_both_sides() {
        let (t, root, outside) = lib();
        crate::test_links::link_dir(&outside, &root.join("escape"));
        let before = snapshot(t.path());
        // 穿链接的源
        assert!(rename_entry_at(&root, "escape/secret.txt", "x.txt").is_err());
        assert!(trash_entry_with(&root, "escape/secret.txt", |_| panic!()).is_err());
        assert!(entry_info_at(&root, "escape/secret.txt").is_err());
        // 穿链接的目标：移不进去、拷不进去、建不了目录
        assert!(move_entry_at(&root, "docs/a.md", "escape").is_err());
        assert!(copy_entry_at(&root, "docs/a.md", "escape").is_err());
        assert!(create_dir_at(&root, "escape", "n").is_err());
        assert_eq!(before, snapshot(t.path()));
        assert!(outside.join("secret.txt").exists());
    }

    #[test]
    fn leaf_symlink_is_operated_on_itself_never_its_target() {
        use crate::test_links::{link_dir, link_file};
        let (_t, root, outside) = lib();
        // 文件链接版（Windows 无开发者模式时跳过）：库内 AGENTS.md -> docs/a.md；库外 leak -> outside/secret.txt
        if link_file(&root.join("docs/a.md"), &root.join("AGENTS.md"))
            && link_file(&outside.join("secret.txt"), &root.join("leak"))
        {
            let seen = RefCell::new(Vec::new());
            trash_entry_with(&root, "AGENTS.md", |p| {
                seen.borrow_mut().push(p.to_path_buf());
                Ok(())
            })
            .unwrap();
            trash_entry_with(&root, "leak", |p| {
                seen.borrow_mut().push(p.to_path_buf());
                Ok(())
            })
            .unwrap();
            let seen = seen.into_inner();
            assert!(seen[0].ends_with("AGENTS.md"), "丢的是链接本身，不是 docs/a.md");
            assert!(seen[1].ends_with("leak"), "丢的是链接本身，不是库外文件");

            // 改名改的是链接；目标原地不动
            let new_rel = rename_entry_at(&root, "leak", "leak2").unwrap();
            assert_eq!(new_rel, "leak2");
            assert!(fs::symlink_metadata(root.join("leak2")).unwrap().file_type().is_symlink());
            assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "S");

            // 属性不解引用；复制拒绝
            let info = entry_info_at(&root, "leak2").unwrap();
            assert!(info.is_symlink && !info.is_dir);
            assert!(copy_entry_at(&root, "leak2", "docs").is_err());
        }

        // 目录链接版（Windows 上是联接）：哪个平台都跑
        link_dir(&root.join("docs/sub"), &root.join("alias"));
        link_dir(&outside, &root.join("escape"));
        let seen = RefCell::new(Vec::new());
        for rel in ["alias", "escape"] {
            trash_entry_with(&root, rel, |p| {
                seen.borrow_mut().push(p.to_path_buf());
                Ok(())
            })
            .unwrap();
        }
        let seen = seen.into_inner();
        assert!(seen[0].ends_with("alias"), "丢的是链接本身，不是 docs/sub");
        assert!(seen[1].ends_with("escape"), "丢的是链接本身，不是库外目录");
        let new_rel = rename_entry_at(&root, "escape", "escape2").unwrap();
        assert_eq!(new_rel, "escape2");
        assert!(fs::symlink_metadata(root.join("escape2")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "S");
        let info = entry_info_at(&root, "escape2").unwrap();
        assert!(info.is_symlink && !info.is_dir, "属性不解引用");
        assert!(info.link_target.as_deref().is_some_and(|t| !t.starts_with(r"\\?\")), "{:?}", info.link_target);
        assert!(copy_entry_at(&root, "escape2", "docs").is_err(), "不复制链接");
        assert!(copy_entry_at(&root, "alias", "docs").is_err(), "不复制链接");
        // 移动链接：动的是链接本身，库外目录里不多不少
        assert_eq!(move_entry_at(&root, "escape2", "docs").unwrap(), "docs/escape2");
        assert!(fs::symlink_metadata(root.join("docs/escape2")).unwrap().file_type().is_symlink());
        let outside_names: Vec<_> = fs::read_dir(&outside).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(outside_names, vec![std::ffi::OsString::from("secret.txt")]);
    }

    #[test]
    fn copy_skips_symlinks_inside_tree() {
        let (_t, root, outside) = lib();
        crate::test_links::link_dir(&outside, &root.join("docs/sub/out"));
        let rel = copy_entry_at(&root, "docs", "").unwrap();
        assert_eq!(rel, "docs 副本");
        assert_eq!(fs::read_to_string(root.join("docs 副本/sub/b.md")).unwrap(), "B");
        assert!(fs::symlink_metadata(root.join("docs 副本/sub/out")).is_err(), "链接不复制");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1, "库外不被复制或改动");
    }

    #[test]
    fn case_only_rename_and_case_variant_self_nesting() {
        let (_t, root, _) = lib();
        // 只改大小写：大小写不敏感的卷上「目标已存在」就是它自己
        assert_eq!(rename_entry_at(&root, "docs/a.md", "A.md").unwrap(), "docs/A.md");
        let names: Vec<_> = fs::read_dir(root.join("docs")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"A.md".to_string()) && !names.contains(&"a.md".to_string()), "{names:?}");
        assert_eq!(fs::read_to_string(root.join("docs").join("A.md")).unwrap(), "A");
        // 真的另一个同名项仍然拒绝覆盖
        fs::write(root.join("docs/other.md"), "O").unwrap();
        assert!(rename_entry_at(&root, "docs/A.md", "other.md").is_err());
        assert_eq!(fs::read_to_string(root.join("docs/other.md")).unwrap(), "O");
        // 以大小写变体指称的目录也不能放进它自己里面（大小写敏感的卷上 DOCS 根本不存在，同样报错）
        assert!(move_entry_at(&root, "DOCS", "docs/sub").is_err());
        assert!(copy_entry_at(&root, "DOCS", "docs/sub").is_err());
        assert!(!root.join("docs/sub/DOCS").exists() && !root.join("docs/sub/docs").exists());
        assert!(root.join("docs/sub/b.md").exists());
    }

    #[test]
    fn trash_target_refuses_paths_without_a_plain_form() {
        let p = Path::new("/lib/a.md");
        assert_eq!(trash_target(p).unwrap(), PathBuf::from("/lib/a.md"));
        #[cfg(windows)]
        {
            assert_eq!(trash_target(Path::new(r"\\?\C:\lib\a.md")).unwrap(), PathBuf::from(r"C:\lib\a.md"));
            assert_eq!(trash_target(Path::new(r"C:\lib\a.md")).unwrap(), PathBuf::from(r"C:\lib\a.md"));
            for bad in [r"\\?\C:\lib\a.", r"\\?\C:\lib\con", r"\\?\C:\lib\x ", r"\\?\UNC\srv\share\a.md"] {
                assert!(trash_target(Path::new(bad)).is_err(), "{bad}");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_illegal_names_cannot_be_created_or_renamed_to() {
        let (t, root, _) = lib();
        let before = snapshot(t.path());
        for bad in ["a.md:x", "a.md::$DATA", "CON", "nul.txt", "com1", "x.", "a?b", "a|b", "a<b", "lpt¹"] {
            assert!(rename_entry_at(&root, "docs/a.md", bad).is_err(), "rename→{bad:?}");
            assert!(create_dir_at(&root, "docs", bad).is_err(), "mkdir {bad:?}");
        }
        for rel in ["docs/a.md:x", "docs\\..\\..\\outside", "C:x", "docs/CON"] {
            assert!(trash_entry_with(&root, rel, |_| panic!("{rel}")).is_err(), "{rel}");
            assert!(create_dir_at(&root, rel, "n").is_err(), "{rel}");
            assert!(move_entry_at(&root, "docs/a.md", rel).is_err(), "{rel}");
        }
        assert_eq!(before, snapshot(t.path()));
    }

    #[test]
    fn never_overwrites() {
        let (_t, root, _) = lib();
        fs::write(root.join("docs/sub/a.md"), "OTHER").unwrap();
        assert!(move_entry_at(&root, "docs/a.md", "docs/sub").is_err());
        assert!(rename_entry_at(&root, "docs/a.md", "sub").is_err());
        assert!(create_dir_at(&root, "docs", "sub").is_err());
        assert_eq!(fs::read_to_string(root.join("docs/sub/a.md")).unwrap(), "OTHER");
        assert_eq!(fs::read_to_string(root.join("docs/a.md")).unwrap(), "A");
        // 复制撞名走副本序列，原件不动
        assert_eq!(copy_entry_at(&root, "docs/a.md", "docs/sub").unwrap(), "docs/sub/a 副本.md");
        assert_eq!(copy_entry_at(&root, "docs/a.md", "docs/sub").unwrap(), "docs/sub/a 副本 2.md");
        assert_eq!(fs::read_to_string(root.join("docs/sub/a.md")).unwrap(), "OTHER");
    }

    #[test]
    fn dir_cannot_go_into_itself() {
        let (_t, root, _) = lib();
        assert!(move_entry_at(&root, "docs", "docs/sub").is_err());
        assert!(copy_entry_at(&root, "docs", "docs/sub").is_err());
        assert!(root.join("docs/sub/b.md").exists());
        assert!(!root.join("docs/sub/docs").exists());
    }

    #[test]
    fn happy_paths() {
        let (_t, root, _) = lib();
        assert_eq!(create_dir_at(&root, "", "新建").unwrap(), "新建");
        assert_eq!(move_entry_at(&root, "docs/a.md", "新建").unwrap(), "新建/a.md");
        assert_eq!(move_entry_at(&root, "新建/a.md", "新建").unwrap(), "新建/a.md"); // 原地
        assert_eq!(rename_entry_at(&root, "新建/a.md", "甲.md").unwrap(), "新建/甲.md");
        assert_eq!(copy_entry_at(&root, "新建/甲.md", "新建").unwrap(), "新建/甲 副本.md");
        let info = entry_info_at(&root, "docs").unwrap();
        assert!(info.is_dir);
        assert_eq!(info.items, Some(2)); // sub + sub/b.md
        assert_eq!(info.size, 1);
        let file = entry_info_at(&root, "新建/甲.md").unwrap();
        assert_eq!((file.size, file.items, file.is_dir), (1, None, false));
    }
}
