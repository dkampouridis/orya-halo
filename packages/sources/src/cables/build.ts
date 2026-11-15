/**
 * Turns an Overpass API response into cables ready for `encodeCables`.
 * Pure, so the selection and stitching rules are tested against a recorded
 * sample; `scripts/build-cables.ts` only adds the network and file I/O.
 *
 * How submarine telecom cables are tagged in OpenStreetMap (wiki checked
 * 2026-11-14): the current scheme is a way with `communication=line` plus
 * `location=underwater` and often `submarine=yes`; nautical-chart imports
 * add `seamark:type=cable_submarine` with a
 * `seamark:cable_submarine:category`; `man_made=submarine_cable` is
 * deprecated but still present. Power cables use `power=cable` and are left
 * out here.
 */
import {
  densifyLine,
  lineLengthKm,
  mergeLines,
  simplifyLine,
  splitAtAntimeridian,
} from "./geometry.ts";
import type { LonLat } from "./geometry.ts";
import { cableId } from "./format.ts";
import type { CableGeometry } from "./format.ts";

export interface OverpassWay {
  type: "way";
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export interface OverpassRelation {
  type: "relation";
  id: number;
  members?: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string };
  elements: (OverpassWay | OverpassRelation | { type: string })[];
}

/**
 * The one Overpass query the build sends. Ways come back with their geometry
 * inline; relations are asked for only to learn which ways belong together.
 */
export const OVERPASS_QUERY = `[out:json][timeout:240][maxsize:1073741824];
(
  way["communication"="line"]["location"="underwater"];
  way["communication"="line"]["submarine"="yes"];
  way["communication"="line"]["seamark:type"="cable_submarine"];
  way["man_made"="submarine_cable"];
  way["telecom"="line"]["location"="underwater"];
  way["telecom"="line"]["submarine"="yes"];
  way["seamark:type"="cable_submarine"]["seamark:cable_submarine:category"~"fibre_optic|fiber_optic|optical|telephone|telegraph"];
)->.cables;
.cables out tags geom;
rel(bw.cables);
out body;`;

export interface BuildOptions {
  /** Simplification tolerance in metres. */
  toleranceM: number;
  /** Longest great-circle arc left between two vertices, degrees. */
  maxArcDeg: number;
  /** Cables mapped for less than this in total are dropped, kilometres. */
  minCableKm: number;
  /** Stitched pieces shorter than this are dropped, kilometres. */
  minPathKm: number;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  toleranceM: 150,
  maxArcDeg: 1,
  minCableKm: 5,
  minPathKm: 1,
};

export interface BuildStats {
  waysIn: number;
  waysKept: number;
  /** Why ways were left out, by reason. */
  rejected: Record<string, number>;
  cables: number;
  named: number;
  paths: number;
  vertices: number;
  lengthKm: number;
  /** Cables dropped for being shorter than `minCableKm`. */
  tooShort: number;
}

const DISUSED_STATUS = /disused|not_in_use|abandoned|removed/i;

/** Why a way is not a live submarine telecom cable, or null when it is one. */
export function rejectReason(way: OverpassWay): string | null {
  const tags = way.tags ?? {};
  const geometry = way.geometry ?? [];
  if (geometry.length < 2) return "no geometry";
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  if (first.lat === last.lat && first.lon === last.lon) return "closed way";

  const category = tags["seamark:cable_submarine:category"] ?? "";
  const telecom =
    tags.communication === "line" ||
    tags.telecom === "line" ||
    tags.man_made === "submarine_cable" ||
    /fibre_optic|fiber_optic|optical|telephone|telegraph/.test(category);
  if (!telecom) return "not telecom";
  if (tags.power !== undefined || (/power/.test(category) && tags.communication !== "line"))
    return "power";
  if (tags.location !== undefined && tags.location !== "underwater") return "not underwater";
  const seamark = tags["seamark:type"];
  if (seamark !== undefined && seamark !== "cable_submarine") return "not a cable line";

  if (
    tags.disused === "yes" ||
    tags.abandoned === "yes" ||
    tags["disused:communication"] !== undefined ||
    tags["abandoned:communication"] !== undefined ||
    DISUSED_STATUS.test(tags["seamark:cable_submarine:status"] ?? "") ||
    DISUSED_STATUS.test(tags["seamark:status"] ?? "") ||
    category === "disused"
  ) {
    return "disused";
  }
  return null;
}

/**
 * A cable's name without its segment label, so "UK-Germany 5 - Seg 3" and
 * "SEA ME WE3-S9" group with their siblings. Returns the input when nothing
 * but a segment label would be left.
 */
export function baseCableName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const base = trimmed
    .replace(/[\s\-–,]*\bseg(?:ment)?(?:\.\s*|\s+|(?=\d))[a-z0-9][\w.-]*(?:\s+\w{1,3})?\s*$/i, "")
    .replace(/[\s\-–]+S\d+(?:\.\d+)?[A-Z]?$/, "")
    .trim();
  return base.length >= 2 ? base : trimmed;
}

