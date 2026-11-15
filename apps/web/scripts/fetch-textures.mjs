#!/usr/bin/env node
// Fetches the night-lights texture for the globe's night side into
// public/textures/. The file is small (about 360 kB) and public domain, so it
// can live in the repository; this script records where it came from and
// restores it if it is missing.
//
//   node scripts/fetch-textures.mjs [--force]
//
// Source: NASA Earth Observatory, "Earth at Night: Flat Maps", the 2016 Black
// Marble composite, grayscale, 0.1 degree per pixel (3600 x 1800).
//   https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/
// Terms: NASA imagery is generally not subject to copyright in the United
// States; NASA asks to be acknowledged as the source.
//   https://www.nasa.gov/nasa-brand-center/images-and-media/
// Credit: NASA Earth Observatory images by Joshua Stevens, using Suomi NPP
// VIIRS data from Miguel Román, NASA GSFC.
//
// Why one equirectangular image and not NASA GIBS tiles: the lights are only
// shown from orbit and fade out by zoom 8, where 0.1 degree is enough, and
// GIBS serves its tiles with `Cache-Control: no-store`, so every visitor would
// refetch them on every visit.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE =
  "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144897/BlackMarble_2016_01deg_gray.jpg";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "textures");
const outFile = join(outDir, "black-marble-2016-01deg-gray.jpg");
const force = process.argv.includes("--force");

if (existsSync(outFile) && !force) {
  console.log(
    `fetch-textures: ${outFile} already exists (${(statSync(outFile).size / 1024).toFixed(0)} kB). Use --force to replace it.`,
  );
} else {
  const res = await fetch(SOURCE);
  if (!res.ok) {
    console.error(`fetch-textures: download failed (${res.status}): ${SOURCE}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  // JPEG files start with FF D8.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    console.error("fetch-textures: the download is not a JPEG image.");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, bytes);
  console.log(`fetch-textures: wrote ${outFile} (${(bytes.length / 1024).toFixed(0)} kB)`);
}
