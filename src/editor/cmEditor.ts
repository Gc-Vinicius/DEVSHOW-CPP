import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  nextSnippetField,
  prevSnippetField,
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeSearchPanel,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  Compartment,
  EditorState,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

// ===================== BREAKPOINT & DIAGNOSTIC FIELDS =====================
const toggleBreakpointEffect = StateEffect.define<{ pos: number; on: boolean }>();
const setBreakpointsEffect = StateEffect.define<number[]>();
const setDiagnosticsEffect = StateEffect.define<
  Array<{ line: number; severity: "error" | "warning" }>
>();
const setDebugLineEffect = StateEffect.define<number | null>();

const diagErrorLineDeco = Decoration.line({ class: "cm-diag-error" });
const diagWarnLineDeco = Decoration.line({ class: "cm-diag-warning" });
const debugLineDeco = Decoration.line({ class: "cm-debug-line" });

const debugLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    let next = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDebugLineEffect)) {
        if (e.value !== null && e.value >= 1 && e.value <= tr.state.doc.lines) {
          const from = tr.state.doc.line(e.value).from;
          next = Decoration.set([debugLineDeco.range(from)]);
        } else {
          next = Decoration.none;
        }
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const diagnosticLinesField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    let next = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDiagnosticsEffect)) {
        const seen = new Map<number, "error" | "warning">();
        for (const item of e.value) {
          if (item.line < 1 || item.line > tr.state.doc.lines) continue;
          const prev = seen.get(item.line);
          if (prev !== "error") {
            seen.set(item.line, item.severity);
          }
        }
        const sorted = [...seen.entries()].sort((a, b) => a[0] - b[0]);
        const ranges = sorted.map(([lineNo, sev]) => {
          const from = tr.state.doc.line(lineNo).from;
          return (sev === "error" ? diagErrorLineDeco : diagWarnLineDeco).range(from);
        });
        next = Decoration.set(ranges, true);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class BreakpointMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-bp-dot";
    el.title = "Breakpoint (clique ou F4 para remover)";
    return el;
  }
}

const bpMarker = new BreakpointMarker();

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty;
  },
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(toggleBreakpointEffect)) {
        if (e.value.on) {
          next = next.update({ add: [bpMarker.range(e.value.pos)] });
        } else {
          next = next.update({ filter: (from) => from !== e.value.pos });
        }
      } else if (e.is(setBreakpointsEffect)) {
        const ranges = [];
        for (const lineNo of e.value) {
          if (lineNo >= 1 && lineNo <= tr.state.doc.lines) {
            ranges.push(bpMarker.range(tr.state.doc.line(lineNo).from));
          }
        }
        next = RangeSet.of(ranges, true);
      }
    }
    return next;
  },
});

function extractBreakpoints(state: EditorState): number[] {
  const lines: number[] = [];
  const field = state.field(breakpointField, false);
  if (!field) return lines;
  const iter = field.iter();
  while (iter.value) {
    lines.push(state.doc.lineAt(iter.from).number);
    iter.next();
  }
  return lines;
}

