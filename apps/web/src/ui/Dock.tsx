import { Toggle } from "@base-ui/react/toggle";
import { LAYERS } from "@orya-halo/schema";
import type { LayerDef, LayerId } from "@orya-halo/schema";
import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { haloActions, sendIntent, useHalo } from "../core/store.ts";
import type { HaloState, LayerUiState } from "../core/store.ts";
import { accentStyle } from "./accents.ts";
import { Tip } from "./components/tip.tsx";
import { cx, formatNumber } from "./format.ts";
import { Icon, Ring } from "./icons.tsx";
import { useClamped, useIsPhone } from "./hooks.ts";
import { rowLabel, rowView } from "./layer-status.ts";
import { Notes } from "./Notices.tsx";
import { Num } from "./Num.tsx";

/**
 * The parts of a layer's state a row draws. Left out on purpose: `updatedMs`, which changes
 * with every batch and would re-render the row once a second for nothing.
 */
const rowState =
  (layer: LayerId) =>
  (s: HaloState): LayerUiState => {
    const { enabled, status, count, total, message } = s.layers[layer];
    return { enabled, status, count, total, message };
  };

/** Hold a lamp button this long on a phone and it says its name instead of toggling. */
const LONG_PRESS_MS = 450;

function LayerRow({ def, onPeek }: { def: LayerDef; onPeek: (layer: LayerId | null) => void }) {
  const layer = useHalo(useShallow(rowState(def.id)));
  const view = rowView(def, layer);
  const noteId = `layer-note-${def.id}`;
  const press = useRef({ timer: 0, held: false });
  const noteRef = useRef<HTMLParagraphElement>(null);
  // A long note is cut at two lines so rows keep their height; the whole sentence is in the
  // tooltip on hover or focus, and always in the description screen readers get.
  const clamped = useClamped(noteRef, view.note?.text);

  const endPress = (): void => {
    clearTimeout(press.current.timer);
    onPeek(null);
  };

  return (
    // Always wrapped, and disabled when the note fits: a wrapper that came and went would
    // remount the row, and a focused row would lose its focus.
    <Tip label={view.note?.text ?? ""} side="right" long disabled={!clamped}>
      <li style={accentStyle(def.id)}>
        <Toggle
          className="row"
          pressed={layer.enabled}
          onPressedChange={() => {
            // A long press already answered with the layer's name: it is not also a toggle.
            if (press.current.held) {
              press.current.held = false;
              return;
            }
            haloActions().toggleLayer(def.id);
          }}
          data-dim={view.dim ? "" : undefined}
          aria-label={rowLabel(def, view, formatNumber)}
          aria-describedby={view.note ? noteId : undefined}
          aria-keyshortcuts={def.hotkey}
          onPointerDown={(event) => {
            if (event.pointerType !== "touch") return;
            press.current.held = false;
            press.current.timer = window.setTimeout(() => {
              press.current.held = true;
              onPeek(def.id);
            }, LONG_PRESS_MS);
          }}
          onPointerUp={endPress}
          onPointerCancel={endPress}
          onPointerLeave={endPress}
          onContextMenu={(event) => {
            // Long-press opens the context menu on Android; the name tag is the answer here.
            if (press.current.held) event.preventDefault();
          }}
        >
          <i className="lamp" data-lamp={view.lamp} />
          <Icon name={def.id} className="row-icon" />
          <span className="row-name">{def.label}</span>
          {view.busy ? (
            <Ring />
          ) : view.state ? (
            <span className={cx("row-state", view.state.warn && "warn")}>{view.state.text}</span>
          ) : view.count !== null ? (
            <Num value={view.count} className="row-count" />
          ) : null}
        </Toggle>
        {view.note ? (
          <p ref={noteRef} className={cx("row-note", view.note.warn && "warn")} id={noteId}>
            {view.note.text}
          </p>
        ) : null}
      </li>
    </Tip>
  );
}

/** The name and count of the lamp button under a long press. Phones only. */
function Peek({ layer }: { layer: LayerId }) {
  const def = LAYERS.find((l) => l.id === layer) as LayerDef;
  const state = useHalo(useShallow(rowState(layer)));
  const view = rowView(def, state);
  return (
    <div className="tag dock-peek" style={accentStyle(layer)} role="status">
      <i className="lamp lamp-small" data-lamp={view.lamp} />
      <span className="tag-name">{def.label}</span>
      {view.state ? (
        <span className={cx("row-state", view.state.warn && "warn")} style={{ display: "inline" }}>
          {view.state.text}
        </span>
      ) : view.count !== null ? (
        <span className="num">{formatNumber(view.count)}</span>
      ) : null}
    </div>
  );
}

function Tools() {
  const sound = useHalo((s) => s.sound);
  const actions = haloActions();
  return (
    <div className="dock-tools">
      <Tip label="Face north" hotkey="N" side="top">
        <button
          type="button"
          className="tool"
          aria-label="Face north"
          onClick={() => sendIntent({ type: "reset-north" })}
        >
          <Icon name="north" />
        </button>
      </Tip>
      <Tip label="Zoom out" hotkey="−" side="top">
        <button
          type="button"
          className="tool"
          aria-label="Zoom out"
          onClick={() => sendIntent({ type: "zoom", delta: -1 })}
        >
          <Icon name="minus" />
        </button>
      </Tip>
      <Tip label="Zoom in" hotkey="+" side="top">
        <button
          type="button"
          className="tool"
          aria-label="Zoom in"
          onClick={() => sendIntent({ type: "zoom", delta: 1 })}
        >
          <Icon name="plus" />
        </button>
      </Tip>
      <span className="tool-gap" />
      <Tip label={sound ? "Sound is on" : "Sound is off"} hotkey="M" side="top">
        <button
          type="button"
          className="tool"
          aria-label="Sound"
          aria-pressed={sound}
          onClick={() => actions.setSound(!sound)}
        >
          <Icon name={sound ? "sound-on" : "sound-off"} />
        </button>
      </Tip>
      <Tip label="Keyboard shortcuts" hotkey="?" side="top">
        <button
          type="button"
          className="tool"
          aria-label="Keyboard shortcuts"
          onClick={() => actions.setOverlay("shortcuts")}
        >
          <Icon name="keyboard" />
        </button>
      </Tip>
      <Tip label="About and data sources" side="top">
        <button
          type="button"
          className="tool"
          aria-label="About and data sources"
          onClick={() => actions.setOverlay("attribution")}
        >
          <Icon name="info" />
        </button>
      </Tip>
    </div>
  );
}

/** The layer dock: one lamp row per layer, then the map tools. A strip of lamp buttons on phones. */
export function Dock() {
  const [peek, setPeek] = useState<LayerId | null>(null);
  const phone = useIsPhone();
  return (
    <nav className="dock glass enter" aria-label="Layers">
      <ul className="dock-rows">
        {LAYERS.map((def) => (
          <LayerRow key={def.id} def={def} onPeek={setPeek} />
        ))}
      </ul>
      {peek ? <Peek layer={peek} /> : null}
      {/* Phones show these under the clock: the strip has no room to grow. */}
      {phone ? null : <Notes />}
      <Tools />
    </nav>
  );
}
