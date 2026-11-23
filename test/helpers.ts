import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDat } from "../src/dat.ts";
import { runIngest, type IngestArgs } from "../src/ingest.ts";
import type {
  AnalysisShardFile,
  CoreFile,
  DigestsFile,
  Manifest,
  VotesFile,
} from "../schema/snapshot-v1.ts";

export const REPO = resolve(import.meta.dirname, "..");
export const FIXTURE = join(REPO, "fixtures", "pubinfo-2025-slice");
export const TABLES = join(REPO, "tables");
export const SESSION = "20252026";
export const SOURCE_DATE = "2026-11-16T05:26:36Z";
export const GENERATED_AT = "2026-11-22T00:00:00Z";
/** The slice holds one known tally mismatch (SB 329) in 107 roll calls, so the slice uses a looser threshold. */
export const SLICE_THRESHOLD = 0.98;

export const tempDirs: string[] = [];
export async function tempDir(prefix = "ca-leg-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
export async function cleanTemp(): Promise<void> {
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
}

export function ingestArgs(over: Partial<IngestArgs> & { out: string }): IngestArgs {
  return {
    source: FIXTURE,
    session: SESSION,
    sourceFile: "pubinfo_2025.zip",
    sourceDate: SOURCE_DATE,
    generatedAt: GENERATED_AT,
    tablesDir: TABLES,
    tallyThreshold: SLICE_THRESHOLD,
    ...over,
  };
}

export interface Snapshot {
  dir: string;
  manifest: Manifest;
  core: CoreFile;
  votes: VotesFile;
  digests: DigestsFile;
  shards: AnalysisShardFile[];
  analyses: Record<string, AnalysisShardFile["analyses"][string]>;
}

export async function readSnapshot(dir: string): Promise<Snapshot> {
  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as Manifest;
  const core = JSON.parse(await readFile(join(dir, manifest.files.core.path), "utf8")) as CoreFile;
  const votes = JSON.parse(await readFile(join(dir, manifest.files.votes.path), "utf8")) as VotesFile;
  const digests = JSON.parse(await readFile(join(dir, manifest.files.digests.path), "utf8")) as DigestsFile;
  const shards: AnalysisShardFile[] = [];
  for (const a of manifest.files.analysis) shards.push(JSON.parse(await readFile(join(dir, a.path), "utf8")) as AnalysisShardFile);
  const analyses: Snapshot["analyses"] = {};
  for (const s of shards) Object.assign(analyses, s.analyses);
  return { dir, manifest, core, votes, digests, shards, analyses };
}

/** Copy of the fixture directory that a test may mutate. */
export async function fixtureCopy(): Promise<string> {
  const d = await tempDir("fixture-");
  await cp(FIXTURE, d, { recursive: true });
  return d;
}

/** Copy of tables/ that a test may mutate. */
export async function tablesCopy(): Promise<string> {
  const d = await tempDir("tables-");
  await cp(TABLES, d, { recursive: true });
  return d;
}

/** Rewrites rows of a .dat file; `edit` returns the new raw row text, or null to drop the row. */
export async function editRows(
  dir: string,
  file: string,
  match: (cells: Array<string | null>, rowNumber: number) => boolean,
  edit: (raw: string, cells: Array<string | null>) => string | null,
): Promise<number> {
  const path = join(dir, file);
  const text = await readFile(path, "utf8");
  const parts: string[] = [];
  let last = 0;
  let touched = 0;
  parseDat(text, (cells, span) => {
    if (!match(cells, span.row)) return;
    const replacement = edit(text.slice(span.start, span.end), cells);
    parts.push(text.slice(last, span.start));
    if (replacement !== null) parts.push(replacement);
    last = replacement === null ? Math.min(span.end + 1, text.length) : span.end;
    touched += 1;
  });
  parts.push(text.slice(last));
  await writeFile(path, parts.join(""), "utf8");
  return touched;
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
}

export { runIngest };
