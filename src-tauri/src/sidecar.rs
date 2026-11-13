//! 运行时 sidecar：桌面端的文库读写、索引、监听、快照、会话进程都在 Node 运行时
//! （packages/runtime/src/api/，`openfile serve --stdio`）。Rust 只拉起它、按 id 配对回包、把事件按窗口转发。
//!
//! 帧格式见 packages/runtime/src/api/stdio.ts 头注释。请求带 `ws` = 窗口 label；事件以 `rpc-event` 只发给那个窗口。
//! 进程死了（崩溃、被杀）：在途请求全部报错；下一次调用重新拉起，并把各窗口当时的文库重新打开（不写最近列表）。
//! 应用退出：合上 stdin（运行时关窗口、杀会话进程后自己退出），等不到就杀进程树。
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::procs::{login_env, read_lines_lossy, resolve_cmd};
use crate::scope::plain_path;

type Reply = Box<dyn FnOnce(Result<Value, String>) + Send>;
type Pending = Arc<Mutex<HashMap<u64, Reply>>>;

struct Conn {
    stdin: ChildStdin,
    child: Arc<Mutex<Child>>,
    pid: u32,
    alive: Arc<AtomicBool>,
    pending: Pending,
}

#[derive(Default)]
pub struct Sidecar {
    conn: Mutex<Option<Conn>>,
    next: AtomicU64,
    /// 第一次拉起时恢复主窗口的文库（OPENFILE_LIBRARY 优先，否则 settings 里上次的）；之后的重启改为重开各窗口的库
    booted: AtomicBool,
}

/// 运行时入口：安装包资源里打好的 openfile 命令（src-tauri/build.rs 每次构建都重新打包）
pub(crate) fn cli_entry(app: &AppHandle) -> Result<PathBuf, String> {
    let cli = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources/openfile-cli/cli.mjs");
    if !cli.is_file() {
        return Err("安装包缺少 Openfile 运行时（resources/openfile-cli）".into());
    }
    Ok(cli)
}

/// Node：安装包自带的（externalBin，放在主程序旁边）优先，否则登录 shell 的 PATH 上的
pub(crate) fn node_binary() -> Result<PathBuf, String> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let bundled = dir.join(exe);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    resolve_cmd("node", login_env()).ok_or_else(|| "找不到 Node.js（需要 22.18 以上）".into())
}

/// 安装包自带的 git（dugite-native，快照引擎）所在目录；没带就由运行时用 PATH 上的 git。
/// 只传目录：配套的 GIT_EXEC_PATH 等由运行时只在拉 git 时设（packages/runtime/src/lib/git-bin.mjs）
/// 应用数据目录（快照、会话档案）：建好后按库根规则规范化再交给运行时
fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    crate::scope::resolve_scoped(&path, "")
}

fn bundled_git_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("resources/git");
    let bin = if cfg!(windows) { dir.join("cmd/git.exe") } else { dir.join("bin/git") };
    bin.is_file().then_some(dir)
}

fn fail_all(pending: &Pending, msg: &str) {
    let drained: Vec<Reply> = pending.lock().unwrap().drain().map(|(_, r)| r).collect();
    for r in drained {
        r(Err(msg.to_string()));
    }
}

fn spawn_conn(app: &AppHandle) -> Result<Conn, String> {
    let cli = cli_entry(app)?;
    let node = node_binary()?;
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let app_data = app_data(app)?;
    let s = |p: &Path| plain_path(p).to_string_lossy().into_owned();
    let mut cmd = Command::new(&node);
    cmd.arg(s(&cli))
        .args(["serve", "--stdio", "--settings"])
        .arg(s(&config.join("settings.json")))
        .arg("--app-data")
        .arg(s(&app_data))
        .envs(login_env())
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(git) = bundled_git_dir(app) {
        cmd.env("OPENFILE_GIT_DIR", s(&git));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::procs::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("运行时启动失败（{}）：{e}", node.display()))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("无法接管运行时 stdin")?;
    let stdout = child.stdout.take().ok_or("无法接管运行时 stdout")?;
    let stderr = child.stderr.take().ok_or("无法接管运行时 stderr")?;
    let child = Arc::new(Mutex::new(child));
    let alive = Arc::new(AtomicBool::new(true));
    let pending: Pending = Arc::default();

    std::thread::spawn(move || read_lines_lossy(stderr, |line| eprintln!("[runtime] {line}")));
    {
        let app = app.clone();
        let alive = Arc::clone(&alive);
        let pending = Arc::clone(&pending);
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            read_lines_lossy(stdout, |line| dispatch(&app, &pending, &line));
            alive.store(false, Ordering::SeqCst);
            let _ = child.lock().unwrap().wait();
            fail_all(&pending, "Openfile 运行时已退出，请重试");
        });
    }
    Ok(Conn { stdin, child, pid, alive, pending })
}

