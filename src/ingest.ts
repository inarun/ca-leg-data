import { resolve } from "node:path";
import { DEFAULT_MIN_MEMBERS, DEFAULT_TALLY_THRESHOLD, buildSnapshot, type BuildStats } from "./build.ts";
import { sealSnapshot, writeSnapshot, type SealedSnapshot } from "./output.ts";
import { openSource } from "./reader.ts";

export interface IngestArgs {
  source: string;
  session: string;
  sourceFile: string;
  sourceDate: string;
  etag?: string | null;
  minAppVersion?: string;
  manifestsDir?: string | null;
  previous?: string[];
  out: string;
  generatedAt?: string;
  tablesDir?: string;
  tallyThreshold?: number;
  /** When false, build and check but write nothing. */
  write?: boolean;
}

export interface IngestResult {
  sealed: SealedSnapshot;
  stats: BuildStats;
}

/** Builds, checks and writes a snapshot. Throws IngestError and writes nothing on any failed check. */
export async function runIngest(a: IngestArgs): Promise<IngestResult> {
  const reader = await openSource(a.source);
  try {
    const built = await buildSnapshot(reader, {
      session: a.session,
      sourceDate: a.sourceDate,
      tablesDir: resolve(a.tablesDir ?? "tables"),
      tallyThreshold: a.tallyThreshold ?? DEFAULT_TALLY_THRESHOLD,
      minMembers: DEFAULT_MIN_MEMBERS,
    });
    const sealed = sealSnapshot(built, {
      sourceFile: a.sourceFile,
      etag: a.etag ?? null,
      minAppVersion: a.minAppVersion ?? "0.1.0",
      generatedAt: a.generatedAt ?? new Date().toISOString(),
      previous: a.previous ?? [],
    });
    if (a.write !== false) await writeSnapshot(resolve(a.out), sealed, a.manifestsDir ? resolve(a.manifestsDir) : null);
    return { sealed, stats: built.stats };
  } finally {
    await reader.close();
  }
}