/** Key under which differently written names of one cable meet ("TAT 12", "TAT-12", "tat12"). */
export function nameKey(name: string): string {
  return baseCableName(name)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function mostCommon(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function wayLine(way: OverpassWay): LonLat[] {
  return (way.geometry ?? []).map((p) => [p.lon, p.lat]);
}

/** Group unnamed ways into cables by which ones touch end to end. */
function groupByContact(ways: readonly OverpassWay[]): OverpassWay[][] {
  const parent = ways.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const up = parent[i];
      parent[i] = root;
      i = up;
    }
    return root;
  };
  const owner = new Map<string, number>();
  ways.forEach((way, index) => {
    const geometry = way.geometry ?? [];
    for (const p of [geometry[0], geometry[geometry.length - 1]]) {
      const key = `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;
      const other = owner.get(key);
      if (other === undefined) owner.set(key, index);
      else parent[find(index)] = find(other);
    }
  });
  const groups = new Map<number, OverpassWay[]>();
  ways.forEach((way, index) => {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(way);
    else groups.set(root, [way]);
  });
  return [...groups.values()];
}

/**
 * Select live submarine telecom cables from an Overpass response, stitch
 * ways that share a name (or a route relation, or simply touch when unnamed)
 * into cables, and prepare their geometry for a globe. Cables come back
 * longest first.
 */
export function buildCables(
  response: OverpassResponse,
  options: BuildOptions = DEFAULT_BUILD_OPTIONS,
): { cables: CableGeometry[]; stats: BuildStats } {
  const ways = response.elements.filter((e): e is OverpassWay => e.type === "way");
  const relations = response.elements.filter((e): e is OverpassRelation => e.type === "relation");

  // A named route relation overrides the names of its member ways and lends them its Wikidata item.
  const relationOf = new Map<number, { name: string; wikidata?: string }>();
  for (const relation of relations) {
    const name = relation.tags?.name;
    if (!name || relation.tags?.type !== "route") continue;
    for (const member of relation.members ?? []) {
      if (member.type === "way")
        relationOf.set(member.ref, { name, wikidata: relation.tags?.wikidata });
    }
  }
  const nameOf = (way: OverpassWay): string | undefined => {
    const tags = way.tags ?? {};
    return (
      relationOf.get(way.id)?.name ??
      tags.name ??
      tags["seamark:cable_submarine:name"] ??
      tags["seamark:name"]
    );
  };

  const rejected: Record<string, number> = {};
  const named = new Map<string, OverpassWay[]>();
  const unnamed: OverpassWay[] = [];
  let waysKept = 0;
  for (const way of ways) {
    const reason = rejectReason(way);
    if (reason) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      continue;
    }
    waysKept++;
    const name = nameOf(way);
    const key = name ? nameKey(name) : "";
    if (!name || key === "") {
      unnamed.push(way);
      continue;
    }
    const group = named.get(key);
    if (group) group.push(way);
    else named.set(key, [way]);
  }

  const groups: { ways: OverpassWay[]; isNamed: boolean }[] = [
    ...[...named.values()].map((g) => ({ ways: g, isNamed: true })),
    ...groupByContact(unnamed).map((g) => ({ ways: g, isNamed: false })),
  ];

  const cables: CableGeometry[] = [];
  let tooShort = 0;
  for (const group of groups) {
    const merged = mergeLines(group.ways.map(wayLine)).filter(
      (line) => lineLengthKm(line) >= options.minPathKm,
    );
    const km = merged.reduce((sum, line) => sum + lineLengthKm(line), 0);
    if (merged.length === 0 || km < options.minCableKm) {
      tooShort++;
      continue;
    }
    const paths = merged.flatMap((line) =>
      splitAtAntimeridian(densifyLine(simplifyLine(line, options.toleranceM), options.maxArcDeg)),
    );
    if (paths.length === 0) continue;

    const tagsOf = (key: string) => group.ways.map((w) => w.tags?.[key]);
    const name = group.isNamed
      ? (mostCommon(
          group.ways.map((w) => {
            const raw = nameOf(w);
            return raw ? baseCableName(raw) : undefined;
          }),
        ) ?? "")
      : "";
    const operator = mostCommon(tagsOf("operator")) ?? mostCommon(tagsOf("owner"));
    const wikidata =
      mostCommon(tagsOf("wikidata")) ??
      mostCommon(group.ways.map((w) => relationOf.get(w.id)?.wikidata));
    const record: CableGeometry["record"] = {
      n: name,
      km: Math.round(km),
      w: Math.min(...group.ways.map((w) => w.id)),
    };
    if (operator) record.o = operator;
    if (wikidata && /^Q\d+$/.test(wikidata)) record.wd = wikidata;
    cables.push({ record, paths });
  }

  cables.sort((a, b) => b.record.km - a.record.km || a.record.w - b.record.w);

  const seen = new Map<number, string>();
  for (const cable of cables) {
    const id = cableId(cable.record.n, cable.record.w);
    const label = cable.record.n || `way ${cable.record.w}`;
    const clash = seen.get(id);
    if (clash !== undefined)
      throw new Error(`Cable id collision between "${clash}" and "${label}".`);
    seen.set(id, label);
  }

  const stats: BuildStats = {
    waysIn: ways.length,
    waysKept,
    rejected,
    cables: cables.length,
    named: cables.filter((c) => c.record.n !== "").length,
    paths: cables.reduce((sum, c) => sum + c.paths.length, 0),
    vertices: cables.reduce((sum, c) => sum + c.paths.reduce((s, p) => s + p.length, 0), 0),
    lengthKm: cables.reduce((sum, c) => sum + c.record.km, 0),
    tooShort,
  };
  return { cables, stats };
}
