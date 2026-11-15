/**
 * Aircraft and ships arrive through the Orya Halo gateway, not straight from
 * a provider, so these two plugins never fetch. They exist so the gateway
 * layers are described the same way as every other feed: schema for the
 * detail panel, licence and credit for the attribution page.
 *
 * The gateway reports which upstreams are actually live in its `hello`
 * message and at `/v1/attribution`; the text here covers the defaults.
 * Terms were verified on 2026-11-14, see docs/DATA_LICENCES.md.
 */
import { EntityKind, defineSource, upsertToUpdate } from "@orya-halo/schema";
import type { SourcePlugin, UpsertFrame } from "@orya-halo/schema";

export const gatewayAircraft: SourcePlugin<UpsertFrame> = defineSource<UpsertFrame>({
  id: "gateway-aircraft",
  name: "adsb.lol",
  layer: "aircraft",
  transport: "gateway",
  refreshRate: 0,
  docs: "https://www.adsb.lol/docs/open-data/api/",
  schema: [
    { key: "label", label: "Callsign", type: "string" },
    { key: "registration", label: "Registration", type: "string" },
    { key: "typeCode", label: "Type", type: "string" },
    { key: "typeName", label: "Aircraft", type: "string" },
    { key: "operator", label: "Operator", type: "string" },
    { key: "squawk", label: "Squawk", type: "string" },
    { key: "country", label: "Country", type: "string" },
  ],
  licence: {
    name: "ODbL 1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Share-alike: a database derived from it must be offered under ODbL. Without a key adsb.lol allows 500 requests a day per address, so the gateway refreshes the areas people are looking at and fills in the rest slowly.",
    verified: "2026-11-14",
  },
  attribution: {
    text: "Contains information from adsb.lol, which is made available here under the Open Database License (ODbL)",
    url: "https://www.adsb.lol/",
  },
  normalise(frame) {
    return { type: "entities", update: upsertToUpdate(frame, "gateway-aircraft") };
  },
  detail(id) {
    const hex = id.toString(16).padStart(6, "0");
    return { sourceUrl: `https://globe.adsb.lol/?icao=${hex}` };
  },
});

export const gatewayShips: SourcePlugin<UpsertFrame> = defineSource<UpsertFrame>({
  id: "gateway-ships",
  name: "Fintraffic Digitraffic and AISStream",
  layer: "ships",
  transport: "gateway",
  refreshRate: 0,
  docs: "https://www.digitraffic.fi/en/marine-traffic/",
  schema: [
    { key: "label", label: "Name", type: "string" },
    { key: "callsign", label: "Call sign", type: "string" },
    { key: "imo", label: "IMO number", type: "string" },
    { key: "typeName", label: "Ship type", type: "string" },
    { key: "navStatus", label: "Status", type: "string" },
    { key: "destination", label: "Destination", type: "string" },
    { key: "eta", label: "Expected arrival", type: "time" },
    { key: "lengthM", label: "Length", type: "number", unit: "m" },
    { key: "widthM", label: "Beam", type: "number", unit: "m" },
    { key: "draughtM", label: "Draught", type: "number", unit: "m" },
    { key: "country", label: "Flag", type: "string" },
  ],
  licence: {
    name: "CC BY 4.0 (Digitraffic)",
    url: "https://www.digitraffic.fi/en/terms-of-service/",
    display: true,
    redistribution: true,
    commercial: true,
    notes:
      "Digitraffic covers Finnish waters and the northern Baltic and needs no key. Worldwide coverage comes from AISStream.io when the gateway has a key; AISStream publishes no licence text and asks that data is relayed from your own server, which is what the gateway does.",
    verified: "2026-11-14",
  },
  attribution: {
    text: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY (modified). Ship positions from AISStream.io where configured",
    url: "https://www.digitraffic.fi/en/marine-traffic/",
  },
  normalise(frame) {
    return { type: "entities", update: upsertToUpdate(frame, "gateway-ships") };
  },
});

/** Kind served by each gateway plugin, for the worker's lookup. */
export const GATEWAY_PLUGIN_KINDS = {
  [EntityKind.Aircraft]: gatewayAircraft,
  [EntityKind.Ship]: gatewayShips,
} as const;
