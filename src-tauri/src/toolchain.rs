use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const DEFAULT_DEVCPP_DIR: &str = r"C:\Program Files (x86)\Dev-Cpp";

#[derive(Debug, Clone, Serialize)]
pub struct ToolStatus {
    pub name: &'static str,
    pub path: Option<String>,
    pub found: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolchainReport {
    pub base_dir: String,
    pub tools: Vec<ToolStatus>,
}

pub fn resolve_base_dir(base_dir: Option<String>) -> PathBuf {
    let root = base_dir
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DEVCPP_DIR.to_string());
    PathBuf::from(root)
}

pub fn mingw_bin_dir(base: &Path) -> PathBuf {
    base.join(r"MinGW64\bin")
}

pub fn build_path_with_mingw(base: &Path) -> OsString {
    let bin = mingw_bin_dir(base);
    let mut combined = OsString::from(bin.as_os_str());
    if let Some(existing) = std::env::var_os("PATH") {
        combined.push(";");
        combined.push(existing);
    }
    combined
}

pub fn resolve_tool(base_dir: Option<String>, tool_name: &str) -> Result<PathBuf, String> {
    let base = resolve_base_dir(base_dir);
    let rel = match tool_name {
        "gcc" => r"MinGW64\bin\gcc.exe",
        "g++" => r"MinGW64\bin\g++.exe",
        "gdb" => r"MinGW64\bin\gdb.exe",
        "astyle" => r"AStyle\AStyle.exe",
        "console_pauser" => "ConsolePauser.exe",
        other => return Err(format!("Ferramenta desconhecida: '{}'", other)),
    };

    let candidate = base.join(rel);
    if candidate.is_file() {
        Ok(candidate)
    } else {
        Err(format!(
            "Ferramenta '{}' não encontrada em '{}'. Verifique a instalação do Dev-C++ 5.11.",
            tool_name,
            candidate.display()
        ))
    }
}

fn find_tool(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

pub fn scan_toolchain(base_dir: Option<String>) -> ToolchainReport {
    let base = resolve_base_dir(base_dir);
    let root = base.to_string_lossy().into_owned();

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

#[tauri::command]
pub fn detect_toolchain(base_dir: Option<String>) -> ToolchainReport {
    scan_toolchain(base_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_five_expected_tools() {
        let report = scan_toolchain(Some(r"C:\nonexistent-devshow-dir".to_string()));
        assert_eq!(report.tools.len(), 5);
        assert!(report.tools.iter().all(|t| !t.found));
    }

    #[test]
    fn rejects_unknown_tool_name() {
        assert!(resolve_tool(None, "clang_inexistente").is_err());
    }
}
