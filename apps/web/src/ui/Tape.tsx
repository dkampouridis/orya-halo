import { useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { haloActions, useHalo } from "../core/store.ts";
import { hourMinute, MINUS } from "./format.ts";
import { usePresence } from "./hooks.ts";
import { Icon } from "./icons.tsx";
import {
  canScrub,
  dragTarget,
  keyScrub,
  minutesBehind,
  MINUTE_MS,
  resolveScrub,
  ticks,
  underNeedle,
  xOfTime,
} from "./tape-model.ts";
import type { ScrubTarget } from "./tape-model.ts";

/** Labels on screen at once never exceed this: one per 50px of a 600px tape, and a few spare. */
const LABEL_POOL = 16;

function apply(target: ScrubTarget): void {
  const actions = haloActions();
  if (target.mode === "live") {
    if (useHalo.getState().clock.mode !== "live") actions.goLive();
  } else {
    actions.scrubTo(target.timeMs);
  }
}

/**
 * The time tape: a ruled strip sliding under a fixed needle. Ticks are drawn
 * on a canvas and the labels are a small pool of elements moved with
 * transforms; both are updated straight from the store, so the clock's tick
 * costs this component no React render.
 */
export function Tape() {
  const scrubbed = useHalo((s) => s.clock.mode === "scrub");
  const ready = useHalo((s) => canScrub(s.history));
  const back = usePresence(scrubbed, 150);

  const tape = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const flag = useRef<HTMLOutputElement>(null);
  const flagLive = useRef<HTMLSpanElement>(null);
  const flagBehind = useRef<HTMLSpanElement>(null);
  const flagNumber = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; underMs: number; frame: number; want: number } | null>(null);

  useEffect(() => {
    const el = tape.current;
    const cv = canvas.current;
    const pool = labels.current;
    if (!el || !cv || !pool) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const css = getComputedStyle(el);
    const colour = {
      minor: "rgb(170 205 255 / 0.42)",
      major: css.getPropertyValue("--ink-dim").trim() || "#9aa8ba",
      ink: css.getPropertyValue("--ink").trim() || "#e9eff6",
      halo: css.getPropertyValue("--halo").trim() || "#bcd9ff",
    };
    let width = 0;
    let height = 0;
    let needleX = 0;

    const measure = (): void => {
      width = el.clientWidth;
      height = el.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The needle is placed in CSS (78%, 62% on phones); read where it landed.
      const needle = el.querySelector<HTMLElement>(".needle");
      needleX = needle ? needle.offsetLeft : Math.round(width * 0.78);
    };

    const draw = (): void => {
      if (width === 0) return;
      const { clock, history } = useHalo.getState();
      const nowMs = Date.now();
      const underMs = underNeedle(clock, nowMs);
      const behind = minutesBehind(clock, nowMs);
      const base = height - 8;
      // With nothing to scrub the tape carries its explanation where the labels would be.
      const scrubbable = canScrub(history);

      // The readout first: its width decides where labels must step aside.
      if (flagLive.current && flagBehind.current && flagNumber.current) {
        flagLive.current.hidden = behind > 0;
        flagBehind.current.hidden = behind === 0;
        if (behind > 0) flagNumber.current.textContent = `${MINUS}${behind}`;
      }
      const flagEnd = needleX + 2 + (flag.current?.offsetWidth ?? 40);
      const phone = window.innerWidth <= 720;
      const list = ticks({
        width,
        needleX,
        underMs,
        nowMs,
        history,
        keepClear: { from: needleX - 20, to: flagEnd + 18 },
        labelLimit: behind > 0 && phone ? width - 64 : undefined,
      });

      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 1;
      let used = 0;
      for (const tick of list) {
        ctx.globalAlpha = tick.reachable ? 1 : 0.35;
        ctx.strokeStyle = tick.major ? colour.major : colour.minor;
        ctx.beginPath();
        ctx.moveTo(tick.x + 0.5, base - (tick.major ? 11 : 5));
        ctx.lineTo(tick.x + 0.5, base);
        ctx.stroke();
        if (tick.labelled && scrubbable && used < LABEL_POOL) {
          const label = pool.children[used++] as HTMLElement;
          label.style.transform = `translateX(${tick.x}px)`;
          label.style.visibility = "visible";
          const text = hourMinute(tick.timeMs);
          if (label.textContent !== text) label.textContent = text;
          label.toggleAttribute("data-far", !tick.reachable);
        }
      }
      for (let i = used; i < LABEL_POOL; i++)
        (pool.children[i] as HTMLElement).style.visibility = "hidden";

      if (behind > 0) {
        // How far behind live the needle sits: a line along the base, ending at "now".
        const nowX = Math.round(xOfTime(nowMs, underMs, needleX));
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = colour.halo;
        ctx.beginPath();
        ctx.moveTo(needleX, base + 0.5);
        ctx.lineTo(nowX, base + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colour.ink;
        ctx.beginPath();
        ctx.moveTo(nowX + 0.5, base - 15);
        ctx.lineTo(nowX + 0.5, base);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const span = history ? Math.round((history.toMs - history.fromMs) / MINUTE_MS) : 0;
      el.setAttribute("aria-valuemin", String(-span));
      el.setAttribute("aria-valuenow", String(-behind));
      el.setAttribute(
        "aria-valuetext",
        behind === 0 ? "Live" : `${behind} ${behind === 1 ? "minute" : "minutes"} ago`,
      );
    };

    measure();
    draw();
    const resize = new ResizeObserver(() => {
      measure();
      draw();
    });
    resize.observe(el);
    const offClock = useHalo.subscribe((s) => s.clock, draw);
    const offHistory = useHalo.subscribe((s) => s.history, draw);
    // While scrubbed the store's clock holds still, but "now" keeps moving away.
    const timer = window.setInterval(() => {
      if (useHalo.getState().clock.mode === "scrub") draw();
    }, 1000);
    return () => {
      resize.disconnect();
      offClock();
      offHistory();
      clearInterval(timer);
    };
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const { clock, history } = useHalo.getState();
    if (!canScrub(history) || event.button > 0) return;
    drag.current = { x: event.clientX, underMs: underNeedle(clock, Date.now()), frame: 0, want: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    d.want = dragTarget(d.underMs, event.clientX - d.x);
    // One store write per frame, however fast the pointer reports.
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (drag.current === d) apply(resolveScrub(d.want, useHalo.getState().history, Date.now()));
    });
  };
  const onPointerEnd = (): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    if (d.want) apply(resolveScrub(d.want, useHalo.getState().history, Date.now()));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const { clock, history } = useHalo.getState();
    const target = keyScrub(event.key, event.shiftKey, clock, history, Date.now());
    if (!target) return;
    event.preventDefault();
    apply(target);
  };

  return (
    <div className="tape-wrap enter">
      <div
        ref={tape}
        className="tape glass"
        role="slider"
        tabIndex={0}
        aria-label="Time"
        aria-orientation="horizontal"
        aria-valuemax={0}
        aria-disabled={!ready}
        aria-describedby={ready ? undefined : "tape-empty"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvas} className="tape-ticks" aria-hidden="true" />
        <div ref={labels} className="tape-labels" aria-hidden="true">
          {Array.from({ length: LABEL_POOL }, (_, i) => (
            <span key={i} />
          ))}
        </div>
        {ready ? null : (
          <p className="tape-empty" id="tape-empty">
            Replay opens up once a minute of live data is recorded.
          </p>
        )}
        <i className="needle" />
      </div>
      <output ref={flag} className="needle-flag" aria-hidden="true">
        <span ref={flagLive}>live</span>
        <span ref={flagBehind} hidden>
          <span ref={flagNumber} className="num" /> min
        </span>
      </output>
      {back.mounted ? (
        <button
          type="button"
          className="btn back-to-live glass"
          data-closing={back.closing ? "" : undefined}
          aria-label="Back to live"
          onClick={() => haloActions().goLive()}
        >
          <Icon name="back-to-live" />
          <span>Back to live</span>
        </button>
      ) : null}
    </div>
  );
}
