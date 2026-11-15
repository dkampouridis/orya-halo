import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { preparePaths } from "./paths.ts";

/**
 * The bundled cable asset, read without its decoder so the engine's tests do
 * not depend on the sources package: after the header come paths as
 * delta-coded integers (the deltas run on from one path into the next), which
 * is all this needs to know. If the asset or its format changes shape the
 * test skips rather than fails; the synthetic cases in paths.test.ts are the
 * specification.
 */
function readCables(): {
  positions: Float32Array;
  startIndices: Uint32Array;
  count: number;
} | null {
  const file = fileURLToPath(new URL("../../public/data/cables.bin", import.meta.url));
  if (!existsSync(file)) return null;
  const bytes = new Uint8Array(readFileSync(file));
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "OHCB") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== 1) return null;
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength))) as {
    scale?: number;
    cables?: { paths?: number }[];
    count?: number;
  };
  const scale = header.scale && header.scale > 0 ? header.scale : 10_000;
  let offset = 12 + headerLength;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };
  const zigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
  const positions: number[] = [];
  const starts: number[] = [];
  let lon = 0;
  let lat = 0;
  try {
    while (offset < bytes.length) {
      const n = varint();
      if (n === 0 || n > 1_000_000) return null;
      starts.push(positions.length / 2);
      for (let i = 0; i < n; i++) {
        lon += zigzag(varint());
        lat += zigzag(varint());
        positions.push(lon / scale, lat / scale);
      }
    }
  } catch {
    return null;
  }
  // A sanity check that the guess at the layout was right.
  for (let i = 0; i < positions.length; i += 2) {
    if (Math.abs(positions[i]) > 360 || Math.abs(positions[i + 1]) > 90) return null;
  }
  starts.push(positions.length / 2);
  return {
    positions: new Float32Array(positions),
    startIndices: new Uint32Array(starts),
    count: starts.length - 1,
  };
}

const cables = readCables();

describe.skipIf(cables === null)("preparePaths on the bundled cable map", () => {
  it("leaves no stroke longer than a degree of arc and none across the map", () => {
    if (!cables) return;
    const t0 = performance.now();
    const p = preparePaths(cables.positions, 2, cables.startIndices, cables.count);
    const ms = performance.now() - t0;
    expect(p.length).toBeGreaterThanOrEqual(cables.count * 0.9);
    const total = p.positions.length / 2;
    let worstLon = 0;
    for (let i = 0; i < p.length; i++) {
      const from = p.startIndices[i];
      const to = i + 1 < p.length ? p.startIndices[i + 1] : total;
      for (let v = from + 1; v < to; v++) {
        worstLon = Math.max(worstLon, Math.abs(p.positions[v * 2] - p.positions[(v - 1) * 2]));
        expect(Math.abs(p.positions[v * 2])).toBeLessThanOrEqual(180);
      }
    }
    // Near the poles a degree of arc is many degrees of longitude, but never half the world.
    expect(worstLon).toBeLessThan(30);
    // The whole map on the main thread, once: it has to stay well inside a frame or two.
    expect(ms).toBeLessThan(50);
  });
});
