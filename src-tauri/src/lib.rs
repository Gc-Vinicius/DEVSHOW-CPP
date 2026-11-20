mod fs_ops;
mod toolchain;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            toolchain::detect_toolchain,
            fs_ops::list_workspace_files,
            fs_ops::read_text_file,
            fs_ops::write_text_file,
            fs_ops::create_file_from_template,
            fs_ops::ensure_roteiro_workspace,
            fs_ops::search_in_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DEVSHOW C++");
}
