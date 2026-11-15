/**
 * Builds a 3D model of each kind of vessel, in code.
 *
 * The model frame is the aircraft's (see `aircraft-mesh.ts`): x forward (the
 * bow at +lengthM / 2), y to port, z up, metres, origin amidships on the
 * waterline. Only what is above the water is built. A ship is placed with
 * yaw = 90 - heading and scaled to its own length and beam.
 *
 * Hulls are a grid of stations (stern to bow) by waterlines (waterline to
 * deck edge), smooth-shaded; everything else is boxes, beams and panels,
 * each face with its own vertices so the shading stays crisp.
 *
 * Every vertex says which part it belongs to and where on that part it is
 * (`colors` and `texCoords`, see `ShipPart`), so the shader can paint a
 * colour scheme on it: hull band and bow stripe, window rows, funnel top,
 * container colours.
 */
import { VesselModel } from "@orya-halo/schema";
import type { VesselModelSpec } from "@orya-halo/schema";

/**
 * The part a vertex belongs to, in its `colors` attribute's first value.
 *
 * - Hull: `colors` = [part, height from waterline (0) to deck edge (1),
 *   place from stern (0) to bow (1)].
 * - Superstructure: [part, 1 on a level face, window kind (0 none, 1 rows,
 *   2 a band of glass)]; `texCoords` = metres along the face and above its foot.
 * - Funnel: [part, height from foot (0) to top (1), 0].
 * - Containers: [part, the stack's number, face (0 end, 1 side, 2 top)];
 *   `texCoords` = place on the face in boxes (across or along, then up).
 * - Others: [part, 0, 0].
 */
export const ShipPart = {
  Hull: 0,
  Deck: 1,
  Superstructure: 2,
  Funnel: 3,
  Containers: 4,
  /** Masts, rigging, gun mounts, fenders. */
  Dark: 5,
  /** Cranes, lifeboats, A-frames: the scheme's accent colour. */
  Accent: 6,
  HatchCover: 7,
  Sail: 8,
  /** Pipes and other light fittings. */
  Light: 9,
} as const;
export type ShipPart = (typeof ShipPart)[keyof typeof ShipPart];

export interface VesselMesh {
  readonly attributes: {
    readonly positions: { readonly value: Float32Array; readonly size: 3 };
    readonly normals: { readonly value: Float32Array; readonly size: 3 };
    /** Part and place on it, see `ShipPart`. */
    readonly colors: { readonly value: Float32Array; readonly size: 3 };
    readonly texCoords: { readonly value: Float32Array; readonly size: 2 };
  };
  readonly indices: { readonly value: Uint32Array; readonly size: 1 };
  /** The length and beam it is built at, metres: the layer scales by the ship's own over these. */
  readonly lengthM: number;
  readonly beamM: number;
  /** Highest point above the waterline, metres. */
  readonly heightM: number;
}

type V3 = [number, number, number];
/** colors[1], colors[2], texCoords[0], texCoords[1]. */
type Tag = readonly [number, number, number, number];
const NO_TAG: Tag = [0, 0, 0, 0];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

class ShipBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  readonly colors: number[] = [];
  readonly texCoords: number[] = [];
  part: ShipPart = ShipPart.Hull;

  private vertex(p: V3, t: Tag): number {
    this.positions.push(p[0], p[1], p[2]);
    this.colors.push(this.part, t[0], t[1]);
    this.texCoords.push(t[2], t[3]);
    return this.positions.length / 3 - 1;
  }

  /** A flat four-sided face, its own vertices, facing `out` whatever order the corners come in. */
  quad(corners: readonly V3[], out: V3, tag: (p: V3) => Tag = () => NO_TAG): void {
    let [a, b, c, d] = corners;
    if (dot(cross(sub(b, a), sub(c, a)), out) < 0) [b, d] = [d, b];
    const i = [a, b, c, d].map((p) => this.vertex(p, tag(p)));
    this.indices.push(i[0], i[1], i[2], i[0], i[2], i[3]);
  }

  /** A triangle seen from both sides: two faces a hair apart. */
  panel(a: V3, b: V3, c: V3, tag: Tag = NO_TAG): void {
    const n = norm(cross(sub(b, a), sub(c, a)));
    const off = scale(n, 0.02);
    const front = [a, b, c].map((p) => this.vertex(add(p, off), tag));
    this.indices.push(front[0], front[1], front[2]);
    const back = [a, b, c].map((p) => this.vertex(sub(p, off), tag));
    this.indices.push(back[0], back[2], back[1]);
  }

  /**
   * A smooth surface through a grid of points, `rows[i][j]`, facing `out`
   * (judged on its largest cell).
   */
  grid(rows: readonly (readonly V3[])[], out: V3, tag: (i: number, j: number) => Tag): void {
    const n = rows[0].length;
    const base = this.positions.length / 3;
    rows.forEach((row, i) => row.forEach((p, j) => this.vertex(p, tag(i, j))));
    let best = 0;
    let flip = false;
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        const c = cross(sub(rows[i][j + 1], rows[i][j]), sub(rows[i + 1][j], rows[i][j]));
        const area = Math.hypot(c[0], c[1], c[2]);
        if (area > best) {
          best = area;
          flip = dot(c, out) < 0;
        }
      }
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        const a = base + i * n + j;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        if (flip) this.indices.push(a, c, b, b, c, d);
        else this.indices.push(a, b, c, b, d, c);
      }
    }
  }

  /**
   * An upright box, x0..x1 by y0..y1 by z0..z1, without a bottom. `tag`
   * places each corner on its face: `face` is 0 for the ends, 1 for the
   * sides, 2 for the top.
   */
  box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    tag: (p: V3, face: 0 | 1 | 2) => Tag = () => NO_TAG,
  ): void {
    const P = (x: number, y: number, z: number): V3 => [x, y, z];
    this.quad([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], [1, 0, 0], (p) =>
      tag(p, 0),
    );
    this.quad([P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1)], [-1, 0, 0], (p) =>
      tag(p, 0),
    );
    this.quad([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], [0, 1, 0], (p) =>
      tag(p, 1),
    );
    this.quad([P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], [0, -1, 0], (p) =>
      tag(p, 1),
    );
    this.quad([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], [0, 0, 1], (p) =>
      tag(p, 2),
    );
  }

  /** A beam from `a` to `b`, `w` wide along `side` and `h` deep the other way, ends closed. */
  beam(a: V3, b: V3, side: V3, w: number, h: number): void {
    const axis = norm(sub(b, a));
    const s = norm(side);
    const u = norm(cross(axis, s));
    const corner = (p: V3, i: number, j: number): V3 =>
      add(p, add(scale(s, (i * w) / 2), scale(u, (j * h) / 2)));
    const ring = (p: V3): V3[] => [
      corner(p, 1, 1),
      corner(p, -1, 1),
      corner(p, -1, -1),
      corner(p, 1, -1),
    ];
    const ra = ring(a);
    const rb = ring(b);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const mid = scale(add(add(ra[k], ra[k2]), add(rb[k], rb[k2])), 0.25);
      this.quad([ra[k], ra[k2], rb[k2], rb[k]], sub(mid, scale(add(a, b), 0.5)));
    }
    this.quad(ra, scale(axis, -1));
    this.quad(rb, axis);
  }

  build(spec: VesselModelSpec): VesselMesh {
    const positions = new Float32Array(this.positions);
    const indices = new Uint32Array(this.indices);
    const normals = new Float32Array(positions.length);
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t] * 3;
      const ib = indices[t + 1] * 3;
      const ic = indices[t + 2] * 3;
      const u: V3 = [
        positions[ib] - positions[ia],
        positions[ib + 1] - positions[ia + 1],
        positions[ib + 2] - positions[ia + 2],
      ];
      const v: V3 = [
        positions[ic] - positions[ia],
        positions[ic + 1] - positions[ia + 1],
        positions[ic + 2] - positions[ia + 2],
      ];
      // Area-weighted face normal, added to each corner.
      const n = cross(u, v);
      for (const i of [ia, ib, ic]) {
        normals[i] += n[0];
        normals[i + 1] += n[1];
        normals[i + 2] += n[2];
      }
    }
    let heightM = 0;
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      if (l > 0) {
        normals[i] /= l;
        normals[i + 1] /= l;
        normals[i + 2] /= l;
      } else {
        normals[i + 2] = 1;
      }
      heightM = Math.max(heightM, positions[i + 2]);
    }
    return {
      attributes: {
        positions: { value: positions, size: 3 },
        normals: { value: normals, size: 3 },
        colors: { value: new Float32Array(this.colors), size: 3 },
        texCoords: { value: new Float32Array(this.texCoords), size: 2 },
      },
      indices: { value: indices, size: 1 },
      lengthM: spec.lengthM,
      beamM: spec.beamM,
      heightM,
    };
  }
}

