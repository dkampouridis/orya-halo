/**
 * Line geometry made safe to draw on a sphere. Pure.
 *
 * Paths arrive as longitude and latitude with longitudes folded into
 * -180..180, so a line that crosses the antimeridian steps from +179 to -179.
 * Drawn as it comes, that step is a stroke the long way round the world on a
 * flat map. And a long straight segment between two sparse vertices cuts
 * through the planet: on the globe its middle dips under the surface and the
 * horizon test hides it, leaving a gap.
 *
 * `preparePaths` fixes both: it follows the great circle between vertices
 * that are far apart, and it cuts each path where it crosses the antimeridian,
 * ending one piece on the line and starting the next on the other side.
 */

const DEG = Math.PI / 180;

export interface PreparedPaths {
  /** Number of pieces. One input path becomes several when it crosses the antimeridian. */
  length: number;
  /** Vertex index where each piece starts; `length` entries. */
  startIndices: Uint32Array;
  /** Flat coordinates, `size` numbers per vertex. */
  positions: Float32Array;
  size: 2 | 3;
  /** For each piece, the index of the input path it came from. */
  owners: Uint32Array;
}

export interface PrepareOptions {
  /**
   * Longest segment left alone, in degrees of arc. At 1 degree a chord sags
   * 0.004% of the planet's radius below the surface, well inside the fade the
   * horizon test allows.
   */
  maxSegmentDeg?: number;
}

/** Grows as needed; coordinates are appended a vertex at a time. */
class VertexSink {
  data: Float32Array;
  count = 0;
  private readonly size: number;

  constructor(size: number, capacity: number) {
    this.size = size;
    this.data = new Float32Array(Math.max(capacity, 4) * size);
  }

