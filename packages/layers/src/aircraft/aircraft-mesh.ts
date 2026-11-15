/**
 * Builds a 3D model of an aircraft type from its published dimensions.
 *
 * The model frame: x forward (the nose at +lengthM / 2), y to the left wing,
 * z up, metres, origin at the middle of the fuselage. That is the frame
 * deck.gl's mesh layers rotate by [pitch, yaw, roll], so an aircraft is
 * placed with yaw = 90 - heading, pitch = -climb angle, roll = bank.
 *
 * Every part is a loft: rings of points joined into a tube or slab. Rings
 * run anticlockwise about the direction the loft grows in, which with the
 * triangle order below makes every face's normal point outwards, so the
 * shading is right without any per-face fixing.
 */
import type { AircraftModelSpec } from "@orya-halo/schema";

export interface AircraftMesh {
  readonly attributes: {
    readonly positions: { readonly value: Float32Array; readonly size: 3 };
    readonly normals: { readonly value: Float32Array; readonly size: 3 };
  };
  readonly indices: { readonly value: Uint32Array; readonly size: 1 };
  /** Overall length, metres: what the engine scales by. */
  readonly lengthM: number;
}

type V3 = [number, number, number];

const DEG = Math.PI / 180;

class MeshBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];

  /**
   * Join rings of equal size into a tube, each ring anticlockwise about the
   * direction from the first ring to the last. `capStart` and `capEnd` close
   * the ends with a fan.
   */
  loft(rings: readonly (readonly V3[])[], capStart = true, capEnd = true): void {
    const n = rings[0].length;
    const base = this.positions.length / 3;
    for (const ring of rings) for (const v of ring) this.positions.push(v[0], v[1], v[2]);
    for (let r = 0; r < rings.length - 1; r++) {
      for (let k = 0; k < n; k++) {
        const a = base + r * n + k;
        const b = base + r * n + ((k + 1) % n);
        const c = base + (r + 1) * n + k;
        const d = base + (r + 1) * n + ((k + 1) % n);
        this.indices.push(a, b, c, b, d, c);
      }
    }
    if (capStart) this.cap(base, n, rings[0], false);
    if (capEnd) this.cap(base + (rings.length - 1) * n, n, rings[rings.length - 1], true);
  }

  private cap(first: number, n: number, ring: readonly V3[], forward: boolean): void {
    const c: V3 = [0, 0, 0];
    for (const v of ring) for (let i = 0; i < 3; i++) c[i] += v[i] / n;
    const centre = this.positions.length / 3;
    this.positions.push(c[0], c[1], c[2]);
    for (let k = 0; k < n; k++) {
      const a = first + k;
      const b = first + ((k + 1) % n);
      if (forward) this.indices.push(centre, a, b);
      else this.indices.push(centre, b, a);
    }
  }

  /** A box from `a` to `b` (its long axis), `width` across in direction `side`, `height` across the other way. */
  box(a: V3, b: V3, side: V3, width: number, height: number): void {
    const axis = norm(sub(b, a));
    const s = norm(side);
    const u = norm(cross(axis, s));
    const ring = (p: V3): V3[] => {
      const out: V3[] = [];
      // Anticlockwise about `axis`: s, u, -s, -u.
      for (const [i, j] of [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ] as const) {
        out.push(add(p, add(scale(s, (i * width) / 2), scale(u, (j * height) / 2))));
      }
      return out;
    };
    this.loft([ring(a), ring(b)]);
  }

  build(lengthM: number): AircraftMesh {
    const positions = new Float32Array(this.positions);
    const indices = new Uint32Array(this.indices);
    const normals = new Float32Array(positions.length);
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t] * 3;
      const ib = indices[t + 1] * 3;
      const ic = indices[t + 2] * 3;
      const ux = positions[ib] - positions[ia];
      const uy = positions[ib + 1] - positions[ia + 1];
      const uz = positions[ib + 2] - positions[ia + 2];
      const vx = positions[ic] - positions[ia];
      const vy = positions[ic + 1] - positions[ia + 1];
      const vz = positions[ic + 2] - positions[ia + 2];
      // Area-weighted face normal, added to each corner.
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const i of [ia, ib, ic]) {
        normals[i] += nx;
        normals[i + 1] += ny;
        normals[i + 2] += nz;
      }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= l;
      normals[i + 1] /= l;
      normals[i + 2] /= l;
    }
    return {
      attributes: {
        positions: { value: positions, size: 3 },
        normals: { value: normals, size: 3 },
      },
      indices: { value: indices, size: 1 },
      lengthM,
    };
  }
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/** Ring of `n` points round the x axis at `x`, centre height `zc`, anticlockwise about +x. */
function ellipseRing(
  x: number,
  zc: number,
  halfW: number,
  halfH: number,
  n: number,
  top = 0,
): V3[] {
  const ring: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const s = Math.sin(a);
    // `top` lifts the upper half only: the 747's upper deck.
    const lift = s > 0 ? top * s ** 0.7 : 0;
    ring.push([x, Math.cos(a) * halfW, zc + s * halfH + lift]);
  }
  return ring;
}

