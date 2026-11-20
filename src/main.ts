import {
  C_TEMPLATES,
  COMPILER_PROFILES,
  ROTEIRO_LESSONS,
} from "./data/cContent";
import { DevShowEditor } from "./editor/cmEditor";
import {
  compileSource,
  createFileFromTemplate,
  detectToolchain,
  ensureRoteiroWorkspace,
  formatWithAStyle,
  isTauriRuntime,
  listWorkspaceFiles,
  onRunnerExit,
  onRunnerOutput,
  pickFolderDialog,
  pickOpenFileDialog,
  pickSaveFileDialog,
  readTextFile,
  runProgram,
  searchInDirectory,
  sendProgramStdin,
  stopRunningProgram,
  writeTextFile,
} from "./ipc/tauriBridge";
import type {
  CompileDiagnostic,
  DrawerTab,
  EditorSettings,
  KeymapMode,
  OpenTab,
  SearchMatch,
  SidebarPanel,
  SymbolItem,
  ThemeMode,
  ToolchainReport,
  WorkspaceEntry,
} from "./types";

interface PaletteCommand {
  cat: string;
  label: string;
  kbd: string;
  run: () => void | Promise<void>;
}

interface TerminalChunk {
  cls: string;
  text: string;
}

interface AppState {
  workspaceDir: string | null;
  workspaceEntries: WorkspaceEntry[];
  tabs: OpenTab[];
  activePath: string | null;
  splitOpen: boolean;
  sidebarPanel: SidebarPanel;
  sidebarOpen: boolean;
  drawerOpen: boolean;
  drawerTab: DrawerTab;
  cursorLine: number;
  cursorCol: number;
  breakpoints: Map<string, number[]>;
  toolchain: ToolchainReport | null;
  selectedProfileId: string;
  selectedTemplateIdx: number;
  searchQuery: string;
  searchResults: SearchMatch[];
  diagnostics: CompileDiagnostic[];
  lastExecutableBySource: Map<string, string>;
  isCompiling: boolean;
  isRunning: boolean;
  activeRunId: number | null;
  useConsolePauser: boolean;
  terminalChunks: TerminalChunk[];
  compileLog: string[];
  settings: EditorSettings;
}

const state: AppState = {
  workspaceDir: null,
  workspaceEntries: [],
  tabs: [],
  activePath: null,
  splitOpen: false,
  sidebarPanel: "roteiro",
  sidebarOpen: true,
  drawerOpen: true,
  drawerTab: "terminal",
  cursorLine: 1,
  cursorCol: 1,
  breakpoints: new Map<string, number[]>(),
  toolchain: null,
  selectedProfileId: COMPILER_PROFILES[0].id,
  selectedTemplateIdx: 0,
  searchQuery: "",
  searchResults: [],
  diagnostics: [],
  lastExecutableBySource: new Map<string, string>(),
  isCompiling: false,
  isRunning: false,
  activeRunId: null,
  useConsolePauser: false,
  terminalChunks: [
    {
      cls: "term-muted",
      text: "DEVSHOW C++ · Pronto para compilar e executar em C11 (F9 Compile · F10 Run · F11 Compile & Run · Ctrl+Shift+A AStyle)\n",
    },
  ],
  compileLog: [
    "Aguardando compilação (F9 / F11)...",
  ],
  settings: {
    theme: "dark",
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    fontSizePx: 14,
    tabSize: 4,
    astyleStyle: "-A3",
    keymap: "hybrid",
  },
};

let primaryEditor!: DevShowEditor;
let secondaryEditor!: DevShowEditor;
let paletteIndex = 0;

// ===================== HELPERS =====================
function el<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Elemento #${id} não encontrado.`);
  return found as unknown as T;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fileExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function dotClassForExt(ext: string, name: string): string {
  if (ext === "h" || ext === "hpp") return "dot-h";
  if (ext === "cpp" || ext === "cc" || ext === "cxx") return "dot-cpp";
  if (name.startsWith("07_")) return "dot-star";
  return "dot-c";
}

function baseName(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || fullPath;
}

function dirName(fullPath: string): string {
  const idx = Math.max(fullPath.lastIndexOf("\\"), fullPath.lastIndexOf("/"));
  return idx > 0 ? fullPath.slice(0, idx) : "";
}

