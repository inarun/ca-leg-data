import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { House } from "../../schema/snapshot-v1.ts";
import { parseDat } from "../dat.ts";
import { draftPeopleTable } from "../people.ts";
import { openSource } from "../reader.ts";
import { loadTables } from "../tables.ts";
import { need, parseArgs } from "./args.ts";

/**
 * Drafts tables/people-<session>.json from LEGISLATOR_TBL and lists the floor and committee vote
 * names the draft does not cover. Those cases (a name spelt two ways, a short vote name) are fixed
 * by hand using only what the file shows; the build fails until every name is mapped.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["source", "session", "out"], ["force"]);
  const session = need(args, "session");
  const out = args.out ?? `tables/people-${session}.json`;
  const reader = await openSource(need(args, "source"));
  try {
    const t = await loadTables(reader, session);
    const names = new Map<House, Set<string>>([
      ["A", new Set()],
      ["S", new Set()],
    ]);
    const detail = await reader.readText("BILL_DETAIL_VOTE_TBL.dat");
    parseDat(detail, (c) => {
      const loc = c[1] ?? "";
      const name = c[2];
      if (name === null || name === undefined) return;
      if (loc === "AFLOOR" || loc.startsWith("CX")) names.get("A")?.add(name);
      else if (loc === "SFLOOR" || loc.startsWith("CS")) names.get("S")?.add(name);
    });
    const { table, unmappedVoteNames } = draftPeopleTable(session, t.legislators, names);
    if (!args.force) {
      const exists = await access(out).then(() => true, () => false);
      if (exists) throw new Error(`${out} exists (it may hold hand edits); pass --force to overwrite`);
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(table, null, 2) + "\n", "utf8");
    console.log(`wrote ${out}: ${table.people.length} people from ${t.legislators.length} LEGISLATOR_TBL rows`);
    if (unmappedVoteNames.length > 0) {
      console.log("vote names the draft does not map (fix by hand):");
      for (const u of unmappedVoteNames) console.log(`  ${u.house} ${JSON.stringify(u.name)}`);
    }
    const unnamed = t.legislators.filter((r) => r.authorName === null || r.legislatorName === null);
    if (unnamed.length > 0) console.log(`${unnamed.length} unnamed (vacant) LEGISLATOR_TBL rows skipped: ${unnamed.map((r) => r.district).join(", ")}`);
    const byDistrict = new Map<string, string[]>();
    for (const r of t.legislators) {
      if (r.authorName === null) continue;
      byDistrict.set(r.district, [...(byDistrict.get(r.district) ?? []), r.authorName]);
    }
    for (const [d, list] of byDistrict) if (list.length > 1) console.log(`district ${d} has ${list.length} named rows: ${list.join(" | ")}`);
  } finally {
    await reader.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