/** Thickness of an airfoil section at chord fractions, upper surface; the lower surface is shallower. */
const AIRFOIL_AT = [0, 0.04, 0.3, 0.65, 1];
const AIRFOIL_UPPER = [0, 0.62, 1, 0.72, 0.04];
const AIRFOIL_LOWER = 0.55;

/**
 * One wing (or tailplane) on the left side, root to tip, as rings in the
 * x-z plane anticlockwise about +y. `mirror` builds the right one.
 */
function wingSection(
  xLe: number,
  y: number,
  z: number,
  chord: number,
  thickness: number,
  mirror: boolean,
): V3[] {
  const sy = mirror ? -1 : 1;
  const at = (f: number, h: number): V3 => [xLe - f * chord, sy * y, z + h];
  const t = thickness * chord;
  const n = AIRFOIL_AT.length;
  // Anticlockwise about +y: leading edge, down the lower surface, trailing edge, back along the upper.
  const ring: V3[] = [at(0, 0)];
  for (let i = 1; i < n - 1; i++)
    ring.push(at(AIRFOIL_AT[i], -t * AIRFOIL_UPPER[i] * AIRFOIL_LOWER));
  ring.push(at(1, 0));
  for (let i = n - 2; i >= 1; i--) ring.push(at(AIRFOIL_AT[i], t * AIRFOIL_UPPER[i]));
  // About -y the same points run the other way.
  return mirror ? ring.reverse() : ring;
}

interface Planform {
  /** Leading edge at the root, x. */
  xLe: number;
  yRoot: number;
  zRoot: number;
  halfSpan: number;
  rootChord: number;
  taper: number;
  sweepDeg: number;
  dihedralDeg: number;
  thickness: number;
}

/** Leading-edge x, height and chord of a planform at distance `y` from the centreline. */
function planformAt(p: Planform, y: number): { x: number; z: number; chord: number } {
  const span = p.halfSpan - p.yRoot;
  const f = Math.min(Math.max((y - p.yRoot) / span, 0), 1);
  return {
    x: p.xLe - (y - p.yRoot) * Math.tan(p.sweepDeg * DEG),
    z: p.zRoot + (y - p.yRoot) * Math.tan(p.dihedralDeg * DEG),
    chord: p.rootChord * (1 - f * (1 - p.taper)),
  };
}

function wingPair(m: MeshBuilder, p: Planform, wingletM = 0): void {
  for (const mirror of [false, true]) {
    const rings: V3[][] = [];
    for (const y of [p.yRoot, p.yRoot + (p.halfSpan - p.yRoot) * 0.35, p.halfSpan]) {
      const s = planformAt(p, y);
      const f = (y - p.yRoot) / (p.halfSpan - p.yRoot);
      rings.push(wingSection(s.x, y, s.z, s.chord, p.thickness * (1 - 0.3 * f), mirror));
    }
    m.loft(rings);
    if (wingletM > 0) {
      const tip = planformAt(p, p.halfSpan);
      const chord = tip.chord * 0.85;
      const sy = mirror ? -1 : 1;
      const base: V3 = [tip.x - tip.chord * 0.1, sy * p.halfSpan, tip.z];
      // A raked fin standing on the tip; rings anticlockwise about +z.
      const section = (z: number, c: number, x0: number): V3[] => {
        const t = c * 0.08;
        return [
          [x0, sy * p.halfSpan, z],
          [x0 - c * 0.3, sy * p.halfSpan + t, z],
          [x0 - c, sy * p.halfSpan, z],
          [x0 - c * 0.3, sy * p.halfSpan - t, z],
        ];
      };
      m.loft([
        section(base[2], chord, base[0]),
        section(base[2] + wingletM, chord * 0.45, base[0] - wingletM * Math.tan(38 * DEG)),
      ]);
    }
  }
}

