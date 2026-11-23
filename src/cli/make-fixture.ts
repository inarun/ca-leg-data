import { basename } from "node:path";
import { makeFixture } from "../fixture.ts";
import { openSource } from "../reader.ts";
import { need, parseArgs } from "./args.ts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["source", "bills", "out", "source-file", "source-date"]);
  const source = need(args, "source");
  const bills = need(args, "bills").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const out = need(args, "out");
  const reader = await openSource(source);
  try {
    const sourceFile = args["source-file"] ?? basename(source);
    const sourceDate = args["source-date"] ?? null;
    const command =
      `npm run make-fixture -- --source ${source} --bills ${bills.join(",")} --out ${out}` +
      ` --source-file ${sourceFile}${sourceDate ? ` --source-date ${sourceDate}` : ""}`;
    const report = await makeFixture(reader, { bills, outDir: out, sourceFile, sourceDate, command });
    console.log(`fixture written to ${out}: ${report.tables.length} tables, ${report.lobs.length} LOB files, ${(report.bytes / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    await reader.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
