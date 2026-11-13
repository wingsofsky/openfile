//! 宿主进程的环境与子进程工具（会话进程由运行时 sidecar 拉起，这里是 sidecar 要用的）：
//! 登录 shell 环境（打包 .app 的 PATH 不含 homebrew/nvm——Zed 同款解法；Windows 直接用当前进程环境）、
//! 按 PATH 解析命令、容错按行读输出、Windows 杀进程树。子进程一律 CREATE_NO_WINDOW。

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
#[cfg(windows)]
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Windows：GUI 进程拉起控制台程序会弹出控制台窗口——除非本意就是开窗口，一律带上它
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 登录 shell 环境（一次捕获，进程级缓存）。打包 GUI app 只有
/// `/usr/bin:/bin:/usr/sbin:/sbin`，用户的 node/npx/claude 都在
/// homebrew/nvm/volta 路径里——跑一次 `$SHELL -lc env` 把真实 PATH 取回来。
/// 失败时退回当前进程环境（dev 模式从终端启动，本来就是全的）。
/// Windows 没有「登录 shell」：GUI 进程从资源管理器继承的就是完整的用户环境（PATH 含 nodejs、
/// %APPDATA%\npm），也绝不在这里拉控制台程序——直接用当前进程环境。
pub(crate) fn login_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        // 非 UTF-8 的变量跳过（std::env::vars 碰到会 panic）；子进程照样从父进程继承它们
        #[allow(unused_mut)]
        let mut map: HashMap<String, String> = std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect();
        #[cfg(not(windows))]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            if let Ok(out) = Command::new(&shell).args(["-lc", "command env"]).output() {
                if out.status.success() {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        if let Some((k, v)) = line.split_once('=') {
                            // 只认合法变量名的行：跳过多行值的续行与 shell 启动噪声
                            if !k.is_empty()
                                && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                            {
                                map.insert(k.to_string(), v.to_string());
                            }
                        }
                    }
                }
            }
        }
        map
    })
}

/// 环境表里的变量。Windows 的变量名不分大小写（系统里 PATH 通常叫 `Path`）。
fn env_var<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a String> {
    if cfg!(windows) {
        env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
    } else {
        env.get(key)
    }
}

/// 环境表里的 PATH（Windows 上大小写不敏感地找）；表里没有再退回当前进程环境。
pub(crate) fn env_path(env: &HashMap<String, String>) -> Option<OsString> {
    env_var(env, "PATH").map(OsString::from).or_else(|| std::env::var_os("PATH"))
}

/// 按登录环境的 PATH 解析命令；带路径分隔符的按字面路径。
///
/// Windows：`/` 与 `\` 都是分隔符（带盘符 / 根的也按字面）；只认可执行扩展名——先 `.exe`，再按
/// PATHEXT 的顺序取 CreateProcess 能直接拉起的 `.com` 与 Rust 会经 cmd 安全转义拉起的 `.bat`/`.cmd`
/// （PATHEXT 里的 .js/.vbs 一类要靠文件关联，拉不起来）；**绝不选无扩展名的文件**
/// （`C:\Program Files\nodejs\npx` 是给 Git Bash 的 sh 脚本，拉起报 os error 193）。
pub(crate) fn resolve_cmd(cmd: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    if cmd.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        resolve_cmd_windows(cmd, env)
    }
    #[cfg(not(windows))]
    {
        if cmd.contains('/') {
            let p = PathBuf::from(cmd);
            return p.is_file().then_some(p);
        }
        let path_var = env_path(env)?;
        for dir in std::env::split_paths(&path_var) {
            let cand = dir.join(cmd);
            if cand.is_file() {
                return Some(cand);
            }
        }
        None
    }
}

