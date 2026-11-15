import { layerDef } from "@orya-halo/schema";
import type {
  DetailField,
  DetailMedia,
  EntityDetail,
  EntityRef,
  LayerId,
  NearbyEntity,
} from "@orya-halo/schema";
import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { haloActions, sendIntent, useHalo } from "../core/store.ts";
import type { HaloState } from "../core/store.ts";
import { accentStyle, layerOfKind } from "./accents.ts";
import { distanceKm, formatNumber, spanOf } from "./format.ts";
import { useIsPhone, usePresence, useServices } from "./hooks.ts";
import { Icon, Ring } from "./icons.tsx";
import { announce, setSheet } from "./local.ts";
import { Num, Unit } from "./Num.tsx";
import { canFollow, detailView, routeProgress } from "./readouts.ts";
import type { Readout } from "./readouts.ts";
import { releaseVelocity, snapSheet } from "./sheet.ts";
import { sparkGeometry, sparkScale, sparkWords } from "./spark.ts";

interface Shown {
  selection: EntityRef;
  detail: EntityDetail | null;
  status: HaloState["detailStatus"];
}

function ReadoutItem({ readout }: { readout: Readout }) {
  const degrees = readout.unit === "°";
  return (
    <div className="readout">
      <dt>{readout.label}</dt>
      <dd>
        {readout.numeric !== undefined ? (
          <Num value={readout.numeric} decimals={readout.decimals} suffix={degrees ? "°" : ""} />
        ) : (
          <span className="num">{readout.text + (degrees ? "°" : "")}</span>
        )}
        {readout.unit && !degrees ? <Unit>{readout.unit}</Unit> : null}
      </dd>
    </div>
  );
}

const placeName = (place: NonNullable<EntityDetail["origin"]>): string =>
  place.name?.trim() || place.code;

/** Origin and destination as a track with the object on it, or as plain words when only one end is known. */
function Route({ detail }: { detail: EntityDetail }) {
  const { origin, destination } = detail;
  if (!origin && !destination) return null;
  if (!origin || !destination) {
    const place = (origin ?? destination) as NonNullable<EntityDetail["origin"]>;
    return (
      <div className="route">
        <p className="route-label">{origin ? "From" : "To"}</p>
        <p className="route-ends">
          <span>{placeName(place)}</span>
        </p>
      </div>
    );
  }
  const progress = routeProgress(detail, distanceKm);
  const percent = progress === null ? null : Math.round(progress * 100);
  return (
    <div
      className="route"
      role="group"
      aria-label={`Route: ${placeName(origin)} to ${placeName(destination)}${percent === null ? "" : `, ${percent} percent travelled`}`}
    >
      <p className="route-ends">
        <span>{placeName(origin)}</span>
        <span>{placeName(destination)}</span>
      </p>
      {progress === null ? (
        <div className="route-track" data-plain="" style={{ "--flown": "0%" } as CSSProperties} />
      ) : (
        <div
          className="route-track"
          style={{ "--flown": `${(progress * 100).toFixed(1)}%` } as CSSProperties}
        >
          <i className="route-flown" />
          <i className="route-here" />
        </div>
      )}
    </div>
  );
}

const SPARK_BOX = { width: 308, height: 40, pad: 3 };

/**
 * The selection's recent altitude (speed for ships; the predicted orbit for
 * satellites) as one hairline. Subscribes on its own, so a new track point
 * redraws the strip and nothing else. Draws nothing when the line would only
 * show noise.
 */
