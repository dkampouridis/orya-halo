/**
 * Where the opening shot lands. We guess the visitor's region from their
 * time zone instead of asking for their location: no permission prompt, and
 * "roughly your part of the world" is all the shot needs.
 */

/** Latitude that frames each time-zone area's populated middle. */
const AREA_LATITUDE: Record<string, number> = {
  Europe: 49,
  Africa: 4,
  Asia: 30,
  America: 30,
  Australia: -27,
  Pacific: -18,
  Atlantic: 38,
  Indian: -15,
  Antarctica: -70,
  Arctic: 75,
};

/** Zones whose area's default latitude would land in the wrong hemisphere. */
const ZONE_LATITUDE: [pattern: RegExp, lat: number][] = [
  [
    /^America\/(Argentina|Sao_Paulo|Santiago|Montevideo|Asuncion|La_Paz|Lima|Bogota|Guayaquil|Caracas|Manaus|Fortaleza|Recife|Bahia|Belem|Cuiaba|Campo_Grande|Porto_Velho|Rio_Branco|Punta_Arenas)/,
    -18,
  ],
  [/^America\/(Anchorage|Juneau|Nome|Yellowknife|Whitehorse|Dawson|Inuvik|Iqaluit)/, 61],
  [/^Africa\/(Johannesburg|Maputo|Harare|Windhoek|Gaborone|Lusaka|Maseru|Mbabane)/, -26],
  [/^Africa\/(Cairo|Tripoli|Tunis|Algiers|Casablanca)/, 31],
  [/^Asia\/(Jakarta|Makassar|Jayapura|Singapore|Kuala_Lumpur|Dili)/, -2],
  [/^Asia\/(Novosibirsk|Krasnoyarsk|Irkutsk|Yakutsk|Omsk|Yekaterinburg|Magadan|Kamchatka)/, 57],
  [/^Pacific\/(Honolulu|Guam|Saipan)/, 20],
  [/^Pacific\/Auckland/, -41],
  [/^Atlantic\/Reykjavik/, 65],
];

/** Centre of the visitor's likely region, from the clock offset and time-zone name. */
export function guessRegion(now = new Date()): { lon: number; lat: number } {
  // 15 degrees of longitude per hour of offset from UTC.
  const lon = Math.max(-170, Math.min(170, (-now.getTimezoneOffset() / 60) * 15));
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    // Older engines: fall through to the default latitude.
  }
  const specific = ZONE_LATITUDE.find(([pattern]) => pattern.test(zone));
  const lat = specific ? specific[1] : (AREA_LATITUDE[zone.split("/")[0]] ?? 30);
  return { lon, lat };
}

/** Longitude where it is local midnight: the middle of the night side. */
export function midnightLongitude(nowMs = Date.now()): number {
  const hours = (nowMs / 3_600_000) % 24;
  // The sun is overhead at 12:00 UTC on the Greenwich meridian and moves west 15 degrees an hour.
  const subsolar = (12 - hours) * 15;
  return ((subsolar + 180 + 540) % 360) - 180;
}