#[cfg(windows)]
fn resolve_cmd_windows(cmd: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    use std::path::Component;
    let exts = windows_exec_exts(env);
    let p = Path::new(cmd);
    if cmd.contains(['/', '\\']) || p.has_root() || matches!(p.components().next(), Some(Component::Prefix(_))) {
        return with_exec_ext(p, &exts);
    }
    let path_var = env_path(env)?;
    std::env::split_paths(&path_var)
        .filter(|dir| !dir.as_os_str().is_empty()) // 空段 = 当前目录：不搜
        .find_map(|dir| with_exec_ext(&dir.join(cmd), &exts))
}

/// `.exe` 打头，其后按 PATHEXT 的顺序，只留拉得起来的 `.com` `.bat` `.cmd`
#[cfg(windows)]
fn windows_exec_exts(env: &HashMap<String, String>) -> Vec<String> {
    let pathext = env_var(env, "PATHEXT")
        .cloned()
        .or_else(|| std::env::var("PATHEXT").ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    let mut out = vec![".exe".to_string()];
    for ext in pathext.split(';').map(|e| e.trim().to_ascii_lowercase()) {
        if matches!(ext.as_str(), ".com" | ".bat" | ".cmd") && !out.contains(&ext) {
            out.push(ext);
        }
    }
    out
}

/// base 自带可执行扩展名就只认它本身；否则依次补扩展名。无扩展名的文件永不入选。
#[cfg(windows)]
fn with_exec_ext(base: &Path, exts: &[String]) -> Option<PathBuf> {
    let own = base.extension().map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()));
    if own.as_ref().is_some_and(|e| exts.contains(e)) {
        return base.is_file().then(|| base.to_path_buf());
    }
    exts.iter().find_map(|ext| {
        let mut s = base.as_os_str().to_owned();
        s.push(ext);
        let cand = PathBuf::from(s);
        cand.is_file().then_some(cand)
    })
}

/// 按行读子进程输出，**容忍非 UTF-8**：逐行 from_utf8_lossy（中文 Windows 上原生程序常吐 GBK），
/// 只有 EOF / 读错才停。`BufRead::lines()` 遇到第一行坏字节就报错——拿它 break / map_while 会让
/// 管道没人读，子进程写满就卡死。行尾的 `\n` / `\r\n` 去掉（与 lines() 一致）。
pub(crate) fn read_lines_lossy(reader: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                    if buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                }
                f(String::from_utf8_lossy(&buf).into_owned());
            }
        }
    }
}

