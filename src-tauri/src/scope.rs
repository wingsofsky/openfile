//! 路径安全层：所有文件访问必须经 `resolve_scoped` 出证。
//! 不变量：返回的路径永远位于文库根的 canonical 前缀之下（拒绝绝对路径、`..`、符号链接逃逸）。
//! JS 实现在 packages/runtime/src/lib/scoped.mjs（桌面端的读写走它）；两侧分叉以本文件为准。
//! 读写、编码嗅探在 Rust 里没有调用方，保留为参照实现与攻击测试的对象（所以整个模块允许未使用）。
#![allow(dead_code)]

use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 索引与列目录时跳过的目录名（体积/噪声型，永不含用户文档）。
/// 注意：`.claude`、`dist`、`build` 等保持可见 —— agent 记忆与构建产物是一等内容。
pub const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    ".pnpm-store",
    ".Trash",
];

/// 列目录时不展示的文件名。
pub const SKIP_FILES: &[&str] = &[".DS_Store"];

pub fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

/// Windows 上不能作为库内路径成分的名字（与 packages/runtime/src/lib/scoped.mjs 的 WIN_BAD_CHAR_RE /
/// WIN_RESERVED_RE / 尾字符检查同口径）：
/// - `:`——`a.md::$DATA`、`a.md:secret` 是 NTFS 备用数据流，`sub/C:x` 是盘符相对路径；
/// - `<>"|?*` 与控制字符 0x00–0x1F；
/// - 以 `.` 或空格结尾（Win32 会悄悄剥掉，落到另一个名字上）；
/// - 设备保留名，带不带扩展名都算（CON PRN AUX NUL COM0-9 LPT0-9 COM¹²³ LPT¹²³ CONIN$ CONOUT$，
///   ASCII 大小写不敏感）。
///
/// 这些名字在 Windows 上本来就建不出正常文件，拒掉不影响真实文档。纯函数、全平台可测；
/// 只在 Windows 上生效——其它平台它们都是合法文件名，行为不变。
pub(crate) fn is_bad_windows_name(name: &OsStr) -> bool {
    let s = name.to_string_lossy();
    if s.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\u{0}'..='\u{1f}')) {
        return true;
    }
    if s.ends_with('.') || s.ends_with(' ') {
        return true;
    }
    let lower = s.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    if matches!(stem, "con" | "prn" | "aux" | "nul" | "conin$" | "conout$") {
        return true;
    }
    if stem.starts_with("com") || stem.starts_with("lpt") {
        let mut rest = stem[3..].chars();
        return matches!((rest.next(), rest.next()), (Some('0'..='9' | '¹' | '²' | '³'), None));
    }
    false
}

/// 库内相对路径 → 普通成分。读、写、契约改写、文件管理共用一份（与 packages/runtime/src/lib/scoped.mjs::relSegments 同口径）：
/// 拒绝 NUL、绝对 / 带根 / 带盘符的路径（`C:x` 是盘符相对路径）、`..`；Windows 上 `\` 也是分隔符
/// （`Path::components` 天然如此），并拒 Windows 非法文件名（`is_bad_windows_name`）。
/// **校验先于任何触盘**：写出证建目录之前名字已经过关，`a/..\..\x` 这种段不可能先在库外建出目录。
pub(crate) fn rel_components(rel: &str) -> Result<Vec<&OsStr>, String> {
    if rel.contains('\0') {
        return Err("非法路径".into());
    }
    let p = Path::new(rel);
    if p.is_absolute() || p.has_root() {
        return Err("不接受绝对路径".into());
    }
    let mut out = Vec::new();
    for comp in p.components() {
        match comp {
            Component::Normal(s) => {
                if cfg!(windows) && is_bad_windows_name(s) {
                    return Err("非法文件名".into());
                }
                out.push(s);
            }
            Component::CurDir => {}
            Component::Prefix(_) => return Err("不接受绝对路径".into()),
            _ => return Err("路径包含越界成分".into()),
        }
    }
    Ok(out)
}

