import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDat } from "./dat.ts";
import type { SourceReader } from "./reader.ts";
import { compareNumericStrings, compareStrings } from "./util.ts";

export interface FixtureOptions {
  bills: string[];
  outDir: string;
  sourceFile: string;
  /** HTTP Last-Modified of the source file, ISO 8601 UTC, or null when unknown. */
  sourceDate: string | null;
  command: string;
}

export interface FixtureReport {
  tables: Array<{ name: string; rows: number[] }>;
  lobs: string[];
  omittedLobs: string[];
  bytes: number;
}

interface Picked {
  rows: number[];
  raw: string[];
}

const ANALYSIS_COMMITTEE_TYPES = new Set(["CMTE", "ABPCA", "SBPCA"]);

/** "1-3, 7, 9-10" */
export function rangesOf(rows: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && (rows[j + 1] as number) === (rows[j] as number) + 1) j += 1;
    out.push(i === j ? String(rows[i]) : `${rows[i]}-${rows[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

async function pick(
  reader: SourceReader,
  name: string,
  keep: (cells: Array<string | null>) => boolean,
): Promise<Picked & { cells: Array<Array<string | null>> }> {
  const text = await reader.readText(name);
  const picked: Picked & { cells: Array<Array<string | null>> } = { rows: [], raw: [], cells: [] };
  parseDat(text, (cells, span) => {
    if (keep(cells)) {
      picked.rows.push(span.row);
      picked.raw.push(text.slice(span.start, span.end).replace(/\r$/, ""));
      picked.cells.push(cells);
    }
  });
  return picked;
}

/**
 * Writes a pubinfo-layout directory holding only the rows for `bills`: the whole LEGISLATOR_TBL and
 * LOCATION_CODE_TBL, only the motions the kept roll calls refer to, bill XML for each bill's latest
 * version only, and for each bill its latest analysis plus one committee analysis. Rows are copied
 * verbatim; FIXTURE.md lists the original 1-based row numbers of every table.
 */
export async function makeFixture(reader: SourceReader, o: FixtureOptions): Promise<FixtureReport> {
  const billSet = new Set(o.bills);
  const tables: Array<{ name: string; rows: number[] }> = [];
  const files = new Map<string, string>();
  const take = (name: string, p: Picked): void => {
    files.set(name, p.raw.length > 0 ? p.raw.join("\n") + "\n" : "");
    tables.push({ name, rows: p.rows });
  };

  const bills = await pick(reader, "BILL_TBL.dat", (c) => billSet.has(c[0] ?? ""));
  take("BILL_TBL.dat", bills);
  const found = new Set(bills.cells.map((c) => c[0] as string));
  const missing = o.bills.filter((b) => !found.has(b));
  if (missing.length > 0) throw new Error(`bills not found in BILL_TBL: ${missing.join(", ")}`);
  const latestVersion = new Set(bills.cells.map((c) => c[10] as string));

  const versions = await pick(reader, "BILL_VERSION_TBL.dat", (c) => billSet.has(c[1] ?? ""));
  take("BILL_VERSION_TBL.dat", versions);
  const versionIds = new Set(versions.cells.map((c) => c[0] as string));
  const lobsAll: string[] = [];
  const lobsKept: string[] = [];
  for (const c of versions.cells) {
    const lob = c[14];
    if (!lob) continue;
    lobsAll.push(lob);
    if (latestVersion.has(c[0] as string)) lobsKept.push(lob);
  }

  take("BILL_VERSION_AUTHORS_TBL.dat", await pick(reader, "BILL_VERSION_AUTHORS_TBL.dat", (c) => versionIds.has(c[0] ?? "")));
  take("BILL_HISTORY_TBL.dat", await pick(reader, "BILL_HISTORY_TBL.dat", (c) => billSet.has(c[0] ?? "")));
  const summary = await pick(reader, "BILL_SUMMARY_VOTE_TBL.dat", (c) => billSet.has(c[0] ?? ""));
  take("BILL_SUMMARY_VOTE_TBL.dat", summary);
  const motionIds = new Set(summary.cells.map((c) => c[4] as string));
  take("BILL_DETAIL_VOTE_TBL.dat", await pick(reader, "BILL_DETAIL_VOTE_TBL.dat", (c) => billSet.has(c[0] ?? "")));
  take("BILL_MOTION_TBL.dat", await pick(reader, "BILL_MOTION_TBL.dat", (c) => motionIds.has(c[0] ?? "")));
  take("COMMITTEE_HEARING_TBL.dat", await pick(reader, "COMMITTEE_HEARING_TBL.dat", (c) => billSet.has(c[0] ?? "")));
  take("LEGISLATOR_TBL.dat", await pick(reader, "LEGISLATOR_TBL.dat", () => true));
  take("LOCATION_CODE_TBL.dat", await pick(reader, "LOCATION_CODE_TBL.dat", () => true));

  // Analyses: the latest per bill plus one committee analysis (the latest other than the latest overall).
  const allAnalyses = await pick(reader, "BILL_ANALYSIS_TBL.dat", (c) => billSet.has(c[1] ?? ""));
  const byBill = new Map<string, Array<{ idx: number; id: string; date: string; type: string }>>();
  allAnalyses.cells.forEach((c, idx) => {
    const list = byBill.get(c[1] as string) ?? [];
    list.push({ idx, id: c[0] as string, date: c[7] ?? "", type: c[3] ?? "" });
    byBill.set(c[1] as string, list);
  });
  const keepIdx = new Set<number>();
  for (const list of byBill.values()) {
    list.sort((a, b) => compareStrings(b.date, a.date) || compareNumericStrings(b.id, a.id));
    const latest = list[0];
    if (latest) keepIdx.add(latest.idx);
    const committee = list.slice(1).find((x) => ANALYSIS_COMMITTEE_TYPES.has(x.type));
    if (committee) keepIdx.add(committee.idx);
  }
  const keptAnalyses: Picked = { rows: [], raw: [] };
  const analysisLobs: string[] = [];
  allAnalyses.cells.forEach((c, i) => {
    if (!keepIdx.has(i)) return;
    keptAnalyses.rows.push(allAnalyses.rows[i] as number);
    keptAnalyses.raw.push(allAnalyses.raw[i] as string);
    if (c[10]) analysisLobs.push(c[10]);
  });
  take("BILL_ANALYSIS_TBL.dat", keptAnalyses);

  const lobs = [...lobsKept, ...analysisLobs].sort(compareStrings);
  const omittedLobs = lobsAll.filter((l) => !lobsKept.includes(l)).sort(compareStrings);

  await mkdir(o.outDir, { recursive: true });
  let bytes = 0;
  for (const [name, text] of [...files].sort((a, b) => compareStrings(a[0], b[0]))) {
    await writeFile(join(o.outDir, name), text, "utf8");
    bytes += Buffer.byteLength(text);
  }
  for (const lob of lobs) {
    const data = await reader.read(lob);
    await writeFile(join(o.outDir, lob), data);
    bytes += data.length;
  }

  const md: string[] = [];
  md.push(`# ${o.outDir.split(/[\\/]/).filter(Boolean).at(-1)}`);
  md.push("");
  md.push("A slice of the Legislative Counsel pubinfo bulk file, in the same layout, for tests. Every row is copied");
  md.push("verbatim from the source; nothing here was typed in. Generated with:");
  md.push("");
  md.push("```");
  md.push(o.command);
  md.push("```");
  md.push("");
  md.push(`- Source file: \`${o.sourceFile}\``);
  md.push(`- Source Last-Modified: \`${o.sourceDate ?? "not recorded (pass --source-date)"}\``);
  md.push(`- Bills (${o.bills.length}): ${[...o.bills].sort(compareStrings).map((b) => `\`${b}\``).join(", ")}`);
  md.push("");
  md.push("Row numbers are 1-based positions in the original `.dat` file of the full source.");
  md.push("");
  md.push("| Table | Rows kept | Original row numbers |");
  md.push("| --- | ---: | --- |");
  for (const t of tables) md.push(`| ${t.name} | ${t.rows.length} | ${rangesOf(t.rows) || "-"} |`);
  md.push("");
  md.push("Whole tables: LEGISLATOR_TBL.dat and LOCATION_CODE_TBL.dat. BILL_MOTION_TBL.dat holds only the motions the kept");
  md.push("roll calls refer to. BILL_ANALYSIS_TBL.dat holds each bill's latest analysis plus one committee analysis.");
  md.push("");
  md.push(`LOB files copied (${lobs.length}): bill XML of each bill's latest version, and the analyses above.`);
  md.push("");
  md.push(
    `LOB files referenced by kept rows but not copied (${omittedLobs.length}): bill XML of versions other than the latest. ` +
      "The ingest job reads only the latest version's XML, so these are never opened.",
  );
  md.push("");
  for (const l of omittedLobs) md.push(`- \`${l}\``);
  md.push("");
  const mdText = md.join("\n");
  await writeFile(join(o.outDir, "FIXTURE.md"), mdText, "utf8");
  bytes += Buffer.byteLength(mdText);
  return { tables, lobs, omittedLobs, bytes };
}
