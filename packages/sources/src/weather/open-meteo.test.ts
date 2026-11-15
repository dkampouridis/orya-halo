import { describe, expect, test } from "vite-plus/test";
import { fakeContext, fixture } from "../shared/overlays/test-context.ts";
import {
  OPEN_METEO_ATTRIBUTION,
  OPEN_METEO_LICENCE,
  currentWeatherUrl,
  fetchCurrentWeather,
  parseCurrentWeather,
  weatherCodeText,
} from "./index.ts";
import type { OpenMeteoResponse } from "./index.ts";

/** Recorded for Helsinki on 2026-11-14 with wind in m/s and Unix times. */
const recorded = JSON.parse(
  fixture(import.meta.url, "fixtures/open-meteo-current.json"),
) as OpenMeteoResponse;

describe("parseCurrentWeather", () => {
  test("reads the recorded answer into SI values", () => {
    expect(parseCurrentWeather(recorded)).toEqual({
      timeMs: 1_794_669_300_000,
      temperatureC: 2.8,
      apparentTemperatureC: -3.9,
      humidityPct: 70,
      windSpeedMs: 8,
      windDirectionDeg: 288,
      windGustMs: 13.2,
      cloudCoverPct: 99,
      precipitationMm: 0,
      weatherCode: 3,
      conditions: "Overcast",
      isDay: false,
    });
  });

  test("reports an answer without current conditions as bad data", () => {
    expect(() => parseCurrentWeather({})).toThrowError(/no current conditions/);
    expect(() => parseCurrentWeather({ current: { time: 1 } })).toThrowError(
      /no current conditions/,
    );
  });

  test("tolerates missing optional values", () => {
    const weather = parseCurrentWeather({ current: { time: 10, temperature_2m: 21.5 } });
    expect(weather.temperatureC).toBe(21.5);
    expect(weather.apparentTemperatureC).toBe(21.5);
    expect(weather.windSpeedMs).toBeNaN();
    expect(weather.precipitationMm).toBe(0);
    expect(weather.conditions).toBe("Unknown conditions");
  });
});

describe("weatherCodeText", () => {
  test("puts WMO codes into plain words", () => {
    expect(weatherCodeText(0)).toBe("Clear sky");
    expect(weatherCodeText(61)).toBe("Light rain");
    expect(weatherCodeText(75)).toBe("Heavy snow");
    expect(weatherCodeText(95)).toBe("Thunderstorm");
    expect(weatherCodeText(42)).toBe("Unknown conditions");
  });
});

describe("currentWeatherUrl", () => {
  test("rounds the position and asks for metric wind and Unix times", () => {
    const url = new URL(currentWeatherUrl(24.93847, 60.16952));
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("60.17");
    expect(url.searchParams.get("longitude")).toBe("24.94");
    expect(url.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(url.searchParams.get("timeformat")).toBe("unixtime");
    expect(url.searchParams.get("current")?.split(",")).toEqual(
      expect.arrayContaining([
        "temperature_2m",
        "wind_speed_10m",
        "cloud_cover",
        "precipitation",
        "weather_code",
      ]),
    );
  });
});

describe("fetchCurrentWeather", () => {
  test("makes one keyless request and returns the conditions", async () => {
    const ctx = fakeContext({ "https://api.open-meteo.com/v1/forecast": recorded });
    const weather = await fetchCurrentWeather(24.94, 60.17, ctx);
    expect(weather.conditions).toBe("Overcast");
    expect(ctx.requests).toHaveLength(1);
    expect(ctx.requests[0].headers).toEqual({});
  });

  test("wraps longitudes from a globe that has been spun past the antimeridian", async () => {
    const ctx = fakeContext({ "https://api.open-meteo.com/": recorded });
    await fetchCurrentWeather(190, -17, ctx);
    expect(new URL(ctx.requests[0].url).searchParams.get("longitude")).toBe("-170.00");
  });

  test("refuses positions that are not on the globe without asking the server", async () => {
    const ctx = fakeContext({});
    await expect(fetchCurrentWeather(0, 95, ctx)).rejects.toMatchObject({
      name: "SourceError",
      code: "bad-data",
    });
    await expect(fetchCurrentWeather(Number.NaN, 0, ctx)).rejects.toMatchObject({
      code: "bad-data",
    });
    expect(ctx.requests).toHaveLength(0);
  });

  test("passes on a rate-limit refusal as blocked", async () => {
    const ctx = fakeContext({
      "https://api.open-meteo.com/": {
        status: 429,
        body: '{"error":true,"reason":"Minutely API request limit exceeded."}',
      },
    });
    await expect(fetchCurrentWeather(24.94, 60.17, ctx)).rejects.toMatchObject({
      code: "blocked",
      status: 429,
    });
  });
});

describe("Open-Meteo terms", () => {
  test("are recorded as non-commercial with the required link", () => {
    expect(OPEN_METEO_LICENCE).toMatchObject({
      display: true,
      commercial: false,
      verified: "2026-11-14",
    });
    expect(OPEN_METEO_ATTRIBUTION).toEqual({
      text: "Weather data by Open-Meteo.com",
      url: "https://open-meteo.com/",
      onMap: true,
    });
  });
});
