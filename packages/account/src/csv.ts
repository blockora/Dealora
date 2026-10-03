import { LIMITS } from "./validation.js";

/**
 * A minimal, dependency-free CSV reader.
 *
 * Deliberately small: this handles the quoted-field, embedded-delimiter,
 * escaped-quote, CRLF and BOM cases a spreadsheet export actually produces, and
 * nothing more. It is not a general-purpose CSV engine.
 */

export interface ParsedCsv {
  header: string[];
  /** Row objects keyed by normalized header name. */
  rows: { line: number; cells: Record<string, string> }[];
  /** Rows that could not be parsed, reported rather than dropped. */
  malformed: { line: number; message: string }[];
}

/** Header names are matched case- and separator-insensitively. */
export function normalizeHeader(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/**
 * Parse CSV text into a header and rows.
 *
 * Guards against oversized files so a malformed upload cannot exhaust memory
 * before validation runs.
 */
export function parseCsv(input: string): ParsedCsv {
  // A UTF-8 byte-order mark is stripped so a spreadsheet export still parses.
  // The mark is compared by code point, never written as an invisible literal.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rowsRaw: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  const malformed: { line: number; message: string }[] = [];

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // Ignore a trailing blank line produced by a final newline.
    if (!(row.length === 1 && row[0]?.trim() === "")) rowsRaw.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line++;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      pushField();
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      pushRow();
      line++;
      continue;
    }
    field += char;
  }
  if (field !== "" || row.length > 0) pushRow();

  if (inQuotes) {
    malformed.push({ line, message: "the file ends inside a quoted field" });
  }

  const header = (rowsRaw.shift() ?? []).map(normalizeHeader);
  if (header.length === 0) {
    return {
      header: [],
      rows: [],
      malformed: [{ line: 1, message: "the file has no header row" }],
    };
  }

  const dataLines = rowsRaw;
  if (dataLines.length > LIMITS.csvRows) {
    malformed.push({
      line: 1,
      message: `the file has ${dataLines.length} rows; at most ${LIMITS.csvRows} are accepted`,
    });
    return { header, rows: [], malformed };
  }

  const rows: ParsedCsv["rows"] = [];
  dataLines.forEach((cells, index) => {
    // Data row 1 sits on source line 2 (line 1 is the header).
    const sourceLine = index + 2;
    if (cells.length > header.length) {
      malformed.push({
        line: sourceLine,
        message: `row has ${cells.length} columns but the header declares ${header.length}`,
      });
      return;
    }
    const mapped: Record<string, string> = {};
    header.forEach((name, columnIndex) => {
      if (name === "") return;
      mapped[name] = (cells[columnIndex] ?? "").trim();
    });
    rows.push({ line: sourceLine, cells: mapped });
  });

  return { header, rows, malformed };
}
