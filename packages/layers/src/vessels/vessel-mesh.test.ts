import { VESSEL_MODELS, VesselModel } from "@orya-halo/schema";
import { describe, expect, it } from "vite-plus/test";
import { ShipPart, buildVesselMesh } from "./vessel-mesh.ts";

describe("buildVesselMesh", () => {
  for (const spec of VESSEL_MODELS) {
    it(`builds a sound mesh for the ${spec.name.toLowerCase()}`, () => {
      const mesh = buildVesselMesh(spec);
      const pos = mesh.attributes.positions.value;
      const nrm = mesh.attributes.normals.value;
      const idx = mesh.indices.value;
      const vertices = pos.length / 3;
      expect(idx.length % 3).toBe(0);
      expect(Math.max(...idx)).toBeLessThan(vertices);
      // Small enough to draw hundreds of.
      expect(vertices).toBeLessThan(4000);
      expect(mesh.lengthM).toBe(spec.lengthM);
      expect(mesh.beamM).toBe(spec.beamM);

      let minX = Infinity;
      let maxX = -Infinity;
      let maxY = 0;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < vertices; i++) {
        const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        expect(Number.isFinite(x + y + z)).toBe(true);
        expect(Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2])).toBeCloseTo(1, 3);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        if (mesh.attributes.colors.value[i * 3] === ShipPart.Hull)
          maxY = Math.max(maxY, Math.abs(y));
      }
      // Stem to stern and side to side match the dimensions it is built at.
      expect(maxX - minX).toBeGreaterThan(spec.lengthM * 0.98);
      expect(maxX - minX).toBeLessThan(spec.lengthM * 1.05);
      expect(maxY).toBeCloseTo(spec.beamM / 2, 1);
      // Built up from the waterline, never below it.
      expect(minZ).toBeGreaterThanOrEqual(-0.05);
      expect(maxZ).toBeCloseTo(mesh.heightM, 3);
      expect(mesh.heightM).toBeGreaterThan(spec.freeboardM);

      // Every face points outwards from its own part: check each triangle's
      // winding against its vertex normals (smooth hull, flat everything else).
      const tri = (k: number, c: number): number => idx[k] * 3 + c;
      let agree = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const a = [0, 1, 2].map((c) => pos[tri(t, c)]);
        const b = [0, 1, 2].map((c) => pos[tri(t + 1, c)]);
        const c = [0, 1, 2].map((c) => pos[tri(t + 2, c)]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const vn = [0, 1, 2].map((k) => nrm[tri(t, k)]);
        if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] >= 0) agree++;
      }
      expect(agree / (idx.length / 3)).toBeGreaterThan(0.99);

      // Every vertex says which part it is on, and where, for the colour scheme.
      const tags = mesh.attributes.colors.value;
      const place = mesh.attributes.texCoords.value;
      expect(tags.length).toBe(vertices * 3);
      expect(place.length).toBe(vertices * 2);
      const parts = new Set<number>();
      for (let i = 0; i < vertices; i++) {
        const part = tags[i * 3];
        parts.add(part);
        expect(Number.isInteger(part)).toBe(true);
        expect(part).toBeLessThanOrEqual(ShipPart.Light);
        if (part === ShipPart.Hull) {
          // Height share up the side and place from stern to bow, both 0..1.
          for (const v of [tags[i * 3 + 1], tags[i * 3 + 2]]) {
            expect(v).toBeGreaterThanOrEqual(-1e-6);
            expect(v).toBeLessThanOrEqual(1 + 1e-6);
          }
        }
        if (part === ShipPart.Funnel) {
          expect(tags[i * 3 + 1]).toBeGreaterThanOrEqual(0);
          expect(tags[i * 3 + 1]).toBeLessThanOrEqual(1);
        }
        if (part === ShipPart.Superstructure) {
          expect([0, 1]).toContain(tags[i * 3 + 1]);
          expect([0, 1, 2]).toContain(tags[i * 3 + 2]);
        }
      }
      expect(parts.has(ShipPart.Hull)).toBe(true);
      expect(parts.has(ShipPart.Deck)).toBe(true);
      expect(parts.has(ShipPart.Superstructure)).toBe(true);
      if (spec.id === VesselModel.Container) expect(parts.has(ShipPart.Containers)).toBe(true);
      if (spec.id === VesselModel.Bulk) expect(parts.has(ShipPart.HatchCover)).toBe(true);
      if (spec.id === VesselModel.SailingYacht) expect(parts.has(ShipPart.Sail)).toBe(true);
    });
  }

  it("puts the bow forward and the hull's height share in step with height", () => {
    const tanker = VESSEL_MODELS.find((m) => m.id === VesselModel.Tanker);
    if (!tanker) throw new Error("no tanker");
    const mesh = buildVesselMesh(tanker);
    const pos = mesh.attributes.positions.value;
    const tags = mesh.attributes.colors.value;
    for (let i = 0; i < pos.length / 3; i++) {
      if (tags[i * 3] !== ShipPart.Hull) continue;
      const h = tags[i * 3 + 1];
      const u = tags[i * 3 + 2];
      if (u > 0.95) expect(pos[i * 3]).toBeGreaterThan(tanker.lengthM * 0.4);
      if (u < 0.05) expect(pos[i * 3]).toBeLessThan(-tanker.lengthM * 0.4);
      if (h > 0.99) expect(pos[i * 3 + 2]).toBeGreaterThan(tanker.freeboardM * 0.95);
      if (h < 0.01) expect(pos[i * 3 + 2]).toBeLessThan(0.01);
    }
  });

  it("stacks containers inside the hull, in whole boxes", () => {
    const spec = VESSEL_MODELS.find((m) => m.id === VesselModel.Container);
    if (!spec) throw new Error("no container ship");
    const mesh = buildVesselMesh(spec);
    const pos = mesh.attributes.positions.value;
    const tags = mesh.attributes.colors.value;
    const place = mesh.attributes.texCoords.value;
    let boxes = 0;
    for (let i = 0; i < pos.length / 3; i++) {
      if (tags[i * 3] !== ShipPart.Containers) continue;
      boxes++;
      expect(Math.abs(pos[i * 3 + 1])).toBeLessThan(spec.beamM / 2);
      // Corners fall on whole boxes across and up.
      const face = tags[i * 3 + 2];
      if (face !== 2) {
        expect(Math.abs(place[i * 2 + 1] - Math.round(place[i * 2 + 1]))).toBeLessThan(1e-3);
      }
    }
    expect(boxes).toBeGreaterThan(200);
  });
});