function normalizePathKey(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

function getActiveTab(): OpenTab | null {
  return state.tabs.find((t) => t.path === state.activePath) ?? null;
}

function extractCSymbols(source: string): SymbolItem[] {
  const lines = source.split("\n");
  const items: SymbolItem[] = [];
  lines.forEach((line, idx) => {
    const structTypedef = line.match(/^\s*\}\s*(\w+)\s*;/);
    if (structTypedef?.[1]) {
      items.push({
        kind: "S",
        label: `struct ${structTypedef[1]}`,
        line: Math.max(1, idx - 2),
      });
    }
    const structNamed = line.match(/^\s*struct\s+(\w+)\s*\{/);
    if (structNamed?.[1]) {
      items.push({ kind: "S", label: `struct ${structNamed[1]}`, line: idx + 1 });
    }
    const fn = line.match(
      /^(?:static\s+)?(?:int|float|double|void|char|bool|size_t|long|short|unsigned\s+int)\s+\*?(\w+)\s*\([^;]*\)\s*\{/
    );
    if (fn?.[1]) {
      items.push({ kind: "fn", label: `${fn[1]}()`, line: idx + 1 });
    }
  });
  return items;
}

function toast(msg: string): void {
  const stack = el<HTMLDivElement>("toastStack");
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = msg;
  stack.appendChild(item);
  window.setTimeout(() => {
    item.style.opacity = "0";
    item.style.transition = "opacity 200ms";
    window.setTimeout(() => item.remove(), 220);
  }, 2900);
}

function appendTerminalChunk(text: string, cls = ""): void {
  const last = state.terminalChunks[state.terminalChunks.length - 1];
  if (last && last.cls === cls) {
    last.text += text;
  } else {
    state.terminalChunks.push({ cls, text });
  }
  if (state.terminalChunks.length > 400) {
    state.terminalChunks.splice(0, state.terminalChunks.length - 400);
  }
  if (state.drawerTab === "terminal") {
    renderDrawer();
  }
}

function applyDiagnosticsToEditor(): void {
  const tab = getActiveTab();
  if (!tab) return;
  const tabKey = normalizePathKey(tab.path);
  const tabBase = tab.name.toLowerCase();

  const matching = state.diagnostics
    .filter((d) => {
      if (d.severity !== "error" && d.severity !== "warning") return false;
      if (!d.file) return true;
      const dk = normalizePathKey(d.file);
      return dk === tabKey || baseName(d.file).toLowerCase() === tabBase;
    })
    .map((d) => ({
      line: d.line,
      severity: d.severity as "error" | "warning",
    }));

  primaryEditor.setDiagnostics(matching);
}

// ===================== WORKSPACE & FILE OPERATIONS =====================
async function refreshWorkspaceTree(): Promise<void> {
  if (!state.workspaceDir || !isTauriRuntime()) return;
  try {
    state.workspaceEntries = await listWorkspaceFiles(state.workspaceDir);
    renderSidebar();
    renderStatus();
  } catch (err) {
    toast(`Erro ao listar pasta: ${String(err)}`);
  }
}

async function openRoteiroWorkspace(): Promise<void> {
  if (isTauriRuntime()) {
    try {
      const seeds = ROTEIRO_LESSONS.map((l) => ({
        name: l.fileName,
        content: l.code,
      }));
      const ws = await ensureRoteiroWorkspace(seeds);
      state.workspaceDir = ws.dir_path;
      state.workspaceEntries = ws.entries;
      appendTerminalChunk(
        `✓ Workspace do Roteiro C pronto em: ${ws.dir_path} (${ws.created_count} novo(s) arquivo(s) .c)\n`,
        "term-ok"
      );

      const defaultEntry =
        ws.entries.find((e) => e.name === "04_ponteiros.c") ??
        ws.entries.find((e) => !e.is_dir);
      if (defaultEntry) {
        await openDiskFile(defaultEntry.path);
      }
      renderAll();
      return;
    } catch (err) {
      appendTerminalChunk(`Aviso ao preparar Roteiro em disco: ${String(err)}\n`, "term-warn");
    }
  }

  state.workspaceDir = "Roteiro_C_Memoria";
  state.workspaceEntries = ROTEIRO_LESSONS.map((l) => ({
    name: l.fileName,
    path: `virtual://${l.fileName}`,
    rel_path: l.fileName,
    ext: "c",
    is_dir: false,
    depth: 0,
  }));
  const starter = ROTEIRO_LESSONS[3];
  openVirtualTab(`virtual://${starter.fileName}`, starter.fileName, starter.code);
  renderAll();
}

function openVirtualTab(path: string, name: string, content: string): void {
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) {
    activateTab(existing.path);
    return;
  }
  state.tabs.push({
    path,
    name,
    ext: fileExt(name),
    content,
    savedContent: content,
    dirty: false,
    virtualOnly: true,
    lossyUtf8: false,
  });
  activateTab(path);
}

async function openDiskFile(filePath: string): Promise<void> {
  const existing = state.tabs.find(
    (t) => normalizePathKey(t.path) === normalizePathKey(filePath)
  );
  if (existing) {
    activateTab(existing.path);
    return;
  }

  if (!isTauriRuntime() && filePath.startsWith("virtual://")) {
    const fileName = filePath.replace("virtual://", "");
    const lesson = ROTEIRO_LESSONS.find((l) => l.fileName === fileName);
    if (lesson) {
      openVirtualTab(filePath, lesson.fileName, lesson.code);
    }
    return;
  }

  try {
    const file = await readTextFile(filePath);
    state.tabs.push({
      path: file.path,
      name: file.name,
      ext: fileExt(file.name),
      content: file.content,
      savedContent: file.content,
      dirty: false,
      virtualOnly: false,
      lossyUtf8: file.lossy_utf8,
    });
    if (file.lossy_utf8) {
      toast(`"${file.name}" aberto com fallback Latin-1 → será salvo em UTF-8.`);
    }
    activateTab(file.path);
  } catch (err) {
    toast(`Erro ao abrir arquivo: ${String(err)}`);
  }
}

async function openRoteiroLesson(fileName: string): Promise<void> {
  const lesson = ROTEIRO_LESSONS.find((l) => l.fileName === fileName);
  if (!lesson) return;

  if (isTauriRuntime()) {
    const existingEntry = state.workspaceEntries.find(
      (e) => !e.is_dir && e.name.toLowerCase() === fileName.toLowerCase()
    );
    if (existingEntry) {
      await openDiskFile(existingEntry.path);
      return;
    }
    const ws = await ensureRoteiroWorkspace(
      ROTEIRO_LESSONS.map((l) => ({ name: l.fileName, content: l.code }))
    );
    state.workspaceDir = ws.dir_path;
    state.workspaceEntries = ws.entries;
    const match = ws.entries.find((e) => !e.is_dir && e.name === fileName);
    if (match) {
      await openDiskFile(match.path);
      return;
    }
  }

  openVirtualTab(`virtual://${lesson.fileName}`, lesson.fileName, lesson.code);
}

function activateTab(path: string): void {
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab) return;
  state.activePath = tab.path;
  primaryEditor.openDocument(
    tab.path,
    tab.content,
    state.breakpoints.get(tab.path) ?? []
  );
  applyDiagnosticsToEditor();
  syncSecondaryEditor();
  renderAll();
}

function syncSecondaryEditor(): void {
  const secHost = el<HTMLDivElement>("secondaryEditorHost");
  secHost.classList.toggle("open", state.splitOpen);
  el<HTMLButtonElement>("btnSplit").classList.toggle("active", state.splitOpen);
  if (!state.splitOpen) return;

  const other =
    state.tabs.find((t) => t.path !== state.activePath) ?? getActiveTab();
  if (other) {
    secondaryEditor.openDocument(
      other.path,
      other.content,
      state.breakpoints.get(other.path) ?? []
    );
  }
}

function closeTab(path: string): void {
  const idx = state.tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (tab.dirty) {
    const proceed = window.confirm(
      `O arquivo "${tab.name}" tem alterações não salvas. Fechar mesmo assim?`
    );
    if (!proceed) return;
  }
  state.tabs.splice(idx, 1);
  primaryEditor.dropCachedDocument(path);
  secondaryEditor.dropCachedDocument(path);

  if (state.activePath === path) {
    const next = state.tabs[Math.max(0, idx - 1)] ?? null;
    state.activePath = next ? next.path : null;
    if (next) {
      primaryEditor.openDocument(
        next.path,
        next.content,
        state.breakpoints.get(next.path) ?? []
      );
      applyDiagnosticsToEditor();
    } else {
      primaryEditor.openDocument("__empty__", "", []);
    }
  }
  syncSecondaryEditor();
  renderAll();
}

async function saveActiveTab(forceSaveAs = false): Promise<boolean> {
  const tab = getActiveTab();
  if (!tab) {
    toast("Nenhum arquivo aberto para salvar.");
    return false;
  }

  let targetPath = tab.path;
  if (forceSaveAs || tab.virtualOnly) {
    if (!isTauriRuntime()) {
      tab.savedContent = tab.content;
      tab.dirty = false;
      renderTabs();
      toast(`"${tab.name}" salvo em memória (modo navegador).`);
      return true;
    }
    const chosen = await pickSaveFileDialog(
      state.workspaceDir ? `${state.workspaceDir}\\${tab.name}` : tab.name
    );
    if (!chosen) return false;
    targetPath = chosen;
  }

  try {
    await writeTextFile(targetPath, tab.content);
    const oldPath = tab.path;
    tab.path = targetPath;
    tab.name = baseName(targetPath);
    tab.ext = fileExt(tab.name);
    tab.savedContent = tab.content;
    tab.dirty = false;
    tab.virtualOnly = false;
    if (oldPath !== targetPath) {
      state.activePath = targetPath;
      primaryEditor.dropCachedDocument(oldPath);
      primaryEditor.openDocument(
        targetPath,
        tab.content,
        state.breakpoints.get(oldPath) ?? []
      );
    }
    await refreshWorkspaceTree();
    renderAll();
    return true;
  } catch (err) {
    toast(`Erro ao salvar: ${String(err)}`);
    return false;
  }
}

async function handleOpenFolder(): Promise<void> {
  const dir = await pickFolderDialog();
  if (!dir) return;
  state.workspaceDir = dir;
  state.sidebarOpen = true;
  state.sidebarPanel = "files";
  await refreshWorkspaceTree();
  appendTerminalChunk(`Pasta aberta: ${dir}\n`, "term-ok");
  const firstFile = state.workspaceEntries.find((e) => !e.is_dir);
  if (firstFile) {
    await openDiskFile(firstFile.path);
  }
  toast(`Workspace alterado para ${baseName(dir)}`);
}

async function handleOpenFile(): Promise<void> {
  const filePath = await pickOpenFileDialog();
  if (!filePath) return;
  await openDiskFile(filePath);
}

