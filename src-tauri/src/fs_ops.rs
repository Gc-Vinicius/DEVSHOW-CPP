use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".vscode",
    "build",
    "out",
];

const SOURCE_EXTS: &[&str] = &["c", "h", "cpp", "hpp", "cc", "cxx", "txt", "md", "win"];

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub rel_path: String,
    pub ext: String,
    pub is_dir: bool,
    pub depth: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub name: String,
    pub content: String,
    pub lossy_utf8: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RoteiroSeedFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoteiroWorkspace {
    pub dir_path: String,
    pub created_count: usize,
    pub entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub rel_path: String,
    pub line: usize,
    pub column: usize,
    pub snippet: String,
}

fn is_supported_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();

    if file_name.eq_ignore_ascii_case("makefile") || file_name.starts_with("Makefile") {
        return true;
    }

    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            SOURCE_EXTS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

fn collect_entries(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<WorkspaceEntry>,
) -> Result<(), String> {
    if depth > max_depth || out.len() >= 600 {
        return Ok(());
    }

    let read_dir = fs::read_dir(dir)
        .map_err(|e| format!("Não foi possível ler a pasta '{}': {}", dir.display(), e))?;

    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for entry in read_dir.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if !IGNORED_DIRS
                .iter()
                .any(|ignored| ignored.eq_ignore_ascii_case(&name))
                && !name.starts_with('.')
            {
                dirs.push(p);
            }
        } else if p.is_file() && is_supported_file(&p) {
            files.push(p);
        }
    }

    dirs.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_ascii_lowercase())
    });
    files.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .cmp(&b.file_name().unwrap_or_default().to_ascii_lowercase())
    });

    for d in dirs {
        if out.len() >= 600 {
            break;
        }
        let name = d
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let rel = d
            .strip_prefix(root)
            .unwrap_or(&d)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(WorkspaceEntry {
            name,
            path: d.to_string_lossy().into_owned(),
            rel_path: rel,
            ext: String::new(),
            is_dir: true,
            depth,
        });
        collect_entries(root, &d, depth + 1, max_depth, out)?;
    }

    for f in files {
        if out.len() >= 600 {
            break;
        }
        let name = f
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = f
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let rel = f
            .strip_prefix(root)
            .unwrap_or(&f)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(WorkspaceEntry {
            name,
            path: f.to_string_lossy().into_owned(),
            rel_path: rel,
            ext,
            is_dir: false,
            depth,
        });
    }

    Ok(())
}

fn decode_bytes(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(valid) => {
            // Strip UTF-8 BOM if present
            let cleaned = valid.strip_prefix('\u{feff}').unwrap_or(valid);
            (cleaned.replace("\r\n", "\n"), false)
        }
        Err(_) => {
            // Legacy Windows-1252 / Latin-1 fallback for old Dev-C++ files
            let decoded: String = bytes.iter().map(|&b| b as char).collect();
            (decoded.replace("\r\n", "\n"), true)
        }
    }
}

fn sanitize_file_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("O nome do arquivo não pode estar vazio.".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("Use apenas o nome do arquivo (sem barras ou '..').".to_string());
    }
    Ok(trimmed.to_string())
}

fn default_roteiro_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let docs = PathBuf::from(&profile).join("Documents");
        if docs.is_dir() {
            return docs.join("DEVSHOW-C-Roteiro");
        }
        return PathBuf::from(profile).join("DEVSHOW-C-Roteiro");
    }
    std::env::temp_dir().join("DEVSHOW-C-Roteiro")
}

#[tauri::command]
pub fn list_workspace_files(dir_path: String) -> Result<Vec<WorkspaceEntry>, String> {
    let root = PathBuf::from(&dir_path);
    if !root.is_dir() {
        return Err(format!("Pasta não encontrada: '{}'", dir_path));
    }
    let mut entries = Vec::new();
    collect_entries(&root, &root, 0, 4, &mut entries)?;
    Ok(entries)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<FileContent, String> {
    let p = PathBuf::from(&path);
    let bytes =
        fs::read(&p).map_err(|e| format!("Erro ao abrir '{}': {}", p.display(), e))?;
    let (content, lossy_utf8) = decode_bytes(&bytes);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Ok(FileContent {
        path,
        name,
        content,
        lossy_utf8,
    })
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Erro ao criar diretório '{}': {}", parent.display(), e))?;
        }
    }
    fs::write(&p, content.as_bytes())
        .map_err(|e| format!("Erro ao salvar '{}': {}", p.display(), e))
}

