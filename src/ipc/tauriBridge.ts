import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  CompileResult,
  FileContent,
  FormatResult,
  RoteiroSeedFile,
  RoteiroWorkspace,
  RunnerExitEvent,
  RunnerOutputEvent,
  SearchMatch,
  ToolchainReport,
  WorkspaceEntry,
} from "../types";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function detectToolchain(baseDir?: string): Promise<ToolchainReport> {
  if (!isTauriRuntime()) {
    return {
      base_dir: baseDir ?? "C:\\Program Files (x86)\\Dev-Cpp",
      tools: [
        { name: "gcc", path: null, found: false },
        { name: "g++", path: null, found: false },
        { name: "gdb", path: null, found: false },
        { name: "astyle", path: null, found: false },
        { name: "console_pauser", path: null, found: false },
      ],
    };
  }
  return invoke<ToolchainReport>("detect_toolchain", {
    baseDir: baseDir ?? null,
  });
}

export async function listWorkspaceFiles(dirPath: string): Promise<WorkspaceEntry[]> {
  return invoke<WorkspaceEntry[]>("list_workspace_files", { dirPath });
}

export async function readTextFile(path: string): Promise<FileContent> {
  return invoke<FileContent>("read_text_file", { path });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_text_file", { path, content });
}

export async function createFileFromTemplate(
  dirPath: string,
  fileName: string,
  content: string,
  overwrite = false
): Promise<FileContent> {
  return invoke<FileContent>("create_file_from_template", {
    dirPath,
    fileName,
    content,
    overwrite,
  });
}

export async function ensureRoteiroWorkspace(
  seeds: RoteiroSeedFile[],
  baseDir?: string
): Promise<RoteiroWorkspace> {
  return invoke<RoteiroWorkspace>("ensure_roteiro_workspace", {
    baseDir: baseDir ?? null,
    seeds,
  });
}

export async function searchInDirectory(
  dirPath: string,
  query: string
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_in_directory", { dirPath, query });
}

export async function pickFolderDialog(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Abrir Pasta de Projeto C/C++",
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickOpenFileDialog(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const selected = await open({
    directory: false,
    multiple: false,
    title: "Abrir Arquivo C/C++",
    filters: [
      { name: "Código C/C++", extensions: ["c", "h", "cpp", "hpp", "cc", "cxx"] },
      { name: "Todos os arquivos", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickSaveFileDialog(defaultPath?: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const selected = await save({
    title: "Salvar Arquivo C/C++",
    defaultPath,
    filters: [
      { name: "Código C", extensions: ["c", "h"] },
      { name: "Código C++", extensions: ["cpp", "hpp"] },
      { name: "Todos os arquivos", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

export async function compileSource(
  sourcePath: string,
  compiler: "gcc" | "g++",
  flags: string[],
  baseDir?: string
): Promise<CompileResult> {
  return invoke<CompileResult>("compile_source", {
    sourcePath,
    compiler,
    flags,
    baseDir: baseDir ?? null,
  });
}

export async function runProgram(
  executablePath: string,
  options: {
    workingDir?: string;
    useConsolePauser?: boolean;
    baseDir?: string;
  } = {}
): Promise<number> {
  return invoke<number>("run_program", {
    executablePath,
    workingDir: options.workingDir ?? null,
    useConsolePauser: options.useConsolePauser ?? false,
    baseDir: options.baseDir ?? null,
  });
}

export async function sendProgramStdin(input: string): Promise<void> {
  return invoke<void>("send_program_stdin", { input });
}

export async function stopRunningProgram(): Promise<boolean> {
  return invoke<boolean>("stop_running_program");
}

export async function formatWithAStyle(
  code: string,
  styleFlag: string,
  tabSize = 4,
  baseDir?: string
): Promise<FormatResult> {
  return invoke<FormatResult>("format_with_astyle", {
    code,
    styleFlag,
    tabSize,
    baseDir: baseDir ?? null,
  });
}

export async function onRunnerOutput(
  handler: (event: RunnerOutputEvent) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<RunnerOutputEvent>("runner://output", (ev) => handler(ev.payload));
}

export async function onRunnerExit(
  handler: (event: RunnerExitEvent) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<RunnerExitEvent>("runner://exit", (ev) => handler(ev.payload));
}
