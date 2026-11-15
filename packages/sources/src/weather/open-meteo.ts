/**
 * Current conditions at a point, from Open-Meteo. A helper for detail panels
 * (conditions at a webcam or a city), not a map layer.
 *
 * Verified 2026-11-14 at https://open-meteo.com/en/terms and
 * https://open-meteo.com/en/licence: the keyless API is free for
 * non-commercial use (no subscriptions, no advertising) up to 10,000 calls a
 * day, 5,000 an hour and 600 a minute per address; data is CC BY 4.0 and a
 * link to Open-Meteo must sit next to wherever it is shown. Answers carry
 * `Access-Control-Allow-Origin: *`.
 */
import type { Attribution, LicenceInfo, SourceContext } from "@orya-halo/schema";
import { SourceError, fetchJson } from "../shared/overlays/http.ts";

export const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

export const OPEN_METEO_DOCS = "https://open-meteo.com/en/docs";

export const OPEN_METEO_LICENCE: LicenceInfo = {
  name: "CC BY 4.0 (data); Open-Meteo free API terms, non-commercial",
  url: "https://open-meteo.com/en/terms",
  display: true,
  redistribution: true,
  commercial: false,
  notes:
    "Keyless API is for non-commercial use only: under 10,000 calls a day, 5,000 an hour, 600 a minute per address. Commercial use needs a paid plan. A link to Open-Meteo must appear next to the data.",
  verified: "2026-11-14",
};

export const OPEN_METEO_ATTRIBUTION: Attribution = {
  text: "Weather data by Open-Meteo.com",
  url: "https://open-meteo.com/",
  // "You must include a link next to any location Open-Meteo data are displayed."
  onMap: true,
};

export interface CurrentWeather {
  /** When the values apply, Unix epoch milliseconds. */
  timeMs: number;
  /** Air temperature at 2 m, degrees Celsius. */
  temperatureC: number;
  /** Feels-like temperature, degrees Celsius. */
  apparentTemperatureC: number;
  /** Relative humidity at 2 m, percent. */
  humidityPct: number;
  /** Wind speed at 10 m, metres per second. */
  windSpeedMs: number;
  /** Direction the wind blows from, degrees clockwise from north. */
  windDirectionDeg: number;
  /** Wind gusts at 10 m, metres per second. */
  windGustMs: number;
  /** Total cloud cover, percent. */
  cloudCoverPct: number;
  /** Rain, showers and snow over the preceding interval, millimetres. */
  precipitationMm: number;
  /** WMO weather interpretation code. */
  weatherCode: number;
  /** The code in words, sentence case: "Light rain". */
  conditions: string;
  isDay: boolean;
}

const CURRENT_FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "is_day",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
].join(",");

/** WMO code table as Open-Meteo documents it. */
const WMO_TEXT: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Light freezing drizzle",
  57: "Heavy freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with light hail",
  99: "Thunderstorm with heavy hail",
};

/** Words for a WMO weather code. Unknown codes read "Unknown conditions". */
export function weatherCodeText(code: number): string {
  return WMO_TEXT[code] ?? "Unknown conditions";
}

/** The part of Open-Meteo's answer this helper reads. */
export interface OpenMeteoResponse {
  current?: {
    time?: number;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    is_day?: number;
    precipitation?: number;
    weather_code?: number;
    cloud_cover?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    wind_gusts_10m?: number;
  };
}

/**
 * Request URL for a point. Coordinates are rounded to two decimals (about
 * 1 km): the model grid is coarser than that, and nearby requests then share
 * a cache entry.
 */
export function currentWeatherUrl(lon: number, lat: number): string {
  const params = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    current: CURRENT_FIELDS,
    wind_speed_unit: "ms",
    timeformat: "unixtime",
  });
  return `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
}

/** Turn Open-Meteo's answer into SI values. Pure. */
export function parseCurrentWeather(raw: OpenMeteoResponse): CurrentWeather {
  const c = raw.current;
  if (!c || typeof c.time !== "number" || typeof c.temperature_2m !== "number") {
    throw new SourceError("bad-data", "Open-Meteo sent no current conditions for this place.");
  }
  const code = c.weather_code ?? -1;
  return {
    timeMs: c.time * 1000,
    temperatureC: c.temperature_2m,
    apparentTemperatureC: c.apparent_temperature ?? c.temperature_2m,
    humidityPct: c.relative_humidity_2m ?? Number.NaN,
    windSpeedMs: c.wind_speed_10m ?? Number.NaN,
    windDirectionDeg: c.wind_direction_10m ?? Number.NaN,
    windGustMs: c.wind_gusts_10m ?? Number.NaN,
    cloudCoverPct: c.cloud_cover ?? Number.NaN,
    precipitationMm: c.precipitation ?? 0,
    weatherCode: code,
    conditions: weatherCodeText(code),
    isDay: c.is_day === 1,
  };
}

/**
 * Current conditions at a point. One request per call: cache the result for
 * the panel's lifetime (values change every 15 minutes) rather than calling
 * on every render.
 */
export async function fetchCurrentWeather(
  lon: number,
  lat: number,
  ctx: Pick<SourceContext, "fetch" | "signal">,
): Promise<CurrentWeather> {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new SourceError(
      "bad-data",
      "Weather was requested for a position that is not on the globe.",
    );
  }
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return parseCurrentWeather(
    await fetchJson<OpenMeteoResponse>(ctx, currentWeatherUrl(wrapped, lat), "Open-Meteo"),
  );
}
