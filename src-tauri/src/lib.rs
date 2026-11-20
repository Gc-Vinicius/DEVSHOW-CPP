mod compiler;
mod debugger;
mod formatter;
mod fs_ops;
mod runner;
mod settings;
mod toolchain;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(runner::RunnerState::default())
        .manage(debugger::DebuggerState::default())
        .invoke_handler(tauri::generate_handler![
            toolchain::detect_toolchain,
            fs_ops::list_workspace_files,
            fs_ops::read_text_file,
            fs_ops::write_text_file,
            fs_ops::create_file_from_template,
            fs_ops::ensure_roteiro_workspace,
            fs_ops::search_in_directory,
            compiler::compile_source,
            runner::run_program,
            runner::send_program_stdin,
            runner::stop_running_program,
            formatter::format_with_astyle,
            debugger::debug_start,
            debugger::debug_continue,
            debugger::debug_step_into,
            debugger::debug_step_over,
            debugger::debug_step_out,
            debugger::debug_evaluate,
            debugger::debug_stop,
            settings::load_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DEVSHOW C++");
}
