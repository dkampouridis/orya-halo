import { AIRCRAFT_MODELS } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { MeshPart, buildAircraftMesh } from "./aircraft-mesh.ts";

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

      // Every vertex says which part it is on, and where, for the colour scheme.
      const tags = mesh.attributes.colors.value;
      const cabin = mesh.attributes.texCoords.value;
      expect(tags.length).toBe(vertices * 3);
      expect(cabin.length).toBe(vertices * 2);
      const parts = new Set<number>();
      for (let i = 0; i < vertices; i++) {
        const part = tags[i * 3];
        parts.add(part);
        expect(Number.isInteger(part)).toBe(true);
        if (part === MeshPart.Fin) {
          // Height and chord on the fin, both 0..1.
          for (const v of [tags[i * 3 + 1], tags[i * 3 + 2]]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
        if (part === MeshPart.Fuselage || part === MeshPart.LightFuselage) {
          // The sine round the fuselage, and the distance from the nose.
          expect(Math.abs(tags[i * 3 + 1])).toBeLessThanOrEqual(1.0001);
          expect(tags[i * 3 + 2]).toBeGreaterThanOrEqual(-1e-6);
        }
      }
      expect(parts.has(MeshPart.Fin)).toBe(true);
      if (spec.rotorM) {
        expect(parts.has(MeshPart.Rotorcraft)).toBe(true);
        expect(parts.has(MeshPart.Dark)).toBe(true);
      } else {
        expect(parts.has(spec.lengthM < 18 ? MeshPart.LightFuselage : MeshPart.Fuselage)).toBe(
          true,
        );
        expect(parts.has(MeshPart.Wing)).toBe(true);
        if (spec.engines.count > 0) expect(parts.has(MeshPart.Engine)).toBe(true);
      }
    });
  }

  it("puts the nose at the front of the cabin and the top of the fuselage on top", () => {
    const a320 = AIRCRAFT_MODELS.find((m) => m.name === "Airbus A320");
    if (!a320) throw new Error("no A320");
    const mesh = buildAircraftMesh(a320);
    const pos = mesh.attributes.positions.value;
    const tags = mesh.attributes.colors.value;
    const cabin = mesh.attributes.texCoords.value;
    for (let i = 0; i < pos.length / 3; i++) {
      if (tags[i * 3] !== MeshPart.Fuselage) continue;
      // Higher round the ring, higher in the model; nearer the nose, further forward.
      if (tags[i * 3 + 1] > 0.9) expect(pos[i * 3 + 2]).toBeGreaterThan(0);
      if (cabin[i * 2] > 1.05) expect(pos[i * 3]).toBeGreaterThan(a320.lengthM * 0.3);
      if (cabin[i * 2] < -0.05) expect(pos[i * 3]).toBeLessThan(-a320.lengthM * 0.2);
    }
  });
});
