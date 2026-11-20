export interface ToolStatus {
  name: string;
  path: string | null;
  found: boolean;
}

export interface ToolchainReport {
  base_dir: string;
  tools: ToolStatus[];
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  rel_path: string;
  ext: string;
  is_dir: boolean;
  depth: number;
}

export interface FileContent {
  path: string;
  name: string;
  content: string;
  lossy_utf8: boolean;
}

export interface RoteiroSeedFile {
  name: string;
  content: string;
}

export interface RoteiroWorkspace {
  dir_path: string;
  created_count: number;
  entries: WorkspaceEntry[];
}

export interface SearchMatch {
  path: string;
  rel_path: string;
  line: number;
  column: number;
  snippet: string;
}

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "note";
  message: string;
  hint: string | null;
}

export interface CompileResult {
  success: boolean;
  command_line: string;
  executable_path: string;
  duration_ms: number;
  raw_output: string;
  diagnostics: CompileDiagnostic[];
}

export interface FormatResult {
  formatted_code: string;
  changed: boolean;
  command_summary: string;
}

export interface RunnerOutputEvent {
  run_id: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface RunnerExitEvent {
  run_id: number;
  exit_code: number | null;
  duration_ms: number;
  killed: boolean;
}

export interface OpenTab {
  path: string;
  name: string;
  ext: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  virtualOnly: boolean;
  lossyUtf8: boolean;
}

export interface RoteiroLesson {
  fileName: string;
  block: string;
  time: string;
  split: string;
  desc: string;
  paper: string;
  code: string;
}

export interface TemplateSpec {
  id: string;
  cat: string;
  name: string;
  desc: string;
  defaultFile: string;
  code: string;
}

export interface SymbolItem {
  kind: "fn" | "S";
  label: string;
  line: number;
}

export interface CompilerProfile {
  id: string;
  label: string;
  compiler: "gcc" | "g++";
  stdFlag: string;
  flags: string[];
}

export type ThemeMode = "dark" | "light";
export type SidebarPanel = "roteiro" | "files" | "outline" | "search" | "debug";
export type DrawerTab = "terminal" | "problems" | "trace" | "log";
export type KeymapMode = "hybrid" | "classic";

export interface EditorSettings {
  theme: ThemeMode;
  fontFamily: string;
  fontSizePx: number;
  tabSize: number;
  astyleStyle: "-A3" | "-A2" | "-A1";
  keymap: KeymapMode;
}
