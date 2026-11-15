/**
 * Sentences about the app itself rather than about any one layer: the globe
 * could not start, the engine lost its base map or its graphics, live traffic
 * is unreachable. On wide screens the last two are notes at the foot of the
 * dock; on phones, where the dock is a strip at the bottom edge, they sit
 * under the clock instead, in the ticker's place.
 */
import { Fragment } from "react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { allLayersOff, dataConfig } from "../app/config.ts";
import { haloActions, useHalo } from "../core/store.ts";
import { useIsPhone } from "./hooks.ts";
import { offlineGatewayLayers } from "./layer-status.ts";

/** "First sentence." and the rest, so the news can be in `--warn` and the explanation quieter. */
export function splitFirstSentence(text: string): [string, string] {
  const trimmed = text.trim();
  const match = /^(.+?[.!?])\s+(\S.*)$/s.exec(trimmed);
  return match ? [match[1], match[2]] : [trimmed, ""];
}

/** `code` in backticks becomes a code span; everything else stays text. */
function withCode(text: string): ReactNode {
  return text
    .split(/`([^`]+)`/)
    .map((part, i) =>
      i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>,
    );
}

/**
 * Shown in place of the HUD when the globe could not start: the reason, and
 * the one thing to do about it. The intro never finishes in this case, so the
 * glass stays hidden and this sits alone on space under the wordmark.
 */
export function StartError() {
  const message = useHalo((s) => s.startError);
  if (!message) return null;
  return (
    <div className="start-error" role="alert">
      <p>{message}</p>
      {/* Focus lands on the only action, so a keyboard user can take it at once. */}
      <button type="button" className="btn" autoFocus onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

/**
 * The engine's own health: base map missing, graphics context lost. Clears
 * itself when the status recovers. The hint is addressed to whoever runs the
 * deployment, so only a development build shows it.
 */
export function EngineNotice() {
  const { message, hint } = useHalo(
    useShallow((s) => ({ message: s.engineStatus?.message, hint: s.engineStatus?.hint })),
  );
  const devHint = import.meta.env.DEV ? hint : undefined;
  if (!message && !devHint) return null;
  const [news, rest] = message ? splitFirstSentence(message) : ["", ""];
  return (
    <div className="note-block engine-notice" role="status">
      {message ? (
        <p>
          <span className="warn">{news}</span>
          {rest ? ` ${rest}` : null}
        </p>
      ) : null}
      {devHint ? <p className="note-hint">{withCode(devHint)}</p> : null}
    </div>
  );
}

/** Whether this build talks to a gateway at all. Without one there is nothing to try again. */
const GATEWAY_CONFIGURED = dataConfig(allLayersOff()).gatewayUrl !== null;

/** The worker's sentences already open with the news; the block says it once. */
const OFFLINE_NEWS = "Live traffic is offline.";

/**
 * Shown once when the gateway layers are on but unreachable, rather than
 * repeating the same sentence beneath each of them.
 */
export function GatewayOffline() {
  const { messages, online } = useHalo(
    useShallow((s) => ({
      messages: [
        ...new Set(
          offlineGatewayLayers(s.layers).map((def) => s.layers[def.id].message?.trim() ?? ""),
        ),
      ].join("\n"),
      online: s.gatewayOnline,
    })),
  );
  const down = useHalo((s) => offlineGatewayLayers(s.layers).length > 0);
  if (!down) return null;

  const explanation =
    messages
      .split("\n")
      .map((m) => (m.startsWith(OFFLINE_NEWS) ? m.slice(OFFLINE_NEWS.length).trim() : m))
      .filter(Boolean)
      .join(" ") || "The gateway isn't reachable; satellites and earthquakes still work.";

  const retry = (): void => {
    // There is no retry service: switching the gateway layers off and on again stands in for one.
    // All off first, then all on: once no gateway layer is wanted the worker drops the
    // connection and its backoff, and the first one back on connects at once. Toggling them
    // one at a time would leave the other wanting the old connection and its pending retry.
    const actions = haloActions();
    const layers = offlineGatewayLayers(useHalo.getState().layers);
    for (const def of layers) actions.setLayerEnabled(def.id, false);
    for (const def of layers) actions.setLayerEnabled(def.id, true);
  };

  return (
    <div className="note-block dock-offline" role="status">
      <p>
        <span className="warn">{OFFLINE_NEWS}</span> {explanation}
      </p>
      {GATEWAY_CONFIGURED && !online ? (
        <button type="button" className="btn" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Both notes, in the order they matter: the globe itself first, then live traffic. */
export function Notes() {
  return (
    <>
      <EngineNotice />
      <GatewayOffline />
    </>
  );
}

/** Phones: the notes under the clock, on glass. Empty, it takes no room. */
export function PhoneNotes() {
  const phone = useIsPhone();
  if (!phone) return null;
  return (
    <div className="phone-notes glass enter">
      <Notes />
    </div>
  );
}