interface HullForm {
  /** Share of the length the bow narrows over, and how full it stays (0 fine, 1 blunt). */
  bowShare: number;
  bowFull: number;
  /** Share of the length the stern narrows over, and the transom's width as a share of the beam. */
  sternShare: number;
  transom: number;
  /** How far the stem leans forward from the waterline to the deck, metres. */
  rake: number;
  /** Extra freeboard at the bow, metres. */
  sheer: number;
}

/** The hull's shape, to place everything else on it. */
interface Hull {
  L: number;
  B: number;
  D: number;
  /** x of place `u` (0 stern, 1 bow) along the deck. */
  x(u: number): number;
  /** Half-breadth at place `u` and height share `h`, metres. */
  half(u: number, h: number): number;
  /** Deck height at place `u`, metres. */
  deck(u: number): number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

const STATIONS = [
  0, 0.015, 0.04, 0.08, 0.13, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.78, 0.84, 0.89, 0.93, 0.96, 0.98,
  0.993, 1,
];
const LEVELS = [0, 0.3, 0.65, 1];

function hull(m: ShipBuilder, spec: VesselModelSpec, f: HullForm): Hull {
  const L = spec.lengthM;
  const B = spec.beamM;
  const D = spec.freeboardM;
  const half = (u: number, h: number): number => {
    let w = 1;
    const bowStart = 1 - f.bowShare;
    if (u > bowStart) {
      const t = (1 - u) / f.bowShare;
      // Fuller higher up: a ship's bow flares out towards the deck.
      const k = 1.4 + 2.2 * f.bowFull + 0.9 * h;
      w = 1 - (1 - t) ** k;
    } else if (u < f.sternShare) {
      const s = u / f.sternShare;
      const tw = f.transom * (0.55 + 0.45 * h);
      w = tw + (1 - tw) * (1 - (1 - s) ** 2);
    }
    return (B / 2) * Math.max(w, 0);
  };
  const deck = (u: number): number => D + f.sheer * smooth(0.72, 1, u) ** 1.5;
  // The stem leans forward with height: the waterline is shorter than the deck.
  const xAt = (u: number, h: number): number => -L / 2 + u * (L - f.rake * (1 - h));
  const point = (u: number, h: number, side: number): V3 => [
    xAt(u, h),
    side * half(u, h),
    h * deck(u),
  ];

  m.part = ShipPart.Hull;
  const hullTag = (u: number, h: number, p: V3): Tag => [h, u, p[0], p[2]];
  for (const side of [1, -1]) {
    const rows = LEVELS.map((h) => STATIONS.map((u) => point(u, h, side)));
    m.grid(rows, [0, side, 0], (i, j) => hullTag(STATIONS[j], LEVELS[i], rows[i][j]));
  }
  // Transom.
  for (let i = 0; i < LEVELS.length - 1; i++) {
    const h0 = LEVELS[i];
    const h1 = LEVELS[i + 1];
    m.quad(
      [point(0, h0, 1), point(0, h1, 1), point(0, h1, -1), point(0, h0, -1)],
      [-1, 0, 0],
      (p) => [p[2] / D, 0, p[0], p[2]],
    );
  }
  // Deck and bottom.
  for (let j = 0; j < STATIONS.length - 1; j++) {
    const u0 = STATIONS[j];
    const u1 = STATIONS[j + 1];
    m.part = ShipPart.Deck;
    m.quad([point(u0, 1, 1), point(u1, 1, 1), point(u1, 1, -1), point(u0, 1, -1)], [0, 0, 1]);
    m.part = ShipPart.Hull;
    m.quad(
      [point(u0, 0, 1), point(u1, 0, 1), point(u1, 0, -1), point(u0, 0, -1)],
      [0, 0, -1],
      (p) => [0, Math.min(Math.max((p[0] + L / 2) / L, 0), 1), p[0], 0],
    );
  }
  return { L, B, D, x: (u) => xAt(u, 1), half, deck };
}

/** Superstructure: a box with window rows (`windows` 1) or a band of glass (2). */
function house(
  m: ShipBuilder,
  x0: number,
  x1: number,
  halfWidth: number,
  z0: number,
  z1: number,
  windows: 0 | 1 | 2 = 1,
): void {
  m.part = ShipPart.Superstructure;
  m.box(x0, x1, -halfWidth, halfWidth, z0, z1, (p, face) =>
    face === 2
      ? [1, windows, p[0], p[1]]
      : [0, windows, face === 0 ? p[1] + halfWidth : p[0] - x0, p[2] - z0],
  );
}

function funnel(
  m: ShipBuilder,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  m.part = ShipPart.Funnel;
  m.box(x0, x1, y0, y1, z0, z1, (p) => [(p[2] - z0) / (z1 - z0), 0, 0, 0]);
}

function plain(
  m: ShipBuilder,
  part: ShipPart,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  m.part = part;
  m.box(x0, x1, y0, y1, z0, z1);
}

/** A mast: a thin dark post from the deck up. */
function mast(m: ShipBuilder, x: number, z0: number, z1: number, w: number): void {
  plain(m, ShipPart.Dark, x - w / 2, x + w / 2, -w / 2, w / 2, z0, z1);
}

/** A deck crane: a pedestal and a jib raised towards `toward` (+1 forward, -1 aft). */
function crane(
  m: ShipBuilder,
  x: number,
  y: number,
  z: number,
  height: number,
  jib: number,
  toward: number,
  w: number,
): void {
  plain(m, ShipPart.Accent, x - w, x + w, y - w, y + w, z, z + height);
  m.part = ShipPart.Accent;
  const top: V3 = [x, y, z + height];
  const angle = (50 * Math.PI) / 180;
  const tip: V3 = [x + toward * jib * Math.cos(angle), y, z + height + jib * Math.sin(angle)];
  m.beam(top, tip, [0, 1, 0], w * 0.9, w * 0.7);
}

/** Lifeboats along both sides, as orange boxes. */
function lifeboats(
  m: ShipBuilder,
  x0: number,
  x1: number,
  y: number,
  z: number,
  count: number,
  size: number,
): void {
  const step = (x1 - x0) / count;
  for (let i = 0; i < count; i++) {
    const cx = x0 + step * (i + 0.5);
    for (const side of [1, -1]) {
      plain(
        m,
        ShipPart.Accent,
        cx - size * 1.6,
        cx + size * 1.6,
        side * y - size / 2,
        side * y + size / 2,
        z,
        z + size * 0.8,
      );
    }
  }
}

const TEU_W = 2.44;
const TEU_H = 2.59;
const TEU_L = 6.1;

/** A container ship's cargo: bays of 40 ft boxes, three stacks across, of varying height. */
function containerBays(m: ShipBuilder, h: Hull, u0: number, u1: number, tiers: number): void {
  const bayLength = 2 * TEU_L;
  const gap = 1.4;
  const x0 = h.x(u0);
  const x1 = h.x(u1);
  let stack = 0;
  for (let x = x0; x + bayLength <= x1; x += bayLength + gap) {
    const xa = x;
    const xb = x + bayLength;
    const uFront = (xb + h.L / 2) / h.L;
    // Fit inside the hull at the bay's narrower end, in whole boxes.
    const room = Math.min(h.half(uFront, 1), h.half((xa + h.L / 2) / h.L, 1)) - 0.8;
    const rows = Math.floor((2 * room) / TEU_W);
    if (rows < 2) continue;
    const width = rows * TEU_W;
    const z0 = Math.max(h.deck(uFront), h.deck((xa + h.L / 2) / h.L));
    // Lower towards the bow, where the bridge has to see over them.
    const bayTiers = Math.max(2, Math.round(tiers * (1 - 0.4 * smooth(0.7, 0.95, uFront))));
    const thirds = [0, Math.round(rows / 3), Math.round((2 * rows) / 3), rows];
    for (let k = 0; k < 3; k++) {
      if (thirds[k + 1] <= thirds[k]) continue;
      const ya = -width / 2 + thirds[k] * TEU_W;
      const yb = -width / 2 + thirds[k + 1] * TEU_W;
      // Stacks stand a tier higher or lower than their neighbours, as loaded ships do.
      const vary = ((stack * 7 + k * 3) % 5 === 0 ? -1 : 0) + ((stack * 5 + k) % 7 === 0 ? -1 : 0);
      const top = z0 + 0.6 + Math.max(1, bayTiers + vary) * TEU_H;
      const id = stack * 3 + k;
      m.part = ShipPart.Containers;
      m.box(xa, xb, ya, yb, z0 + 0.6, top, (p, face) =>
        face === 0
          ? [id, 0, (p[1] - ya) / TEU_W, (p[2] - z0 - 0.6) / TEU_H]
          : face === 1
            ? [id, 1, (p[0] - xa) / (2 * TEU_L), (p[2] - z0 - 0.6) / TEU_H]
            : [id, 2, (p[1] - ya) / TEU_W, (p[0] - xa) / (2 * TEU_L)],
      );
    }
    stack++;
  }
}

/** Hatch covers between u0 and u1, `count` of them, a share of the beam wide. */
function hatches(
  m: ShipBuilder,
  h: Hull,
  u0: number,
  u1: number,
  count: number,
  share: number,
  height: number,
): number[] {
  const step = (u1 - u0) / count;
  const gaps: number[] = [];
  for (let i = 0; i < count; i++) {
    const ua = u0 + step * (i + 0.12);
    const ub = u0 + step * (i + 0.88);
    const halfW = Math.min(h.half(ua, 1), h.half(ub, 1)) * share;
    const z = Math.max(h.deck(ua), h.deck(ub));
    plain(m, ShipPart.HatchCover, h.x(ua), h.x(ub), -halfW, halfW, z, z + height);
    gaps.push(u0 + step * i);
  }
  return gaps;
}

/** An aft deckhouse with bridge wings and a funnel behind it: tankers, bulk and general cargo ships. */
function aftHouse(
  m: ShipBuilder,
  h: Hull,
  u0: number,
  u1: number,
  widthShare: number,
  height: number,
  funnelHeight: number,
): void {
  const z = h.deck((u0 + u1) / 2);
  const x0 = h.x(u0);
  const x1 = h.x(u1);
  house(m, x0, x1, (h.B / 2) * widthShare, z, z + height, 1);
  // The bridge, its wings out to the ship's side.
  const deckH = Math.min(2.8, height * 0.2);
  house(m, x1 - (x1 - x0) * 0.35, x1, h.B / 2 - 0.3, z + height - deckH, z + height, 2);
  mast(m, x0 + (x1 - x0) * 0.6, z + height, z + height + height * 0.3, Math.max(h.B * 0.012, 0.15));
  const fx1 = x0 - (x1 - x0) * 0.05;
  const fx0 = fx1 - (x1 - x0) * 0.3;
  funnel(m, fx0, fx1, -h.B * 0.1, h.B * 0.1, z, z + funnelHeight);
}

function buildModel(spec: VesselModelSpec): ShipBuilder {
  const m = new ShipBuilder();
  const id = spec.id;
  if (id === VesselModel.Container) {
    const h = hull(m, spec, {
      bowShare: 0.2,
      bowFull: 0.3,
      sternShare: 0.14,
      transom: 0.75,
      rake: 8,
      sheer: 3,
    });
    const z = h.deck(0.2);
    const tiers = 6;
    const stackTop = z + 0.6 + tiers * TEU_H;
    // Deckhouse a fifth of the way from the stern, tall enough to see over the boxes.
    const x0 = h.x(0.17);
    const x1 = h.x(0.215);
    house(m, x0, x1, h.B * 0.32, z, stackTop + 9, 1);
    house(m, x1 - 5, x1, h.B / 2 - 0.5, stackTop + 6, stackTop + 9, 2);
    mast(m, x0 + 4, stackTop + 9, stackTop + 15, 0.6);
    funnel(m, h.x(0.115), h.x(0.15), -h.B * 0.12, h.B * 0.12, z, stackTop + 4);
    containerBays(m, h, 0.225, 0.9, tiers);
    containerBays(m, h, 0.025, 0.105, tiers - 2);
  } else if (id === VesselModel.Tanker) {
    const h = hull(m, spec, {
      bowShare: 0.16,
      bowFull: 0.75,
      sternShare: 0.12,
      transom: 0.8,
      rake: 5,
      sheer: 1.5,
    });
    aftHouse(m, h, 0.05, 0.13, 0.78, 17, 22);
    // The cargo pipes along the deck, and the manifold across it amidships.
    const z = h.deck(0.5);
    plain(m, ShipPart.Light, h.x(0.15), h.x(0.93), -1.6, 1.6, z, z + 1.4);
    plain(m, ShipPart.Light, h.x(0.49), h.x(0.52), -h.B * 0.42, h.B * 0.42, z, z + 1.2);
    crane(m, h.x(0.47), h.B * 0.3, z, 4, 12, 1, 0.6);
    crane(m, h.x(0.47), -h.B * 0.3, z, 4, 12, 1, 0.6);
    mast(m, h.x(0.97), h.deck(0.97), h.deck(0.97) + 10, 0.6);
  } else if (id === VesselModel.Bulk) {
    const h = hull(m, spec, {
      bowShare: 0.15,
      bowFull: 0.7,
      sternShare: 0.12,
      transom: 0.8,
      rake: 4,
      sheer: 1.5,
    });
    aftHouse(m, h, 0.05, 0.13, 0.75, 15, 19);
    const gaps = hatches(m, h, 0.16, 0.93, 5, 0.62, 2.2);
    // Geared bulk carriers: a crane between each pair of holds.
    for (let i = 1; i < gaps.length; i++) {
      crane(m, h.x(gaps[i]), 0, h.deck(gaps[i]), 7, 24, i % 2 === 0 ? 1 : -1, 0.9);
    }
    mast(m, h.x(0.97), h.deck(0.97), h.deck(0.97) + 8, 0.5);
  } else if (id === VesselModel.CarCarrier) {
    const h = hull(m, spec, {
      bowShare: 0.1,
      bowFull: 0.95,
      sternShare: 0.06,
      transom: 0.95,
      rake: 2,
      sheer: 0,
    });
    const z = h.D;
    house(m, h.x(0.85), h.x(0.92), h.B * 0.45, z, z + 3.2, 2);
    mast(m, h.x(0.87), z + 3.2, z + 9, 0.6);
    funnel(m, h.x(0.04), h.x(0.11), -h.B * 0.14, h.B * 0.14, z, z + 6);
  } else if (id === VesselModel.Cruise) {
    const h = hull(m, spec, {
      bowShare: 0.2,
      bowFull: 0.35,
      sternShare: 0.1,
      transom: 0.85,
      rake: 10,
      sheer: 2,
    });
    const z = h.D;
    house(m, h.x(0.07), h.x(0.84), h.B * 0.44, z, z + 6, 1);
    lifeboats(m, h.x(0.25), h.x(0.72), h.B * 0.44 + 1.6, z + 1.5, 8, 3.2);
    house(m, h.x(0.08), h.x(0.83), h.B * 0.49, z + 6, z + 27, 2);
    house(m, h.x(0.14), h.x(0.72), h.B * 0.4, z + 27, z + 33, 1);
    house(m, h.x(0.79), h.x(0.83), h.B / 2, z + 24, z + 27, 2);
    funnel(m, h.x(0.2), h.x(0.28), -h.B * 0.1, h.B * 0.1, z + 33, z + 42);
    plain(m, ShipPart.Deck, h.x(0.32), h.x(0.5), -h.B * 0.18, h.B * 0.18, z + 33, z + 33.4);
  } else if (id === VesselModel.Ferry) {
    const h = hull(m, spec, {
      bowShare: 0.18,
      bowFull: 0.5,
      sternShare: 0.08,
      transom: 0.92,
      rake: 6,
      sheer: 1.5,
    });
    const z = h.D;
    house(m, h.x(0.06), h.x(0.82), h.B * 0.48, z, z + 11, 1);
    lifeboats(m, h.x(0.3), h.x(0.7), h.B * 0.48 + 1.4, z + 5, 4, 2.6);
    house(m, h.x(0.25), h.x(0.79), h.B * 0.42, z + 11, z + 17, 1);
    house(m, h.x(0.75), h.x(0.79), h.B / 2, z + 14, z + 17, 2);
    mast(m, h.x(0.7), z + 17, z + 24, 0.6);
    funnel(m, h.x(0.13), h.x(0.22), -h.B * 0.12, h.B * 0.12, z + 11, z + 21);
  } else if (id === VesselModel.GeneralCargo) {
    const h = hull(m, spec, {
      bowShare: 0.18,
      bowFull: 0.6,
      sternShare: 0.12,
      transom: 0.8,
      rake: 3,
      sheer: 1.5,
    });
    aftHouse(m, h, 0.06, 0.17, 0.85, 9, 12);
    hatches(m, h, 0.21, 0.9, 2, 0.72, 1.6);
    crane(m, h.x(0.555), h.B * 0.32, h.deck(0.555), 5, 15, 1, 0.6);
    crane(m, h.x(0.205), -h.B * 0.32, h.deck(0.205), 5, 15, 1, 0.6);
    mast(m, h.x(0.95), h.deck(0.95), h.deck(0.95) + 6, 0.35);
  } else if (id === VesselModel.Fishing) {
    const h = hull(m, spec, {
      bowShare: 0.32,
      bowFull: 0.5,
      sternShare: 0.1,
      transom: 0.85,
      rake: 1.2,
      sheer: 1.6,
    });
    const z = h.deck(0.6);
    house(m, h.x(0.52), h.x(0.74), h.B * 0.34, z, z + 2.6, 1);
    house(m, h.x(0.58), h.x(0.72), h.B * 0.3, z + 2.6, z + 4.6, 2);
    mast(m, h.x(0.66), z + 4.6, z + 10, 0.25);
    m.part = ShipPart.Dark;
    m.beam([h.x(0.66), 0, z + 9], [h.x(0.15), 0, z + 2], [0, 1, 0], 0.18, 0.18);
    // A gantry over the stern for the nets.
    const xs = h.x(0.05);
    const zs = h.deck(0.05);
    m.part = ShipPart.Accent;
    for (const side of [1, -1])
      m.beam([xs, side * h.B * 0.36, zs], [xs, side * h.B * 0.36, zs + 4.5], [1, 0, 0], 0.35, 0.35);
    m.beam([xs, h.B * 0.36, zs + 4.5], [xs, -h.B * 0.36, zs + 4.5], [1, 0, 0], 0.35, 0.35);
  } else if (id === VesselModel.Tug) {
    const h = hull(m, spec, {
      bowShare: 0.36,
      bowFull: 0.85,
      sternShare: 0.16,
      transom: 0.9,
      rake: 1,
      sheer: 1,
    });
    const z = h.deck(0.6);
    house(m, h.x(0.42), h.x(0.74), h.B * 0.33, z, z + 2.6, 1);
    house(m, h.x(0.52), h.x(0.7), h.B * 0.28, z + 2.6, z + 5.2, 2);
    mast(m, h.x(0.6), z + 5.2, z + 9, 0.25);
    for (const side of [1, -1])
      funnel(m, h.x(0.36), h.x(0.42), side * h.B * 0.12, side * h.B * 0.26, z, z + 5.5);
    // The fender round the bow.
    plain(
      m,
      ShipPart.Dark,
      h.x(0.97),
      h.x(1) + 0.3,
      -h.B * 0.12,
      h.B * 0.12,
      h.deck(1) - 1.6,
      h.deck(1),
    );
  } else if (id === VesselModel.PilotBoat) {
    const h = hull(m, spec, {
      bowShare: 0.38,
      bowFull: 0.3,
      sternShare: 0.05,
      transom: 0.95,
      rake: 1.2,
      sheer: 0.4,
    });
    const z = h.deck(0.5);
    house(m, h.x(0.36), h.x(0.68), h.B * 0.37, z, z + 2.3, 2);
    mast(m, h.x(0.48), z + 2.3, z + 4.2, 0.12);
  } else if (id === VesselModel.Patrol) {
    const h = hull(m, spec, {
      bowShare: 0.28,
      bowFull: 0.25,
      sternShare: 0.1,
      transom: 0.85,
      rake: 4,
      sheer: 1.6,
    });
    const z = h.deck(0.5);
    house(m, h.x(0.36), h.x(0.66), h.B * 0.4, z, z + 6, 1);
    house(m, h.x(0.56), h.x(0.66), h.B * 0.44, z + 6, z + 8.8, 2);
    mast(m, h.x(0.58), z + 8.8, z + 18, 0.8);
    funnel(m, h.x(0.4), h.x(0.47), -h.B * 0.13, h.B * 0.13, z + 6, z + 10);
    // A gun forward.
    const xg = h.x(0.79);
    const zg = h.deck(0.79);
    plain(m, ShipPart.Dark, xg - 1.5, xg + 1.5, -1.3, 1.3, zg, zg + 1.6);
    m.part = ShipPart.Dark;
    m.beam([xg + 1.5, 0, zg + 1], [xg + 6, 0, zg + 1.6], [0, 1, 0], 0.25, 0.25);
  } else if (id === VesselModel.SailingYacht) {
    const h = hull(m, spec, {
      bowShare: 0.45,
      bowFull: 0.15,
      sternShare: 0.25,
      transom: 0.72,
      rake: 1.6,
      sheer: 0.3,
    });
    const z = h.deck(0.5);
    house(m, h.x(0.36), h.x(0.66), h.B * 0.3, z, z + 0.65, 2);
    const xm = h.x(0.6);
    const top = z + spec.lengthM * 1.3;
    mast(m, xm, z, top, 0.18);
    // Mainsail back to the boom, a jib forward to the stem.
    m.part = ShipPart.Sail;
    m.panel([xm - 0.2, 0, z + 1.2], [h.x(0.08), 0, z + 1.4], [xm - 0.2, 0, top - 0.6]);
    m.panel([xm + 0.2, 0, top - 2.2], [h.x(0.995), 0, h.deck(1) + 0.4], [xm + 0.4, 0, z + 1]);
  } else if (id === VesselModel.MotorYacht) {
    const h = hull(m, spec, {
      bowShare: 0.35,
      bowFull: 0.3,
      sternShare: 0.04,
      transom: 0.92,
      rake: 2.5,
      sheer: 0.8,
    });
    const z = h.deck(0.5);
    house(m, h.x(0.2), h.x(0.74), h.B * 0.43, z, z + 2.4, 2);
    house(m, h.x(0.3), h.x(0.64), h.B * 0.37, z + 2.4, z + 4.6, 2);
    m.part = ShipPart.Dark;
    m.beam([h.x(0.42), h.B * 0.3, z + 4.6], [h.x(0.45), 0, z + 6.2], [1, 0, 0], 0.25, 0.25);
    m.beam([h.x(0.42), -h.B * 0.3, z + 4.6], [h.x(0.45), 0, z + 6.2], [1, 0, 0], 0.25, 0.25);
  } else {
    // Any other vessel: a workboat with the bridge forward and an open deck aft.
    const h = hull(m, spec, {
      bowShare: 0.22,
      bowFull: 0.6,
      sternShare: 0.06,
      transom: 0.95,
      rake: 2.5,
      sheer: 2.5,
    });
    const z = h.deck(0.75);
    house(m, h.x(0.64), h.x(0.88), h.B * 0.43, z, z + 7, 1);
    house(m, h.x(0.72), h.x(0.86), h.B * 0.38, z + 7, z + 10, 2);
    mast(m, h.x(0.78), z + 10, z + 16, 0.4);
    funnel(m, h.x(0.58), h.x(0.64), -h.B * 0.2, h.B * 0.2, z, z + 9);
    crane(m, h.x(0.2), h.B * 0.3, h.deck(0.2), 3, 10, 1, 0.4);
  }
  return m;
}

/** The model for one kind of vessel. */
export function buildVesselMesh(spec: VesselModelSpec): VesselMesh {
  return buildModel(spec).build(spec);
}