async function handleCreateFromTemplate(): Promise<void> {
  const tpl = C_TEMPLATES[state.selectedTemplateIdx];
  const fileName = el<HTMLInputElement>("tplFileNameInput").value.trim();
  if (!fileName) {
    toast("Informe um nome de arquivo (ex: exercicio.c).");
    return;
  }

  if (!isTauriRuntime()) {
    openVirtualTab(`virtual://${fileName}`, fileName, tpl.code);
    closeModal("templateModal");
    toast(`Criado "${fileName}" em memória (modo navegador).`);
    return;
  }

  let targetDir = state.workspaceDir;
  if (!targetDir) {
    const ws = await ensureRoteiroWorkspace([]);
    targetDir = ws.dir_path;
    state.workspaceDir = targetDir;
  }

  try {
    const created = await createFileFromTemplate(targetDir, fileName, tpl.code, false);
    closeModal("templateModal");
    await refreshWorkspaceTree();
    await openDiskFile(created.path);
    toast(`Arquivo "${created.name}" criado em ${baseName(targetDir)}.`);
  } catch (err) {
    toast(String(err));
  }
}

async function runWorkspaceSearch(query: string): Promise<void> {
  state.searchQuery = query;
  if (query.trim().length < 2) {
    state.searchResults = [];
    renderSidebar();
    return;
  }

  if (state.workspaceDir && isTauriRuntime()) {
    try {
      state.searchResults = await searchInDirectory(state.workspaceDir, query);
    } catch (err) {
      toast(`Erro na busca: ${String(err)}`);
      state.searchResults = [];
    }
  } else {
    const q = query.trim().toLowerCase();
    const out: SearchMatch[] = [];
    for (const tab of state.tabs) {
      tab.content.split("\n").forEach((line, idx) => {
        const col = line.toLowerCase().indexOf(q);
        if (col >= 0) {
          out.push({
            path: tab.path,
            rel_path: tab.name,
            line: idx + 1,
            column: col + 1,
            snippet: line.trim(),
          });
        }
      });
    }
    state.searchResults = out;
  }
  renderSidebar();
}

// ===================== REAL COMPILE / RUN / STOP / ASTYLE =====================
function syncRunControls(): void {
  el<HTMLButtonElement>("btnStopRun").classList.toggle("hidden", !state.isRunning);
  const showStdin =
    state.isRunning && state.drawerOpen && state.drawerTab === "terminal";
  el<HTMLFormElement>("stdinBar").classList.toggle("hidden", !showStdin);
}

async function compileActiveFile(andRun: boolean): Promise<void> {
  if (state.isCompiling) return;
  const tab = getActiveTab();
  if (!tab) {
    toast("Abra um arquivo .c ou .cpp antes de compilar.");
    return;
  }
  if (!isTauriRuntime()) {
    toast("Compilação real requer o app desktop (npm run tauri dev).");
    return;
  }

  // Always save before compiling
  if (tab.dirty || tab.virtualOnly) {
    const ok = await saveActiveTab(false);
    if (!ok) return;
  }

  const profile =
    COMPILER_PROFILES.find((p) => p.id === state.selectedProfileId) ??
    COMPILER_PROFILES[0];
  const isCppExt = ["cpp", "cc", "cxx", "hpp"].includes(tab.ext);
  const compiler: "gcc" | "g++" = isCppExt ? "g++" : profile.compiler;
  const flags =
    isCppExt && profile.compiler === "gcc"
      ? ["-std=c++17", "-Wall", "-Wextra", "-g", "-static-libgcc"]
      : profile.flags;

  state.isCompiling = true;
  state.drawerOpen = true;
  state.compileLog = [`[Build] ${profile.label}`, `[Arquivo] ${tab.path}`];
  renderStatus();

  try {
    const res = await compileSource(tab.path, compiler, flags);
    state.diagnostics = res.diagnostics;
    applyDiagnosticsToEditor();

    state.compileLog = [
      `[Comando] ${res.command_line}`,
      ...(res.raw_output ? res.raw_output.split("\n") : []),
      res.success
        ? `[Sucesso] ${baseName(res.executable_path)} gerado em ${res.duration_ms} ms.`
        : `[Falha] Compilação encerrada com erro em ${res.duration_ms} ms.`,
    ];

    const errCount = res.diagnostics.filter((d) => d.severity === "error").length;
    const warnCount = res.diagnostics.filter((d) => d.severity === "warning").length;

    if (!res.success) {
      state.drawerTab = "problems";
      renderAll();
      const firstErr =
        res.diagnostics.find((d) => d.severity === "error") ?? res.diagnostics[0];
      if (firstErr) {
        await jumpToDiagnostic(firstErr);
      }
      toast(
        `Compilação falhou (${errCount} erro(s), ${warnCount} aviso(s)) em ${res.duration_ms} ms.`
      );
      return;
    }

    state.lastExecutableBySource.set(tab.path, res.executable_path);
    if (andRun) {
      state.terminalChunks = [
        {
          cls: "term-ok",
          text: `✓ Compilado (${compiler}.exe) em ${res.duration_ms} ms${warnCount > 0 ? ` · ${warnCount} aviso(s)` : ""}\n`,
        },
        {
          cls: "term-muted",
          text: `▶ Executando ${baseName(res.executable_path)}...\n`,
        },
      ];
      state.drawerTab = "terminal";
      renderAll();
      await launchExecutable(res.executable_path, dirName(tab.path));
    } else {
      state.drawerTab = warnCount > 0 ? "problems" : "log";
      renderAll();
      toast(
        `Compilado com sucesso em ${res.duration_ms} ms${warnCount > 0 ? ` (${warnCount} aviso(s))` : ""}!`
      );
    }
  } catch (err) {
    state.compileLog.push(`[Erro] ${String(err)}`);
    state.drawerTab = "log";
    renderAll();
    toast(`Erro ao compilar: ${String(err)}`);
  } finally {
    state.isCompiling = false;
    renderStatus();
  }
}

async function launchExecutable(
  executablePath: string,
  workingDir: string
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    state.isRunning = !state.useConsolePauser;
    syncRunControls();
    const runId = await runProgram(executablePath, {
      workingDir,
      useConsolePauser: state.useConsolePauser,
    });
    state.activeRunId = runId;
    syncRunControls();
    if (state.isRunning) {
      el<HTMLInputElement>("stdinInput").focus();
    }
  } catch (err) {
    state.isRunning = false;
    syncRunControls();
    appendTerminalChunk(`\n[Erro ao executar] ${String(err)}\n`, "term-err");
    toast(`Erro ao executar: ${String(err)}`);
  }
}

async function runCurrentProgram(): Promise<void> {
  const tab = getActiveTab();
  if (!tab) {
    toast("Nenhum arquivo aberto.");
    return;
  }
  const knownExe =
    state.lastExecutableBySource.get(tab.path) ??
    tab.path.replace(/\.(c|cpp|cc|cxx)$/i, ".exe");

  state.drawerOpen = true;
  state.drawerTab = "terminal";
  state.terminalChunks = [
    { cls: "term-muted", text: `▶ Executando ${baseName(knownExe)}...\n` },
  ];
  renderDrawer();
  await launchExecutable(knownExe, dirName(tab.path));
}

async function stopExecution(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const stopped = await stopRunningProgram();
    if (stopped) {
      toast("Programa interrompido.");
    }
  } catch (err) {
    toast(`Erro ao parar execução: ${String(err)}`);
  }
}

