import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { runIngest } from "../ingest.ts";
import { IngestError } from "../util.ts";
import { need, parseArgs } from "./args.ts";

const FLAGS = [
  "source",
  "session",
  "source-file",
  "source-date",
  "etag",
  "min-app-version",
  "manifests",
  "previous",
  "out",
  "generated-at",
  "tables",
  "tally-threshold",
  "report",
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  const t0 = Date.now();
  const { sealed, stats } = await runIngest({
    source: need(args, "source"),
    session: need(args, "session"),
    sourceFile: need(args, "source-file"),
    sourceDate: need(args, "source-date"),
    etag: args.etag ?? null,
    minAppVersion: args["min-app-version"] ?? "0.1.0",
    manifestsDir: args.manifests ?? null,
    previous: args.previous ? args.previous.split(",").filter((s) => s !== "") : [],
    out: need(args, "out"),
    generatedAt: args["generated-at"],
    tablesDir: args.tables,
    tallyThreshold: args["tally-threshold"] ? Number(args["tally-threshold"]) : undefined,
  });
  const wallSeconds = (Date.now() - t0) / 1000;
  const peakRssMb = process.resourceUsage().maxRSS / 1024;

  const sizes = sealed.files.map((f) => ({
    path: f.path,
    raw: Buffer.byteLength(f.bytes),
    gzip: gzipSync(f.bytes).length,
  }));
  const report = { snapshotId: sealed.snapshotId, wallSeconds, peakRssMb: Math.round(peakRssMb), sizes, stats };
  if (args.report) {
    await mkdir(dirname(args.report), { recursive: true });
    await writeFile(args.report, JSON.stringify(report, null, 2), "utf8");
  }
  const total = (k: "raw" | "gzip"): number => sizes.reduce((s, f) => s + f[k], 0);
  console.log(`snapshot ${sealed.snapshotId}`);
  console.log(`wall time ${wallSeconds.toFixed(1)} s, peak RSS ${Math.round(peakRssMb)} MB`);
  console.log(`bills ${stats.inScopeBills}, roll calls ${Object.values(stats.emittedByKind).reduce((a, b) => a + b, 0)}, final ${stats.finalRollCalls}`);
  console.log(`files ${sizes.length}, raw ${total("raw")} bytes, gzip ${total("gzip")} bytes`);
  if (args.report) console.log(`report written to ${args.report}`);
}

main().catch((e: unknown) => {
  if (e instanceof IngestError) {
    console.error(`INGEST FAILED (${e.code}), nothing written\n${e.message}`);
  } else {
    console.error(`INGEST FAILED, nothing written\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
  process.exit(1);
});
