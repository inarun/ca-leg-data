import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "../schema/snapshot-v1.ts";
import { validateFile } from "../schema/validate-v1.ts";
import type { BuiltSnapshot } from "./build.ts";
import { assertAllRecordsHaveSrc, checkCountsAgainstManifests, crossCheck } from "./checks.ts";
import { IngestError, compactTimestamp, sha256Hex, stableStringify } from "./util.ts";

export interface SealOptions {
  sourceFile: string;
  etag: string | null;
  minAppVersion: string;
  generatedAt: string;
  previous: string[];
}

export interface OutputFile {
  /** Path relative to the output directory. */
  path: string;
  bytes: string;
}

export interface SealedSnapshot {
  snapshotId: string;
  manifest: Manifest;
  files: OutputFile[];
}

const hash8 = (hex: string): string => hex.slice(0, 8);

/**
 * Gives the files their snapshot id and content-hashed names.
 *
 * Every file embeds the snapshot id, and the id contains a hash of the content, so the id hash is
 * taken over every file (core, votes, digests, analysis shards in shard order) serialised with an
 * empty snapshotId, which makes the id change whenever any file's content changes. The names are different: each
 * file is called `<kind>-<first 8 hex of the SHA-256 of its own bytes>.json`, and Manifest.files
 * records the full hash.
 */
export function sealSnapshot(built: BuiltSnapshot, o: SealOptions): SealedSnapshot {
  const idHash = sha256Hex(
    stableStringify(
      [built.core, built.votes, built.digests, ...built.analysisShards].map((f) => ({ ...f, snapshotId: "" })),
    ),
  );
  const snapshotId = `${compactTimestamp(built.sourceDate)}-${hash8(idHash)}`;

  const core = { ...built.core, snapshotId };
  const votes = { ...built.votes, snapshotId };
  const digests = { ...built.digests, snapshotId };
  const shards = built.analysisShards.map((s) => ({ ...s, snapshotId }));

  // Fail closed: nothing is written unless every file passes its validator and the cross-checks.
  validateFile("core", core, "core");
  validateFile("votes", votes, "votes");
  validateFile("digests", digests, "digests");
  for (const s of shards) validateFile("analysis", s, "analysis");
  assertAllRecordsHaveSrc(core, votes, digests, shards);
  crossCheck(core, votes, digests, shards);

  const files: OutputFile[] = [];
  const ref = (kind: string, value: unknown): { path: string; sha256: string; bytes: number } => {
    const text = stableStringify(value);
    const sha = sha256Hex(text);
    const path = `${kind}-${hash8(sha)}.json`;
    files.push({ path, bytes: text });
    return { path, sha256: sha, bytes: Buffer.byteLength(text) };
  };
  const coreRef = ref("core", core);
  const votesRef = ref("votes", votes);
  const digestsRef = ref("digests", digests);
  const analysisRefs = shards.map((s) => ({ ...ref(`analysis-${s.shard}`, s), shard: s.shard }));

  const manifest: Manifest = {
    schemaVersion: 1,
    snapshotId,
    generatedAt: o.generatedAt,
    minAppVersion: o.minAppVersion,
    sources: [{ session: built.session, file: o.sourceFile, sourceFileDate: built.sourceDate, etag: o.etag }],
    counts: [built.counts],
    files: { core: coreRef, votes: votesRef, digests: digestsRef, analysis: analysisRefs },
    previous: o.previous,
  };
  validateFile("manifest", manifest, "manifest");
  const manifestText = stableStringify(manifest);
  files.push({ path: "latest.json", bytes: manifestText });
  files.push({ path: `manifests/${snapshotId}.json`, bytes: manifestText });
  return { snapshotId, manifest, files };
}

/** Runs the checks that need the output directory's history, then writes all files. */
export async function writeSnapshot(outDir: string, sealed: SealedSnapshot, manifestsDir: string | null): Promise<void> {
  if (manifestsDir !== null) await checkCountsAgainstManifests(manifestsDir, sealed.manifest.counts);
  const names = new Set<string>();
  for (const f of sealed.files) {
    if (names.has(f.path)) throw new IngestError("output-names", `two output files are called ${f.path}`);
    names.add(f.path);
  }
  await mkdir(join(outDir, "manifests"), { recursive: true });
  for (const f of sealed.files) await writeFile(join(outDir, f.path), f.bytes, "utf8");
}