async function handleSendStdin(rawValue: string): Promise<void> {
  if (!state.isRunning) return;
  try {
    await sendProgramStdin(rawValue);
    appendTerminalChunk(`${rawValue}\n`, "term-stdin");
  } catch (err) {
    appendTerminalChunk(`[stdin erro] ${String(err)}\n`, "term-err");
  }
}

async function formatActiveWithAStyle(): Promise<void> {
  const tab = getActiveTab();
  if (!tab) {
    toast("Abra um arquivo C/C++ para formatar.");
    return;
  }
  if (!isTauriRuntime()) {
    toast("Formatação via AStyle.exe requer o app desktop (npm run tauri dev).");
    return;
  }

  try {
    const res = await formatWithAStyle(
      tab.content,
      state.settings.astyleStyle,
      state.settings.tabSize
    );
    if (!res.changed) {
      toast(`Código já está formatado (${res.command_summary}).`);
      return;
    }
    primaryEditor.replaceContentPreservingUndo(res.formatted_code);
    toast(`Formatado com ${res.command_summary} (Ctrl+Z para desfazer).`);
  } catch (err) {
    toast(`Erro no AStyle: ${String(err)}`);
  }
}

async function jumpToDiagnostic(diag: CompileDiagnostic): Promise<void> {
  const activeTab = getActiveTab();
  if (diag.file) {
    let targetPath = diag.file;
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(targetPath) || targetPath.startsWith("/");
    if (!isAbsolute && activeTab) {
      const base = dirName(activeTab.path);
      if (base) targetPath = `${base}\\${targetPath}`;
    }
    if (!activeTab || normalizePathKey(activeTab.path) !== normalizePathKey(targetPath)) {
      await openDiskFile(targetPath);
    }
  }
  primaryEditor.goToLine(diag.line);
}

// ===================== TOOLCHAIN =====================
async function loadToolchain(): Promise<void> {
  const report = await detectToolchain();
  state.toolchain = report;
  const foundCount = report.tools.filter((t) => t.found).length;
  const gcc = report.tools.find((t) => t.name === "gcc");

  el<HTMLSpanElement>("statusToolchain").textContent = gcc?.found
    ? `Toolchain OK (${foundCount}/5 · gcc.exe)`
    : isTauriRuntime()
      ? `Toolchain parcial (${foundCount}/5)`
      : "Modo Navegador (Vite)";

  el<HTMLSpanElement>("statusDot").style.background = gcc?.found
    ? "var(--success)"
    : "var(--warning)";

  renderToolchainModalList();
}

function renderToolchainModalList(): void {
  const baseEl = el<HTMLDivElement>("toolchainBaseDir");
  const listEl = el<HTMLUListElement>("toolchainList");
  const report = state.toolchain;
  if (!report) return;

  baseEl.textContent = `Base configurada: ${report.base_dir}`;
  listEl.innerHTML = report.tools
    .map(
      (t) => `
      <li class="tool-item ${t.found ? "ok" : "missing"}">
        <span class="tool-name">${escapeHtml(t.name)}</span>
        <span class="tool-path">${escapeHtml(t.path ?? "Não encontrado")}</span>
      </li>`
    )
    .join("");
}

// ===================== RENDERERS =====================
function renderAll(): void {
  renderTabs();
  renderBreadcrumb();
  renderSidebar();
  renderDrawer();
  renderStatus();
}

function renderTabs(): void {
  const list = el<HTMLDivElement>("tabList");
  if (state.tabs.length === 0) {
    list.innerHTML = `<div class="editor-tab" style="cursor:default;opacity:0.6;">Nenhum arquivo aberto</div>`;
    return;
  }
  list.innerHTML = state.tabs
    .map((tab) => {
      const active = tab.path === state.activePath;
      const dot = dotClassForExt(tab.ext, tab.name);
      return `
        <div class="editor-tab ${active ? "active" : ""}" data-tab-path="${escapeHtml(tab.path)}">
          <span class="file-dot ${dot}"></span>
          <span>${escapeHtml(tab.name)}</span>
          ${tab.dirty ? '<span class="dirty-dot" title="Alterações não salvas"></span>' : ""}
          <button class="tab-close" data-close-tab="${escapeHtml(tab.path)}" type="button" title="Fechar aba (Ctrl+W)">×</button>
        </div>
      `;
    })
    .join("");
}

function renderBreadcrumb(): void {
  const tab = getActiveTab();
  el<HTMLSpanElement>("crumbWorkspace").textContent = state.workspaceDir
    ? baseName(state.workspaceDir)
    : "Sem Workspace";
  el<HTMLSpanElement>("crumbFile").textContent = tab ? tab.name : "—";

  const symbols = tab ? extractCSymbols(tab.content) : [];
  let activeSym = symbols[0]?.label ?? "(global)";
  for (const s of symbols) {
    if (s.line <= state.cursorLine) activeSym = s.label;
  }
  el<HTMLSpanElement>("crumbSymbol").textContent = activeSym;

  const lesson = tab
    ? ROTEIRO_LESSONS.find((l) => l.fileName === tab.name)
    : undefined;
  el<HTMLSpanElement>("blockChip").textContent = lesson
    ? `${lesson.block} (${lesson.split})`
    : tab
      ? `${tab.ext.toUpperCase() || "TEXT"} · ${tab.dirty ? "Modificado" : "Salvo"}`
      : "C11 · Pronto";
}