/// Windows：结束整棵进程树。taskkill 用 System32 里的绝对路径
/// （不按 PATH / 当前目录找），CREATE_NO_WINDOW 不弹窗；阻塞到 taskkill 退出。
#[cfg(windows)]
pub(crate) fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let _ = Command::new(system_root.join("System32").join("taskkill.exe"))
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn resolve_cmd_absolute_and_path() {
        let env = login_env();
        // 字面路径
        assert!(resolve_cmd("/bin/cat", env).is_some());
        assert!(resolve_cmd("/bin/绝不存在的命令", env).is_none());
        // PATH 查找：sh 在任何 Unix 的 PATH 里
        assert!(resolve_cmd("sh", env).is_some());
        assert!(resolve_cmd("绝不存在的命令xyz", env).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn resolve_cmd_windows_semantics() {
        use std::fs;
        let env = login_env();
        let system32 = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into())).join("System32");
        let cmd_exe = system32.join("cmd.exe");
        // 字面路径：带不带扩展名都行，正斜杠同样是分隔符
        assert_eq!(resolve_cmd(&cmd_exe.to_string_lossy(), env), Some(cmd_exe.clone()));
        assert_eq!(resolve_cmd(&system32.join("cmd").to_string_lossy(), env), Some(cmd_exe.clone()));
        assert!(resolve_cmd(&cmd_exe.to_string_lossy().replace('\\', "/"), env).is_some());
        assert!(resolve_cmd(r"C:\绝不存在\x.exe", env).is_none());
        // PATH 查找补扩展名
        let found = resolve_cmd("cmd", env).expect("cmd.exe 在 PATH 上");
        assert!(found.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")), "{found:?}");
        assert!(resolve_cmd("绝不存在的命令xyz", env).is_none());
        assert!(resolve_cmd("", env).is_none());

        // 合成 PATH：无扩展名（sh 脚本）永不入选；.exe 先于 .cmd；PATHEXT 里的 .js 不选；变量名大小写不计
        let dir = tempfile::tempdir().unwrap();
        for name in ["tool", "tool.cmd", "only-sh", "both.cmd", "both.exe", "scr.js", "legacy.bat"] {
            fs::write(dir.path().join(name), "").unwrap();
        }
        let mut fake = HashMap::new();
        fake.insert("Path".to_string(), dir.path().to_string_lossy().into_owned());
        fake.insert("PathExt".to_string(), ".COM;.EXE;.BAT;.CMD;.VBS;.JS".to_string());
        assert_eq!(resolve_cmd("tool", &fake), Some(dir.path().join("tool.cmd")));
        assert_eq!(resolve_cmd("only-sh", &fake), None);
        assert_eq!(resolve_cmd("both", &fake), Some(dir.path().join("both.exe")));
        assert_eq!(resolve_cmd("scr", &fake), None);
        assert_eq!(resolve_cmd("legacy", &fake), Some(dir.path().join("legacy.bat")));
        assert_eq!(resolve_cmd("tool.cmd", &fake), Some(dir.path().join("tool.cmd")));
        // 字面路径里的反斜杠也是分隔符，同样不选无扩展名的
        assert_eq!(resolve_cmd(&format!("{}\\tool", dir.path().display()), &fake), Some(dir.path().join("tool.cmd")));
        assert_eq!(resolve_cmd(&format!("{}\\only-sh", dir.path().display()), &fake), None);
    }

    #[test]
    fn login_env_has_path() {
        // 捕获失败也必须兜回当前环境——PATH 永远在（Windows 上变量名叫 Path，按大小写不敏感找）
        assert!(env_path(login_env()).is_some());
        #[cfg(unix)]
        assert!(login_env().contains_key("PATH"));
    }

    #[test]
    fn lines_are_read_lossily_to_the_end() {
        // 第二行是 GBK（「中文」）：lines() 会在这里报错、读取停下，后面的行与管道就没人管了
        let bytes: &[u8] = b"first\r\n\xd6\xd0\xce\xc4 gbk\nthird\n\nlast-no-newline";
        let mut lines = Vec::new();
        read_lines_lossy(bytes, |l| lines.push(l));
        assert_eq!(lines.len(), 5, "{lines:?}");
        assert_eq!(lines[0], "first");
        assert!(lines[1].ends_with(" gbk") && lines[1].contains('\u{FFFD}'), "{:?}", lines[1]);
        assert_eq!(lines[2..], ["third", "", "last-no-newline"]);
    }

    /// 结束会话要收整棵树：子进程再拉一个孙进程，杀子进程树后孙进程也必须不在了
    #[cfg(windows)]
    #[test]
    fn kill_tree_takes_grandchildren() {
        use std::os::windows::process::CommandExt;
        let node = resolve_cmd("node", login_env()).expect("node.exe");
        let script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
        let mut child = Command::new(node)
            .args(["-e", script])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let grandchild: u32 = line.trim().parse().expect("孙进程 pid");
        assert!(alive(grandchild));
        kill_tree(child.id());
        let _ = child.wait();
        let gone = (0..50).any(|_| {
            if alive(grandchild) {
                std::thread::sleep(std::time::Duration::from_millis(100));
                false
            } else {
                true
            }
        });
        assert!(gone, "孙进程 {grandchild} 必须随进程树一起结束");
    }

    #[cfg(windows)]
    fn alive(pid: u32) -> bool {
        let mut sys = sysinfo::System::new();
        let pid = sysinfo::Pid::from_u32(pid);
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        sys.process(pid).is_some()
    }
}
