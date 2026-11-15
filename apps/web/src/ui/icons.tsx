/**
 * The Orya Halo icon family, drawn for this project (source of truth:
 * docs/mockup/icons.js). 16px box, 1.25px stroke, butt caps and mitre joins.
 * Circles are always the halo. Layer icons are the shapes the layer draws on
 * the globe. Solid details carry class "f".
 */
import type { LayerId } from "@orya-halo/schema";

const PATHS = {
  aircraft: '<path d="M8 2.5 12.25 12 8 10 3.75 12Z"/><path d="M8 12.25v2.5"/>',
  ships: '<path d="M8 1.9 10.75 6.5v6L9.5 14h-3l-1.25-1.5v-6Z"/><path d="M6.9 10.5h2.2"/>',
  satellites:
    '<path d="M9.25 6.5 12 9.25 9.25 12 6.5 9.25Z"/><path d="M2 11.5A8.5 8.5 0 0 1 11.5 2"/>',
  quakes:
    '<circle cx="8" cy="8" r="2.25"/><circle cx="8" cy="8" r="6" stroke-dasharray="6.92 2.5" stroke-dashoffset="-1.25"/>',
  cables:
    '<circle cx="2.75" cy="11.25" r="1.5"/><circle cx="13.25" cy="4.75" r="1.5"/><path d="M4.25 11.25C8.5 11.25 7.5 4.75 11.75 4.75"/>',
  radar:
    '<path d="M2.25 8.25a5.75 5.75 0 0 1 11.5 0"/><path d="M5 10.25 4 13.5M8.5 10.25l-1 3.25M12 10.25l-1 3.25"/>',
  imagery:
    '<path d="M2.25 2.75h11.5v10.5H2.25Z"/><path d="M2.25 11.25C5.5 7.75 10 6.5 13.75 6.75"/>',
  fires:
    '<path d="M8.25 1.75C8.25 5 12 6.25 12 10a4 4 0 0 1-8 0c0-1.75.9-2.9 1.75-3.75C6 7.5 6.75 8 7.25 8c0-2.5 0-4.5 1-6.25Z"/>',
  webcams:
    '<circle cx="8" cy="6.75" r="4.5"/><circle class="f" cx="8" cy="6.75" r="1.4"/><path d="M8 11.25v2.5M4.75 14h6.5"/>',
  nightlights:
    '<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25a3 5.75 0 0 0 0 11.5"/><circle class="f" cx="10.25" cy="6.25" r=".7"/><circle class="f" cx="11" cy="9.5" r=".7"/>',

  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.25 10.25 14 14"/>',
  close: '<path d="M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5"/>',
  follow:
    '<path d="M10.7 2.92a5.75 5.75 0 1 1-5.4 0"/><path class="f" d="M8 4.75 10 10 8 8.9 6 10Z"/>',
  "copy-link": '<path d="M5.75 5.75h7.5v7.5h-7.5Z"/><path d="M10.25 5.5V2.75h-7.5v7.5H5.5"/>',
  north: '<path d="M8 1.75 10.25 8 8 14.25 5.75 8Z"/><path class="f" d="M8 1.75 10.25 8h-4.5Z"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  "sound-on":
    '<path d="M2.5 6.25H5L8.25 3.5v9L5 9.75H2.5Z"/><path d="M10.5 6a2.75 2.75 0 0 1 0 4M12.25 4.25a5.25 5.25 0 0 1 0 7.5"/>',
  "sound-off":
    '<path d="M2.5 6.25H5L8.25 3.5v9L5 9.75H2.5Z"/><path d="M10.75 6.25l3.5 3.5M14.25 6.25l-3.5 3.5"/>',
  info: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25v4"/><circle class="f" cx="8" cy="5.1" r=".8"/>',
  keyboard:
    '<path d="M1.75 4.25h12.5v7.5H1.75Z"/><path d="M4 6.9h1.25M7.4 6.9h1.25M10.75 6.9H12M5 9.4h6"/>',
  "back-to-live": '<path d="M2.5 8H10M7.25 5.25 10 8l-2.75 2.75M13 3v10"/>',
} satisfies Record<LayerId, string> & Record<string, string>;

export type IconName = keyof typeof PATHS;

/** One icon, sized by its box and coloured by `currentColor`. Decorative: label the control, not the icon. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      // The path data is a constant from this file, never user input.
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

/** The halo as a loading indicator: a ring with a gap, turning. */
export function Ring({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `halo-ring ${className}` : "halo-ring"}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
    >
      <path d="M12.3 9.82A6 6 0 1 1 12.3 4.18" />
    </svg>
  );
}
