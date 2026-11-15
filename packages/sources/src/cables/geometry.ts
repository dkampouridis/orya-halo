/**
 * Line geometry on a sphere, used when baking the cable asset: length,
 * simplification, great-circle densification and antimeridian splitting.
 * Points are `[lon, lat]` in degrees throughout.
 */

export type LonLat = [lon: number, lat: number];

const RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0088;

type Vec3 = [number, number, number];

function toVec(p: LonLat): Vec3 {
  const lat = p[1] * RAD;
  const lon = p[0] * RAD;
  const c = Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of a line in kilometres. */
export function lineLengthKm(line: readonly LonLat[]): number {
  let km = 0;
  for (let i = 1; i < line.length; i++) km += haversineKm(line[i - 1], line[i]);
  return km;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Angle between two unit vectors, radians. Stable for tiny angles, unlike `acos(dot)`. */
function angleBetween(a: Vec3, b: Vec3): number {
  const c = cross(a, b);
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b));
}

/** Angular distance (radians) from `p` to the great-circle arc `a`-`b`. */
function arcDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const n = cross(a, b);
  const length = Math.hypot(n[0], n[1], n[2]);
  // Coincident or antipodal ends define no single arc.
  if (length < 1e-12) return angleBetween(p, a);
  const unit: Vec3 = [n[0] / length, n[1] / length, n[2] / length];
  // `p` is abeam of the arc when it lies between the planes through each end, square to the arc.
  const abeam = dot(cross(a, p), unit) >= 0 && dot(cross(p, b), unit) >= 0;
  if (!abeam) return Math.min(angleBetween(p, a), angleBetween(p, b));
  return Math.abs(Math.asin(Math.min(1, Math.max(-1, dot(p, unit)))));
}

/**
 * Douglas-Peucker simplification with the tolerance in metres. Distance is
 * measured to the great-circle arc between two kept vertices, which is how
 * the line is drawn after `densifyLine`, so the result does not depend on
 * latitude or on which side of the antimeridian the line lies. End points
 * are always kept.
 */
export function simplifyLine(line: readonly LonLat[], toleranceM: number): LonLat[] {
  if (line.length <= 2 || toleranceM <= 0) return line.map((p) => [p[0], p[1]]);
  const vecs = line.map(toVec);
  const tolerance = toleranceM / 1000 / EARTH_RADIUS_KM;
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;

  // An explicit stack: some ways have tens of thousands of vertices.
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = arcDistance(vecs[i], vecs[first], vecs[last]);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const out: LonLat[] = [];
  for (let i = 0; i < line.length; i++) if (keep[i]) out.push([line[i][0], line[i][1]]);
  return out;
}

/**
 * Insert points along the great circle so that no segment spans more than
 * `maxArcDeg` degrees of arc. A globe renderer draws straight chords between
 * vertices; without this a 4,000 km ocean segment would cut through the
 * planet. Inserted longitudes are in -180..180, so a crossing of the
 * antimeridian shows up as a jump for `splitAtAntimeridian` to cut.
 */
export function densifyLine(line: readonly LonLat[], maxArcDeg: number): LonLat[] {
  if (line.length === 0) return [];
  const out: LonLat[] = [[line[0][0], line[0][1]]];
  for (let i = 1; i < line.length; i++) {
    const a = toVec(line[i - 1]);
    const b = toVec(line[i]);
    const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const arc = Math.acos(dot);
    const steps = Math.ceil(arc / RAD / maxArcDeg);
    const sin = Math.sin(arc);
    for (let s = 1; s < steps && sin > 1e-12; s++) {
      const t = s / steps;
      const wa = Math.sin((1 - t) * arc) / sin;
      const wb = Math.sin(t * arc) / sin;
      const x = wa * a[0] + wb * b[0];
      const y = wa * a[1] + wb * b[1];
      const z = wa * a[2] + wb * b[2];
      out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
    }
    out.push([line[i][0], line[i][1]]);
  }
  return out;
}

/** Bring a longitude into -180..180. */
export function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lon > 0 ? 180 : wrapped;
}

/**
 * Cut a line wherever it crosses the antimeridian, so no piece is drawn the
 * long way round the globe. Each cut adds a vertex at longitude 180 on one
 * piece and -180 on the next, at the latitude where the line crosses. Pieces
 * shorter than two points are dropped.
 */
export function splitAtAntimeridian(line: readonly LonLat[]): LonLat[][] {
  const parts: LonLat[][] = [];
  if (line.length === 0) return parts;
  let current: LonLat[] = [[wrapLon(line[0][0]), line[0][1]]];

  for (let i = 1; i < line.length; i++) {
    const a = current[current.length - 1];
    const b: LonLat = [wrapLon(line[i][0]), line[i][1]];
    const jump = b[0] - a[0];
    if (Math.abs(jump) <= 180) {
      current.push(b);
      continue;
    }
    // Heading east leaves through +180 and re-enters at -180; west is the mirror.
    const edge = jump < 0 ? 180 : -180;
    const bUnwrapped = b[0] + (jump < 0 ? 360 : -360);
    const span = bUnwrapped - a[0];
    const t = span === 0 ? 0 : (edge - a[0]) / span;
    const lat = a[1] + t * (b[1] - a[1]);
    if (a[0] !== edge) current.push([edge, lat]);
    if (current.length >= 2) parts.push(current);
    current = [[-edge, lat]];
    if (b[0] !== -edge) current.push(b);
  }
  if (current.length >= 2) parts.push(current);
  return parts;
}

function pointKey(p: LonLat): string {
  return `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
}

/**
 * Join lines that meet end to end into longer lines. A line is extended only
 * where exactly one unused line shares its end point, so branching units stay
 * junctions between separate paths instead of being stitched arbitrarily.
 */
export function mergeLines(lines: readonly (readonly LonLat[])[]): LonLat[][] {
  const usable = lines.filter((l) => l.length >= 2);
  const ends = new Map<string, number[]>();
  usable.forEach((line, index) => {
    for (const key of [pointKey(line[0]), pointKey(line[line.length - 1])]) {
      const list = ends.get(key);
      if (list) list.push(index);
      else ends.set(key, [index]);
    }
  });

  const used = new Uint8Array(usable.length);
  const next = (end: LonLat): number => {
    const free = (ends.get(pointKey(end)) ?? []).filter((i) => !used[i]);
    // A line whose two ends coincide lists itself twice.
    const unique = [...new Set(free)];
    return unique.length === 1 ? unique[0] : -1;
  };

  const merged: LonLat[][] = [];
  for (let start = 0; start < usable.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    let chain: LonLat[] = usable[start].map((p) => [p[0], p[1]]);

    for (let j = next(chain[chain.length - 1]); j !== -1; j = next(chain[chain.length - 1])) {
      used[j] = 1;
      const line = usable[j];
      const forward = pointKey(line[0]) === pointKey(chain[chain.length - 1]);
      const ordered = forward ? line : [...line].reverse();
      for (let k = 1; k < ordered.length; k++) chain.push([ordered[k][0], ordered[k][1]]);
    }
    for (let j = next(chain[0]); j !== -1; j = next(chain[0])) {
      used[j] = 1;
      const line = usable[j];
      const forward = pointKey(line[line.length - 1]) === pointKey(chain[0]);
      const ordered = forward ? line : [...line].reverse();
      const head: LonLat[] = [];
      for (let k = 0; k < ordered.length - 1; k++) head.push([ordered[k][0], ordered[k][1]]);
      chain = head.concat(chain);
    }
    merged.push(chain);
  }
  return merged;
}
