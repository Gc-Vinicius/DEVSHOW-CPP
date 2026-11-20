use crate::toolchain::{build_path_with_mingw, resolve_base_dir, resolve_tool};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CompileDiagnostic {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub severity: String, // "error" | "warning" | "note"
    pub message: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompileResult {
    pub success: bool,
    pub command_line: String,
    pub executable_path: String,
    pub duration_ms: u64,
    pub raw_output: String,
    pub diagnostics: Vec<CompileDiagnostic>,
}

fn decode_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.replace("\r\n", "\n"),
        Err(_) => bytes
            .iter()
            .map(|&b| b as char)
            .collect::<String>()
            .replace("\r\n", "\n"),
    }
}

fn translate_c_hint(message: &str) -> Option<String> {
    let lower = message.to_ascii_lowercase();

    if lower.contains("expected ';'") || lower.contains("expected ',' or ';'") {
        return Some(
            "Verifique se faltou ponto e vírgula ';' no fim da linha anterior ou logo após o '}' de uma struct / typedef struct."
                .to_string(),
        );
    }
    if lower.contains("makes pointer from integer")
        || (lower.contains("expected") && lower.contains("but argument is of type") && lower.contains("*"))
    {
        return Some(
            "A função espera um ponteiro (endereço de memória). Use o operador '&' ao passar a variável (ex.: troca(&x, &y) ou scanf(\"%d\", &n))."
                .to_string(),
        );
    }
    if lower.contains("makes integer from pointer") {
        return Some(
            "Você passou um endereço/ponteiro onde era esperado um valor comum. Talvez precise desreferenciar com '*p'."
                .to_string(),
        );
    }
    if lower.contains("invalid type argument of '->'") {
        return Some(
            "O operador '->' só funciona com ponteiro para struct (Aluno *a). Para uma struct comum (Aluno a), use ponto: a.nota."
                .to_string(),
        );
    }
    if lower.contains("request for member") && lower.contains("something not a structure") {
        return Some(
            "Você usou ponto '.' em um ponteiro para struct. Troque por seta '->' (ex.: a->nota em vez de a.nota)."
                .to_string(),
        );
    }
    if lower.contains("invalid type argument of unary '*'") {
        return Some(
            "O operador '*' (conteúdo apontado) só pode ser aplicado a ponteiros, não a variáveis comuns."
                .to_string(),
        );
    }
    if lower.contains("implicit declaration of function") {
        if lower.contains("printf") || lower.contains("scanf") || lower.contains("fgets") {
            return Some(
                "Inclua #include <stdio.h> no topo do arquivo para usar funções de entrada/saída."
                    .to_string(),
            );
        }
        if lower.contains("malloc") || lower.contains("free") || lower.contains("calloc") {
            return Some(
                "Inclua #include <stdlib.h> no topo do arquivo para usar malloc/calloc/free."
                    .to_string(),
            );
        }
        if lower.contains("strlen") || lower.contains("strcmp") || lower.contains("strcpy") {
            return Some(
                "Inclua #include <string.h> no topo do arquivo para manipular strings em C."
                    .to_string(),
            );
        }
        return Some(
            "Declare o protótipo da função antes da main() ou inclua o header (.h) correspondente."
                .to_string(),
        );
    }
    if lower.contains("undeclared (first use") {
        return Some(
            "Variável ou tipo não declarado neste escopo. Confira a ortografia (C diferencia maiúsculas/minúsculas) ou se ela foi declarada dentro de outro bloco {}."
                .to_string(),
        );
    }
    if lower.contains("format '%") && lower.contains("expects argument of type") {
        if lower.contains("int *") || lower.contains("float *") || lower.contains("double *") {
            return Some(
                "No scanf(), lembre de usar '&' antes da variável (ex.: scanf(\"%d\", &x)) e '%lf' para double."
                    .to_string(),
            );
        }
        return Some(
            "O especificador do printf/scanf (%d, %f, %lf, %s, %p) não bate com o tipo da variável passada."
                .to_string(),
        );
    }
    if lower.contains("control reaches end of non-void function") {
        return Some(
            "A função promete retornar um valor (int, float, etc.), mas existe um caminho sem 'return'. Garanta um return no final (ex.: return -1;)."
                .to_string(),
        );
    }
    if lower.contains("unused variable") {
        return Some(
            "Variável declarada mas ainda não usada no código (aviso -Wall)."
                .to_string(),
        );
    }
    if lower.contains("comparison between signed and unsigned") {
        return Some(
            "Você comparou 'int' com 'size_t' (sem sinal). Use o mesmo tipo nos índices do loop."
                .to_string(),
        );
    }
    if lower.contains("undefined reference to") {
        return Some(
            "Erro de linker: a função foi declarada mas não foi implementada (ou outro arquivo .c não foi compilado junto)."
                .to_string(),
        );
    }

    None
}