function renderSidebar(): void {
  el<HTMLElement>("sidebar").classList.toggle("hidden", !state.sidebarOpen);
  document.querySelectorAll<HTMLButtonElement>(".rail-btn[data-panel]").forEach((btn) => {
    btn.classList.toggle(
      "active",
      state.sidebarOpen && btn.dataset.panel === state.sidebarPanel
    );
  });

  const titleEl = el<HTMLSpanElement>("sidebarTitle");
  const body = el<HTMLDivElement>("sidebarBody");
  const activeTab = getActiveTab();

  if (state.sidebarPanel === "roteiro") {
    titleEl.textContent = "Roteiro C · 2º Semestre";
    body.innerHTML = ROTEIRO_LESSONS.map((lesson) => {
      const isCurrent = activeTab?.name === lesson.fileName;
      return `
        <div class="roteiro-item ${isCurrent ? "active" : ""}" data-roteiro-file="${escapeHtml(lesson.fileName)}">
          <div class="roteiro-meta">
            <span>${escapeHtml(lesson.time)}</span>
            <span>${escapeHtml(lesson.split)}</span>
          </div>
          <div class="roteiro-title">${escapeHtml(lesson.block)}</div>
          <div class="roteiro-desc">${escapeHtml(lesson.desc)}</div>
          ${isCurrent ? `<div class="paper-note">✏️ ${escapeHtml(lesson.paper)}</div>` : ""}
        </div>`;
    }).join("");
  } else if (state.sidebarPanel === "files") {
    titleEl.textContent = "Arquivos do Workspace";
    const headerTools = `
      <div class="sidebar-toolbar">
        <button class="btn btn-subtle" id="sbOpenFolder" type="button" style="flex:1;height:26px;font-size:11.5px;">Abrir Pasta</button>
        <button class="btn btn-subtle" id="sbNewFile" type="button" style="flex:1;height:26px;font-size:11.5px;">+ Novo .c</button>
      </div>
      <div class="tree-section-title">
        <span>${escapeHtml(state.workspaceDir ? baseName(state.workspaceDir) : "SEM PASTA")}</span>
        <span>${state.workspaceEntries.filter((e) => !e.is_dir).length}</span>
      </div>`;

    const treeHtml =
      state.workspaceEntries.length > 0
        ? state.workspaceEntries
            .map((entry) => {
              const pad = 8 + entry.depth * 14;
              if (entry.is_dir) {
                return `<div class="tree-item dir-item" style="padding-left:${pad}px;">📁 ${escapeHtml(entry.name)}</div>`;
              }
              const active = entry.path === state.activePath;
              return `
                <button class="tree-item ${active ? "active" : ""}" style="padding-left:${pad}px;" data-open-path="${escapeHtml(entry.path)}" type="button">
                  <span class="file-dot ${dotClassForExt(entry.ext, entry.name)}"></span>
                  <span>${escapeHtml(entry.name)}</span>
                  ${entry.ext ? `<span class="ext-badge">.${escapeHtml(entry.ext)}</span>` : ""}
                </button>`;
            })
            .join("")
        : `<div class="muted-hint" style="padding:8px;">Nenhum arquivo C/C++ encontrado nesta pasta.</div>`;

    body.innerHTML = headerTools + treeHtml;
  } else if (state.sidebarPanel === "outline") {
    titleEl.textContent = "Funções & Structs";
    const symbols = activeTab ? extractCSymbols(activeTab.content) : [];
    body.innerHTML = `
      <div class="tree-section-title">
        <span>${escapeHtml(activeTab?.name ?? "ARQUIVO")}</span>
        <span>${symbols.length}</span>
      </div>
      ${
        symbols.length > 0
          ? symbols
              .map(
                (s) => `
              <button class="tree-item" data-jump-line="${s.line}" type="button">
                <span class="sym-kind">${s.kind}</span>
                <span style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(s.label)}</span>
                <span class="ext-badge">:${s.line}</span>
              </button>`
              )
              .join("")
          : `<div class="muted-hint" style="padding:8px;">Nenhuma função ou struct detectada no arquivo atual.</div>`
      }`;
  } else if (state.sidebarPanel === "search") {
    titleEl.textContent = "Buscar no Workspace";
    body.innerHTML = `
      <input class="text-input" id="sbSearchInput" style="width:100%;margin-bottom:8px;" placeholder="Pesquisar em .c / .h (ex: troca, Aluno)..." value="${escapeHtml(state.searchQuery)}" />
      <div class="tree-section-title">
        <span>RESULTADOS</span>
        <span>${state.searchResults.length}</span>
      </div>
      ${
        state.searchResults.length > 0
          ? state.searchResults
              .map(
                (m) => `
              <button class="tree-item" style="flex-direction:column;align-items:flex-start;gap:2px;" data-search-path="${escapeHtml(m.path)}" data-search-line="${m.line}" type="button">
                <span style="font-size:11px;color:var(--accent-hover);">${escapeHtml(m.rel_path)}:${m.line}</span>
                <span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;">${escapeHtml(m.snippet)}</span>
              </button>`
              )
              .join("")
          : `<div class="muted-hint" style="padding:8px;">Digite 2+ caracteres para buscar nos arquivos do workspace via Rust.</div>`
      }`;
  } else if (state.sidebarPanel === "debug") {
    titleEl.textContent = "Memória & Breakpoints";
    const allBps: Array<{ path: string; name: string; line: number }> = [];
    state.breakpoints.forEach((lines, path) => {
      for (const line of lines) {
        allBps.push({ path, name: baseName(path), line });
      }
    });
    body.innerHTML = `
      <div class="debug-card">
        <div class="debug-card-title">
          <span>Visualizador de Memória (SVG)</span>
          <span>ENTREGA 3</span>
        </div>
        <div class="muted-hint" style="line-height:1.45;">
          Na <strong>Entrega 3</strong>, este painel receberá variáveis, endereços (<code>&amp;x</code>) e ponteiros (<code>*p</code>, <code>a-&gt;campo</code>) ao vivo via <code>gdb.exe --interpreter=mi2</code>.
        </div>
      </div>
      <div class="debug-card">
        <div class="debug-card-title">
          <span>Breakpoints Ativos (Calha CM6)</span>
          <span>${allBps.length}</span>
        </div>
        ${
          allBps.length > 0
            ? allBps
                .map(
                  (bp) => `
                <button class="tree-item" data-search-path="${escapeHtml(bp.path)}" data-search-line="${bp.line}" type="button">
                  <span style="width:8px;height:8px;border-radius:50%;background:var(--error);flex-shrink:0;"></span>
                  <span>${escapeHtml(bp.name)}</span>
                  <span class="ext-badge">Ln ${bp.line}</span>
                </button>`
                )
                .join("")
            : `<div class="muted-hint">Clique na coluna esquerda do editor ou pressione <strong>F4</strong> para marcar breakpoints.</div>`
        }
      </div>`;
  }
}

function renderDrawer(): void {
  el<HTMLElement>("bottomDrawer").classList.toggle("hidden", !state.drawerOpen);
  document.querySelectorAll<HTMLButtonElement>(".drawer-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.dtab === state.drawerTab);
  });

  const actionableDiags = state.diagnostics.filter(
    (d) => d.severity === "error" || d.severity === "warning"
  );
  const hasErr = actionableDiags.some((d) => d.severity === "error");
  const pCount = el<HTMLSpanElement>("problemsCount");
  pCount.textContent = String(actionableDiags.length);
  pCount.className = `pill-count${hasErr ? " err" : actionableDiags.length > 0 ? " warn" : ""}`;

  const body = el<HTMLDivElement>("drawerBody");
  if (state.drawerTab === "terminal") {
    const spans = state.terminalChunks
      .map((c) => `<span class="${escapeHtml(c.cls)}">${escapeHtml(c.text)}</span>`)
      .join("");
    body.innerHTML = `<pre class="terminal-pre">${spans}</pre>`;
  } else if (state.drawerTab === "problems") {
    if (state.diagnostics.length === 0) {
      body.innerHTML = `<div class="term-ok" style="font-family:var(--font-ui);">✓ Nenhum erro ou aviso no último build.</div>`;
    } else {
      body.innerHTML = state.diagnostics
        .map((d, idx) => {
          const badgeLabel =
            d.severity === "error"
              ? "Erro GCC"
              : d.severity === "warning"
                ? "Aviso"
                : "Nota";
          const loc = d.file
            ? `${baseName(d.file)}:${d.line}:${d.column}`
            : `Ln ${d.line}`;
          return `
            <div class="diag-card" data-diag-idx="${idx}">
              <div class="diag-top">
                <span class="diag-badge ${d.severity}">${badgeLabel}</span>
                <span class="diag-msg">${escapeHtml(d.message)}</span>
                <span class="diag-loc">${escapeHtml(loc)}</span>
              </div>
              ${d.hint ? `<div class="diag-hint">💡 ${escapeHtml(d.hint)}</div>` : ""}
            </div>`;
        })
        .join("");
    }
  } else if (state.drawerTab === "trace") {
    body.innerHTML = `<div class="term-muted" style="font-family:var(--font-ui);">A tabela automática de <strong>Teste de Mesa</strong> será alimentada pelo depurador GDB/MI na Entrega 3.</div>`;
  } else {
    body.innerHTML = state.compileLog
      .map((l) => `<div class="term-line term-muted">${escapeHtml(l)}</div>`)
      .join("");
  }

  body.scrollTop = body.scrollHeight;
  syncRunControls();
}

