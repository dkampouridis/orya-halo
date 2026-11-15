import { AIRCRAFT_MODELS } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { buildAircraftMesh } from "./aircraft-mesh.ts";

describe("buildAircraftMesh", () => {
  for (const spec of AIRCRAFT_MODELS) {
    it(`builds a sound mesh for ${spec.name}`, () => {
      const mesh = buildAircraftMesh(spec);
      const pos = mesh.attributes.positions.value;
      const nrm = mesh.attributes.normals.value;
      const idx = mesh.indices.value;
      const vertices = pos.length / 3;
      expect(idx.length % 3).toBe(0);
      expect(Math.max(...idx)).toBeLessThan(vertices);
      // Small enough to draw hundreds of.
      expect(vertices).toBeLessThan(4000);

      let minX = Infinity;
      let maxX = -Infinity;
      let maxY = 0;
      let outward = 0;
      for (let i = 0; i < vertices; i++) {
        const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        expect(Number.isFinite(x + y + z)).toBe(true);
        expect(Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2])).toBeCloseTo(1, 3);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, Math.abs(y));
        // Normals point away from the middle of the aircraft far more often than not.
        if (nrm[i * 3] * x + nrm[i * 3 + 1] * y + nrm[i * 3 + 2] * z > 0) outward++;
      }
      // Nose to tail and tip to tip match the published dimensions.
      expect(maxX - minX).toBeGreaterThan(spec.lengthM * 0.95);
      expect(maxX - minX).toBeLessThan(spec.lengthM * 1.12);
      if (spec.rotorM) {
        // Rotor blades stand at 45 degrees: they reach 0.71 of the radius sideways.
        expect(maxY).toBeGreaterThan((spec.rotorM / 2) * 0.68);
        expect(maxY).toBeLessThan((spec.rotorM / 2) * 0.75);
      } else {
        expect(maxY).toBeGreaterThan((spec.spanM / 2) * 0.9);
        expect(maxY).toBeLessThan((spec.spanM / 2) * 1.08);
      }
      // (Propeller blades are thin slabs: half their faces look back at the middle.)
      expect(outward / vertices).toBeGreaterThan(0.7);
    });
  }
});