#[tauri::command]
pub fn create_file_from_template(
    dir_path: String,
    file_name: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<FileContent, String> {
    let safe_name = sanitize_file_name(&file_name)?;
    let dir = PathBuf::from(&dir_path);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Erro ao preparar pasta '{}': {}", dir.display(), e))?;

    let target = dir.join(&safe_name);
    if target.exists() && !overwrite.unwrap_or(false) {
        return Err(format!(
            "O arquivo '{}' já existe nesta pasta. Escolha outro nome.",
            safe_name
        ));
    }

    fs::write(&target, content.as_bytes())
        .map_err(|e| format!("Erro ao criar '{}': {}", target.display(), e))?;

    Ok(FileContent {
        path: target.to_string_lossy().into_owned(),
        name: safe_name,
        content,
        lossy_utf8: false,
    })
}

#[tauri::command]
pub fn ensure_roteiro_workspace(
    base_dir: Option<String>,
    seeds: Vec<RoteiroSeedFile>,
) -> Result<RoteiroWorkspace, String> {
    let dir = base_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_roteiro_dir);

    fs::create_dir_all(&dir)
        .map_err(|e| format!("Erro ao criar pasta do roteiro '{}': {}", dir.display(), e))?;

    let mut created_count = 0usize;
    for seed in seeds {
        let safe_name = sanitize_file_name(&seed.name)?;
        let file_path = dir.join(safe_name);
        if !file_path.exists() {
            fs::write(&file_path, seed.content.as_bytes()).map_err(|e| {
                format!("Erro ao gravar '{}': {}", file_path.display(), e)
            })?;
            created_count += 1;
        }
    }

    let mut entries = Vec::new();
    collect_entries(&dir, &dir, 0, 2, &mut entries)?;

    Ok(RoteiroWorkspace {
        dir_path: dir.to_string_lossy().into_owned(),
        created_count,
        entries,
    })
}

#[tauri::command]
pub fn search_in_directory(dir_path: String, query: String) -> Result<Vec<SearchMatch>, String> {
    let trimmed = query.trim();
    if trimmed.len() < 2 {
        return Ok(Vec::new());
    }

    let root = PathBuf::from(&dir_path);
    if !root.is_dir() {
        return Err(format!("Pasta inválida para busca: '{}'", dir_path));
    }

    let mut entries = Vec::new();
    collect_entries(&root, &root, 0, 4, &mut entries)?;

    let needle = trimmed.to_lowercase();
    let mut matches = Vec::new();

    for entry in entries.into_iter().filter(|e| !e.is_dir) {
        if matches.len() >= 200 {
            break;
        }
        let Ok(bytes) = fs::read(&entry.path) else {
            continue;
        };
        if bytes.len() > 2 * 1024 * 1024 {
            continue;
        }
        let (text, _) = decode_bytes(&bytes);
        for (idx, line) in text.lines().enumerate() {
            if let Some(col_byte) = line.to_lowercase().find(&needle) {
                matches.push(SearchMatch {
                    path: entry.path.clone(),
                    rel_path: entry.rel_path.clone(),
                    line: idx + 1,
                    column: col_byte + 1,
                    snippet: line.trim().chars().take(140).collect(),
                });
                if matches.len() >= 200 {
                    break;
                }
            }
        }
    }

    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_reads_and_searches_c_files() {
        let temp = std::env::temp_dir().join(format!(
            "devshow_cpp_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp);

        let created = create_file_from_template(
            temp.to_string_lossy().into_owned(),
            "teste.c".to_string(),
            "#include <stdio.h>\nint main(void) { return 0; }\n".to_string(),
            Some(true),
        )
        .expect("should create file");
        assert_eq!(created.name, "teste.c");

        let read_back = read_text_file(created.path.clone()).expect("should read file");
        assert!(read_back.content.contains("int main(void)"));
        assert!(!read_back.lossy_utf8);

        let found = search_in_directory(temp.to_string_lossy().into_owned(), "main".to_string())
            .expect("should search");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 2);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn rejects_path_traversal_in_template_name() {
        let res = sanitize_file_name("../hack.c");
        assert!(res.is_err());
    }
}
