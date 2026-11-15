/**
 * Deployment configuration, read once from the build-time environment and
 * the page's query string.
 */
import { LAYER_IDS } from "@orya-halo/schema";
import type { DataConfig, LayerId } from "@orya-halo/schema";

const env = import.meta.env;
const query = new URLSearchParams(location.search);

function gatewayUrl(): string | null {
  const configured = (env.VITE_GATEWAY_URL as string | undefined)?.trim();
  if (configured === "off" || query.get("gateway") === "off") return null;
  if (configured) return configured.replace(/\/+$/, "");
  // In development a gateway on this machine is the common case. A production
  // build with no VITE_GATEWAY_URL runs without one: client-side layers only.
  return env.DEV ? `ws://${location.hostname}:8787` : null;
}

/** Base URL for static assets, always ending in a slash. */
export const assetBase = new URL(env.BASE_URL, location.href).href;

/** `?synthetic=20000` adds that many generated movers per gateway layer, for load testing. */
const synthetic = Math.max(0, Math.min(200_000, Number(query.get("synthetic")) || 0));

/** `?fps=1` (or a development build) shows the frame-rate readout. */
export const showFps = env.DEV || query.get("fps") === "1";

export function dataConfig(layers: Record<LayerId, boolean>): DataConfig {
  return {
    gatewayUrl: gatewayUrl(),
    assetBase,
    // No browser-side source needs a key today: keyed feeds go through the gateway.
    keys: {},
    layers,
    historyMs: 30 * 60_000,
    radarSource: env.VITE_RADAR_SOURCE === "imerg" ? "imerg" : "rainviewer",
    satelliteSource: env.VITE_SATELLITE_SOURCE === "direct" ? "direct" : "gateway",
    synthetic: synthetic || undefined,
  };
}

export const allLayersOff = (): Record<LayerId, boolean> =>
  Object.fromEntries(LAYER_IDS.map((id) => [id, false])) as Record<LayerId, boolean>;
