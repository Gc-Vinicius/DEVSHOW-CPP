import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  FileContent,
  RoteiroSeedFile,
  RoteiroWorkspace,
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