function renderStatus(): void {
  el<HTMLSpanElement>("statusCursor").textContent = `Ln ${state.cursorLine}, Col ${state.cursorCol}`;
  el<HTMLSpanElement>("statusWorkspacePath").textContent = state.workspaceDir
    ? `Pasta: ${state.workspaceDir}`
    : "Workspace: nenhum";

  const errs = state.diagnostics.filter((d) => d.severity === "error").length;
  const warns = state.diagnostics.filter((d) => d.severity === "warning").length;
  el<HTMLSpanElement>("statusDiag").textContent = state.isCompiling
    ? "Compilando..."
    : state.isRunning
      ? "Executando..."
      : `${errs} erro(s) · ${warns} aviso(s)`;

  const profile =
    COMPILER_PROFILES.find((p) => p.id === state.selectedProfileId) ??
    COMPILER_PROFILES[0];
  el<HTMLSpanElement>("statusLang").textContent = profile.stdFlag.replace("-std=", "").toUpperCase();

  const astyleLabel =
    state.settings.astyleStyle === "-A3"
      ? "-A3 K&R"
      : state.settings.astyleStyle === "-A1"
        ? "-A1 Allman"
        : "-A2 Java";
  el<HTMLSpanElement>("statusAStyle").textContent = `AStyle (${astyleLabel})`;
  el<HTMLSpanElement>("statusKeymap").textContent =
    state.settings.keymap === "hybrid" ? "Keymap: Híbrido" : "Keymap: Clássico";
}

// ===================== TEMPLATES, SETTINGS & COMMAND PALETTE =====================
function openModal(id: string): void {
  el<HTMLDivElement>(id).classList.add("open");
  if (id === "templateModal") {
    renderTemplatesModal();
  } else if (id === "settingsModal") {
    renderToolchainModalList();
  }
}

function closeModal(id: string): void {
  el<HTMLDivElement>(id).classList.remove("open");
}

function renderTemplatesModal(): void {
  const grid = el<HTMLDivElement>("tplGrid");
  grid.innerHTML = C_TEMPLATES.map(
    (tpl, idx) => `
      <button class="tpl-card ${idx === state.selectedTemplateIdx ? "selected" : ""}" data-tpl-idx="${idx}" type="button">
        <div class="tpl-cat">${escapeHtml(tpl.cat)}</div>
        <div class="tpl-name">${escapeHtml(tpl.name)}</div>
        <div class="tpl-desc">${escapeHtml(tpl.desc)}</div>
      </button>`
  ).join("");

  const active = C_TEMPLATES[state.selectedTemplateIdx];
  el<HTMLInputElement>("tplFileNameInput").value = active.defaultFile;
  el<HTMLSpanElement>("tplTargetDirHint").textContent = state.workspaceDir
    ? `Em: ${baseName(state.workspaceDir)}`
    : "Em: Documents\\DEVSHOW-C-Roteiro";
  el<HTMLPreElement>("tplPreview").textContent = active.code;
}

function applyTheme(theme: ThemeMode): void {
  state.settings.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  el<HTMLSelectElement>("setTheme").value = theme;
  el<SVGElement>("themeIcon").innerHTML =
    theme === "dark"
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
}

function applyTypography(): void {
  document.documentElement.style.setProperty("--font-mono", state.settings.fontFamily);
  document.documentElement.style.setProperty(
    "--editor-font-size",
    `${state.settings.fontSizePx}px`
  );
}

function getPaletteCommands(): PaletteCommand[] {
  const base: PaletteCommand[] = [
    { cat: "Build", label: "Compile & Run (Compilar e Executar)", kbd: "F11", run: () => { void compileActiveFile(true); } },
    { cat: "Build", label: "Compile (Compilar com gcc/g++)", kbd: "F9", run: () => { void compileActiveFile(false); } },
    { cat: "Build", label: "Run (Executar último executável)", kbd: "F10", run: () => { void runCurrentProgram(); } },
    { cat: "Build", label: "Parar Programa em Execução", kbd: "F6", run: () => { void stopExecution(); } },
    { cat: "AStyle", label: "Formatar Código Atual com AStyle.exe", kbd: "Ctrl+Shift+A", run: () => { void formatActiveWithAStyle(); } },
    { cat: "Arquivo", label: "Salvar Arquivo Atual", kbd: "Ctrl+S", run: () => { void saveActiveTab(false); } },
    { cat: "Arquivo", label: "Salvar Como...", kbd: "Ctrl+Shift+S", run: () => { void saveActiveTab(true); } },
    { cat: "Arquivo", label: "Abrir Pasta de Projeto", kbd: "Ctrl+Shift+O", run: () => { void handleOpenFolder(); } },
    { cat: "Arquivo", label: "Abrir Arquivo .c/.h", kbd: "Ctrl+O", run: () => { void handleOpenFile(); } },
    { cat: "Template", label: "Novo Arquivo a partir de Template C", kbd: "Ctrl+Shift+N", run: () => openModal("templateModal") },
    { cat: "Editor", label: "Localizar e Substituir Inline", kbd: "Ctrl+F", run: () => primaryEditor.openFind() },
    { cat: "Editor", label: "Autocomplete C", kbd: "Ctrl+Space", run: () => primaryEditor.triggerAutocomplete() },
    { cat: "Editor", label: "Alternar Split View", kbd: "Ctrl+\\", run: () => { state.splitOpen = !state.splitOpen; syncSecondaryEditor(); } },
    { cat: "Editor", label: "Alternar Breakpoint na Linha Atual", kbd: "F4", run: () => primaryEditor.toggleBreakpointAtCurrentLine() },
    { cat: "Tema", label: "Alternar Tema Dark / Daylight Paper", kbd: "", run: () => applyTheme(state.settings.theme === "dark" ? "light" : "dark") },
    { cat: "View", label: "Alternar Painel Inferior", kbd: "Ctrl+`", run: () => { state.drawerOpen = !state.drawerOpen; renderDrawer(); } },
    { cat: "Config", label: "Configurações & Toolchain", kbd: "Ctrl+,", run: () => openModal("settingsModal") },
  ];

  const lessons: PaletteCommand[] = ROTEIRO_LESSONS.map((l) => ({
    cat: "Roteiro",
    label: `Abrir ${l.block} (${l.fileName})`,
    kbd: "",
    run: () => { void openRoteiroLesson(l.fileName); },
  }));

  return [...base, ...lessons];
}

function getFilteredPalette(): PaletteCommand[] {
  const q = el<HTMLInputElement>("paletteInput").value.trim().toLowerCase();
  return getPaletteCommands().filter((c) =>
    `${c.cat} ${c.label}`.toLowerCase().includes(q)
  );
}

function openPalette(): void {
  paletteIndex = 0;
  el<HTMLInputElement>("paletteInput").value = "";
  openModal("paletteModal");
  renderPaletteList();
  window.setTimeout(() => el<HTMLInputElement>("paletteInput").focus(), 20);
}

function renderPaletteList(): void {
  const items = getFilteredPalette();
  if (paletteIndex >= items.length) paletteIndex = 0;
  const list = el<HTMLDivElement>("paletteList");
  list.innerHTML =
    items.length > 0
      ? items
          .map(
            (c, idx) => `
          <div class="palette-item ${idx === paletteIndex ? "selected" : ""}" data-pal-idx="${idx}">
            <div><span class="palette-cat">${escapeHtml(c.cat)}</span><span>${escapeHtml(c.label)}</span></div>
            ${c.kbd ? `<span class="kbd">${escapeHtml(c.kbd)}</span>` : ""}
          </div>`
          )
          .join("")
      : `<div class="muted-hint" style="padding:14px;text-align:center;">Nenhum comando encontrado.</div>`;
}

function execPaletteIndex(idx: number): void {
  const items = getFilteredPalette();
  const item = items[idx];
  if (!item) return;
  closeModal("paletteModal");
  void item.run();
}

