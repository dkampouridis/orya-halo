import { LAYERS } from "@orya-halo/schema";
import type { HaloEvent, LayerId } from "@orya-halo/schema";
import { haloActions, sendIntent, useHalo } from "../core/store.ts";
import { accentStyle, layerOfKind } from "./accents.ts";
import { agoText } from "./format.ts";

/** The line to show: the newest event that is at least notable, else simply the newest. */
export function pickEvent(events: readonly HaloEvent[]): HaloEvent | null {
  return events.find((e) => (e.severity ?? 0) >= 1) ?? events[0] ?? null;
}

/** The layer an event belongs to, for the colour of its ring. */
export function eventLayer(event: HaloEvent): LayerId | null {
  if (event.ref) return layerOfKind(event.ref.kind);
  const topic = event.topic.toLowerCase();
  return LAYERS.find((l) => l.id === topic || l.noun === topic || l.id === `${topic}s`)?.id ?? null;
}

/** One line on space that replaces itself when something notable happens. Click to go there. */
export function Ticker() {
  const event = useHalo((s) => pickEvent(s.events));
  // Re-render once a minute, not once a second: "2 min ago" only changes that often.
  const minute = useHalo((s) => Math.floor(s.clock.timeMs / 60_000));
  if (!event) return null;

  const layer = eventLayer(event);
  const reachable = event.ref !== undefined || (event.lon !== undefined && event.lat !== undefined);
  const go = (): void => {
    if (event.ref) haloActions().select(event.ref);
    else if (event.lon !== undefined && event.lat !== undefined) {
      sendIntent({ type: "fly", lon: event.lon, lat: event.lat });
    }
  };
  // Read at render: this component re-renders when the minute or the event changes, which is often enough.
  const age = Math.max(minute * 60_000, useHalo.getState().clock.timeMs) - event.timeMs;
  const title = event.title.replace(/[.\s]+$/, "");

  return (
    <button
      type="button"
      className="ticker enter"
      style={layer ? accentStyle(layer) : undefined}
      onClick={go}
      disabled={!reachable}
    >
      <svg className="ticker-mark" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </svg>
      <span className="ticker-text" key={event.id}>
        {title}, {agoText(age)}
      </span>
    </button>
  );
}
