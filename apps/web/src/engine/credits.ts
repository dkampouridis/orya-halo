/**
 * The on-map credit line.
 *
 * One element in the bottom right corner of the globe, inside the engine's
 * own container so it stays put when the HUD fades. It lists, in order, the
 * credits for the data layers being shown, the credits of any raster overlay
 * on screen, and the base map's own.
 *
 * MapLibre's attribution control is not used: it takes HTML strings from
 * sources and offers no way to change custom credits after it is built.
 * Here every credit is a text and a link, set with `textContent`, so nothing
 * a provider sends is ever parsed as markup.
 */

/** One credit: what to say and where it links. Structurally the schema's `Attribution`. */
export interface Credit {
  readonly text: string;
  readonly url?: string;
}

/** Only web links are followed; anything else is shown as plain text. */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * The credits to show, in order, with repeats removed. Two sources that say
 * the same thing (two feeds from one provider) are credited once. When one
 * credit contains another ("© OpenStreetMap" and "© OpenStreetMap
 * contributors", from the cables and the base map) only the fuller one is
 * shown, in the place the first of them had.
 */
export function mergeCredits(...groups: readonly (readonly Credit[])[]): Credit[] {
  const seen: string[] = [];
  const out: Credit[] = [];
  for (const group of groups) {
    for (const credit of group) {
      const text = credit.text.trim();
      if (text.length === 0) continue;
      const key = text.toLowerCase();
      if (seen.some((earlier) => earlier.includes(key))) continue;
      const shorter = seen.findIndex((earlier) => key.includes(earlier));
      if (shorter >= 0) {
        seen[shorter] = key;
        out[shorter] = { text, url: credit.url };
        continue;
      }
      seen.push(key);
      out.push({ text, url: credit.url });
    }
  }
  return out;
}

const signature = (credits: readonly Credit[]): string =>
  credits.map((c) => `${c.text}\u0000${c.url ?? ""}`).join("\u0001");

/** Owns the credit element and redraws it only when the list really changes. */
export class CreditLine {
  readonly element: HTMLElement;
  private shown = "";

  constructor(parent: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "halo-credits";
    // A list of sources, not page content to read out with every map update.
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Map and data credits");
    parent.appendChild(this.element);
  }

  set(credits: readonly Credit[]): void {
    const next = signature(credits);
    if (next === this.shown) return;
    this.shown = next;
    const items = credits.map((credit) => {
      const href = safeHref(credit.url);
      const item = document.createElement(href ? "a" : "span");
      item.className = "halo-credit";
      item.textContent = credit.text;
      if (href) {
        const link = item as HTMLAnchorElement;
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      return item;
    });
    this.element.replaceChildren(...items);
    this.element.hidden = items.length === 0;
  }

  /** Distance from the bottom edge, CSS pixels, when something covers the corner. */
  setLift(pixels: number): void {
    this.element.style.setProperty("--halo-credits-lift", `${Math.max(0, Math.round(pixels))}px`);
  }

  remove(): void {
    this.element.remove();
  }
}