// ===================== SPLITTERS & EVENTS =====================
function initSplitters(): void {
  const leftSpl = el<HTMLDivElement>("splitterLeft");
  const botSpl = el<HTMLDivElement>("splitterBottom");

  leftSpl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    leftSpl.classList.add("dragging");
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(200, Math.min(480, ev.clientX - 46));
      document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    };
    const onUp = () => {
      leftSpl.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  botSpl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    botSpl.classList.add("dragging");
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(
        100,
        Math.min(window.innerHeight * 0.55, window.innerHeight - ev.clientY - 26)
      );
      document.documentElement.style.setProperty("--drawer-h", `${h}px`);
    };
    const onUp = () => {
      botSpl.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function bindEvents(): void {
  const compSel = el<HTMLSelectElement>("compilerSelect");
  compSel.innerHTML = COMPILER_PROFILES.map(
    (p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`
  ).join("");
  compSel.addEventListener("change", () => {
    state.selectedProfileId = compSel.value;
    renderStatus();
  });

  // Header buttons
  el<HTMLButtonElement>("btnBrand").addEventListener("click", () => openModal("settingsModal"));
  el<HTMLButtonElement>("btnOpenFolder").addEventListener("click", () => { void handleOpenFolder(); });
  el<HTMLButtonElement>("btnOpenFile").addEventListener("click", () => { void handleOpenFile(); });
  el<HTMLButtonElement>("btnSave").addEventListener("click", () => {
    void saveActiveTab(false).then((ok) => {
      if (ok) toast("Arquivo salvo.");
    });
  });
  el<HTMLButtonElement>("btnTemplates").addEventListener("click", () => openModal("templateModal"));
  el<HTMLButtonElement>("btnCompile").addEventListener("click", () => { void compileActiveFile(false); });
  el<HTMLButtonElement>("btnRunOnly").addEventListener("click", () => { void runCurrentProgram(); });
  el<HTMLButtonElement>("btnCompileRun").addEventListener("click", () => { void compileActiveFile(true); });
  el<HTMLButtonElement>("btnStopRun").addEventListener("click", () => { void stopExecution(); });
  el<HTMLButtonElement>("btnStopDrawer").addEventListener("click", () => { void stopExecution(); });
  el<HTMLButtonElement>("btnAStyle").addEventListener("click", () => { void formatActiveWithAStyle(); });
  el<HTMLButtonElement>("btnDebug").addEventListener("click", () => {
    state.sidebarOpen = true;
    state.sidebarPanel = "debug";
    renderSidebar();
    toast("Depurador GDB/MI + Memória SVG ao vivo entra na Entrega 3!");
  });

  el<HTMLButtonElement>("btnPalette").addEventListener("click", openPalette);
  el<HTMLButtonElement>("btnSplit").addEventListener("click", () => {
    state.splitOpen = !state.splitOpen;
    syncSecondaryEditor();
  });
  el<HTMLButtonElement>("btnTheme").addEventListener("click", () => {
    const next: ThemeMode = state.settings.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    toast(next === "dark" ? "Tema Obsidian Slate (Dark)" : "Tema Daylight Paper (Light)");
  });
  el<HTMLButtonElement>("btnSettings").addEventListener("click", () => openModal("settingsModal"));
  el<HTMLSpanElement>("statusToolchainBtn").addEventListener("click", () => openModal("settingsModal"));
  el<HTMLSpanElement>("statusDiag").addEventListener("click", () => {
    state.drawerOpen = true;
    state.drawerTab = "problems";
    renderDrawer();
  });
  el<HTMLButtonElement>("btnRefreshToolchain").addEventListener("click", () => { void loadToolchain(); });

  // Editor bar
  el<HTMLButtonElement>("btnInlineFind").addEventListener("click", () => primaryEditor.openFind());
  el<HTMLButtonElement>("btnComplete").addEventListener("click", () => primaryEditor.triggerAutocomplete());
  el<HTMLSpanElement>("crumbSymbol").addEventListener("click", () => {
    state.sidebarOpen = true;
    state.sidebarPanel = "outline";
    renderSidebar();
  });

  // Activity rail
  document.querySelectorAll<HTMLButtonElement>(".rail-btn[data-panel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = btn.dataset.panel as SidebarPanel;
      if (state.sidebarOpen && state.sidebarPanel === panel) {
        state.sidebarOpen = false;
      } else {
        state.sidebarOpen = true;
        state.sidebarPanel = panel;
      }
      renderSidebar();
    });
  });

  el<HTMLButtonElement>("btnToggleDrawerRail").addEventListener("click", () => {
    state.drawerOpen = !state.drawerOpen;
    renderDrawer();
  });
  el<HTMLButtonElement>("btnCollapseSidebar").addEventListener("click", () => {
    state.sidebarOpen = false;
    renderSidebar();
  });
  el<HTMLButtonElement>("btnCloseDrawer").addEventListener("click", () => {
    state.drawerOpen = false;
    renderDrawer();
  });

  // Drawer controls & tabs
  el<HTMLInputElement>("chkConsolePauser").addEventListener("change", (e) => {
    state.useConsolePauser = (e.target as HTMLInputElement).checked;
  });
  el<HTMLButtonElement>("btnClearTerminal").addEventListener("click", () => {
    state.terminalChunks = [];
    renderDrawer();
  });
  document.querySelectorAll<HTMLButtonElement>(".drawer-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.drawerTab = btn.dataset.dtab as DrawerTab;
      renderDrawer();
    });
  });

  // Diagnostic card clicks
  el<HTMLDivElement>("drawerBody").addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-diag-idx]");
    if (card?.dataset.diagIdx !== undefined) {
      const diag = state.diagnostics[Number(card.dataset.diagIdx)];
      if (diag) void jumpToDiagnostic(diag);
    }
  });

  // Interactive stdin form
  el<HTMLFormElement>("stdinBar").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = el<HTMLInputElement>("stdinInput");
    const val = input.value;
    input.value = "";
    void handleSendStdin(val);
  });

  // Tabs delegation
  el<HTMLDivElement>("tabList").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const closePath = target.dataset.closeTab;
    if (closePath) {
      e.stopPropagation();
      closeTab(closePath);
      return;
    }
    const tabEl = target.closest<HTMLElement>("[data-tab-path]");
    if (tabEl?.dataset.tabPath) {
      activateTab(tabEl.dataset.tabPath);
    }
  });

  // Sidebar delegation
  el<HTMLDivElement>("sidebarBody").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.id === "sbOpenFolder") {
      void handleOpenFolder();
      return;
    }
    if (target.id === "sbNewFile") {
      openModal("templateModal");
      return;
    }
    const roteiroCard = target.closest<HTMLElement>("[data-roteiro-file]");
    if (roteiroCard?.dataset.roteiroFile) {
      void openRoteiroLesson(roteiroCard.dataset.roteiroFile);
      return;
    }
    const fileBtn = target.closest<HTMLElement>("[data-open-path]");
    if (fileBtn?.dataset.openPath) {
      void openDiskFile(fileBtn.dataset.openPath);
      return;
    }
    const symBtn = target.closest<HTMLElement>("[data-jump-line]");
    if (symBtn?.dataset.jumpLine) {
      primaryEditor.goToLine(Number(symBtn.dataset.jumpLine));
      return;
    }
    const searchBtn = target.closest<HTMLElement>("[data-search-path]");
    if (searchBtn?.dataset.searchPath) {
      const p = searchBtn.dataset.searchPath;
      const line = Number(searchBtn.dataset.searchLine ?? "1");
      void openDiskFile(p).then(() => primaryEditor.goToLine(line));
    }
  });

  el<HTMLDivElement>("sidebarBody").addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (target.id === "sbSearchInput") {
      void runWorkspaceSearch((target as HTMLInputElement).value);
    }
  });

  // Templates modal
  el<HTMLDivElement>("tplGrid").addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-tpl-idx]");
    if (card?.dataset.tplIdx !== undefined) {
      state.selectedTemplateIdx = Number(card.dataset.tplIdx);
      renderTemplatesModal();
    }
  });
  el<HTMLButtonElement>("btnCreateTemplate").addEventListener("click", () => {
    void handleCreateFromTemplate();
  });

  // Settings
  el<HTMLSelectElement>("setTheme").addEventListener("change", (e) => {
    applyTheme((e.target as HTMLSelectElement).value as ThemeMode);
  });
  el<HTMLSelectElement>("setFont").addEventListener("change", (e) => {
    state.settings.fontFamily = (e.target as HTMLSelectElement).value;
    applyTypography();
  });
  el<HTMLSelectElement>("setFontSize").addEventListener("change", (e) => {
    state.settings.fontSizePx = Number((e.target as HTMLSelectElement).value);
    applyTypography();
  });
  el<HTMLSelectElement>("setAStyle").addEventListener("change", (e) => {
    state.settings.astyleStyle = (e.target as HTMLSelectElement).value as "-A3" | "-A2" | "-A1";
    renderStatus();
  });
  el<HTMLSelectElement>("setKeymap").addEventListener("change", (e) => {
    state.settings.keymap = (e.target as HTMLSelectElement).value as KeymapMode;
    renderStatus();
  });

  // Modals
  document.querySelectorAll<HTMLElement>(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.remove("open");
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.closeModal) closeModal(btn.dataset.closeModal);
    });
  });

  el<HTMLInputElement>("paletteInput").addEventListener("input", renderPaletteList);
  el<HTMLDivElement>("paletteList").addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-pal-idx]");
    if (item?.dataset.palIdx !== undefined) {
      execPaletteIndex(Number(item.dataset.palIdx));
    }
  });

  // Global keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    const palOpen = el<HTMLDivElement>("paletteModal").classList.contains("open");
    if (palOpen) {
      const items = getFilteredPalette();
      if (e.key === "Escape") {
        closeModal("paletteModal");
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        paletteIndex = (paletteIndex + 1) % Math.max(1, items.length);
        renderPaletteList();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        paletteIndex =
          (paletteIndex - 1 + Math.max(1, items.length)) % Math.max(1, items.length);
        renderPaletteList();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        execPaletteIndex(paletteIndex);
        return;
      }
      return;
    }

    if (e.key === "Escape") {
      document
        .querySelectorAll<HTMLElement>(".modal-backdrop.open")
        .forEach((m) => m.classList.remove("open"));
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ctrl && key === "k") {
      e.preventDefault();
      openPalette();
    } else if (ctrl && e.shiftKey && key === "p") {
      e.preventDefault();
      openPalette();
    } else if (ctrl && e.shiftKey && key === "s") {
      e.preventDefault();
      void saveActiveTab(true);
    } else if (ctrl && key === "s") {
      e.preventDefault();
      void saveActiveTab(false).then((ok) => {
        if (ok) toast("Arquivo salvo.");
      });
    } else if (ctrl && e.shiftKey && key === "o") {
      e.preventDefault();
      void handleOpenFolder();
    } else if (ctrl && key === "o") {
      e.preventDefault();
      void handleOpenFile();
    } else if (ctrl && e.shiftKey && key === "n") {
      e.preventDefault();
      openModal("templateModal");
    } else if (ctrl && e.shiftKey && key === "f") {
      e.preventDefault();
      state.sidebarOpen = true;
      state.sidebarPanel = "search";
      renderSidebar();
      window.setTimeout(() => document.getElementById("sbSearchInput")?.focus(), 20);
    } else if (ctrl && key === "w") {
      e.preventDefault();
      if (state.activePath) closeTab(state.activePath);
    } else if (ctrl && key === "\\") {
      e.preventDefault();
      state.splitOpen = !state.splitOpen;
      syncSecondaryEditor();
    } else if (ctrl && e.key === "`") {
      e.preventDefault();
      state.drawerOpen = !state.drawerOpen;
      renderDrawer();
    } else if (ctrl && e.key === ",") {
      e.preventDefault();
      openModal("settingsModal");
    } else if (ctrl && e.shiftKey && key === "a") {
      e.preventDefault();
      void formatActiveWithAStyle();
    } else if (e.key === "F4") {
      e.preventDefault();
      primaryEditor.toggleBreakpointAtCurrentLine();
    } else if (e.key === "F9") {
      e.preventDefault();
      void compileActiveFile(false);
    } else if (e.key === "F10") {
      e.preventDefault();
      void runCurrentProgram();
    } else if (e.key === "F11") {
      e.preventDefault();
      void compileActiveFile(true);
    } else if (e.key === "F6" && state.isRunning) {
      e.preventDefault();
      void stopExecution();
    } else if (e.key === "F5") {
      e.preventDefault();
      state.sidebarOpen = true;
      state.sidebarPanel = "debug";
      renderSidebar();
      toast("Depurador GDB/MI + Memória SVG ao vivo entra na Entrega 3!");
    }
  });
}

