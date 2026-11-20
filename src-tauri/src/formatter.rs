use crate::toolchain::resolve_tool;
use serde::Serialize;
use std::io::Write;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ALLOWED_STYLES: &[&str] = &["-A1", "-A2", "-A3", "-A4", "-A8", "-A10"];

#[derive(Debug, Clone, Serialize)]
pub struct FormatResult {
    pub formatted_code: String,
    pub changed: bool,
    pub command_summary: String,
}

fn validate_style(style_flag: &str) -> Result<&'static str, String> {
    let trimmed = style_flag.trim();
    ALLOWED_STYLES
        .iter()
        .copied()
        .find(|&s| s == trimmed)
        .ok_or_else(|| format!("Estilo AStyle inválido: '{}'", style_flag))
}

#[tauri::command]
pub fn format_with_astyle(
    code: String,
    style_flag: String,
    tab_size: Option<u32>,
    base_dir: Option<String>,
) -> Result<FormatResult, String> {
    let style = validate_style(&style_flag)?;
    let spaces = tab_size.unwrap_or(4).clamp(2, 8);
    let astyle_exe = resolve_tool(base_dir, "astyle")?;

    let indent_arg = format!("--indent=spaces={}", spaces);
    let args = [
        style,
        indent_arg.as_str(),
        "--indent-switches",
        "--indent-preprocessor",
        "--pad-oper",
        "--pad-header",
        "--unpad-paren",
    ];

    let mut cmd = Command::new(&astyle_exe);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao iniciar AStyle.exe: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(code.as_bytes())
            .map_err(|e| format!("Falha ao enviar código ao AStyle.exe: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Falha ao aguardar AStyle.exe: {}", e))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err_msg.is_empty() {
            "AStyle.exe encerrou com erro.".to_string()
        } else {
            format!("AStyle.exe falhou: {}", err_msg)
        });
    }

    let formatted_code = String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n");
    let changed = formatted_code != code.replace("\r\n", "\n");

    Ok(FormatResult {
        formatted_code,
        changed,
        command_summary: format!("AStyle.exe {} {}", style, indent_arg),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_style_allowlist() {
        assert_eq!(validate_style("-A3").unwrap(), "-A3");
        assert_eq!(validate_style(" -A1 ").unwrap(), "-A1");
        assert!(validate_style("--arbitrary-flag").is_err());
    }
}