// ===================== C-FIRST AUTOCOMPLETE =====================
const C_STANDARD_COMPLETIONS: Completion[] = [
  snippetCompletion('printf("${1:%d}\\n", ${2:valor});', {
    label: "printf",
    type: "function",
    detail: "<stdio.h>",
  }),
  snippetCompletion('scanf("${1:%d}", &${2:var});', {
    label: "scanf",
    type: "function",
    detail: "<stdio.h>",
  }),
  snippetCompletion("fgets(${1:buf}, sizeof(${1:buf}), stdin);", {
    label: "fgets",
    type: "function",
    detail: "<stdio.h>",
  }),
  { label: "fprintf", type: "function", detail: "<stdio.h>" },
  snippetCompletion("malloc(${1:n} * sizeof(${2:int}))", {
    label: "malloc",
    type: "function",
    detail: "<stdlib.h>",
  }),
  { label: "calloc", type: "function", detail: "<stdlib.h>" },
  { label: "realloc", type: "function", detail: "<stdlib.h>" },
  snippetCompletion("free(${1:ptr});", {
    label: "free",
    type: "function",
    detail: "<stdlib.h>",
  }),
  { label: "sizeof", type: "keyword", detail: "operador C" },
  snippetCompletion("typedef struct {\n\t${1:int campo;}\n} ${2:Nome};", {
    label: "typedef struct",
    type: "keyword",
    detail: "struct C",
  }),
  { label: "#include <stdio.h>", type: "keyword", detail: "entrada/saída" },
  { label: "#include <stdlib.h>", type: "keyword", detail: "memória/util" },
  { label: "#include <string.h>", type: "keyword", detail: "strings C" },
  { label: "#include <stdbool.h>", type: "keyword", detail: "bool C99+" },
  { label: "NULL", type: "constant", detail: "ponteiro nulo" },
  { label: "size_t", type: "type", detail: "inteiro sem sinal" },
  { label: "strlen", type: "function", detail: "<string.h>" },
  { label: "strcmp", type: "function", detail: "<string.h>" },
  { label: "strcpy", type: "function", detail: "<string.h>" },
  { label: "return 0;", type: "keyword", detail: "fim da main" },
];

function cCompletionSource(context: CompletionContext) {
  const word = context.matchBefore(/[#a-zA-Z_][\w<>.-]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const docText = context.state.doc.toString();
  const dynamic = new Map<string, Completion>();

  const fnRegex = /^(?:int|float|double|void|char|size_t|bool)\s+\*?(\w+)\s*\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = fnRegex.exec(docText)) !== null) {
    if (m[1] && m[1] !== "main") {
      dynamic.set(m[1], {
        label: m[1],
        type: "function",
        detail: `(${m[2].trim()})`,
      });
    }
  }

  const structRegex = /\}\s*(\w+)\s*;/g;
  while ((m = structRegex.exec(docText)) !== null) {
    if (m[1]) {
      dynamic.set(m[1], { label: m[1], type: "type", detail: "typedef struct" });
    }
  }

  return {
    from: word.from,
    options: [...dynamic.values(), ...C_STANDARD_COMPLETIONS],
  };
}

// ===================== CSS-TOKEN SYNTAX THEME =====================
const devShowHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword], color: "var(--syn-kw)", fontWeight: "600" },
  { tag: [tags.typeName, tags.className, tags.standard(tags.typeName)], color: "var(--syn-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syn-fn)" },
  { tag: [tags.string, tags.character, tags.special(tags.string)], color: "var(--syn-str)" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool], color: "var(--syn-num)" },
  { tag: [tags.processingInstruction, tags.meta, tags.macroName], color: "var(--syn-pre)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syn-com)", fontStyle: "italic" },
  { tag: [tags.operator, tags.derefOperator], color: "var(--syn-ptr)" },
  { tag: [tags.variableName, tags.propertyName], color: "var(--text-primary)" },
]);

const devShowEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg-canvas)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--editor-font-size)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
  },
  ".cm-content": {
    caretColor: "var(--accent-hover)",
    padding: "10px 0 48px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent-hover)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--bg-active)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--bg-line-active)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-canvas)",
    color: "var(--text-muted)",
    borderRight: "1px solid var(--border-subtle)",
    paddingRight: "4px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--bg-line-active)",
    color: "var(--text-primary)",
    fontWeight: "600",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "34px",
    padding: "0 8px 0 2px",
    fontSize: "12px",
  },
  ".cm-bp-gutter": {
    width: "18px",
    cursor: "pointer",
  },
  ".cm-bp-gutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 2px",
  },
  ".cm-bp-dot": {
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    backgroundColor: "var(--error)",
    boxShadow: "0 0 0 2px rgba(239, 68, 68, 0.28)",
    display: "inline-block",
  },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 3px",
    cursor: "pointer",
    color: "var(--text-muted)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-md)",
    color: "var(--text-primary)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    maxHeight: "240px",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    padding: "5px 10px",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--bg-active)",
    color: "var(--text-primary)",
  },
  ".cm-completionDetail": {
    color: "var(--text-muted)",
    fontFamily: "var(--font-ui)",
    fontSize: "11px",
    marginLeft: "10px",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-surface)",
    color: "var(--text-primary)",
    borderBottom: "1px solid var(--border-subtle)",
  },
  ".cm-search": {
    padding: "8px 12px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
  },
  ".cm-search input.cm-textfield": {
    backgroundColor: "var(--bg-canvas)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-strong)",
    borderRadius: "5px",
    padding: "4px 8px",
    outline: "none",
    fontSize: "12px",
  },
  ".cm-search input.cm-textfield:focus": {
    borderColor: "var(--accent)",
  },
  ".cm-search button.cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--bg-surface-2)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "5px",
    padding: "4px 9px",
    cursor: "pointer",
    fontSize: "12px",
  },
  ".cm-search button.cm-button:hover": {
    borderColor: "var(--border-strong)",
    backgroundColor: "var(--bg-elevated)",
  },
  ".cm-search button[name=close]": {
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "16px",
    padding: "0 6px",
  },
  ".cm-selectionMatch": {
    backgroundColor: "rgba(245, 158, 11, 0.25)",
    borderRadius: "2px",
  },
  ".cm-diag-error": {
    backgroundColor: "rgba(239, 68, 68, 0.14)",
    boxShadow: "inset 3px 0 0 var(--error)",
  },
  ".cm-diag-warning": {
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    boxShadow: "inset 3px 0 0 var(--warning)",
  },
  ".cm-debug-line": {
    backgroundColor: "rgba(245, 158, 11, 0.22)",
    boxShadow: "inset 3px 0 0 var(--warning)",
  },
});

export interface EditorCallbacks {
  onDocChange?: (filePath: string, content: string) => void;
  onCursorChange?: (line: number, col: number) => void;
  onBreakpointsChange?: (filePath: string, lines: number[]) => void;
}

export class DevShowEditor {
  private view: EditorView;
  private states = new Map<string, EditorState>();
  private currentPath: string | null = null;
  private tabSizeCompartment = new Compartment();
  private readOnlyCompartment = new Compartment();
  private callbacks: EditorCallbacks;
  private readOnly: boolean;

  constructor(parent: HTMLElement, callbacks: EditorCallbacks = {}, readOnly = false) {
    this.callbacks = callbacks;
    this.readOnly = readOnly;

    this.view = new EditorView({
      state: this.createEditorState("", []),
      parent,
    });
  }