  push(lon: number, lat: number, alt: number): void {
    const at = this.count * this.size;
    if (at + this.size > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[at] = lon;
    this.data[at + 1] = lat;
    if (this.size === 3) this.data[at + 2] = alt;
    this.count++;
  }
}

/** Shortest signed difference between two longitudes, degrees, in -180..180. */
function lonDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/**
 * Cuts paths at the antimeridian and follows the great circle across long
 * segments. `startIndices` holds the first vertex of each path and, as in
 * `PathSet`, may carry one closing entry; `count` is the number of paths.
 */
export function preparePaths(
  positions: ArrayLike<number>,
  size: 2 | 3,
  startIndices: ArrayLike<number>,
  count: number,
  options: PrepareOptions = {},
): PreparedPaths {
  const maxStep = (options.maxSegmentDeg ?? 1) * DEG;
  /** Degrees: a segment whose longitude and latitude both change by less than this is short enough as it is. */
  const quick = (options.maxSegmentDeg ?? 1) * 0.7;
  const total = Math.floor(positions.length / size);
  const sink = new VertexSink(size, total + 16);
  const starts: number[] = [];
  const owners: number[] = [];

  for (let path = 0; path < count; path++) {
    const first = startIndices[path];
    const end = Math.min(path + 1 < startIndices.length ? startIndices[path + 1] : total, total);
    if (!(end > first)) continue;

    let pieceStart = sink.count;
    const closePiece = (): void => {
      // A piece needs two vertices to be a line.
      if (sink.count - pieceStart >= 2) {
        starts.push(pieceStart);
        owners.push(path);
      } else {
        sink.count = pieceStart;
      }
      pieceStart = sink.count;
    };

    // Everything below keeps the current vertex inside -180..180.
    let lon0 = lonDelta(0, positions[first * size]);
    let lat0 = positions[first * size + 1];
    let alt0 = size === 3 ? positions[first * size + 2] : 0;
    sink.push(lon0, lat0, alt0);

    for (let v = first + 1; v < end; v++) {
      const lon1 = positions[v * size];
      const lat1 = positions[v * size + 1];
      const alt1 = size === 3 ? positions[v * size + 2] : 0;
      if (!Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;

      // Most segments of real data are short and nowhere near the
      // antimeridian: both differences under 0.7 of the step bound the arc
      // below the step (0.7 * sqrt(2) < 1), so they are copied as they are,
      // with no trigonometry. A cable map is a hundred thousand of these.
      const quickLon = lon1 - lon0;
      const quickLat = lat1 - lat0;
      if (
        quickLon < quick &&
        quickLon > -quick &&
        quickLat < quick &&
        quickLat > -quick &&
        lon1 <= 180 &&
        lon1 >= -180
      ) {
        sink.push(lon1, lat1, alt1);
        lon0 = lon1;
        lat0 = lat1;
        alt0 = alt1;
        continue;
      }

      // Otherwise walk the segment in steps no longer than `maxStep`, along
      // the great circle, keeping longitude continuous (it may leave
      // -180..180 for now).
      const dLon = lonDelta(lon0, lon1);
      const phi0 = lat0 * DEG;
      const phi1 = lat1 * DEG;
      const h =
        Math.sin((phi1 - phi0) / 2) ** 2 +
        Math.cos(phi0) * Math.cos(phi1) * Math.sin((dLon * DEG) / 2) ** 2;
      const arc = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
      const steps = arc > maxStep ? Math.min(Math.ceil(arc / maxStep), 720) : 1;
      const sinArc = Math.sin(arc);

      let prevLon = lon0;
      let prevLat = lat0;
      let prevAlt = alt0;
      // Once the walk has crossed the line, the rest of it is a turn of the world over.
      let turn = 0;
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        let lon: number;
        let lat: number;
        if (s === steps) {
          lon = lon0 + dLon + turn;
          lat = lat1;
        } else {
          // Spherical interpolation, with the start at longitude 0.
          const a = Math.sin((1 - f) * arc) / sinArc;
          const b = Math.sin(f * arc) / sinArc;
          const x = a * Math.cos(phi0) + b * Math.cos(phi1) * Math.cos(dLon * DEG);
          const y = b * Math.cos(phi1) * Math.sin(dLon * DEG);
          const z = a * Math.sin(phi0) + b * Math.sin(phi1);
          lat = Math.atan2(z, Math.hypot(x, y)) / DEG;
          lon = lon0 + Math.atan2(y, x) / DEG + turn;
        }
        const alt = alt0 + (alt1 - alt0) * f;

        // `prevLon` is always inside -180..180; `lon` is continuous with it.
        if (lon > 180 || lon < -180) {
          const edge = lon > 180 ? 180 : -180;
          const t = (edge - prevLon) / (lon - prevLon);
          const latAt = prevLat + (lat - prevLat) * t;
          const altAt = prevAlt + (alt - prevAlt) * t;
          sink.push(edge, latAt, altAt);
          closePiece();
          sink.push(-edge, latAt, altAt);
          lon -= 2 * edge;
          turn -= 2 * edge;
        }
        sink.push(lon, lat, alt);
        prevLon = lon;
        prevLat = lat;
        prevAlt = alt;
      }
      // Carry the end of this segment on as it was stored, so rounding does not build up.
      lon0 = prevLon;
      lat0 = lat1;
      alt0 = alt1;
    }
    closePiece();
  }

  return {
    length: starts.length,
    startIndices: Uint32Array.from(starts),
    positions: sink.data.subarray(0, sink.count * size),
    size,
    owners: Uint32Array.from(owners),
  };
}

/**
 * The pieces of one input path, or of every input path `belongs` accepts
 * (a cable is often several paths), as a set of their own.
 */
export function piecesOf(
  prepared: PreparedPaths,
  owner: number | ((owner: number) => boolean),
): PreparedPaths {
  const belongs = typeof owner === "number" ? (o: number): boolean => o === owner : owner;
  const { size } = prepared;
  const total = prepared.positions.length / size;
  const starts: number[] = [];
  const owners: number[] = [];
  const chunks: Float32Array[] = [];
  let vertices = 0;
  for (let i = 0; i < prepared.length; i++) {
    if (!belongs(prepared.owners[i])) continue;
    const from = prepared.startIndices[i];
    const to = i + 1 < prepared.length ? prepared.startIndices[i + 1] : total;
    starts.push(vertices);
    owners.push(prepared.owners[i]);
    chunks.push(prepared.positions.subarray(from * size, to * size));
    vertices += to - from;
  }
  const positions = new Float32Array(vertices * size);
  let at = 0;
  for (const chunk of chunks) {
    positions.set(chunk, at);
    at += chunk.length;
  }
  return {
    length: starts.length,
    startIndices: Uint32Array.from(starts),
    positions,
    size,
    owners: Uint32Array.from(owners),
  };
}
