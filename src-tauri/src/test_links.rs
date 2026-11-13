//! 测试用链接（仅 cfg(test)）：让符号链接类安全测试在 Windows 上照样跑，而不是被 cfg(unix) 门控掉。
//!
//! - Unix：普通符号链接。
//! - Windows：目录先试符号链接（要开发者模式或管理员），建不出来退回 NTFS 目录联接
//!   （junction，`mklink /J`，无需特权）。Rust 的 `FileType::is_symlink()` 对联接同样为真、
//!   `canonicalize` 同样解开它，所以出证代码走的是与符号链接同一条路径。
//! - 文件链接在 Windows 上没有无特权的替代品：建不出来（os error 1314）时 `link_file` 返回 false，
//!   调用方只跳过**依赖文件链接**的那几条断言，测试其余部分照跑。
use std::path::Path;

/// 目录链接 `link -> target`：一定要建出来，建不出来让测试失败（不悄悄跳过）。
pub(crate) fn link_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link)
        .unwrap_or_else(|e| panic!("symlink {} -> {}: {e}", link.display(), target.display()));
    #[cfg(windows)]
    {
        // mklink 不认 `\\?\` 前缀，还会把路径里的 `/` 当成开关：两端都还原成普通形式并统一成 `\`
        // （测试路径都是可还原的本地绝对路径）。符号链接目标按原样存，同样先规范。
        let norm = |p: &Path| std::path::PathBuf::from(dunce::simplified(p).to_string_lossy().replace('/', "\\"));
        let (target, link) = (norm(target), norm(link));
        if std::os::windows::fs::symlink_dir(&target, &link).is_ok() {
            return;
        }
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&target)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdout(std::process::Stdio::null())
            .status()
            .expect("cmd /C mklink /J");
        assert!(status.success(), "mklink /J {} {} 失败", link.display(), target.display());
        assert!(
            std::fs::symlink_metadata(&link).map(|m| m.file_type().is_symlink()).unwrap_or(false),
            "联接 {} 没有被识别为链接",
            link.display()
        );
    }
}

/// 文件链接 `link -> target`（target 可以是相对路径、可以悬空）。建出来返回 true；
/// Windows 未开开发者模式时（os error 1314）返回 false 并打印跳过原因；其它错误直接失败。
#[must_use]
pub(crate) fn link_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    return match std::os::unix::fs::symlink(target, link) {
        Ok(()) => true,
        Err(e) => panic!("symlink {} -> {}: {e}", link.display(), target.display()),
    };
    #[cfg(windows)]
    let norm = |p: &Path| std::path::PathBuf::from(dunce::simplified(p).to_string_lossy().replace('/', "\\"));
    #[cfg(windows)]
    return match std::os::windows::fs::symlink_file(norm(target), norm(link)) {
        Ok(()) => true,
        Err(e) if e.raw_os_error() == Some(1314) => {
            eprintln!(
                "skip: 文件符号链接 {} 需要开发者模式或管理员权限（os error 1314），跳过依赖文件链接的断言",
                link.display()
            );
            false
        }
        Err(e) => panic!("symlink_file {} -> {}: {e}", link.display(), target.display()),
    };
}