/// 一帧：有 id 的是回包，method = "event" 的是事件（按 params.ws 发给那个窗口）
fn dispatch(app: &AppHandle, pending: &Pending, line: &str) {
    let Ok(mut frame) = serde_json::from_str::<Value>(line) else {
        eprintln!("[runtime] 非 JSON 帧：{}", line.chars().take(200).collect::<String>());
        return;
    };
    if let Some(id) = frame.get("id").and_then(Value::as_u64) {
        let Some(reply) = pending.lock().unwrap().remove(&id) else { return };
        match frame.get_mut("error") {
            Some(err) => reply(Err(err.get("message").and_then(Value::as_str).unwrap_or("运行时错误").to_string())),
            None => reply(Ok(frame.get_mut("result").map(Value::take).unwrap_or(Value::Null))),
        }
        return;
    }
    if frame.get("method").and_then(Value::as_str) == Some("event") {
        let params = frame.get_mut("params").map(Value::take).unwrap_or(Value::Null);
        if let Some(ws) = params.get("ws").and_then(Value::as_str) {
            let _ = app.emit_to(ws, "rpc-event", &params);
        }
    }
}

impl Sidecar {
    /// 发一个请求；reply 在读线程里回调（不能在里面再同步调用 sidecar）
    fn send(&self, app: &AppHandle, method: &str, params: Value, reply: Reply) -> Result<(), String> {
        let mut guard = self.conn.lock().unwrap();
        if !guard.as_ref().is_some_and(|c| c.alive.load(Ordering::SeqCst)) {
            let mut conn = spawn_conn(app)?;
            self.restore(app, &mut conn);
            *guard = Some(conn);
        }
        let conn = guard.as_mut().unwrap();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        conn.pending.lock().unwrap().insert(id, reply);
        if let Err(e) = write_frame(&mut conn.stdin, id, method, params) {
            conn.pending.lock().unwrap().remove(&id);
            return Err(format!("写入运行时失败：{e}"));
        }
        Ok(())
    }

    /// 刚拉起的进程：先把文库挂上，再放行别的请求（同一把锁里写进 stdin，运行时按顺序处理）
    fn restore(&self, app: &AppHandle, conn: &mut Conn) {
        let mut opens: Vec<(String, &'static str, Value)> = Vec::new();
        if !self.booted.swap(true, Ordering::SeqCst) {
            match std::env::var("OPENFILE_LIBRARY") {
                // e2e / 无头验证：临时挂载，不写进用户设置
                Ok(p) if Path::new(&p).is_dir() => opens.push(("main".into(), "library.open", json!({ "path": p, "persist": false }))),
                _ => opens.push(("main".into(), "library.restore", json!({}))),
            }
        } else {
            for (ws, root) in app.state::<crate::workspaces::Workspaces>().all() {
                opens.push((ws, "library.open", json!({ "path": plain_path(&root), "persist": false })));
            }
        }
        for (ws, method, mut params) in opens {
            params["ws"] = json!(ws);
            let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
            let app2 = app.clone();
            let reply: Reply = Box::new(move |r| crate::workspaces::sync(&app2, &ws, r.as_ref().ok().unwrap_or(&Value::Null)));
            conn.pending.lock().unwrap().insert(id, reply);
            if write_frame(&mut conn.stdin, id, method, params).is_err() {
                conn.pending.lock().unwrap().remove(&id);
            }
        }
    }

    /// 同步调用（阻塞到回包）：只在阻塞线程池里用
    pub fn call(&self, app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.send(app, method, params, Box::new(move |r| {
            let _ = tx.send(r);
        }))?;
        rx.recv().map_err(|_| "Openfile 运行时已退出，请重试".to_string())?
    }

    /// 不等回包（关窗通知之类）
    pub fn notify(&self, app: &AppHandle, method: &str, params: Value) {
        if let Err(e) = self.send(app, method, params, Box::new(|_| {})) {
            eprintln!("[openfile] {method} 未送达：{e}");
        }
    }

    /// 应用退出：合上 stdin 等它自己收尾，2 秒不退就杀进程树
    pub fn shutdown(&self) {
        let Some(conn) = self.conn.lock().unwrap().take() else { return };
        let Conn { stdin, child, pid, alive, .. } = conn;
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(2);
        while alive.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if alive.load(Ordering::SeqCst) {
            #[cfg(windows)]
            crate::procs::kill_tree(pid);
            #[cfg(not(windows))]
            let _ = pid;
            if let Ok(mut c) = child.try_lock() {
                let _ = c.kill();
            }
        }
    }
}

fn write_frame(stdin: &mut ChildStdin, id: u64, method: &str, params: Value) -> std::io::Result<()> {
    let mut line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes())?;
    stdin.flush()
}

/// 只有 Rust 能调的方法（前端调不到）：给库外目录打快照等
const INTERNAL_PREFIX: &str = "internal.";

/// 前端的唯一后端入口：方法名 + 参数，`ws` 由 Rust 按调用窗口填（前端不能冒充别的窗口）
#[tauri::command]
pub async fn rpc_call(app: AppHandle, window: tauri::WebviewWindow, method: String, params: Option<Value>) -> Result<Value, String> {
    if method.starts_with(INTERNAL_PREFIX) || method == "library.closeWindow" {
        return Err(format!("未知方法：{method}"));
    }
    let ws = window.label().to_string();
    let mut params = params.unwrap_or_else(|| json!({}));
    let Some(obj) = params.as_object_mut() else { return Err("参数必须是对象".into()) };
    obj.insert("ws".into(), json!(ws));
    tauri::async_runtime::spawn_blocking(move || {
        let result = app.state::<Sidecar>().call(&app, &method, params)?;
        if method == "library.get" || method == "library.open" {
            crate::workspaces::sync(&app, &ws, &result);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