/** Vertical fin from (xLe, zRoot) upwards, rings in the x-y plane anticlockwise about +z. */
function fin(
  m: MeshBuilder,
  xLe: number,
  zRoot: number,
  height: number,
  rootChord: number,
  tipChord: number,
  sweepDeg: number,
): {
  tipLe: number;
  tipZ: number;
  tipChord: number;
} {
  const section = (x: number, z: number, c: number): V3[] => {
    const t = c * 0.055;
    return [
      [x, 0, z],
      [x - c * 0.3, t, z],
      [x - c * 0.7, t * 0.6, z],
      [x - c, 0, z],
      [x - c * 0.7, -t * 0.6, z],
      [x - c * 0.3, -t, z],
    ];
  };
  const tipLe = xLe - height * Math.tan(sweepDeg * DEG);
  m.loft([section(xLe, zRoot, rootChord), section(tipLe, zRoot + height, tipChord)]);
  return { tipLe, tipZ: zRoot + height, tipChord };
}

/** A tube along +x centred at `c`: nacelles, spinners, booms. */
function tube(
  m: MeshBuilder,
  c: V3,
  length: number,
  radius: number,
  profile: readonly (readonly [number, number])[],
  n = 12,
): void {
  const rings = profile.map(([f, r]) =>
    ellipseRing(c[0] - length / 2 + f * length, c[2], radius * r, radius * r, n).map((v): V3 => [
      v[0],
      v[1] + c[1],
      v[2],
    ]),
  );
  m.loft(rings);
}

const NACELLE: readonly (readonly [number, number])[] = [
  [0, 0.5],
  [0.15, 0.78],
  [0.45, 0.97],
  [0.75, 1],
  [0.94, 1],
  [1, 0.9],
];
const SPINNER: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.5, 0.8],
  [1, 0.05],
];

/** Propeller blades in the y-z plane at `c`, as thin boxes. */
function propeller(m: MeshBuilder, c: V3, radius: number, blades: number): void {
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + Math.PI / 4;
    const dir: V3 = [0, Math.cos(a), Math.sin(a)];
    const tangent: V3 = [0, -Math.sin(a), Math.cos(a)];
    m.box(
      add(c, scale(dir, radius * 0.12)),
      add(c, scale(dir, radius)),
      tangent,
      radius * 0.16,
      radius * 0.04,
    );
  }
}