  private buildBaseExtensions(tabSize = 4): Extension[] {
    const bpGutter = gutter({
      class: "cm-bp-gutter",
      markers: (v) => v.state.field(breakpointField),
      initialSpacer: () => bpMarker,
      domEventHandlers: {
        mousedown: (view, line) => {
          this.toggleBreakpointAtPos(view, line.from);
          return true;
        },
      },
    });

    return [
      breakpointField,
      diagnosticLinesField,
      debugLineField,
      bpGutter,
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [cCompletionSource] }),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      cpp(),
      syntaxHighlighting(devShowHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      devShowEditorTheme,
      this.tabSizeCompartment.of([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
      ]),
      this.readOnlyCompartment.of(EditorState.readOnly.of(this.readOnly)),
      // Tab aceita sugestão do autocomplete ou avança snippet ANTES do indentWithTab
      Prec.highest(
        keymap.of([
          {
            key: "Tab",
            run: (view) => acceptCompletion(view) || nextSnippetField(view),
          },
          { key: "Shift-Tab", run: prevSnippetField },
        ])
      ),
      keymap.of([
        ...completionKeymap,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && this.currentPath && !this.readOnly) {
          this.callbacks.onDocChange?.(this.currentPath, update.state.doc.toString());
        }
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          this.callbacks.onCursorChange?.(line.number, pos - line.from + 1);
        }
      }),
    ];
  }

  private createEditorState(doc: string, breakpoints: number[]): EditorState {
    let state = EditorState.create({
      doc,
      extensions: this.buildBaseExtensions(4),
    });
    if (breakpoints.length > 0) {
      state = state.update({ effects: setBreakpointsEffect.of(breakpoints) }).state;
    }
    return state;
  }

  private toggleBreakpointAtPos(view: EditorView, pos: number): void {
    const lineStart = view.state.doc.lineAt(pos).from;
    const field = view.state.field(breakpointField);
    let exists = false;
    field.between(lineStart, lineStart, () => {
      exists = true;
    });
    view.dispatch({
      effects: toggleBreakpointEffect.of({ pos: lineStart, on: !exists }),
    });
    if (this.currentPath) {
      this.callbacks.onBreakpointsChange?.(this.currentPath, extractBreakpoints(view.state));
    }
  }

  public openDocument(path: string, content: string, breakpoints: number[] = []): void {
    if (this.currentPath) {
      this.states.set(this.currentPath, this.view.state);
    }

    const existing = this.states.get(path);
    if (existing && existing.doc.toString() === content) {
      this.view.setState(existing);
    } else {
      const fresh = this.createEditorState(content, breakpoints);
      this.states.set(path, fresh);
      this.view.setState(fresh);
    }
    this.currentPath = path;

    const pos = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(pos);
    this.callbacks.onCursorChange?.(line.number, pos - line.from + 1);
  }

  public syncExternalContent(path: string, content: string): void {
    if (this.currentPath === path) {
      const current = this.view.state.doc.toString();
      if (current !== content) {
        this.view.dispatch({
          changes: { from: 0, to: current.length, insert: content },
        });
      }
    } else {
      this.states.delete(path);
    }
  }

  public dropCachedDocument(path: string): void {
    this.states.delete(path);
    if (this.currentPath === path) {
      this.currentPath = null;
    }
  }

  public getValue(): string {
    return this.view.state.doc.toString();
  }

  public getCurrentLine(): number {
    const pos = this.view.state.selection.main.head;
    return this.view.state.doc.lineAt(pos).number;
  }

  public toggleBreakpointAtCurrentLine(): void {
    const pos = this.view.state.selection.main.head;
    this.toggleBreakpointAtPos(this.view, pos);
  }

  public goToLine(lineNo: number): void {
    const clamped = Math.max(1, Math.min(lineNo, this.view.state.doc.lines));
    const line = this.view.state.doc.line(clamped);
    this.view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    this.view.focus();
  }

  public openFind(): void {
    openSearchPanel(this.view);
    this.view.focus();
  }

  public closeFind(): void {
    closeSearchPanel(this.view);
    this.view.focus();
  }

  public triggerAutocomplete(): void {
    this.view.focus();
    startCompletion(this.view);
  }

  public setTabSize(tabSize: number): void {
    this.view.dispatch({
      effects: this.tabSizeCompartment.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
      ]),
    });
  }

  public focus(): void {
    this.view.focus();
  }

  public setDiagnostics(
    items: Array<{ line: number; severity: "error" | "warning" }>
  ): void {
    this.view.dispatch({
      effects: setDiagnosticsEffect.of(items),
    });
  }

  public setDebugLine(lineNo: number | null): void {
    this.view.dispatch({
      effects: setDebugLineEffect.of(lineNo),
    });
  }

  public replaceContentPreservingUndo(newContent: string): void {
    const current = this.view.state.doc.toString();
    if (current === newContent) return;
    const prevCursor = Math.min(this.view.state.selection.main.head, newContent.length);
    this.view.dispatch({
      changes: { from: 0, to: current.length, insert: newContent },
      selection: { anchor: prevCursor },
    });
  }
}