function Sparkline({ detail }: { detail: EntityDetail }) {
  const series = useHalo((s) => s.trackSeries);
  if (!series) return null;
  const altitudeUnit = detail.fields.find((f) => f.key === "alt" || f.key === "altitude")?.unit;
  const scale = sparkScale(series.measure, detail.layer, altitudeUnit);
  const geometry = sparkGeometry(series, SPARK_BOX, scale.minRange);
  if (!geometry) return null;
  const words = sparkWords(geometry, scale);
  return (
    <figure className="spark">
      <figcaption>
        <span>
          {words.lead}
          {words.span ? (
            <>
              {" "}
              <span className="num">{words.span.value}</span> {words.span.unit}
            </>
          ) : null}
        </span>
        <span className="spark-range">
          <span className="num">{words.range.low}</span>
          {/* A dash in the mono face reads as a minus sign: the separator stays in the text face. */}
          {words.range.high ? (
            <>
              <span className="spark-to">–</span>
              <span className="num">{words.range.high}</span>
            </>
          ) : null}
          <Unit>{words.unit}</Unit>
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${SPARK_BOX.width} ${SPARK_BOX.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={words.description}
      >
        <path className="spark-line" d={geometry.d} />
        {/* A zero-length stroke with round caps: a dot that stays round however the strip is stretched. */}
        <path className="spark-dot" d={`M${geometry.end.x} ${geometry.end.y}h0`} />
      </svg>
    </figure>
  );
}

/**
 * A photo or camera image, as the providers' terms ask: a plain link to their
 * page (no `nofollow`, no `noreferrer`, so they receive the Referer they rely
 * on), the image loaded by the browser from the URL exactly as given and never
 * drawn larger than it is, and the credit in visible text.
 */
function Media({ media, updatedMs }: { media: DetailMedia; updatedMs: number | null }) {
  const href = media.link ?? media.url;
  const age = updatedMs === null ? null : spanOf(Date.now() - updatedMs);
  const caption =
    media.credit || age ? (
      <figcaption>
        {media.credit ? media.credit.replace(/[.\s]+$/, "") + "." : null}
        {age ? (
          <>
            {media.credit ? " " : null}
            {age.value === 0 && age.unit === "s" ? (
              "Updated just now."
            ) : (
              <>
                Updated <span className="num">{age.value}</span> {age.unit} ago.
              </>
            )}
          </>
        ) : null}
      </figcaption>
    ) : null;
  if (media.type === "image") {
    return (
      <figure className="media">
        <a href={href} target="_blank" rel="noopener">
          <img src={media.url} alt={media.alt} loading="lazy" decoding="async" />
        </a>
        {caption}
      </figure>
    );
  }
  if (media.type === "video") {
    return (
      <figure className="media">
        <video
          src={media.url}
          aria-label={media.alt}
          controls
          muted
          playsInline
          preload="metadata"
        />
        {caption}
      </figure>
    );
  }
  // Embedded players are third-party pages; link out rather than frame them here.
  return (
    <figure className="media">
      <a className="btn" href={href} target="_blank" rel="noopener">
        Open the live view
      </a>
      {caption}
    </figure>
  );
}

function FactValue({ field }: { field: DetailField }) {
  if (/^https?:\/\//.test(field.value)) {
    let host = field.value;
    try {
      host = new URL(field.value).hostname.replace(/^www\./, "");
    } catch {
      // Not a URL after all: show it as written.
    }
    return (
      <a className="link" href={field.value} target="_blank" rel="noopener noreferrer">
        {host}
      </a>
    );
  }
  return (
    <>
      {field.value}
      {field.unit ? field.unit === "°" ? "°" : <Unit>{field.unit}</Unit> : null}
    </>
  );
}

function Nearby({ items }: { items: NearbyEntity[] }) {
  return (
    <section className="nearby" aria-labelledby="nearby-heading">
      <h2 id="nearby-heading">Nearby</h2>
      <ul>
        {items.map((item) => {
          const layer = layerOfKind(item.ref.kind);
          return (
            <li key={`${item.ref.kind}.${item.ref.id}`}>
              <button
                type="button"
                className="near"
                style={layer ? accentStyle(layer) : undefined}
                onClick={() => haloActions().select(item.ref)}
              >
                <i className="lamp lamp-small" data-lamp={layer ? "lit" : "hollow"} />
                <span className="near-name">{item.label}</span>
                <span className="near-sub">{layer ? layerDef(layer).noun : ""}</span>
                <span>
                  <span className="num">
                    {formatNumber(item.distanceKm, item.distanceKm < 10 ? 1 : 0)}
                  </span>
                  <Unit>km</Unit>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Actions({ detail }: { detail: EntityDetail }) {
  const following = useHalo((s) => s.following);
  const chase = useHalo((s) => s.chase);
  const services = useServices();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    const url = services?.shareUrl() ?? location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      announce("Link copied");
    } catch {
      // Clipboard access can be refused (permissions, insecure origin): say so rather than pretend.
      announce("The link could not be copied. Copy it from the address bar.");
    }
  };

  return (
    <div className="actions">
      {detail.layer === "aircraft" || detail.layer === "ships" ? (
        <button
          type="button"
          className="btn actions-wide"
          aria-pressed={chase}
          aria-keyshortcuts="v"
          onClick={() => haloActions().setChase(!chase)}
        >
          <Icon name="view-3d" />
          {chase ? "Leave 3D view" : "3D view"}
        </button>
      ) : null}
      {canFollow(detail.layer) ? (
        <button
          type="button"
          className="btn"
          aria-pressed={following}
          aria-keyshortcuts="f"
          onClick={() => haloActions().setFollowing(!following)}
        >
          <Icon name="follow" />
          {following ? "Following" : "Follow"}
        </button>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => sendIntent({ type: "fly-entity", ref: detail.ref })}
        >
          <Icon name="follow" />
          Fly there
        </button>
      )}
      <button type="button" className="btn" onClick={() => void copy()}>
        <Icon name="copy-link" />
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}

function Source({ detail }: { detail: EntityDetail }) {
  // Age against the clock being shown, so replay does not claim a fix is minutes stale.
  const clockMs = useHalo.getState().clock.timeMs;
  // Only things that move have a "last heard from": a cable or a quake does not go stale.
  const age =
    canFollow(detail.layer) && Number.isFinite(detail.fixTimeMs) && detail.fixTimeMs > 0
      ? spanOf(clockMs - detail.fixTimeMs)
      : null;
  const { url } = detail.attribution;
  const text = detail.attribution.text.replace(/[.\s]+$/, "");
  return (
    <p className="source">
      {url ? (
        <a className="link" href={url} target="_blank" rel="noopener noreferrer">
          {text}
        </a>
      ) : (
        text
      )}
      {age ? (
        <>
          {". Updated "}
          <span className="num">{age.value}</span> <Unit>{age.unit}</Unit> ago.
        </>
      ) : (
        "."
      )}
      {detail.sourceUrl ? (
        <>
          {" "}
          <a className="link" href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">
            Open the source page
          </a>
        </>
      ) : null}
    </p>
  );
}

/** Everything beneath the heading. Memoised so dragging the sheet or changing its stop does not re-render it. */
const Body = memo(function Body({ detail }: { detail: EntityDetail }) {
  const view = detailView(detail);
  const media = detail.media?.[0];
  return (
    <>
      {view.readouts.length > 0 ? (
        <dl className="readouts">
          {view.readouts.map((readout) => (
            <ReadoutItem key={readout.key} readout={readout} />
          ))}
        </dl>
      ) : null}
      <Sparkline detail={detail} />
      <Route detail={detail} />
      {media ? (
        <Media
          media={media}
          // Only a camera says how fresh its picture is; a photo of an aircraft has no such time.
          updatedMs={detail.layer === "webcams" && detail.fixTimeMs > 0 ? detail.fixTimeMs : null}
        />
      ) : null}
      {view.facts.length > 0 ? (
        <dl className="facts">
          {view.facts.map((field) => (
            <div key={field.key} style={{ display: "contents" }}>
              <dt>{field.label}</dt>
              <dd>
                <FactValue field={field} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {detail.nearby && detail.nearby.length > 0 ? <Nearby items={detail.nearby} /> : null}
      <Actions detail={detail} />
      <Source detail={detail} />
    </>
  );
});

/** The subtitle arrives as "type · operator": the type reads as a title, the rest as a quieter line. */
function splitSubtitle(subtitle: string | undefined): { type?: string; rest?: string } {
  if (!subtitle) return {};
  const [type, ...rest] = subtitle.split(" · ");
  return { type, rest: rest.length > 0 ? rest.join(", ") : undefined };
}

/**
 * The detail panel for the selected object; a bottom sheet with two stops on
 * phones. It stays mounted for 150ms after the selection clears so it can
 * leave the way it came.
 */
export function Detail() {
  const selection = useHalo((s) => s.selection);
  const detail = useHalo((s) => s.detail);
  const status = useHalo((s) => s.detailStatus);
  const phone = useIsPhone();
  const open = selection !== null;
  const presence = usePresence(open, 150);

  // What to keep showing while the panel leaves.
  const last = useRef<Shown | null>(null);
  if (selection) last.current = { selection, detail, status };
  const shown = last.current;

  const [stop, setStop] = useState<"peek" | "full">("peek");
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setStop("peek");
  }
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    setSheet(open && phone ? stop : "none");
    // Tell the camera and the on-map credits how much of the screen the sheet covers.
    if (open && phone) {
      const el = panel.current;
      const peek = el
        ? Number.parseFloat(getComputedStyle(el).getPropertyValue("--peek")) || 132
        : 132;
      haloActions().setBottomInset(stop === "full" ? (el?.offsetHeight ?? peek) : peek);
    } else {
      haloActions().setBottomInset(null);
    }
    return () => {
      setSheet("none");
      haloActions().setBottomInset(null);
    };
  }, [open, phone, stop]);

  const drag = useRef<{
    y: number;
    visible: number;
    samples: [number, number][];
    moved: boolean;
  } | null>(null);

  if (!presence.mounted || !shown) return null;

  const layer: LayerId | null = shown.detail?.layer ?? layerOfKind(shown.selection.kind);
  const noun = layer ? layerDef(layer).noun : "object";
  const close = (): void => haloActions().select(null);

  const heights = (): { peek: number; full: number } => {
    const el = panel.current;
    const peek = el
      ? Number.parseFloat(getComputedStyle(el).getPropertyValue("--peek")) || 132
      : 132;
    return { peek, full: el?.offsetHeight ?? peek };
  };

  const onDragStart = (event: PointerEvent<HTMLElement>): void => {
    if (!phone || event.button > 0) return;
    // The close button sits in the head: pressing it is not a drag.
    if ((event.target as HTMLElement).closest(".detail-close")) return;
    const h = heights();
    drag.current = {
      y: event.clientY,
      visible: stop === "full" ? h.full : h.peek,
      // Timed on arrival: event timestamps are not comparable across input sources.
      samples: [[performance.now(), event.clientY]],
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    const el = panel.current;
    if (!d || !el) return;
    const dy = d.y - event.clientY;
    if (!d.moved && Math.abs(dy) < 4) return;
    d.moved = true;
    d.samples.push([performance.now(), event.clientY]);
    if (d.samples.length > 8) d.samples.shift();
    const { full } = heights();
    const visible = Math.min(Math.max(d.visible + dy, 0), full);
    el.setAttribute("data-dragging", "");
    el.style.setProperty("--sheet-y", `${full - visible}px`);
  };
  const onDragEnd = (event: PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    const el = panel.current;
    drag.current = null;
    if (!d || !el) return;
    el.removeAttribute("data-dragging");
    el.style.removeProperty("--sheet-y");
    if (!d.moved) {
      // A tap on the handle steps between the two stops.
      if ((event.target as HTMLElement).closest(".sheet-handle"))
        setStop(stop === "full" ? "peek" : "full");
      return;
    }
    const h = heights();
    const visible = Math.min(Math.max(d.visible + (d.y - event.clientY), 0), h.full);
    const rest = snapSheet({ visible, velocity: releaseVelocity(d.samples), ...h, from: stop });
    if (rest === "close") close();
    else setStop(rest);
  };
  const dragHandlers = {
    onPointerDown: onDragStart,
    onPointerMove: onDragMove,
    onPointerUp: onDragEnd,
    onPointerCancel: onDragEnd,
  };

  const titles = splitSubtitle(shown.detail?.subtitle);

  return (
    <aside
      ref={panel}
      className="detail glass"
      style={layer ? accentStyle(layer) : undefined}
      aria-label={`Selected ${noun}`}
      data-closing={presence.closing ? "" : undefined}
      data-stop={phone ? stop : undefined}
    >
      <button
        type="button"
        className="sheet-handle"
        aria-label={stop === "full" ? "Collapse details" : "Expand details"}
        aria-expanded={stop === "full"}
        {...dragHandlers}
        onKeyDown={(event) => {
          // Pointer taps are handled by the drag logic; this is the keyboard's way in.
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setStop(stop === "full" ? "peek" : "full");
          }
        }}
      >
        <i />
      </button>
      <header className="detail-head" {...dragHandlers}>
        <div className="detail-titles">
          {shown.detail ? (
            <>
              <h1 className="detail-name">{shown.detail.title}</h1>
              {titles.type ? <p className="detail-type">{titles.type}</p> : null}
              {titles.rest ? <p className="detail-sub">{titles.rest}</p> : null}
            </>
          ) : shown.status === "missing" ? (
            <div className="detail-gone" role="status">
              <p>This {noun} is no longer in view.</p>
              <p>
                It may have moved out of coverage or stopped reporting. Close this and pick another.
              </p>
            </div>
          ) : (
            <p className="detail-wait" role="status">
              <Ring /> Loading this {noun}
            </p>
          )}
        </div>
        <button
          type="button"
          className="tool detail-close"
          aria-label="Close details"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>
      {shown.detail ? <Body detail={shown.detail} /> : null}
    </aside>
  );
}
