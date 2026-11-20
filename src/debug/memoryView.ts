import type { DebugSnapshot, DebugVariable } from "../types";

function esc(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortVal(val: string, maxLen = 14): string {
  const clean = val.trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function parseIntArray(val: string): number[] | null {
  const trimmed = val.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return null;
  const nums = inner.split(",").map((p) => Number(p.trim()));
  if (nums.length < 2 || nums.length > 16 || nums.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return nums;
}

function renderPointerSvg(vars: DebugVariable[]): string {
  const pointers = vars.filter((v) => v.is_pointer);
  if (pointers.length === 0) return "";

  const byAddr = new Map<string, DebugVariable>();
  for (const v of vars) {
    if (v.address) byAddr.set(v.address.toLowerCase(), v);
  }

  const rowH = 74;
  const shown = pointers.slice(0, 4);
  const svgH = shown.length * rowH + 14;

  const rows = shown
    .map((ptr, idx) => {
      const y = 12 + idx * rowH;
      const targetAddr = ptr.points_to_addr?.toLowerCase() ?? null;
      const targetVar = targetAddr ? byAddr.get(targetAddr) : undefined;
      const isNull = !targetAddr || targetAddr === "0x0";

      const targetLabel = targetVar
        ? `${targetVar.var_type} ${targetVar.name}`
        : isNull
          ? "NULL"
          : `*${ptr.name}`;
      const targetVal = targetVar
        ? shortVal(targetVar.value, 13)
        : ptr.deref_value
          ? shortVal(ptr.deref_value, 13)
          : isNull
            ? "0x0"
            : "?";
      const targetAddrTxt = targetAddr ?? "—";
      const ptrAddrTxt = ptr.address ?? "reg";

      return `
        <g transform="translate(0, ${y})">
          <text x="52" y="10" text-anchor="middle" font-size="8.5" fill="var(--text-muted)" font-family="monospace">${esc(targetAddrTxt)}</text>
          <rect x="6" y="15" width="92" height="48" rx="6" fill="var(--bg-surface)" stroke="${isNull ? "var(--border-strong)" : "var(--emerald)"}" stroke-width="1.6" ${isNull ? 'stroke-dasharray="3 2"' : ""}/>
          <text x="52" y="31" text-anchor="middle" font-size="9.5" fill="var(--emerald)" font-family="monospace" font-weight="700">${esc(shortVal(targetLabel, 14))}</text>
          <text x="52" y="51" text-anchor="middle" font-size="13" fill="var(--text-primary)" font-family="monospace" font-weight="700">${esc(targetVal)}</text>

          <text x="208" y="10" text-anchor="middle" font-size="8.5" fill="var(--text-muted)" font-family="monospace">${esc(ptrAddrTxt)}</text>
          <rect x="160" y="15" width="96" height="48" rx="6" fill="var(--bg-surface)" stroke="var(--accent)" stroke-width="1.6"/>
          <text x="208" y="31" text-anchor="middle" font-size="9.5" fill="var(--accent-hover)" font-family="monospace" font-weight="700">${esc(shortVal(`${ptr.var_type} ${ptr.name}`, 14))}</text>
          <text x="208" y="50" text-anchor="middle" font-size="11" fill="var(--accent-hover)" font-family="monospace" font-weight="700">${esc(shortVal(targetAddrTxt, 12))}</text>

          ${
            !isNull
              ? `<path d="M160 39 L103 39" stroke="var(--accent)" stroke-width="2" marker-end="url(#gdbPtrArr)"/>
                 <text x="131" y="33" text-anchor="middle" font-size="9.5" fill="var(--warning)" font-family="monospace" font-weight="700">*${esc(ptr.name)}</text>`
              : `<text x="131" y="42" text-anchor="middle" font-size="9" fill="var(--text-muted)" font-family="monospace">NULL</text>`
          }
        </g>`;
    })
    .join("");

  return `
    <div class="mem-svg-box">
      <svg viewBox="0 0 262 ${svgH}" width="100%" role="img" aria-label="Mapa de memória e ponteiros GDB">
        <defs>
          <marker id="gdbPtrArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 1L10 5L0 9z" fill="var(--accent)"/>
          </marker>
        </defs>
        ${rows}
      </svg>
    </div>`;
}

function renderArrayStrip(vars: DebugVariable[]): string {
  const arrVar = vars.find((v) => !v.is_pointer && parseIntArray(v.value) !== null);
  if (!arrVar) return "";
  const nums = parseIntArray(arrVar.value);
  if (!nums) return "";

  const findInt = (names: string[]): number | null => {
    const v = vars.find((x) => names.includes(x.name.toLowerCase()));
    if (!v) return null;
    const n = Number(v.value.trim());
    return Number.isInteger(n) ? n : null;
  };

  const ini = findInt(["ini", "inicio", "left", "low"]);
  const mid = findInt(["meio", "mid", "i", "j"]);
  const fim = findInt(["fim", "right", "high"]);

  return `
    <div style="margin-top:8px;">
      <div class="muted-hint" style="margin-bottom:4px;font-family:var(--font-mono);">Vetor ${esc(arrVar.name)}[${nums.length}]</div>
      <div class="array-strip">
        ${nums
          .map((n, idx) => {
            const tags: string[] = [];
            if (idx === ini) tags.push("ini");
            if (idx === mid) tags.push("meio");
            if (idx === fim) tags.push("fim");
            const cls =
              idx === mid
                ? "hi-mid"
                : idx === ini
                  ? "hi-ini"
                  : idx === fim
                    ? "hi-fim"
                    : "";
            const dimmed =
              ini !== null && fim !== null && (idx < ini || idx > fim)
                ? "opacity:0.35;"
                : "";
            return `<div class="arr-cell ${cls}" style="${dimmed}"><span class="idx">[${idx}]${tags.length ? ` ${tags.join("/")}` : ""}</span>${n}</div>`;
          })
          .join("")}
      </div>
    </div>`;
}

export function renderLiveMemoryPanel(snapshot: DebugSnapshot | null): string {
  if (!snapshot) {
    return `<div class="muted-hint" style="line-height:1.45;">
      Pressione <strong>F5 (Debug)</strong> para compilar com <code>-g -O0</code> e inspecionar <strong>endereços reais (&amp;x)</strong>, <strong>ponteiros (*p, a-&gt;campo)</strong> e <strong>vetores</strong> ao vivo via <code>gdb.exe</code>!
    </div>`;
  }

  const ptrSvg = renderPointerSvg(snapshot.variables);
  const arrStrip = renderArrayStrip(snapshot.variables);

  if (!ptrSvg && !arrStrip) {
    const scalars = snapshot.variables.slice(0, 6);
    if (scalars.length === 0) {
      return `<div class="muted-hint">Nenhuma variável local neste frame (<code>${esc(snapshot.func)}</code>).</div>`;
    }
    return `
      <div class="scalar-grid">
        ${scalars
          .map(
            (v) => `
          <div class="scalar-box">
            <span class="scalar-addr">${esc(v.address ?? "reg")}</span>
            <span class="scalar-name">${esc(v.name)}</span>
            <span class="scalar-val">${esc(shortVal(v.value, 16))}</span>
          </div>`
          )
          .join("")}
      </div>`;
  }

  return `${ptrSvg}${arrStrip}`;
}