async function subscribeRunnerEvents(): Promise<void> {
  await onRunnerOutput((ev) => {
    const cls =
      ev.stream === "stderr"
        ? "term-err"
        : ev.stream === "system"
          ? "term-muted"
          : "";
    appendTerminalChunk(ev.text, cls);
  });

  await onRunnerExit((ev) => {
    if (state.activeRunId !== null && ev.run_id !== state.activeRunId) return;
    state.isRunning = false;
    state.activeRunId = null;
    const summary = ev.killed
      ? `\n■ Execução interrompida pelo usuário após ${(ev.duration_ms / 1000).toFixed(2)}s.\n`
      : `\n-------------------------------------------\nProcesso encerrado em ${(ev.duration_ms / 1000).toFixed(3)}s · código de retorno ${ev.exit_code ?? -1}\n`;
    appendTerminalChunk(summary, ev.killed || ev.exit_code !== 0 ? "term-warn" : "term-ok");
    syncRunControls();
    renderStatus();
  });
}

// ===================== BOOTSTRAP =====================
window.addEventListener("DOMContentLoaded", () => {
  primaryEditor = new DevShowEditor(
    el<HTMLDivElement>("primaryEditorHost"),
    {
      onDocChange: (path, content) => {
        const tab = state.tabs.find((t) => t.path === path);
        if (!tab) return;
        tab.content = content;
        const wasDirty = tab.dirty;
        tab.dirty = content !== tab.savedContent;
        if (wasDirty !== tab.dirty) {
          renderTabs();
          renderBreadcrumb();
        }
        if (state.sidebarPanel === "outline") {
          renderSidebar();
        }
      },
      onCursorChange: (line, col) => {
        state.cursorLine = line;
        state.cursorCol = col;
        renderBreadcrumb();
        renderStatus();
      },
      onBreakpointsChange: (path, lines) => {
        state.breakpoints.set(path, lines);
        if (state.sidebarPanel === "debug") {
          renderSidebar();
        }
      },
    },
    false
  );

  secondaryEditor = new DevShowEditor(
    el<HTMLDivElement>("secondaryEditorHost"),
    {},
    true
  );

  applyTheme("dark");
  applyTypography();
  initSplitters();
  bindEvents();

  void subscribeRunnerEvents();
  void loadToolchain();
  void openRoteiroWorkspace();
});
