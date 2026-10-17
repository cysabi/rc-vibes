// The shader editor: a sheet over the right side of the screen, so the room
// stays visible while you write. Saving puts the shader in the preview; it
// reaches the room when the pending changes are applied.

import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useRef, useState } from "react";
import { useMe } from "../api.ts";
import { drafts, type Layer } from "../draft.ts";
import { CloseIcon } from "../icons.tsx";
import { usePreviewErrors } from "../sim.ts";
import { ago } from "../time.ts";

const TEMPLATE = `// update() runs about 100 times a second.
//
//   prev  the room as the shaders below left it:
//         { lights: [{ id, channels: { a, b, brightness, fidelity } }] }
//         a, b        the color, as OKLab at L = 1 (3000 K is 0.060, 0.135)
//         brightness  1.0 is 1000 lm. Saturated colors are dim: a bulb's
//                     pure blue tops out near 0.03, so keep colors low.
//         fidelity    0 makes whites from the RGB LEDs, 1 from the white ones
//         Old bulbs have one channel, on: 1 switches them on, 0 off.
//   now   the time in milliseconds
//
// Return the lights and channels you want to change; everything else stays
// as the shaders below left it.
function update(prev, now) {
  const lights = [];
  for (const light of prev.lights) {
    if (!("a" in light.channels)) continue; // old bulbs only switch on and off
    const wave = Math.sin(now / 1000 + light.id / 4);
    lights.push({ id: light.id, channels: { brightness: 0.45 + 0.35 * wave } });
  }
  return { lights };
}
`;

const theme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "#e9e2d6", height: "100%" },
    ".cm-content": { caretColor: "#f1ebe0", fontFamily: "var(--mono-font)", fontVariationSettings: '"MONO" 1' },
    ".cm-scroller": { fontFamily: "var(--mono-font)", lineHeight: "1.6", fontSize: "13px" },
    ".cm-gutters": { backgroundColor: "transparent", color: "#4d4740", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#8a8174" },
    ".cm-activeLine": { backgroundColor: "rgba(241,235,224,0.035)" },
    ".cm-cursor": { borderLeftColor: "#f1ebe0" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(224,169,109,0.22) !important",
    },
    ".cm-matchingBracket": { backgroundColor: "rgba(241,235,224,0.1)", outline: "none" },
    "&.cm-focused": { outline: "none" },
  },
  { dark: true },
);

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.comment, color: "#71695e", fontStyle: "italic" },
    { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.modifier], color: "#e0a96d" },
    { tag: [t.string, t.special(t.string)], color: "#b9c78e" },
    { tag: [t.number, t.bool, t.null], color: "#e9c57d" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#f1ebe0", fontWeight: "600" },
    { tag: t.propertyName, color: "#cdb89a" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "#968c7e" },
    { tag: t.variableName, color: "#e9e2d6" },
  ]),
);

const extensions = [javascript(), theme, highlight];

/** Why the script won't even parse, or null. */
function syntaxError(script: string): string | null {
  try {
    // Parses without running it.
    new Function(script);
    return null;
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
}

export function ShaderSheet({ layer, onClose }: { layer: Layer | null; onClose: () => void }) {
  const me = useMe();
  const previewErrors = usePreviewErrors();
  const [name, setName] = useState(layer?.name ?? "");
  const [script, setScript] = useState(layer?.script ?? TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const initial = useRef({ name, script });
  const dirty = name !== initial.current.name || script !== initial.current.script;
  const deleted = layer?.status === "deleted";
  const canSave = name.trim().length > 0 && script.trim().length > 0 && !deleted && (dirty || !layer);
  // What the preview says about this script, once it's the one running there.
  const previewError = layer && !dirty ? (previewErrors[layer.key] ?? null) : null;

  const save = () => {
    if (!canSave) return;
    const bad = syntaxError(script);
    if (bad) {
      setError(bad);
      return;
    }
    if (layer) drafts.patchShader(layer.key, { name: name.trim(), script });
    else drafts.createShader(name.trim(), script, me.data?.name ?? "you");
    onClose();
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveRef.current();
      } else if (e.key === "Escape" && !dirty) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  const node = layer?.node ?? null;
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={layer ? `Edit ${layer.name}` : "New shader"}>
      <div className="sheet-head">
        <input
          className="sheet-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this shader"
          maxLength={80}
          aria-label="Shader name"
          autoFocus={!layer}
        />
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      {layer && (
        <p className="sheet-meta">
          by {layer.by}
          {node?.modified_at && `, last changed ${ago(node.modified_at)}`}
          {node?.meta && node.meta.modifiedBy.id !== node.meta.createdBy.id && ` by ${node.meta.modifiedBy.name}`}
          {layer.status === "new" && ", not applied yet"}
          {layer.status === "edited" && ", with changes not applied yet"}
          {deleted && ", to be deleted"}
        </p>
      )}
      <div className="code">
        <CodeMirror
          value={script}
          onChange={(v) => {
            setScript(v);
            setError(null);
          }}
          extensions={extensions}
          theme="none"
          height="100%"
          basicSetup={{ tabSize: 2, highlightActiveLine: true, foldGutter: false }}
        />
      </div>
      {error && <pre className="sheet-error">{error}</pre>}
      {!error && previewError && <pre className="sheet-error">In the preview: {previewError}</pre>}
      <div className="sheet-foot">
        {layer &&
          (deleted ? (
            <button
              className="text-button"
              onClick={() => {
                drafts.restoreShader(layer.key);
                onClose();
              }}
            >
              Restore
            </button>
          ) : (
            <button
              className="text-button danger-text"
              onClick={() => {
                drafts.deleteShader(layer.key);
                onClose();
              }}
            >
              Delete
            </button>
          ))}
        <span className="spacer" />
        <span className="hint">⌘S saves to the preview</span>
        <button onClick={onClose}>{dirty ? "Cancel" : "Close"}</button>
        <button className="primary" onClick={save} disabled={!canSave}>
          {layer ? "Save" : "Create"}
        </button>
      </div>
    </div>
  );
}
