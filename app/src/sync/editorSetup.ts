import { basicSetup } from "codemirror";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";

export function languageFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
      return javascript({ typescript: true });
    case "html":
    case "htm":
      return html();
    case "css":
      return css();
    case "json":
      return json();
    default:
      return [];
  }
}

// ── Cursores de quem está no mesmo arquivo ──────────────────────────────────

export interface RemoteCursor {
  uid: string;
  name: string;
  color: string;
  line: number; // 1-based
  col: number; // 0-based
}

class CursorWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  eq(other: CursorWidget) {
    return other.name === this.name && other.color === this.color;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-remote-cursor";
    el.style.setProperty("--c", this.color);
    const tag = document.createElement("span");
    tag.className = "cm-remote-cursor-tag";
    tag.textContent = this.name;
    el.appendChild(tag);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export const setRemoteCursors = StateEffect.define<RemoteCursor[]>();

const remoteCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setRemoteCursors)) continue;
      const doc = tr.state.doc;
      const ranges = e.value
        .filter((c) => c.line >= 1 && c.line <= doc.lines)
        .map((c) => {
          const line = doc.line(c.line);
          const pos = Math.min(line.from + c.col, line.to);
          return {
            pos,
            line: line.from,
            c,
          };
        });
      deco = Decoration.set(
        ranges.flatMap(({ pos, line, c }) => [
          Decoration.line({ attributes: { style: `background: color-mix(in srgb, ${c.color} 10%, transparent)` } }).range(line),
          Decoration.widget({ widget: new CursorWidget(c.name, c.color), side: 1 }).range(pos),
        ]),
        true,
      );
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13.5px" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace", lineHeight: "1.55" },
  ".cm-remote-cursor": {
    position: "relative",
    borderLeft: "2px solid var(--c)",
    marginLeft: "-1px",
    marginRight: "-1px",
  },
  ".cm-remote-cursor-tag": {
    position: "absolute",
    top: "-1.35em",
    left: "-2px",
    background: "var(--c)",
    color: "#16131f",
    fontSize: "10.5px",
    fontWeight: "700",
    fontFamily: "system-ui, sans-serif",
    padding: "0 5px",
    borderRadius: "4px 4px 4px 0",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: "5",
  },
});

export function editorExtensions(path: string, readOnly: boolean): Extension[] {
  return [
    basicSetup,
    keymap.of([indentWithTab]),
    languageFor(path),
    oneDark,
    theme,
    remoteCursorField,
    EditorState.readOnly.of(readOnly),
  ];
}