/** The model for one aircraft type. */
export function buildAircraftMesh(spec: AircraftModelSpec): AircraftMesh {
  if (spec.rotorM) return buildHelicopter(spec);
  const m = new MeshBuilder();
  const L = spec.lengthM;
  const W = spec.fuselageWidthM;
  const H = spec.fuselageHeightM;
  const short = L < 18;
  const noseShare = short ? 0.16 : 0.11;
  const tailShare = short ? 0.42 : 0.25;
  const upsweep = short ? 0.15 : 0.32;
  const hump = spec.humpShare ?? 0;

  // ── Fuselage, tail (u = 0) to nose (u = 1) ──
  const rings: V3[][] = [];
  const N = 30;
  const AROUND = 16;
  const centreZ = (u: number): number =>
    u < tailShare ? (1 - u / tailShare) ** 1.6 * upsweep * H : 0;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    let r = 1;
    if (u > 1 - noseShare) {
      const t = (1 - u) / noseShare;
      r = Math.sqrt(Math.max(1 - (1 - t) ** 2, 0));
    } else if (u < tailShare) {
      const t = u / tailShare;
      r = 0.12 + 0.88 * Math.sqrt(Math.max(1 - (1 - t) ** 2, 0));
    }
    const x = -L / 2 + u * L;
    const lift = hump > 0 ? H * 0.2 * smooth(1 - hump - 0.06, 1 - hump + 0.04, u) * r : 0;
    rings.push(
      ellipseRing(
        x,
        centreZ(u),
        (W / 2) * Math.max(r, 0.02),
        (H / 2) * Math.max(r, 0.02),
        AROUND,
        lift,
      ),
    );
  }
  m.loft(rings);

  // ── Wings ──
  const halfSpan = spec.spanM / 2;
  const w = spec.wing;
  const wingZ = w.position === "low" ? -0.3 * H : 0.4 * H;
  const wing: Planform = {
    xLe: L / 2 - w.rootShare * L,
    yRoot: W * 0.35,
    zRoot: wingZ,
    halfSpan: halfSpan - (w.wingletM ? 0.05 : 0),
    rootChord: w.rootChordM,
    taper: w.taper,
    sweepDeg: w.sweepDeg,
    dihedralDeg: w.dihedralDeg,
    thickness: w.sweepDeg > 15 ? 0.12 : 0.15,
  };
  wingPair(m, wing, w.wingletM ?? 0);

  // ── Engines ──
  const e = spec.engines;
  const engineR = e.diameterM / 2;
  let tailEngineTop = 0;
  if (e.count > 0 && (e.mount === "wing" || e.mount === "wing-tail")) {
    for (const share of e.spanShare ?? [0.33]) {
      const y = share * halfSpan;
      const s = planformAt(wing, y);
      for (const side of [1, -1]) {
        if (e.kind === "jet") {
          const c: V3 = [s.x + e.lengthM * 0.12, side * y, s.z - engineR * 1.08];
          tube(m, c, e.lengthM, engineR, NACELLE);
          // Pylon from the nacelle's top to the wing.
          m.box(
            [c[0] - e.lengthM * 0.15, side * y, c[2] + engineR * 0.6],
            [s.x - s.chord * 0.35, side * y, s.z],
            [0, 1, 0],
            engineR * 0.22,
            engineR * 0.5,
          );
        } else {
          // Turboprop: a nacelle slung under (or through) the wing, a spinner and blades.
          const nacR = engineR * 0.17;
          const c: V3 = [s.x - e.lengthM * 0.12, side * y, s.z - nacR * 0.4];
          tube(m, c, e.lengthM, nacR, NACELLE);
          const front: V3 = [c[0] + e.lengthM / 2, c[1], c[2]];
          tube(m, add(front, [nacR * 0.6, 0, 0]), nacR * 1.2, nacR * 0.75, SPINNER);
          propeller(m, add(front, [nacR * 0.3, 0, 0]), engineR, 4);
        }
      }
    }
  }
  if (e.count > 0 && e.mount === "rear") {
    const x = -L / 2 + 0.3 * L;
    for (const side of [1, -1]) {
      const y = side * (W / 2 + engineR * 1.25);
      tube(m, [x, y, 0.18 * H], e.lengthM, engineR, NACELLE);
      m.box(
        [x, side * W * 0.3, 0.18 * H],
        [x, y, 0.18 * H],
        [1, 0, 0],
        e.lengthM * 0.45,
        engineR * 0.35,
      );
    }
  }
  if (e.mount === "wing-tail") {
    // The third engine sits in the fin's root, above the tail cone.
    const x = -L / 2 + 0.11 * L;
    const z = centreZ(0.11) + H * 0.32 + engineR;
    tube(m, [x, 0, z], e.lengthM * 1.1, engineR, NACELLE);
    tailEngineTop = z + engineR * 0.9;
  }
  if (e.count > 0 && e.mount === "nose") {
    const nose: V3 = [L / 2, 0, 0];
    tube(m, add(nose, [engineR * 0.08, 0, 0]), engineR * 0.25, engineR * 0.1, SPINNER);
    propeller(m, add(nose, [engineR * 0.02, 0, 0]), engineR, 3);
  }

  // ── Tail ──
  const t = spec.tail;
  const tKind = t.kind === "t";
  const finRoot = (tKind ? 0.2 : 0.17) * L * (short ? 1.25 : 1);
  const finTip = finRoot * (tKind ? 0.72 : 0.42);
  const finSweep = tKind ? 32 : spec.engines.kind === "prop" ? 30 : 40;
  const finRootZ = Math.max(centreZ(0.08) + H * 0.3, tailEngineTop);
  const finLe = -L / 2 + 0.03 * L + finRoot;
  const f = fin(m, finLe, finRootZ, t.finHeightM, finRoot, finTip, finSweep);

  const tailChord = Math.max(0.1 * L * (short ? 1.3 : 1), t.spanM * 0.17);
  const tailPlane: Planform = tKind
    ? {
        xLe: f.tipLe + finTip * 0.1,
        yRoot: 0,
        zRoot: f.tipZ,
        halfSpan: t.spanM / 2,
        rootChord: Math.min(tailChord, finTip * 1.1),
        taper: 0.55,
        sweepDeg: Math.max(w.sweepDeg + 4, 8),
        dihedralDeg: 0,
        thickness: 0.1,
      }
    : {
        xLe: -L / 2 + 0.05 * L + tailChord,
        yRoot: W * 0.18,
        zRoot: centreZ(0.1) + H * 0.05,
        halfSpan: t.spanM / 2,
        rootChord: tailChord,
        taper: 0.4,
        sweepDeg: Math.max(w.sweepDeg + 4, 8),
        dihedralDeg: w.sweepDeg > 15 ? 6 : 0,
        thickness: 0.1,
      };
  wingPair(m, tailPlane);

  return m.build(L);
}

