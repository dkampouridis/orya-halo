/**
 * Global keyboard shortcuts. `resolveShortcut` is pure (key in, action out)
 * so the rules about typing and modifiers are tested; `runShortcut` applies
 * an action to the store.
 */
import { LAYERS } from "@orya-halo/schema";
import type { LayerId } from "@orya-halo/schema";
import { haloActions, sendIntent, useHalo } from "../core/store.ts";

export type ShortcutAction =
  | { type: "search" }
  | { type: "layer"; layer: LayerId }
  | { type: "follow" }
  | { type: "live" }
  | { type: "north" }
  | { type: "zoom"; delta: 1 | -1 }
  | { type: "home" }
  | { type: "escape" }
  | { type: "shortcuts" }
  | { type: "sound" };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Focus is in a text field: letters belong to it. */
  typing: boolean;
  /** A dialog is open: it owns the keyboard (and Esc). */
  overlayOpen: boolean;
}

const LAYER_BY_HOTKEY = new Map<string, LayerId>(LAYERS.map((l) => [l.hotkey, l.id]));

export function resolveShortcut(input: KeyInput): ShortcutAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.typing) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (input.overlayOpen) return key === "?" ? { type: "shortcuts" } : null;
  const layer = LAYER_BY_HOTKEY.get(key);
  if (layer) return { type: "layer", layer };
  switch (key) {
    case "/":
      return { type: "search" };
    case "f":
      return { type: "follow" };
    case "l":
      return { type: "live" };
    case "n":
      return { type: "north" };
    case "+":
    case "=":
      return { type: "zoom", delta: 1 };
    case "-":
    case "_":
      return { type: "zoom", delta: -1 };
    case "h":
      return { type: "home" };
    case "m":
      return { type: "sound" };
    case "?":
      return { type: "shortcuts" };
    case "Escape":
      return { type: "escape" };
    default:
      return null;
  }
}

/** True when keystrokes at this target are text, not commands. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function runShortcut(action: ShortcutAction): void {
  const actions = haloActions();
  const state = useHalo.getState();
  switch (action.type) {
    case "search":
      actions.setSearchOpen(true);
      break;
    case "layer":
      actions.toggleLayer(action.layer);
      break;
    case "follow":
      if (state.selection) actions.setFollowing(!state.following);
      break;
    case "live":
      if (state.clock.mode === "scrub") actions.goLive();
      break;
    case "north":
      sendIntent({ type: "reset-north" });
      break;
    case "zoom":
      sendIntent({ type: "zoom", delta: action.delta });
      break;
    case "home":
      sendIntent({ type: "home" });
      break;
    case "sound":
      actions.setSound(!state.sound);
      break;
    case "shortcuts":
      actions.setOverlay(state.overlay === "shortcuts" ? "none" : "shortcuts");
      break;
    case "escape":
      // One thing at a time, nearest first.
      if (state.searchOpen) actions.setSearchOpen(false);
      else if (state.selection) actions.select(null);
      break;
  }
}

/** Listen for shortcuts on the window. Returns the function that stops listening. */
export function listenForShortcuts(): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    const action = resolveShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      typing: isTypingTarget(event.target),
      overlayOpen: useHalo.getState().overlay !== "none",
    });
    if (!action) return;
    // "/" would otherwise land in the search field it just focused.
    event.preventDefault();
    runShortcut(action);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** The shortcuts sheet's contents, in the order people look for them. */
export const SHORTCUT_LIST: readonly { keys: readonly string[]; join?: string; does: string }[] = [
  { keys: ["/"], does: "Search" },
  { keys: ["1", "0"], join: "to", does: "Turn a layer on or off, in dock order" },
  { keys: ["F"], does: "Follow the selected object" },
  { keys: ["Esc"], does: "Close search, then clear the selection" },
  { keys: ["←", "→"], does: "Move through time, with the time tape focused" },
  { keys: ["L"], does: "Back to live" },
  { keys: ["+", "−"], does: "Zoom in and out" },
  { keys: ["N"], does: "Face north" },
  { keys: ["H"], does: "Return to your region" },
  { keys: ["M"], does: "Sound on or off" },
  { keys: ["?"], does: "Show this list" },
];
