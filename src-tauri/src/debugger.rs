use crate::toolchain::{build_path_with_mingw, resolve_base_dir, resolve_tool};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Deserialize)]
pub struct DebugBreakpointSpec {
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct StackFrame {
    pub level: usize,
    pub func: String,
    pub file: String,
    pub line: usize,
    pub addr: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugVariable {
    pub name: String,
    pub var_type: String,
    pub value: String,
    pub address: Option<String>,
    pub is_pointer: bool,
    pub points_to_addr: Option<String>,
    pub deref_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugSnapshot {
    pub reason: String,
    pub file: String,
    pub line: usize,
    pub func: String,
    pub frames: Vec<StackFrame>,
    pub variables: Vec<DebugVariable>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugOutputEvent {
    pub stream: String, // "target" | "console" | "log"
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugExitEvent {
    pub reason: String,
}

enum DebugCommand {
    Continue,
    StepInto,
    StepOver,
    StepOut,
    Evaluate {
        expr: String,
        reply: Sender<Result<String, String>>,
    },
    Stop,
}

enum LoopMsg {
    MiLine(String),
    Cmd(DebugCommand),
    Eof,
}

struct ActiveDebugSession {
    pid: u32,
    tx: Sender<LoopMsg>,
}

#[derive(Default)]
pub struct DebuggerState {
    active: Arc<Mutex<Option<ActiveDebugSession>>>,
}

// ===================== MI2 RECURSIVE-DESCENT PARSER =====================
#[derive(Debug, Clone, PartialEq, Eq)]
enum MiVal {
    Str(String),
    Tuple(Vec<(String, MiVal)>),
    List(Vec<MiVal>),
}

impl MiVal {
    fn as_str(&self) -> Option<&str> {
        match self {
            MiVal::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_tuple(&self) -> Option<&[(String, MiVal)]> {
        match self {
            MiVal::Tuple(pairs) => Some(pairs.as_slice()),
            _ => None,
        }
    }

    fn as_list(&self) -> Option<&[MiVal]> {
        match self {
            MiVal::List(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    fn get(&self, key: &str) -> Option<&MiVal> {
        self.as_tuple()?
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key)?.as_str()
    }
}

struct MiParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> MiParser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            bytes: input.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if b.is_ascii_whitespace() {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_c_string(&mut self) -> Option<String> {
        if self.peek() != Some(b'"') {
            return None;
        }
        self.pos += 1;
        let mut out = String::new();
        while let Some(b) = self.peek() {
            self.pos += 1;
            match b {
                b'"' => return Some(out),
                b'\\' => {
                    let Some(esc) = self.peek() else { break };
                    self.pos += 1;
                    match esc {
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        other => out.push(other as char),
                    }
                }
                other => out.push(other as char),
            }
        }
        Some(out)
    }

    fn parse_key(&mut self) -> Option<String> {
        self.skip_ws();
        let start = self.pos;
        while let Some(b) = self.peek() {
            if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos > start {
            Some(String::from_utf8_lossy(&self.bytes[start..self.pos]).into_owned())
        } else {
            None
        }
    }

    fn parse_value(&mut self) -> Option<MiVal> {
        self.skip_ws();
        match self.peek()? {
            b'"' => self.parse_c_string().map(MiVal::Str),
            b'{' => {
                self.pos += 1;
                let mut pairs = Vec::new();
                loop {
                    self.skip_ws();
                    if self.peek() == Some(b'}') {
                        self.pos += 1;
                        break;
                    }
                    let Some(k) = self.parse_key() else {
                        break;
                    };
                    if self.peek() == Some(b'=') {
                        self.pos += 1;
                    }
                    if let Some(v) = self.parse_value() {
                        pairs.push((k, v));
                    }
                    self.skip_ws();
                    if self.peek() == Some(b',') {
                        self.pos += 1;
                    }
                }
                Some(MiVal::Tuple(pairs))
            }
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_ws();
                    if self.peek() == Some(b']') {
                        self.pos += 1;
                        break;
                    }
                    let saved = self.pos;
                    if let Some(k) = self.parse_key() {
                        if self.peek() == Some(b'=') {
                            self.pos += 1;
                            if let Some(v) = self.parse_value() {
                                items.push(MiVal::Tuple(vec![(k, v)]));
                            }
                        } else {
                            self.pos = saved;
                            if let Some(v) = self.parse_value() {
                                items.push(v);
                            } else {
                                break;
                            }
                        }
                    } else if let Some(v) = self.parse_value() {
                        items.push(v);
                    } else {
                        break;
                    }
                    self.skip_ws();
                    if self.peek() == Some(b',') {
                        self.pos += 1;
                    }
                }
                Some(MiVal::List(items))
            }
            _ => None,
        }
    }

    fn parse_kv_pairs(&mut self) -> MiVal {
        let mut pairs = Vec::new();
        loop {
            self.skip_ws();
            if self.peek() == Some(b',') {
                self.pos += 1;
                self.skip_ws();
            }
            let Some(k) = self.parse_key() else {
                break;
            };
            if self.peek() != Some(b'=') {
                break;
            }
            self.pos += 1;
            if let Some(v) = self.parse_value() {
                pairs.push((k, v));
            }
        }
        MiVal::Tuple(pairs)
    }
}

fn parse_mi_kv(payload: &str) -> MiVal {
    let mut parser = MiParser::new(payload);
    parser.parse_kv_pairs()
}

fn unescape_mi_stream(line: &str) -> Option<String> {
    let mut parser = MiParser::new(line);
    parser.parse_c_string()
}

/// Extracts and normalizes a hexadecimal address like `0x000000000061fe1c` -> `0x61fe1c`.
pub fn extract_hex_address(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let idx = trimmed.find("0x").or_else(|| trimmed.find("0X"))?;
    let hex_slice = &trimmed[idx + 2..];
    let hex_digits: String = hex_slice
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .collect();
    if hex_digits.is_empty() {
        return None;
    }
    let normalized = hex_digits.trim_start_matches('0');
    if normalized.is_empty() {
        Some("0x0".to_string())
    } else {
        Some(format!("0x{}", normalized.to_ascii_lowercase()))
    }
}

fn terminate_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

fn stop_existing_session(active: &Arc<Mutex<Option<ActiveDebugSession>>>) {
    let existing = {
        let mut guard = active.lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    if let Some(sess) = existing {
        let _ = sess.tx.send(LoopMsg::Cmd(DebugCommand::Stop));
        thread::sleep(Duration::from_millis(80));
        terminate_pid_tree(sess.pid);
    }
}

fn split_token_and_rest(line: &str) -> (Option<u64>, &str) {
    let digits_len = line.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits_len == 0 {
        return (None, line);
    }
    let token = line[..digits_len].parse::<u64>().ok();
    (token, &line[digits_len..])
}

// ===================== COORDINATOR HELPER =====================
struct GdbController {
    app: AppHandle,
    stdin: ChildStdin,
    rx: Receiver<LoopMsg>,
    pending: VecDeque<LoopMsg>,
    next_token: u64,
    exited: bool,
}

impl GdbController {
    fn new(app: AppHandle, stdin: ChildStdin, rx: Receiver<LoopMsg>) -> Self {
        Self {
            app,
            stdin,
            rx,
            pending: VecDeque::new(),
            next_token: 100,
            exited: false,
        }
    }

    fn write_mi(&mut self, token: u64, cmd: &str) -> Result<(), String> {
        let full = format!("{}{}\n", token, cmd);
        self.stdin
            .write_all(full.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("Falha ao enviar comando GDB: {}", e))
    }

    fn send_and_wait(&mut self, cmd: &str) -> Result<String, String> {
        let token = self.next_token;
        self.next_token += 1;
        self.write_mi(token, cmd)?;

        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        while std::time::Instant::now() < deadline {
            let msg = match self.rx.recv_timeout(Duration::from_millis(250)) {
                Ok(m) => m,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.exited = true;
                    return Err("Conexão com gdb.exe encerrada.".to_string());
                }
            };

            match msg {
                LoopMsg::MiLine(line) => {
                    let (line_tok, rest) = split_token_and_rest(&line);
                    if line_tok == Some(token) {
                        if let Some(payload) = rest.strip_prefix("^done") {
                            return Ok(payload.to_string());
                        }
                        if let Some(payload) = rest.strip_prefix("^running") {
                            return Ok(payload.to_string());
                        }
                        if let Some(payload) = rest.strip_prefix("^exit") {
                            self.exited = true;
                            return Ok(payload.to_string());
                        }
                        if let Some(payload) = rest.strip_prefix("^error") {
                            let kv = parse_mi_kv(payload);
                            let err_msg = kv
                                .get_str("msg")
                                .unwrap_or("Erro retornado pelo GDB")
                                .to_string();
                            return Err(err_msg);
                        }
                    } else {
                        self.pending.push_back(LoopMsg::MiLine(line));
                    }
                }
                LoopMsg::Cmd(DebugCommand::Stop) => {
                    self.exited = true;
                    let _ = self.stdin.write_all(b"-gdb-exit\n");
                    let _ = self.stdin.flush();
                    return Err("Sessão encerrada pelo usuário.".to_string());
                }
                other => {
                    self.pending.push_back(other);
                }
            }
        }
        Err(format!("Timeout aguardando resposta do GDB para '{}'", cmd))
    }

    fn eval_expr(&mut self, expr: &str) -> Option<String> {
        let escaped = expr.replace('\\', "\\\\").replace('"', "\\\"");
        let cmd = format!("-data-evaluate-expression \"{}\"", escaped);
        let payload = self.send_and_wait(&cmd).ok()?;
        let kv = parse_mi_kv(&payload);
        kv.get_str("value").map(|s| s.to_string())
    }

    fn query_stack_frames(&mut self) -> Vec<StackFrame> {
        let Ok(payload) = self.send_and_wait("-stack-list-frames 0 12") else {
            return Vec::new();
        };
        let kv = parse_mi_kv(&payload);
        let Some(stack_list) = kv.get("stack").and_then(|v| v.as_list()) else {
            return Vec::new();
        };

        let mut frames = Vec::new();
        for item in stack_list {
            let frame_val = item.get("frame").unwrap_or(item);
            let level = frame_val
                .get_str("level")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(frames.len());
            let func = frame_val.get_str("func").unwrap_or("??").to_string();
            let file = frame_val
                .get_str("fullname")
                .or_else(|| frame_val.get_str("file"))
                .unwrap_or("")
                .to_string();
            let line = frame_val
                .get_str("line")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(1);
            let addr = frame_val.get_str("addr").unwrap_or("").to_string();
            frames.push(StackFrame {
                level,
                func,
                file,
                line,
                addr,
            });
        }
        frames
    }

    fn query_variables(&mut self) -> Vec<DebugVariable> {
        let Ok(payload) = self.send_and_wait("-stack-list-variables --simple-values") else {
            return Vec::new();
        };
        let kv = parse_mi_kv(&payload);
        let Some(var_list) = kv.get("variables").and_then(|v| v.as_list()) else {
            return Vec::new();
        };

        let mut vars = Vec::new();
        for item in var_list.iter().take(16) {
            let Some(name) = item.get_str("name").map(|s| s.to_string()) else {
                continue;
            };
            let var_type = item.get_str("type").unwrap_or("").to_string();
            let mut value = item.get_str("value").unwrap_or("").to_string();

            // Fetch full value for structs/arrays omitted by --simple-values
            if value.is_empty() {
                if let Some(evaled) = self.eval_expr(&name) {
                    value = evaled;
                }
            }

            // Query real memory address &var
            let address = self
                .eval_expr(&format!("&({})", name))
                .and_then(|raw| extract_hex_address(&raw));

            let is_pointer = var_type.contains('*');
            let points_to_addr = if is_pointer {
                extract_hex_address(&value)
            } else {
                None
            };

            // Safely dereference non-NULL pointers (excluding void*)
            let deref_value = if is_pointer
                && !var_type.trim().starts_with("void")
                && points_to_addr.as_deref().map(|a| a != "0x0").unwrap_or(false)
            {
                self.eval_expr(&format!("*({})", name))
            } else {
                None
            };

            vars.push(DebugVariable {
                name,
                var_type,
                value,
                address,
                is_pointer,
                points_to_addr,
                deref_value,
            });
        }
        vars
    }

    fn handle_stopped(&mut self, payload: &str) {
        let kv = parse_mi_kv(payload);
        let reason = kv.get_str("reason").unwrap_or("stopped").to_string();

        if reason.starts_with("exited") {
            self.exited = true;
            let _ = self.app.emit("debug://exited", DebugExitEvent { reason });
            let _ = self.stdin.write_all(b"-gdb-exit\n");
            let _ = self.stdin.flush();
            return;
        }

        let frame = kv.get("frame");
        let file = frame
            .and_then(|f| f.get_str("fullname").or_else(|| f.get_str("file")))
            .unwrap_or("")
            .to_string();
        let line = frame
            .and_then(|f| f.get_str("line"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(1);
        let func = frame
            .and_then(|f| f.get_str("func"))
            .unwrap_or("??")
            .to_string();

        let frames = self.query_stack_frames();
        let variables = self.query_variables();

        let _ = self.app.emit(
            "debug://stopped",
            DebugSnapshot {
                reason,
                file,
                line,
                func,
                frames,
                variables,
            },
        );
    }

    fn next_msg(&mut self) -> Option<LoopMsg> {
        if let Some(m) = self.pending.pop_front() {
            return Some(m);
        }
        self.rx.recv().ok()
    }

    fn run_event_loop(&mut self) {
        while !self.exited {
            let Some(msg) = self.next_msg() else { break };
            match msg {
                LoopMsg::Eof => {
                    self.exited = true;
                    let _ = self.app.emit(
                        "debug://exited",
                        DebugExitEvent {
                            reason: "gdb-eof".to_string(),
                        },
                    );
                }
                LoopMsg::MiLine(line) => {
                    if let Some(payload) = line.strip_prefix("*stopped") {
                        self.handle_stopped(payload);
                    }
                }
                LoopMsg::Cmd(cmd) => match cmd {
                    DebugCommand::Continue => {
                        let _ = self.send_and_wait("-exec-continue");
                    }
                    DebugCommand::StepInto => {
                        let _ = self.send_and_wait("-exec-step");
                    }
                    DebugCommand::StepOver => {
                        let _ = self.send_and_wait("-exec-next");
                    }
                    DebugCommand::StepOut => {
                        let _ = self.send_and_wait("-exec-finish");
                    }
                    DebugCommand::Evaluate { expr, reply } => {
                        let escaped = expr.replace('\\', "\\\\").replace('"', "\\\"");
                        let res = self
                            .send_and_wait(&format!("-data-evaluate-expression \"{}\"", escaped))
                            .map(|payload| {
                                parse_mi_kv(&payload)
                                    .get_str("value")
                                    .unwrap_or("")
                                    .to_string()
                            });
                        let _ = reply.send(res);
                    }
                    DebugCommand::Stop => {
                        self.exited = true;
                        let _ = self.stdin.write_all(b"-gdb-exit\n");
                        let _ = self.stdin.flush();
                        let _ = self.app.emit(
                            "debug://exited",
                            DebugExitEvent {
                                reason: "stopped-by-user".to_string(),
                            },
                        );
                    }
                },
            }
        }
    }
}

// ===================== TAURI COMMANDS =====================
#[tauri::command]
pub fn debug_start(
    app: AppHandle,
    state: State<'_, DebuggerState>,
    executable_path: String,
    breakpoints: Vec<DebugBreakpointSpec>,
    base_dir: Option<String>,
) -> Result<(), String> {
    let exe = PathBuf::from(&executable_path);
    if !exe.is_file() {
        return Err(format!(
            "Executável para depuração não encontrado: '{}'",
            executable_path
        ));
    }

    stop_existing_session(&state.active);

    let base = resolve_base_dir(base_dir.clone());
    let gdb_exe = resolve_tool(base_dir, "gdb")?;

    let mut cmd = Command::new(&gdb_exe);
    cmd.args(["--interpreter=mi2", "--quiet"])
        .arg(&exe)
        .env("PATH", build_path_with_mingw(&base))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(parent) = exe.parent() {
        cmd.current_dir(parent);
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao iniciar gdb.exe: {}", e))?;

    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Não foi possível abrir stdin do gdb.exe.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Não foi possível abrir stdout do gdb.exe.".to_string())?;
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<LoopMsg>();
    let tx_reader = tx.clone();
    let app_reader = app.clone();
    let app_err = app.clone();

    // Reader thread: separates MI records from target stdout / console logs
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx_reader.send(LoopMsg::Eof);
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
                    if trimmed.is_empty() || trimmed == "(gdb)" {
                        continue;
                    }
                    if let Some(rest) = trimmed.strip_prefix("@\"") {
                        let quoted = format!("\"{}", rest);
                        if let Some(text) = unescape_mi_stream(&quoted) {
                            let _ = app_reader.emit(
                                "debug://output",
                                DebugOutputEvent {
                                    stream: "target".to_string(),
                                    text,
                                },
                            );
                        }
                    } else if let Some(rest) = trimmed.strip_prefix("~\"") {
                        let quoted = format!("\"{}", rest);
                        if let Some(text) = unescape_mi_stream(&quoted) {
                            let _ = app_reader.emit(
                                "debug://output",
                                DebugOutputEvent {
                                    stream: "console".to_string(),
                                    text,
                                },
                            );
                        }
                    } else if trimmed.starts_with('&') || trimmed.starts_with('=') {
                        // Internal GDB log/notify — ignore noise
                    } else {
                        let (_, after_tok) = split_token_and_rest(trimmed);
                        let is_mi = after_tok.starts_with('^')
                            || after_tok.starts_with('*')
                            || after_tok.starts_with('+');
                        if is_mi {
                            let _ = tx_reader.send(LoopMsg::MiLine(trimmed.to_string()));
                        } else {
                            // Direct stdout from MinGW C program under GDB
                            let _ = app_reader.emit(
                                "debug://output",
                                DebugOutputEvent {
                                    stream: "target".to_string(),
                                    text: format!("{}\n", trimmed),
                                },
                            );
                        }
                    }
                }
                Err(_) => {
                    let _ = tx_reader.send(LoopMsg::Eof);
                    break;
                }
            }
        }
    });

    // Stderr forwarder
    if let Some(err_stream) = stderr {
        thread::spawn(move || {
            let mut reader = BufReader::new(err_stream);
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                let _ = app_err.emit(
                    "debug://output",
                    DebugOutputEvent {
                        stream: "log".to_string(),
                        text: line.clone(),
                    },
                );
                line.clear();
            }
        });
    }

    {
        let mut guard = state.active.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(ActiveDebugSession { pid, tx });
    }

    let active_ref = Arc::clone(&state.active);
    thread::spawn(move || {
        let mut controller = GdbController::new(app, stdin, rx);

        let _ = controller.send_and_wait("-gdb-set new-console off");
        let _ = controller.send_and_wait("-gdb-set print elements 24");

        if breakpoints.is_empty() {
            let _ = controller.send_and_wait("-break-insert -t main");
        } else {
            let mut inserted = 0usize;
            for bp in &breakpoints {
                let norm_file = bp.file.replace('\\', "/");
                let bp_cmd = format!("-break-insert \"\\\"{}\\\": {}\"", norm_file, bp.line)
                    .replace(": ", ":");
                if controller.send_and_wait(&bp_cmd).is_ok() {
                    inserted += 1;
                }
            }
            if inserted == 0 {
                let _ = controller.send_and_wait("-break-insert -t main");
            }
        }

        let _ = controller.send_and_wait("-exec-run");
        controller.run_event_loop();

        let _ = child.wait();
        let mut guard = active_ref.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().map(|s| s.pid) == Some(pid) {
            *guard = None;
        }
    });

    Ok(())
}

fn send_debug_cmd(state: &State<'_, DebuggerState>, cmd: DebugCommand) -> Result<(), String> {
    let guard = state.active.lock().unwrap_or_else(|e| e.into_inner());
    let Some(sess) = guard.as_ref() else {
        return Err("Nenhuma sessão de depuração GDB ativa.".to_string());
    };
    sess.tx
        .send(LoopMsg::Cmd(cmd))
        .map_err(|_| "Sessão de depuração já encerrada.".to_string())
}

#[tauri::command]
pub fn debug_continue(state: State<'_, DebuggerState>) -> Result<(), String> {
    send_debug_cmd(&state, DebugCommand::Continue)
}

#[tauri::command]
pub fn debug_step_into(state: State<'_, DebuggerState>) -> Result<(), String> {
    send_debug_cmd(&state, DebugCommand::StepInto)
}

#[tauri::command]
pub fn debug_step_over(state: State<'_, DebuggerState>) -> Result<(), String> {
    send_debug_cmd(&state, DebugCommand::StepOver)
}

#[tauri::command]
pub fn debug_step_out(state: State<'_, DebuggerState>) -> Result<(), String> {
    send_debug_cmd(&state, DebugCommand::StepOut)
}

#[tauri::command]
pub fn debug_evaluate(state: State<'_, DebuggerState>, expression: String) -> Result<String, String> {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return Err("Digite uma expressão C (ex: *p, &x, a->nota).".to_string());
    }
    let (reply_tx, reply_rx) = mpsc::channel();
    send_debug_cmd(
        &state,
        DebugCommand::Evaluate {
            expr: trimmed.to_string(),
            reply: reply_tx,
        },
    )?;
    reply_rx
        .recv_timeout(Duration::from_secs(4))
        .map_err(|_| "Timeout ao avaliar expressão no GDB.".to_string())?
}

#[tauri::command]
pub fn debug_stop(state: State<'_, DebuggerState>) -> Result<(), String> {
    stop_existing_session(&state.active);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mi2_stopped_and_variables() {
        let stopped = r#",reason="breakpoint-hit",frame={addr="0x00401530",func="main",file="04_ponteiros.c",fullname="C:\\Users\\vineee\\04_ponteiros.c",line="21"}"#;
        let kv = parse_mi_kv(stopped);
        assert_eq!(kv.get_str("reason"), Some("breakpoint-hit"));
        let frame = kv.get("frame").expect("frame tuple");
        assert_eq!(frame.get_str("func"), Some("main"));
        assert_eq!(frame.get_str("line"), Some("21"));
        assert_eq!(
            frame.get_str("fullname"),
            Some(r"C:\Users\vineee\04_ponteiros.c")
        );

        let vars = r#",variables=[{name="x",type="int",value="10"},{name="p",type="int *",value="0x000000000061fe1c"}]"#;
        let vkv = parse_mi_kv(vars);
        let list = vkv.get("variables").and_then(|v| v.as_list()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].get_str("name"), Some("p"));
        assert_eq!(
            extract_hex_address(list[1].get_str("value").unwrap()),
            Some("0x61fe1c".to_string())
        );
    }

    #[test]
    fn normalizes_null_and_annotated_addresses() {
        assert_eq!(extract_hex_address("0x00000000"), Some("0x0".to_string()));
        assert_eq!(
            extract_hex_address("0x0061fe10 <ana>"),
            Some("0x61fe10".to_string())
        );
        assert_eq!(extract_hex_address("42"), None);
    }
}