function buildHelicopter(spec: AircraftModelSpec): AircraftMesh {
  const m = new MeshBuilder();
  const L = spec.lengthM;
  const W = spec.fuselageWidthM;
  const H = spec.fuselageHeightM;
  const cabin = 0.45 * L;
  const cabinStart = L / 2 - cabin;
  // Cabin pod: round nose, deepest a third of the way back, narrowing into the boom.
  const rings: V3[][] = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const u = i / N; // 0 rear of the cabin, 1 nose
    const r =
      u > 0.7
        ? Math.sqrt(Math.max(1 - ((u - 0.7) / 0.3) ** 2, 0))
        : 0.35 + 0.65 * Math.sin((u / 0.7) * Math.PI * 0.5);
    rings.push(
      ellipseRing(
        cabinStart + u * cabin,
        (1 - r) * H * 0.18,
        (W / 2) * Math.max(r, 0.02),
        (H / 2) * Math.max(r, 0.02),
        14,
      ),
    );
  }
  m.loft(rings);
  // Tail boom to the back, with a small fin and tailplane.
  const boomR = W * 0.11;
  const boomLength = cabinStart + L / 2 + boomR;
  tube(
    m,
    [-L / 2 + boomLength / 2, 0, H * 0.12],
    boomLength,
    boomR,
    [
      [0, 0.7],
      [1, 1],
    ],
    8,
  );
  fin(m, -L / 2 + 1.1, H * 0.12, spec.tail.finHeightM, 1.0, 0.6, 30);
  m.box(
    [-L / 2 + 1.3, -spec.tail.spanM / 2, H * 0.15],
    [-L / 2 + 1.3, spec.tail.spanM / 2, H * 0.15],
    [1, 0, 0],
    0.6,
    0.08,
  );
  // Main rotor: four blades on a mast above the cabin.
  const mast: V3 = [cabinStart + cabin * 0.45, 0, H / 2 + 0.35];
  m.box([mast[0], 0, H / 2 - 0.1], mast, [1, 0, 0], 0.25, 0.25);
  const R = (spec.rotorM ?? 10) / 2;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const dir: V3 = [Math.cos(a), Math.sin(a), 0];
    const across: V3 = [-Math.sin(a), Math.cos(a), 0];
    m.box(add(mast, scale(dir, 0.2)), add(mast, scale(dir, R)), across, 0.38, 0.08);
  }
  // Skids.
  for (const side of [1, -1]) {
    const y = side * W * 0.55;
    m.box(
      [cabinStart - 0.2, y, -H / 2 - 0.35],
      [L / 2 - cabin * 0.15, y, -H / 2 - 0.35],
      [0, 1, 0],
      0.12,
      0.12,
    );
  }
  return m.build(L);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