/// 离开 Rust 的路径一律用普通形式：给界面的文库根（前端按 `${root}/${rel}` 拼 asset URL）、写进设置的根、
/// 子进程的 argv / cwd（Node 的 fs.realpathSync 碰到 `\\?\` 会 EISDIR）、剪贴板与拖放的文件列表、
/// 影子仓库的哈希键（与 JS 侧 canonicalRoot = realpathSync.native 同口径）。
///
/// Windows 的 `canonicalize` 带 `\\?\` 扩展长度前缀：内部照用（比较时两边同口径即可），出门前经
/// `dunce::simplified` 还原——它只在能无歧义还原时才剥（保留名、尾点/空格、超 260 字符的照旧带前缀）。
/// `\\?\UNC\srv\share\…`（映射的网络盘 canonicalize 出来就是它）按同样条件还原成 `\\srv\share\…`，
/// 与 packages/runtime/src/lib/scoped.mjs::plainWinPath 一致。其它平台原样返回。
pub fn plain_path(p: &Path) -> PathBuf {
    let simple = dunce::simplified(p);
    #[cfg(windows)]
    if let Some(unc) = plain_unc(simple) {
        return unc;
    }
    simple.to_path_buf()
}

/// `\\?\UNC\srv\share\a\b` → `\\srv\share\a\b`；任一成分不能无歧义还原或超过 260 字符时 None（保持原样）。
#[cfg(windows)]
fn plain_unc(p: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Prefix;
    let mut comps = p.components();
    let Some(Component::Prefix(prefix)) = comps.next() else { return None };
    let Prefix::VerbatimUNC(server, share) = prefix.kind() else { return None };
    let ok = |n: &OsStr| !n.is_empty() && !is_bad_windows_name(n) && !n.to_string_lossy().contains(['/', '\\']);
    if !ok(server) || !ok(share) {
        return None;
    }
    let mut out = std::ffi::OsString::from(r"\\");
    out.push(server);
    out.push(r"\");
    out.push(share);
    for comp in comps {
        match comp {
            Component::RootDir => {}
            Component::Normal(n) if ok(n) => {
                out.push(r"\");
                out.push(n);
            }
            _ => return None,
        }
    }
    (out.encode_wide().count() <= 260).then(|| PathBuf::from(out))
}

/// 内部的文库根（canonical）与界面 / 设置传回来的字符串是否同一个根：两边都还原成普通形式再逐字比较
/// （同口径：界面拿到的就是 `plain_path`；存下的 `\\?\` 形式也认）。其它平台逐字比较。
pub fn same_root(internal: &Path, external: &str) -> bool {
    plain_path(internal).to_string_lossy() == plain_path(Path::new(external)).to_string_lossy()
}

/// 出证后的 canonical 绝对路径 → 相对 canonical 文库根的成分。这是**真名**：大小写变体、8.3 短名
/// （`OPENFI~1`）、库内目录链接都已被 canonicalize 还原——内部目录一类的名字检查必须跑在它上面。
pub(crate) fn rel_components_of(root_canon: &Path, abs: &Path) -> Result<Vec<String>, String> {
    let tail = abs
        .strip_prefix(root_canon)
        .map_err(|_| "路径越出文库范围".to_string())?;
    tail.components()
        .map(|c| match c {
            Component::Normal(s) => Ok(s.to_string_lossy().into_owned()),
            _ => Err("路径越出文库范围".to_string()),
        })
        .collect()
}

/// 写目标（可以还不存在）的规范库内成分，**只读不建**：父目录的最长已存在前缀交给 canonicalize
/// （大小写变体、8.3 短名、库内目录链接都还原成真名），其余成分与叶子原样接上（写是 rename 替换叶子，
/// 不跟随，所以叶子不解引用）。越界即 Err。用于「这次写落在哪个内部目录里」的判断。
pub(crate) fn canonical_write_rel(root: &Path, rel: &str) -> Result<Vec<String>, String> {
    let comps = rel_components(rel)?;
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("文库根不可访问: {e}"))?;
    let Some((leaf, parents)) = comps.split_last() else {
        return Ok(Vec::new());
    };
    let mut existing = root_canon.clone();
    let mut known = 0;
    for seg in parents {
        let candidate = existing.join(seg);
        if fs::symlink_metadata(&candidate).is_err() {
            break;
        }
        existing = candidate;
        known += 1;
    }
    let canon = existing
        .canonicalize()
        .map_err(|e| format!("路径不可访问: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err("路径越出文库范围".into());
    }
    let mut out = rel_components_of(&root_canon, &canon)?;
    out.extend(parents[known..].iter().map(|s| s.to_string_lossy().into_owned()));
    out.push(leaf.to_string_lossy().into_owned());
    Ok(out)
}

/// 把库内相对路径解析为绝对路径，并保证不越出文库根。
pub fn resolve_scoped(root: &Path, rel: &str) -> Result<PathBuf, String> {
    rel_components(rel)?;
    let rel_path = Path::new(rel);
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("文库根不可访问: {e}"))?;
    let joined = root_canon.join(rel_path);
    // canonicalize 同时解掉符号链接：链接指向库外时前缀检查会拒绝
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("路径不可访问: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err("路径越出文库范围".into());
    }
    Ok(canon)
}

/// 写入路径出证（可建缺失父目录）：从文库根开始逐段推进——已存在的段先
/// canonicalize 验证仍在根内（符号链接指向库外时，在创建任何东西**之前**拒绝），
/// 不存在的段此后才逐层 create_dir（父已出证 + 段是普通成分 ⇒ 新目录必在根内）。
/// 还原被删目录中的文件时用。
pub fn resolve_write_path_creating(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // 成分校验（含 Windows 非法名）在任何 create_dir 之前
    let comps = rel_components(rel)?;
    let Some((leaf, parents)) = comps.split_last() else {
        return Err("非法文件名".into());
    };
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("文库根不可访问: {e}"))?;
    let mut cur = root_canon.clone();
    for seg in parents {
        let candidate = cur.join(seg);
        let existed = if fs::symlink_metadata(&candidate).is_ok() {
            true
        } else {
            match fs::create_dir(&candidate) {
                Ok(()) => false,
                // 并发创建（app 与 MCP server 同时写）：让它走已存在分支复验
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => true,
                Err(e) => return Err(format!("创建目录失败: {e}")),
            }
        };
        if existed {
            let canon = candidate
                .canonicalize()
                .map_err(|e| format!("路径不可访问: {e}"))?;
            if !canon.starts_with(&root_canon) {
                return Err("路径越出文库范围".into());
            }
            if !canon.is_dir() {
                return Err("父路径不是目录".into());
            }
            cur = canon;
        } else {
            cur = candidate;
        }
    }
    Ok(cur.join(leaf))
}

