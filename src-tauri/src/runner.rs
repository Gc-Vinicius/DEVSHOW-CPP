use crate::toolchain::{build_path_with_mingw, resolve_base_dir, resolve_tool};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct ActiveProcess {
    run_id: u64,
    pid: u32,
    stdin: Option<ChildStdin>,
    killed: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct RunnerState {
    next_id: AtomicU64,
    active: Arc<Mutex<Option<ActiveProcess>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunnerOutputEvent {
    pub run_id: u64,
    pub stream: String, // "stdout" | "stderr" | "system"
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunnerExitEvent {
    pub run_id: u64,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub killed: bool,
}

fn decode_chunk(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.replace("\r\n", "\n"),
        Err(_) => bytes
            .iter()
            .map(|&b| b as char)
            .collect::<String>()
            .replace("\r\n", "\n"),
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

fn kill_existing(active: &Arc<Mutex<Option<ActiveProcess>>>) -> bool {
    let existing = {
        let mut guard = active.lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    if let Some(proc_info) = existing {
        proc_info.killed.store(true, Ordering::SeqCst);
        drop(proc_info.stdin);
        terminate_pid_tree(proc_info.pid);
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn run_program(
    app: AppHandle,
    state: State<'_, RunnerState>,
    executable_path: String,
    working_dir: Option<String>,
    use_console_pauser: Option<bool>,
    base_dir: Option<String>,
) -> Result<u64, String> {
    let exe = PathBuf::from(&executable_path);
    if !exe.is_file() {
        return Err(format!(
            "Executável não encontrado: '{}'. Compile o arquivo antes (F9).",
            executable_path
        ));
    }

    let cwd = working_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| exe.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));

    let base = resolve_base_dir(base_dir.clone());
    let run_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;

    // Optional external ConsolePauser.exe mode (classic Dev-C++ behavior)
    if use_console_pauser.unwrap_or(false) {
        let pauser = resolve_tool(base_dir, "console_pauser")?;
        let mut cmd = Command::new(&pauser);
        cmd.arg(&exe);
        cmd.current_dir(&cwd);
        cmd.env("PATH", build_path_with_mingw(&base));
        cmd.spawn()
            .map_err(|e| format!("Falha ao abrir ConsolePauser.exe: {}", e))?;

        let _ = app.emit(
            "runner://output",
            RunnerOutputEvent {
                run_id,
                stream: "system".to_string(),
                text: format!(
                    "▶ Executando em janela externa via ConsolePauser.exe: {}\n",
                    exe.display()
                ),
            },
        );
        let _ = app.emit(
            "runner://exit",
            RunnerExitEvent {
                run_id,
                exit_code: Some(0),
                duration_ms: 0,
                killed: false,
            },
        );
        return Ok(run_id);
    }

    // Kill any previously running program before starting a new one
    let _ = kill_existing(&state.active);

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&cwd);
    cmd.env("PATH", build_path_with_mingw(&base));
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao iniciar '{}': {}", exe.display(), e))?;

    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let killed_flag = Arc::new(AtomicBool::new(false));

    {
        let mut guard = state.active.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(ActiveProcess {
            run_id,
            pid,
            stdin,
            killed: Arc::clone(&killed_flag),
        });
    }

    let started = Instant::now();
    let active_arc = Arc::clone(&state.active);
    let app_out = app.clone();
    let app_err = app.clone();
    let app_exit = app;

    let out_handle = thread::spawn(move || {
        if let Some(mut reader) = stdout {
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = decode_chunk(&buf[..n]);
                        let _ = app_out.emit(
                            "runner://output",
                            RunnerOutputEvent {
                                run_id,
                                stream: "stdout".to_string(),
                                text,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        }
    });

    let err_handle = thread::spawn(move || {
        if let Some(mut reader) = stderr {
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = decode_chunk(&buf[..n]);
                        let _ = app_err.emit(
                            "runner://output",
                            RunnerOutputEvent {
                                run_id,
                                stream: "stderr".to_string(),
                                text,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        }
    });

    thread::spawn(move || {
        let status = child.wait().ok();
        let _ = out_handle.join();
        let _ = err_handle.join();
        let duration_ms = started.elapsed().as_millis() as u64;
        let was_killed = killed_flag.load(Ordering::SeqCst);

        {
            let mut guard = active_arc.lock().unwrap_or_else(|e| e.into_inner());
            if guard.as_ref().map(|p| p.run_id) == Some(run_id) {
                *guard = None;
            }
        }

        let _ = app_exit.emit(
            "runner://exit",
            RunnerExitEvent {
                run_id,
                exit_code: status.and_then(|s| s.code()),
                duration_ms,
                killed: was_killed,
            },
        );
    });

    Ok(run_id)
}

#[tauri::command]
pub fn send_program_stdin(state: State<'_, RunnerState>, input: String) -> Result<(), String> {
    let mut guard = state.active.lock().unwrap_or_else(|e| e.into_inner());
    let Some(proc_info) = guard.as_mut() else {
        return Err("Nenhum programa em execução para receber entrada.".to_string());
    };
    let Some(stdin) = proc_info.stdin.as_mut() else {
        return Err("O canal stdin do programa já foi fechado.".to_string());
    };

    let payload = if input.ends_with('\n') {
        input
    } else {
        format!("{}\n", input)
    };
    stdin
        .write_all(payload.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Falha ao enviar entrada para o programa: {}", e))
}

#[tauri::command]
pub fn stop_running_program(state: State<'_, RunnerState>) -> Result<bool, String> {
    Ok(kill_existing(&state.active))
}
