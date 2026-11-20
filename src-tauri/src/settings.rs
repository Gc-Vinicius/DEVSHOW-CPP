use crate::toolchain::DEFAULT_DEVCPP_DIR;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AppSettings {
    pub theme: String,
    pub font_family: String,
    pub font_size_px: u32,
    pub tab_size: u32,
    pub astyle_style: String,
    pub keymap: String,
    pub default_profile_id: String,
    pub toolchain_base_dir: String,
    pub use_console_pauser: bool,
    pub last_workspace_dir: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            font_family: "\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace".to_string(),
            font_size_px: 14,
            tab_size: 4,
            astyle_style: "-A3".to_string(),
            keymap: "hybrid".to_string(),
            default_profile_id: "c11-rel".to_string(),
            toolchain_base_dir: DEFAULT_DEVCPP_DIR.to_string(),
            use_console_pauser: false,
            last_workspace_dir: None,
        }
    }
}

fn settings_file_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata)
                .join("DEVSHOW-CPP")
                .join("settings.json");
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.trim().is_empty() {
            return PathBuf::from(profile)
                .join(".devshow-cpp")
                .join("settings.json");
        }
    }
    std::env::temp_dir()
        .join("DEVSHOW-CPP")
        .join("settings.json")
}

pub fn read_settings_from(path: &Path) -> AppSettings {
    let Ok(raw) = fs::read_to_string(path) else {
        return AppSettings::default();
    };
    serde_json::from_str::<AppSettings>(&raw).unwrap_or_default()
}

pub fn write_settings_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Erro ao criar pasta de configurações: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Erro ao serializar configurações: {}", e))?;
    fs::write(path, json.as_bytes())
        .map_err(|e| format!("Erro ao salvar '{}': {}", path.display(), e))
}

#[tauri::command]
pub fn load_settings() -> Result<AppSettings, String> {
    let path = settings_file_path();
    Ok(read_settings_from(&path))
}

#[tauri::command]
pub fn save_settings(settings: AppSettings) -> Result<(), String> {
    let path = settings_file_path();
    write_settings_to(&path, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_settings_json() {
        let temp = std::env::temp_dir().join(format!(
            "devshow_cpp_settings_test_{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&temp);

        let custom = AppSettings {
            theme: "light".to_string(),
            font_size_px: 16,
            tab_size: 2,
            astyle_style: "-A1".to_string(),
            use_console_pauser: true,
            last_workspace_dir: Some(r"C:\Users\vineee\Documents\DEVSHOW-C-Roteiro".to_string()),
            ..AppSettings::default()
        };

        write_settings_to(&temp, &custom).expect("should write settings");
        let loaded = read_settings_from(&temp);
        assert_eq!(loaded, custom);

        let _ = fs::remove_file(&temp);
    }

    #[test]
    fn falls_back_to_defaults_when_missing_or_corrupt() {
        let temp = std::env::temp_dir().join(format!(
            "devshow_cpp_corrupt_{}.json",
            std::process::id()
        ));
        let _ = fs::write(&temp, "{invalid json");
        let loaded = read_settings_from(&temp);
        assert_eq!(loaded, AppSettings::default());
        let _ = fs::remove_file(&temp);
    }
}
