/**
 * A small CSV reader for provider files (CelesTrak OMM, NASA FIRMS).
 *
 * Both providers write plain comma-separated lines with a header row. Quoted
 * fields are rare but legal, so they are handled; the common unquoted line
 * takes the fast path.
 */

export interface CsvTable {
  /** Column names from the header row, trimmed. */
  header: string[];
  /** One array of cells per data row. Blank lines are skipped. */
  rows: string[][];
}

function splitQuoted(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** Split one CSV line into cells. */
export function splitCsvLine(line: string): string[] {
  return line.includes('"') ? splitQuoted(line) : line.split(",");
}

/** Parse CSV text with a header row. Does not support line breaks inside quoted fields. */
export function parseCsv(text: string): CsvTable {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length) return { header: [], rows: [] };
  // A byte-order mark would otherwise become part of the first column name.
  const header = splitCsvLine(lines[start].replace(/^﻿/, "").trim()).map((name) => name.trim());
  const rows: string[][] = [];
  for (let i = start + 1; i < lines.length; i++) {
    let line = lines[i];
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    if (line.length === 0 || line.trim() === "") continue;
    rows.push(splitCsvLine(line));
  }
  return { header, rows };
}

/** Index of each named column, or -1 when the file does not have it. */
export function columnIndexes<const T extends readonly string[]>(
  header: readonly string[],
  names: T,
): { [K in T[number]]: number } {
  const out = {} as { [K in T[number]]: number };
  for (const name of names) (out as Record<string, number>)[name] = header.indexOf(name);
  return out;
}
