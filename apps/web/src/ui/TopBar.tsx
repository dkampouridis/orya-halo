import { showFps } from "../app/config.ts";
import { haloActions, useHalo } from "../core/store.ts";
import { clockText } from "./format.ts";
import { liveTotal } from "./layer-status.ts";
import { Num, Unit } from "./Num.tsx";

/** The wordmark, set straight on space. It opens the about page. */
export function Brand() {
  return (
    <button
      type="button"
      className="brand"
      aria-label="Orya Halo: about and data sources"
      onClick={() => haloActions().setOverlay("attribution")}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <defs>
          <linearGradient id="halo-limb" x1="0.1" y1="0.15" x2="0.75" y2="0.8">
            <stop offset="0" stopColor="#eaf3ff" />
            <stop offset="0.45" stopColor="#bcd9ff" />
            <stop offset="0.8" stopColor="#bcd9ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle
          cx="10"
          cy="10"
          r="8.6"
          fill="none"
          stroke="#e9eff6"
          strokeOpacity="0.3"
          strokeWidth="1.25"
        />
        <circle cx="10" cy="10" r="8.6" fill="none" stroke="url(#halo-limb)" strokeWidth="1.6" />
      </svg>
      <span className="brand-name">orya halo</span>
    </button>
  );
}

/** UTC clock. Re-renders once a second and is the only thing here that does. */
function Clock() {
  // Whole seconds: sub-second clock updates would re-render for no visible change.
  const second = useHalo((s) => Math.floor(s.clock.timeMs / 1000));
  return (
    <p className="status-item">
      <span className="num">{clockText(second * 1000)}</span>
      <Unit>utc</Unit>
    </p>
  );
}

/** Everything live on the globe, or "in replay" while the tape is scrubbed. */
function Total() {
  const total = useHalo((s) => liveTotal(s.layers));
  const scrubbed = useHalo((s) => s.clock.mode === "scrub");
  return (
    <p className="status-item status-count">
      <Num value={total} />
      <Unit>{scrubbed ? "in replay" : "live"}</Unit>
    </p>
  );
}

function Fps() {
  const fps = useHalo((s) => Math.round(s.fps));
  return (
    <p className="status-item status-fps">
      <span className="num">{fps}</span>
      <Unit>fps</Unit>
    </p>
  );
}

/** Top right, on space: the clock and what is live. */
export function Status() {
  return (
    <div className="status enter">
      {showFps ? <Fps /> : null}
      <Clock />
      <Total />
    </div>
  );
}
