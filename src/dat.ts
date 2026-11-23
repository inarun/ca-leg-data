/**
 * Parser for the pubinfo `.dat` files: UTF-8, tab-separated, one row per line.
 * Strings are wrapped in backticks, `NULL` is null, numbers and dates are bare.
 * A closing backtick is one followed by a tab, a line break or the end of the text,
 * so a string may contain backticks and line breaks.
 * Ported from docs/reference/probe.py.
 */

export type Cell = string | null;

export interface RowSpan {
  /** 1-based row number in the file. */
  row: number;
  /** Offset of the first character of the row. */
  start: number;
  /** Offset just past the last character of the row, before the line break. */
  end: number;
}

/** Calls `onRow` for every row. `cells` is a fresh array per call. */
export function parseDat(text: string, onRow: (cells: Cell[], span: RowSpan) => void): void {
  const n = text.length;
  let i = 0;
  let row: Cell[] = [];
  let rowStart = 0;
  let rowNumber = 0;
  while (i < n) {
    if (row.length === 0) rowStart = i;
    if (text.charCodeAt(i) === 96) {
      let j = i + 1;
      for (;;) {
        j = text.indexOf("`", j);
        if (j === -1) {
          j = n;
          break;
        }
        if (j + 1 >= n) break;
        const c = text.charCodeAt(j + 1);
        if (c === 9 || c === 10 || c === 13) break;
        j += 1;
      }
      row.push(text.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === 9 || c === 10) break;
        j += 1;
      }
      let v = text.slice(i, j);
      if (v.endsWith("\r")) v = v.slice(0, -1);
      row.push(v === "NULL" ? null : v);
      i = j;
    }
    let endOfRow = i;
    if (i < n && text.charCodeAt(i) === 13) i += 1;
    if (i >= n || text.charCodeAt(i) === 10) {
      rowNumber += 1;
      onRow(row, { row: rowNumber, start: rowStart, end: endOfRow });
      row = [];
      i += 1;
    } else if (text.charCodeAt(i) === 9) {
      i += 1;
    }
  }
  if (row.length > 0) {
    rowNumber += 1;
    onRow(row, { row: rowNumber, start: rowStart, end: n });
  }
}

export function readRows(text: string): Cell[][] {
  const out: Cell[][] = [];
  parseDat(text, (cells) => out.push(cells));
  return out;
}

/** Reads a cell that must not be null. */
export function req(cells: Cell[], index: number, table: string, row?: number): string {
  const v = cells[index];
  if (v === undefined || v === null) {
    throw new Error(`${table}: column ${index} is NULL or missing${row ? ` in row ${row}` : ""}`);
  }
  return v;
}