/// 持久化原子写（字节）：同目录临时文件 → fsync 文件 → rename → fsync 父目录。
/// - rename 原子性保证 agent/监听器永远只见完整内容，且**替换**（而非跟随）
///   目标处的符号链接，叶子是外指链接也写不出去；
/// - 数据先 fsync 再 rename（macOS 上 sync_all = F_FULLFSYNC）：掉电/内核崩溃后
///   目标要么旧内容要么新内容，绝不空文件/半截；
/// - 父目录 fsync 让 rename 本身持久；Windows 打不开目录句柄，故尽力而为——
///   失败只缩不短崩溃窗口，不影响内容完整性；
/// - Windows 上目标被别的进程短暂占着时 rename 退避重试（`rename_retrying`）。
pub fn write_bytes_at(root: &Path, rel: &str, content: &[u8]) -> Result<(), String> {
    let target = resolve_write_path_creating(root, rel)?;
    let parent = target.parent().ok_or("非法路径")?;
    let tmp = parent.join(format!(
        ".openfile-tmp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let write_synced = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()
    };
    write_synced().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("写入失败: {e}")
    })?;
    rename_retrying(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("写入失败: {e}")
    })?;
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Windows 上目标文件被别的进程开着（杀毒、索引、OneDrive、编辑器）时 rename 报
/// os error 5 / 32 / 33（拒绝访问 / 共享冲突 / 锁冲突），通常几十毫秒内就放开：最多重试 5 次、
/// 退避 20ms·2^i（合计约 0.6 秒），仍失败才报错。与 packages/runtime/src/lib/scoped.mjs::renameRetrying 同参数。
/// 其它平台直接 rename。
fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0u32;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if cfg!(windows) && attempt < 5 && matches!(e.raw_os_error(), Some(5 | 32 | 33)) => {
                std::thread::sleep(std::time::Duration::from_millis(20u64 << attempt));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

pub fn write_text_at(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    write_bytes_at(root, rel, content.as_bytes())
}

#[derive(serde::Serialize, Debug)]
pub struct TextRead {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub encoding: String,
}

/// 读文本：utf-8 直读；否则 chardetng 嗅探（GBK 等中文编码常见于历史 txt）。
/// 二进制（前 8KB 含 NUL）返回 encoding = "binary"、内容为空，由前端决定降级视图。
pub fn read_text_at(path: &Path, max_bytes: u64) -> Result<TextRead, String> {
    let meta = fs::metadata(path).map_err(|e| format!("读取失败: {e}"))?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    let size = meta.len();
    let cap = max_bytes.min(size);
    let mut buf = Vec::with_capacity(cap as usize);
    let f = fs::File::open(path).map_err(|e| format!("打开失败: {e}"))?;
    f.take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败: {e}"))?;
    let truncated = size > buf.len() as u64;

    // UTF-16 BOM 先于 NUL 嗅探（UTF-16 的 ASCII 区间满是 NUL，会被误判二进制）
    if buf.len() >= 2 {
        let (enc, label) = match (buf[0], buf[1]) {
            (0xFF, 0xFE) => (Some(encoding_rs::UTF_16LE), "utf-16le"),
            (0xFE, 0xFF) => (Some(encoding_rs::UTF_16BE), "utf-16be"),
            _ => (None, ""),
        };
        if let Some(enc) = enc {
            let (cow, _, _) = enc.decode(&buf);
            let mut content = cow.into_owned();
            if content.starts_with('\u{FEFF}') {
                content.remove(0);
            }
            return Ok(TextRead {
                content,
                size,
                truncated,
                encoding: label.into(),
            });
        }
    }
    // UTF-8 BOM：剥掉，否则首行 \u{FEFF} 会让标题/围栏正则失配
    let body: &[u8] = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &buf[3..]
    } else {
        &buf
    };

    let sniff_len = body.len().min(8192);
    if body[..sniff_len].contains(&0) {
        return Ok(TextRead {
            content: String::new(),
            size,
            truncated,
            encoding: "binary".into(),
        });
    }

    match std::str::from_utf8(body) {
        Ok(s) => Ok(TextRead {
            content: s.to_string(),
            size,
            truncated,
            encoding: "utf-8".into(),
        }),
        Err(_) => {
            let mut det =
                chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
            det.feed(&buf, !truncated);
            let enc = det.guess(None, chardetng::Utf8Detection::Allow);
            let (cow, _, _) = enc.decode(&buf);
            Ok(TextRead {
                content: cow.into_owned(),
                size,
                truncated,
                encoding: enc.name().to_ascii_lowercase(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_links::{link_dir, link_file};
    use std::fs;

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("a.md"), "hello").unwrap();
        fs::write(dir.path().join("sub/b.md"), "world").unwrap();
        dir
    }

    /// 校验器本身是纯函数：全平台都跑（只是只在 Windows 上被启用）
    #[test]
    fn windows_name_validator_matches_js_rules() {
        for bad in [
            "a.md::$DATA", "a.md:secret", "C:x", "a?.md", "a|b.md", "a<b", "a>b", "a\"b", "a*b", "tab\there",
            "a.md.", "sub ", "...", "CON", "con", "Con.txt", "nul.tar.gz", "AUX", "prn.md", "COM1", "com0",
            "LPT9", "lpt1.txt", "COM¹", "lpt³.log", "conin$", "CONOUT$.txt",
        ] {
            assert!(is_bad_windows_name(OsStr::new(bad)), "{bad:?} 应判为 Windows 非法名");
        }
        for good in [
            "a.md", ".openfile", ".git", "console.md", "com10", "lpt", "contoso", "nul_", " lead.md", "a b.md",
            "中文.md", "~$doc.docx", "OPENFI~1", "a..b", "COM1x", "x.con",
        ] {
            assert!(!is_bad_windows_name(OsStr::new(good)), "{good:?} 应判为合法名");
        }
    }

    #[test]
    fn plain_path_and_same_root() {
        // 普通路径原样
        assert_eq!(plain_path(Path::new("/Users/a/lib")), PathBuf::from("/Users/a/lib"));
        let dir = setup();
        let canon = dir.path().canonicalize().unwrap();
        assert!(same_root(&canon, &canon.to_string_lossy()));
        assert!(same_root(&canon, &plain_path(&canon).to_string_lossy()));
        assert!(!same_root(&canon, "stale"));
        #[cfg(windows)]
        {
            assert_eq!(plain_path(Path::new(r"\\?\C:\Users\me\lib")), PathBuf::from(r"C:\Users\me\lib"));
            assert_eq!(plain_path(Path::new(r"\\?\UNC\srv\share\lib")), PathBuf::from(r"\\srv\share\lib"));
            assert_eq!(plain_path(Path::new(r"C:\Users\me\lib")), PathBuf::from(r"C:\Users\me\lib"));
            // 不能无歧义还原的保持原样（Win32 规范化会把尾点、保留名、正斜杠解读成别的东西）
            for keep in [r"\\?\C:\lib\a.", r"\\?\C:\lib\con", r"\\?\C:\lib\a/b", r"\\?\UNC\srv\share\nul", r"\\?\UNC\srv\share\x "] {
                assert_eq!(plain_path(Path::new(keep)), PathBuf::from(keep), "{keep}");
            }
            // canonicalize 带前缀，出门前还原；界面传回的普通形式与内部 canonical 是同一个根
            assert!(canon.to_string_lossy().starts_with(r"\\?\"));
            assert!(!plain_path(&canon).to_string_lossy().starts_with(r"\\?\"));
        }
    }

    #[test]
    fn canonical_write_rel_reports_real_names_without_side_effects() {
        let dir = setup();
        fs::create_dir(dir.path().join(".openfile")).unwrap();
        assert_eq!(canonical_write_rel(dir.path(), "./.openfile//tasks/t.md").unwrap(), [".openfile", "tasks", "t.md"]);
        assert_eq!(canonical_write_rel(dir.path(), "new/deeper/x.md").unwrap(), ["new", "deeper", "x.md"]);
        assert!(!dir.path().join("new").exists() && !dir.path().join(".openfile/notes").exists(), "只读不建");
        // 库内目录链接指回内部目录：报的是真名
        link_dir(&dir.path().join(".openfile"), &dir.path().join("cfg"));
        assert_eq!(canonical_write_rel(dir.path(), "cfg/tasks/t.md").unwrap(), [".openfile", "tasks", "t.md"]);
        // 越界与非法成分照旧拒绝
        let outside = tempfile::tempdir().unwrap();
        link_dir(outside.path(), &dir.path().join("out"));
        for bad in ["../x.md", "/etc/x", "out/x.md", "a\0b"] {
            assert!(canonical_write_rel(dir.path(), bad).is_err(), "{bad:?}");
        }
        #[cfg(windows)]
        {
            // 大小写变体还原成磁盘上的真名
            assert_eq!(canonical_write_rel(dir.path(), ".OPENFILE/tasks/t.md").unwrap(), [".openfile", "tasks", "t.md"]);
            if fs::symlink_metadata(dir.path().join("OPENFI~1")).is_ok() {
                assert_eq!(canonical_write_rel(dir.path(), "OPENFI~1/tasks/t.md").unwrap(), [".openfile", "tasks", "t.md"]);
            } else {
                eprintln!("skip: 卷上没有 8.3 短名，跳过短名别名断言");
            }
        }
    }

    /// 与 tests/scoped-windows.test.mjs 同一批攻击面（只在 Windows 上有意义：别处 `\`、`:` 是合法文件名字符）
    #[cfg(windows)]
    #[test]
    fn windows_backslash_traversal_has_zero_outside_side_effects() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("lib");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "x").unwrap();
        for rel in [r"..\x.md", r"sub\..\..\x.md", r"sub/..\..\made\y.md", r"sub\..\..\..\made"] {
            assert!(resolve_write_path_creating(&root, rel).is_err(), "{rel}");
            assert!(write_text_at(&root, rel, "pwn").is_err(), "{rel}");
            assert!(resolve_scoped(&root, rel).is_err(), "{rel}");
            assert!(canonical_write_rel(&root, rel).is_err(), "{rel}");
        }
        let outside: Vec<_> = fs::read_dir(base.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(outside, vec![std::ffi::OsString::from("lib")], "库外零副作用");
        // 反斜杠在库内照常是分隔符
        assert!(resolve_scoped(&root, r"sub\..").is_err());
        write_text_at(&root, r"sub\new\x.md", "ok").unwrap();
        assert_eq!(fs::read_to_string(root.join("sub").join("new").join("x.md")).unwrap(), "ok");
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_ads_reserved_and_trailing_names_are_illegal() {
        let dir = setup();
        fs::create_dir(dir.path().join(".openfile")).unwrap();
        for rel in [
            "C:x", r"C:\Windows", "c:/x", r"\Windows", "a.md::$DATA", "a.md:secret", "sub/a.md:x", "CON", "nul.txt",
            "sub/COM1/x.md", "lpt9", "conin$", "a.md.", "sub /x.md", "a?.md", "a|b.md", "sub/C:x", ".openfile::$DATA",
        ] {
            assert!(resolve_scoped(dir.path(), rel).is_err(), "{rel}");
            assert!(resolve_write_path_creating(dir.path(), rel).is_err(), "{rel}");
            assert!(write_text_at(dir.path(), rel, "pwn").is_err(), "{rel}");
        }
        let mut names: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, [".openfile", "a.md", "sub"]);
        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "hello");
        // 正常名字不受影响
        write_text_at(dir.path(), "sub/console.md", "ok").unwrap();
        assert!(resolve_scoped(dir.path(), "sub/console.md").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_variant_and_short_name_resolve_to_real_name() {
        let dir = setup();
        fs::create_dir(dir.path().join(".openfile")).unwrap();
        let real = resolve_scoped(dir.path(), ".OPENFILE").unwrap();
        assert_eq!(real.file_name().unwrap(), ".openfile", "canonicalize 给出磁盘上的真实大小写");
        match resolve_scoped(dir.path(), "OPENFI~1") {
            Ok(short) => assert_eq!(short.file_name().unwrap(), ".openfile"),
            Err(_) => eprintln!("skip: 卷上没有 8.3 短名，跳过短名别名断言"),
        }
    }

    /// 目标被别的进程以独占方式开着：rename 退避重试，放开后写入成功；一直不放就报错且不留临时文件
    #[cfg(windows)]
    #[test]
    fn windows_atomic_write_retries_while_target_is_locked() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = setup();
        let target = dir.path().join("a.md");
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(80));
            drop(lock);
        });
        write_text_at(dir.path(), "a.md", "新内容").unwrap();
        releaser.join().unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "新内容");

        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        assert!(write_text_at(dir.path(), "a.md", "丢了").is_err());
        drop(held);
        assert_eq!(fs::read_to_string(&target).unwrap(), "新内容");
        assert!(!fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(".openfile-tmp")));
    }

    #[test]
    fn resolves_inside_root() {
        let dir = setup();
        assert!(resolve_scoped(dir.path(), "a.md").is_ok());
        assert!(resolve_scoped(dir.path(), "sub/b.md").is_ok());
        assert!(resolve_scoped(dir.path(), "").is_ok());
    }

    #[test]
    fn rejects_traversal_and_absolute() {
        let dir = setup();
        assert!(resolve_scoped(dir.path(), "../x").is_err());
        assert!(resolve_scoped(dir.path(), "sub/../../x").is_err());
        assert!(resolve_scoped(dir.path(), "/etc/passwd").is_err());
        assert!(resolve_scoped(dir.path(), "a\0.md").is_err());
    }

    #[test]
    fn rejects_symlink_escape() {
        let dir = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "s").unwrap();
        link_dir(outside.path(), &dir.path().join("link"));
        assert!(resolve_scoped(dir.path(), "link/secret.txt").is_err());
        assert!(resolve_scoped(dir.path(), "link").is_err());
    }

    #[test]
    fn write_path_scoped_and_atomic() {
        let dir = setup();
        // 正常：覆盖已有 + 新建
        write_text_at(dir.path(), "a.md", "新内容").unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "新内容");
        write_text_at(dir.path(), "sub/new.md", "创建").unwrap();
        assert!(dir.path().join("sub/new.md").exists());
        // 越权一律拒绝
        assert!(write_text_at(dir.path(), "../evil.md", "x").is_err());
        assert!(write_text_at(dir.path(), "/etc/evil", "x").is_err());
        assert!(write_text_at(dir.path(), "sub/../../evil.md", "x").is_err());
        // 无临时文件残留
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".openfile-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn write_rejects_symlink_parent_escape() {
        let dir = setup();
        let outside = tempfile::tempdir().unwrap();
        link_dir(outside.path(), &dir.path().join("outlink"));
        assert!(write_text_at(dir.path(), "outlink/pwn.md", "x").is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn creating_write_builds_missing_parents_inside_root() {
        let dir = setup();
        write_text_at(dir.path(), ".openfile/notes/t1.md", "任务").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join(".openfile/notes/t1.md")).unwrap(),
            "任务"
        );
        // 越权变体照旧全灭
        assert!(write_text_at(dir.path(), "../new/evil.md", "x").is_err());
        assert!(write_text_at(dir.path(), "a\0/x.md", "x").is_err());
        assert!(resolve_write_path_creating(dir.path(), "").is_err());
    }

    #[test]
    fn creating_write_never_mkdirs_through_symlink() {
        // 攻击：outlink -> 库外；请求 outlink/a/b.md。
        // 修复前的"先 mkdir -p 再验证"会先在库外创建 a/ 才拒绝。
        let dir = setup();
        let outside = tempfile::tempdir().unwrap();
        link_dir(outside.path(), &dir.path().join("outlink"));
        assert!(write_text_at(dir.path(), "outlink/a/b.md", "x").is_err());
        assert!(
            !outside.path().join("a").exists(),
            "库外不得产生任何目录副作用"
        );
    }

    #[test]
    fn write_replaces_leaf_symlink_instead_of_following() {
        // 叶子本身是外指链接：rename 替换链接为普通文件，库外文件不被触碰
        let dir = setup();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "原始").unwrap();
        if link_file(&secret, &dir.path().join("leaf.md")) {
            write_text_at(dir.path(), "leaf.md", "新内容").unwrap();
            assert_eq!(fs::read_to_string(&secret).unwrap(), "原始");
            let meta = fs::symlink_metadata(dir.path().join("leaf.md")).unwrap();
            assert!(meta.is_file(), "叶子应被替换为普通文件");
            assert_eq!(
                fs::read_to_string(dir.path().join("leaf.md")).unwrap(),
                "新内容"
            );
        }
        // 叶子是外指的目录链接（Windows 上是联接）：写要么把链接本身替换成文件（Unix），要么失败
        // （Windows 不允许拿文件替换目录项）——无论哪种，库外目录不得多出任何东西，也不留临时文件
        link_dir(outside.path(), &dir.path().join("leafdir"));
        if write_text_at(dir.path(), "leafdir", "新内容").is_ok() {
            assert!(fs::symlink_metadata(dir.path().join("leafdir")).unwrap().is_file());
        }
        let outside_names: Vec<_> = fs::read_dir(outside.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(outside_names, vec![std::ffi::OsString::from("secret.txt")]);
        assert_eq!(fs::read_to_string(&secret).unwrap(), "原始");
        assert!(!fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(".openfile-tmp")));
    }

    #[test]
    fn creating_write_rejects_file_as_parent() {
        let dir = setup();
        // a.md 是文件，不能当目录穿过
        assert!(write_text_at(dir.path(), "a.md/x.md", "x").is_err());
    }

    #[test]
    fn reads_utf8_and_truncates() {
        let dir = setup();
        let p = dir.path().join("big.txt");
        fs::write(&p, "你好世界".repeat(100)).unwrap();
        let r = read_text_at(&p, 12).unwrap();
        assert!(r.truncated);
        assert_eq!(r.encoding, "utf-8");
        assert_eq!(r.content, "你好世界");
    }

    #[test]
    fn detects_gbk() {
        let dir = setup();
        let p = dir.path().join("gbk.txt");
        let (bytes, _, _) = encoding_rs::GBK.encode("中文编码测试，历史遗留文本。");
        fs::write(&p, &bytes).unwrap();
        let r = read_text_at(&p, 1 << 20).unwrap();
        assert!(r.content.contains("中文编码测试"));
        assert_ne!(r.encoding, "utf-8");
    }

    #[test]
    fn flags_binary() {
        let dir = setup();
        let p = dir.path().join("bin.dat");
        fs::write(&p, [0u8, 1, 2, 3]).unwrap();
        let r = read_text_at(&p, 1 << 20).unwrap();
        assert_eq!(r.encoding, "binary");
    }

    #[test]
    fn strips_utf8_bom_and_finds_first_heading() {
        let dir = setup();
        let p = dir.path().join("bom.md");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("# 标题\n正文".as_bytes());
        fs::write(&p, &bytes).unwrap();
        let r = read_text_at(&p, 1 << 20).unwrap();
        assert_eq!(r.encoding, "utf-8");
        // 首字符必须是 '#' 而非 \u{FEFF}，否则 TOC/围栏正则失配
        assert!(r.content.starts_with("# 标题"), "BOM 未剥离: {:?}", &r.content[..6.min(r.content.len())]);
    }

    #[test]
    fn shared_legacy_encoding_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/text-encodings.json")).unwrap();
        let dir = setup();
        for fixture in fixtures.as_array().unwrap() {
            let hex = fixture["hex"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
            let file = dir.path().join("encoded.txt");
            fs::write(&file, bytes).unwrap();
            let result = read_text_at(&file, 1 << 20).unwrap();
            assert_eq!(result.encoding, fixture["encoding"].as_str().unwrap(), "{}", fixture["name"]);
            assert_eq!(result.content, fixture["content"].as_str().unwrap(), "{}", fixture["name"]);
        }
    }

    // encoding_rs 的 UTF-16 是 decode-only，需手写字节
    fn to_utf16le(s: &str) -> Vec<u8> {
        let mut v = vec![0xFF, 0xFE]; // LE BOM
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }
    fn to_utf16be(s: &str) -> Vec<u8> {
        let mut v = vec![0xFE, 0xFF]; // BE BOM
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_be_bytes());
        }
        v
    }

    #[test]
    fn utf16le_decoded_not_binary() {
        let dir = setup();
        let p = dir.path().join("u16.txt");
        fs::write(&p, to_utf16le("Windows 记事本 Unicode 文本")).unwrap();
        let r = read_text_at(&p, 1 << 20).unwrap();
        assert_eq!(r.encoding, "utf-16le");
        assert!(r.content.contains("记事本"), "UTF-16 被误判: {:?}", r.encoding);
        assert!(!r.content.starts_with('\u{FEFF}'), "BOM 未剥离");
    }

    #[test]
    fn utf16be_decoded_not_binary() {
        let dir = setup();
        let p = dir.path().join("u16be.txt");
        fs::write(&p, to_utf16be("字符测试")).unwrap();
        let r = read_text_at(&p, 1 << 20).unwrap();
        assert_eq!(r.encoding, "utf-16be");
        assert!(r.content.contains("字符测试"));
    }
}
