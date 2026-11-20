use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct ToolStatus {
    pub name: &'static str,
    pub path: Option<String>,
    pub found: bool,
}

#[derive(Serialize)]
pub struct ToolchainReport {
    pub base_dir: String,
    pub tools: Vec<ToolStatus>,
}

fn find_tool(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn detect_toolchain(base_dir: Option<String>) -> ToolchainReport {
    let root = base_dir.unwrap_or_else(|| r"C:\Program Files (x86)\Dev-Cpp".to_string());
    let base = Path::new(&root);

    let specs: [(&'static str, Vec<PathBuf>); 5] = [
        ("gcc", vec![base.join(r"MinGW64\bin\gcc.exe")]),
        ("g++", vec![base.join(r"MinGW64\bin\g++.exe")]),
        ("gdb", vec![base.join(r"MinGW64\bin\gdb.exe")]),
        ("astyle", vec![base.join(r"AStyle\AStyle.exe")]),
        ("console_pauser", vec![base.join("ConsolePauser.exe")]),
    ];

    let tools = specs
        .into_iter()
        .map(|(name, candidates)| {
            let path = find_tool(&candidates);
            ToolStatus {
                name,
                found: path.is_some(),
                path,
            }
        })
        .collect();

    ToolchainReport {
        base_dir: root,
        tools,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![detect_toolchain])
        .run(tauri::generate_context!())
        .expect("error while running DEVSHOW C++");
}
