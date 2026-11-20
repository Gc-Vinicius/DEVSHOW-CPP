import { invoke } from "@tauri-apps/api/core";

interface ToolStatus {
  name: string;
  path: string | null;
  found: boolean;
}

interface ToolchainReport {
  base_dir: string;
  tools: ToolStatus[];
}

async function loadToolchain() {
  const baseDirEl = document.querySelector<HTMLElement>("#base-dir");
  const listEl = document.querySelector<HTMLUListElement>("#toolchain-list");
  if (!baseDirEl || !listEl) return;

  try {
    const report = await invoke<ToolchainReport>("detect_toolchain");
    baseDirEl.textContent = `Base: ${report.base_dir}`;
    listEl.innerHTML = report.tools
      .map(
        (tool) => `
          <li class="tool-item ${tool.found ? "ok" : "missing"}">
            <span class="tool-name">${tool.name}</span>
            <span class="tool-path">${tool.path ?? "Não encontrado"}</span>
          </li>
        `
      )
      .join("");
  } catch (err) {
    baseDirEl.textContent = `Modo navegador / erro IPC: ${String(err)}`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document
    .querySelector<HTMLButtonElement>("#refresh-btn")
    ?.addEventListener("click", () => {
      void loadToolchain();
    });

  void loadToolchain();
});