/// Parses a single GCC/G++ diagnostic line, handling Windows drive letters like `C:\path\file.c:10:5: error: msg`.
fn parse_gcc_line(raw_line: &str) -> Option<CompileDiagnostic> {
    let line = raw_line.trim();
    if line.is_empty() {
        return None;
    }

    // Find severity token ": error: ", ": fatal error: ", ": warning: ", ": note: "
    let severities = [
        (": fatal error: ", "error"),
        (": error: ", "error"),
        (": warning: ", "warning"),
        (": note: ", "note"),
    ];

    let mut matched: Option<(usize, usize, &str)> = None;
    for (needle, sev) in severities {
        if let Some(pos) = line.find(needle) {
            matched = Some((pos, needle.len(), sev));
            break;
        }
    }

    let (sev_pos, needle_len, severity) = matched?;
    let loc_part = &line[..sev_pos];
    let message = line[sev_pos + needle_len..].trim().to_string();

    // Parse trailing :line or :line:col from loc_part (preserving Windows drive letter C:\)
    let mut parts_rev = loc_part.rsplitn(3, ':');
    let last = parts_rev.next()?;
    let second = parts_rev.next()?;
    let third = parts_rev.next();

    let (file, line_no, col_no) = match (last.parse::<usize>(), second.parse::<usize>(), third) {
        (Ok(col), Ok(ln), Some(file_str)) if !file_str.is_empty() => (file_str, ln, col),
        (Ok(ln), Err(_), Some(prefix)) => {
            // Rejoin prefix:second (e.g. "C" + ":" + "\foo\bar.c")
            let file_end = loc_part.len() - last.len() - 1;
            let _ = prefix;
            (&loc_part[..file_end], ln, 1)
        }
        (Ok(ln), Err(_), None) => (second, ln, 1),
        _ => return None,
    };

    let hint = if severity == "note" {
        None
    } else {
        translate_c_hint(&message)
    };

    Some(CompileDiagnostic {
        file: file.trim().to_string(),
        line: line_no,
        column: col_no,
        severity: severity.to_string(),
        message,
        hint,
    })
}

pub fn parse_gcc_diagnostics(raw_output: &str) -> Vec<CompileDiagnostic> {
    let mut out = Vec::new();
    for line in raw_output.lines() {
        if let Some(diag) = parse_gcc_line(line) {
            out.push(diag);
        }
    }
    // Capture linker errors like `undefined reference to 'foo'` if no file:line matched
    if out.is_empty() && raw_output.to_ascii_lowercase().contains("undefined reference to") {
        for line in raw_output.lines() {
            if line.to_ascii_lowercase().contains("undefined reference to") {
                out.push(CompileDiagnostic {
                    file: String::new(),
                    line: 1,
                    column: 1,
                    severity: "error".to_string(),
                    message: line.trim().to_string(),
                    hint: translate_c_hint(line),
                });
            }
        }
    }
    out
}

fn output_executable_for(source: &Path) -> PathBuf {
    source.with_extension("exe")
}

#[tauri::command]
pub fn compile_source(
    source_path: String,
    compiler: String,
    flags: Vec<String>,
    base_dir: Option<String>,
) -> Result<CompileResult, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("Arquivo fonte não encontrado: '{}'", source_path));
    }

    let tool_key = if compiler.eq_ignore_ascii_case("g++") {
        "g++"
    } else {
        "gcc"
    };

    let base = resolve_base_dir(base_dir.clone());
    let compiler_exe = resolve_tool(base_dir, tool_key)?;
    let exe_out = output_executable_for(&source);

    let mut cmd = Command::new(&compiler_exe);
    cmd.env("PATH", build_path_with_mingw(&base));
    if let Some(parent) = source.parent() {
        cmd.current_dir(parent);
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut display_args: Vec<String> = Vec::new();
    for flag in &flags {
        let trimmed = flag.trim();
        if !trimmed.is_empty() {
            cmd.arg(trimmed);
            display_args.push(trimmed.to_string());
        }
    }
    cmd.arg(&source);
    cmd.arg("-o");
    cmd.arg(&exe_out);

    let command_line = format!(
        "\"{}\" {} \"{}\" -o \"{}\"",
        compiler_exe.display(),
        display_args.join(" "),
        source.display(),
        exe_out.display()
    );

    let started = Instant::now();
    let output = cmd
        .output()
        .map_err(|e| format!("Falha ao executar '{}': {}", compiler_exe.display(), e))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let stdout = decode_output(&output.stdout);
    let stderr = decode_output(&output.stderr);
    let raw_output = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{}\n{}", stdout.trim_end(), stderr),
    };

    let diagnostics = parse_gcc_diagnostics(&raw_output);
    let success = output.status.success();

    Ok(CompileResult {
        success,
        command_line,
        executable_path: exe_out.to_string_lossy().into_owned(),
        duration_ms,
        raw_output,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_windows_gcc_error_and_provides_c_hint() {
        let sample = r"C:\Users\vineee\Documents\DEVSHOW-C-Roteiro\04_ponteiros.c:6:1: error: expected ';', identifier or '(' before 'void'
C:\Users\vineee\Documents\DEVSHOW-C-Roteiro\04_ponteiros.c:28:11: warning: passing argument 1 of 'troca' makes pointer from integer without a cast [-Wint-conversion]";

        let diags = parse_gcc_diagnostics(sample);
        assert_eq!(diags.len(), 2);

        assert_eq!(
            diags[0].file,
            r"C:\Users\vineee\Documents\DEVSHOW-C-Roteiro\04_ponteiros.c"
        );
        assert_eq!(diags[0].line, 6);
        assert_eq!(diags[0].column, 1);
        assert_eq!(diags[0].severity, "error");
        assert!(diags[0].hint.as_deref().unwrap_or("").contains("ponto e vírgula"));

        assert_eq!(diags[1].line, 28);
        assert_eq!(diags[1].severity, "warning");
        assert!(diags[1].hint.as_deref().unwrap_or("").contains("'&'"));
    }

    #[test]
    fn parses_struct_arrow_hint() {
        let sample = "main.c:14:6: error: invalid type argument of '->' (have 'Aluno')";
        let diags = parse_gcc_diagnostics(sample);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].hint.as_deref().unwrap_or("").contains("a.nota"));
    }
}
