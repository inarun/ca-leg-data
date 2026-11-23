import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoreFile, Manifest, RollCall, VotesFile } from "../../schema/snapshot-v1.ts";
import type { BuildStats } from "../build.ts";
import { need, parseArgs } from "./args.ts";

/** Deterministic PRNG (mulberry32) so the spot-check sample is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOTE_WORD: Record<string, string> = { A: "Aye", N: "No", X: "No vote recorded (source code ABS)" };
const KIND_WORD: Record<string, string> = { third_reading: "third reading", consent: "consent", concurrence: "concurrence" };
const cell = (s: string): string => s.replace(/\|/g, "\\|");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ["snapshot", "out", "seed", "count", "report"]);
  const dir = need(args, "snapshot");
  const outDir = args.out ?? "docs/review";
  const seed = Number(args.seed ?? "20261116");
  const count = Number(args.count ?? "30");

  const manifest = JSON.parse(await readFile(join(dir, "latest.json"), "utf8")) as Manifest;
  const core = JSON.parse(await readFile(join(dir, manifest.files.core.path), "utf8")) as CoreFile;
  const votes = JSON.parse(await readFile(join(dir, manifest.files.votes.path), "utf8")) as VotesFile;
  await mkdir(outDir, { recursive: true });

  // ------------------------------------------------------------ vote spot check
  const billById = new Map(core.bills.map((b) => [b.id, b]));
  const personById = new Map(core.people.map((p) => [p.id, p]));
  const finals = votes.rollCalls.filter((r) => r.final);
  const rand = prng(seed);
  const pool = [...finals];
  const chosen: RollCall[] = [];
  while (chosen.length < count && pool.length > 0) {
    chosen.push(pool.splice(Math.floor(rand() * pool.length), 1)[0] as RollCall);
  }
  const rows: string[] = [];
  chosen.forEach((r, i) => {
    const roster = votes.rosters[`${r.src.billId.slice(0, 8)}-${r.house}`] as string[];
    const idxs = [...r.v].flatMap((c, k) => (c === "-" ? [] : [k]));
    const k = idxs[Math.floor(rand() * idxs.length)] as number;
    const person = personById.get(roster[k] as string);
    const bill = billById.get(r.billId);
    const term = person?.terms.find((t) => t.house === r.house);
    rows.push(
      `| ${i + 1} | ${cell(bill?.label ?? r.billId)} | ${cell(term?.displayName ?? (roster[k] as string))} (${r.house === "A" ? "Assembly" : "Senate"}, ${term?.district ?? ""}) | ` +
        `${r.date}${r.time ? " " + r.time : ""} | ${KIND_WORD[r.kind]} | ${cell(r.fileLocation ?? "(none)")} | ${VOTE_WORD[r.v[k] as string]} | ${r.ayes}-${r.noes}-${r.noVoteRecorded} ${r.result} | ` +
        `${r.versionId}${r.versionInferred ? " (inferred)" : ""} | [${r.billId}](https://leginfo.legislature.ca.gov/faces/billVotesClient.xhtml?bill_id=${r.billId}) |`,
    );
  });
  // Cases the build could not settle by rule (from the ingest report's stats), for a human to check.
  const look: string[] = [];
  if (args.report) {
    const stats = (JSON.parse(await readFile(args.report, "utf8")) as { stats: BuildStats }).stats;
    const link = (billId: string): string => `[${billId}](https://leginfo.legislature.ca.gov/faces/billVotesClient.xhtml?bill_id=${billId})`;
    const house = (h: string): string => (h === "A" ? "Assembly" : "Senate");
    const flat = (s: string): string => s.replace(/\s+/g, " ");
    look.push("## Needs a human look", "");
    look.push("### Passages not reported as missing a roll call, although no counted roll call matches them", "");
    look.push("The bill history records a passage with a tally, and the source holds a floor roll call of the same bill, house and date with the same");
    look.push("official tally, but a rule excludes that roll call. `noRollCall` does not list these. Check whether the roll call is the passage vote.", "");
    look.push("| Bill | House | Date | History line | Roll call (location, outcome, motion text) |", "| --- | --- | --- | --- | --- |");
    for (const n of stats.noRollCallNeedsLook) {
      const rc = n.rollCalls.map((r) => `${r.fileLocation ?? "(none)"}, ${r.kind ?? "excluded"}, ${flat(r.motionText)}`).join("; ");
      look.push(`| ${link(n.billId)} | ${house(n.house)} | ${n.date} | ${cell(flat(n.historyAction))} | ${cell(rc)} |`);
    }
    if (stats.noRollCallNeedsLook.length === 0) look.push("| none | | | | |");
    look.push("", "### Second-reading roll calls counted because a history action has the same tally", "");
    look.push("These are filed under a second-reading location. Each is counted as the kind shown because the bill history has a `Read third time ... Passed`");
    look.push("or `concurred in` action of the same bill, house and date with the same official tally. Check that the roll call is that vote.", "");
    look.push("| Bill | House | Date | File location | Motion text | Counted as | Tally | Matching history line |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const u of stats.secondReadingUpgrades) {
      look.push(
        `| ${link(u.billId)} | ${house(u.house)} | ${u.date} | ${cell(u.fileLocation ?? "(none)")} | ${cell(flat(u.motionText))} | ${KIND_WORD[u.kind]} | ${u.ayes}-${u.noes} | ${cell(flat(u.historyLine))} |`,
      );
    }
    if (stats.secondReadingUpgrades.length === 0) look.push("| none | | | | | | | |");
    look.push("", "### Roll calls filed under a motion to reconsider, counted because a history passage has the same tally", "");
    look.push("The motion text ends \"Motion to Reconsider\" but the same text is shared by the passage vote itself. Each is counted as the kind shown because the");
    look.push("bill history has an applied `Read third time ... Passed` (or `concurred in`) action of the same bill, house and date with the same official tally.", "");
    look.push("| Bill | House | Date | File location | Motion text | Counted as | Tally | Matching history line |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const u of stats.reconsiderationUpgrades) {
      look.push(
        `| ${link(u.billId)} | ${house(u.house)} | ${u.date} | ${cell(u.fileLocation ?? "(none)")} | ${cell(flat(u.motionText))} | ${KIND_WORD[u.kind]} | ${u.ayes}-${u.noes} | ${cell(flat(u.historyLine))} |`,
      );
    }
    if (stats.reconsiderationUpgrades.length === 0) look.push("| none | | | | | | | |");
    look.push("", "### Final roll calls cleared because the passage was later rescinded", "");
    look.push("The bill history has an applied `Action rescinded whereby ... passed` action in that house after the roll call, and no later passage roll call");
    look.push("in that house. The roll call is still listed (`final` false) so the vote is not lost; the bill has no final passage in that house.", "");
    look.push("| Bill | House | Date | Counted as | Tally | Rescinded on | Rescinding history line |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const x of stats.rescindedFinals) {
      look.push(`| ${link(x.billId)} | ${house(x.house)} | ${x.date} | ${KIND_WORD[x.kind]} | ${x.ayes}-${x.noes} | ${x.rescindedOn} | ${cell(flat(x.historyAction))} |`);
    }
    if (stats.rescindedFinals.length === 0) look.push("| none | | | | | | |");
    look.push("", "### Votes placed on a same-day version by the bill history's order", "");
    look.push("A bill version is dated the day of the vote. When the history has an applied `amended` action of that house and day before the passage action");
    look.push("(same bill, house, date and tally), the vote is placed on that day's version instead of the previous one (`versionInferred` stays true).", "");
    const orders = Object.entries(stats.sameDayVersionOrder).map(([k, n]) => `${k} ${n}`).join(", ");
    look.push(`Votes on such a day, by the history's order: ${orders || "none"}.`, "");
    look.push("| Bill | House | Date | Previous-version pick | Version used |", "| --- | --- | --- | --- | --- |");
    for (const x of stats.sameDayVersionChanged) look.push(`| ${link(x.billId)} | ${house(x.house)} | ${x.date} | ${x.from} | ${x.to} |`);
    if (stats.sameDayVersionChanged.length === 0) look.push("| none | | | | |");
    look.push("", "### Constitutional amendment roll calls counted by the adoption rule", "");
    look.push("A constitutional amendment's floor vote is worded `Adopted and to Assembly.` or `Adopted and to Senate.` in the history. These roll calls");
    look.push("are filed under W/O REF. TO FILE (or have no file_location) and are counted as a third reading because such an action has the same tally.", "");
    look.push("| Bill | House | Date | File location | Motion text | Tally | Matching history line |", "| --- | --- | --- | --- | --- | --- | --- |");
    const adopted = stats.historyDecisions.filter((d) => d.kind === "third_reading" && d.historyLine !== null && d.historyLine.startsWith("Adopted and to"));
    for (const d of adopted) {
      look.push(`| ${link(d.billId)} | ${house(d.house)} | ${d.date} | ${cell(d.group.slice(2))} | ${cell(flat(d.motionText))} | ${d.ayes}-${d.noes} | ${cell(flat(d.historyLine as string))} |`);
    }
    if (adopted.length === 0) look.push("| none | | | | | | |");
    look.push("", "### W/O REF. TO FILE roll calls with no matching history action (excluded)", "");
    look.push("| Roll call | Motion text | Tally |", "| --- | --- | --- |");
    const unmatched = stats.noHistoryMatch.filter((x) => x.keptAs === null);
    for (const x of unmatched) look.push(`| ${cell(x.id)} | ${cell(flat(x.motionText))} | ${x.ayes}-${x.noes} |`);
    if (unmatched.length === 0) look.push("| none | | |");
    look.push("");
  }
  const spot = [
    "# Vote spot check",
    "",
    `${count} member votes drawn at random (seed ${seed}) from the ${finals.length} roll calls flagged \`final\` in snapshot \`${manifest.snapshotId}\`.`,
    "Each row is one roll call (distinct) and one member who has a vote on it (A, N or X in `v`).",
    "To check a row: open the link, find the roll call on the date and house shown, and confirm the member's vote, the tally",
    "(ayes-noes-no vote recorded), and that the version id is the one the bill text stood at on the day of the vote.",
    "",
    "Source: " + manifest.sources.map((s) => `\`${s.file}\` (last modified ${s.sourceFileDate})`).join(", ") + ".",
    "",
    "| # | Bill | Member | Date | Kind | File location | Vote | Official tally | Version voted on | Link |",
    "| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...look,
  ].join("\n");
  await writeFile(join(outDir, "vote-spot-check.md"), spot, "utf8");

  // ------------------------------------------------------------ issue map
  const issueName = new Map(core.issues.map((i) => [i.id, i.name]));
  const billsPerIssue = new Map<string, number>();
  for (const b of core.bills) for (const id of b.issueIds) billsPerIssue.set(id, (billsPerIssue.get(id) ?? 0) + 1);
  const billsPerCommittee = new Map<string, number>();
  for (const b of core.bills) for (const c of b.committees) billsPerCommittee.set(c, (billsPerCommittee.get(c) ?? 0) + 1);
  const byIssue = new Map<string | null, string[]>();
  for (const c of core.committees) {
    const list = byIssue.get(c.issueId) ?? [];
    list.push(`${c.code} ${c.house === "A" ? "Asm" : "Sen"} ${c.name}`);
    byIssue.set(c.issueId, list);
  }
  const md: string[] = [];
  md.push("# Issue list and committee map", "");
  md.push("For human review. Sources: `tables/issues.json` and `tables/committees-20252026.json`; committee names are");
  md.push("A bill's committees are those it was referred to (the committee code carried by the history row), heard in or voted in, in order of first appearance.");
  md.push("`LOCATION_CODE_TBL.long_description`. Each policy subject is one neutral issue named with the committees' own words;");
  md.push("Assembly and Senate committees on the same subject share an issue. Fiscal and procedural committees map to no issue.");
  md.push("An issue id and its number `n` are stored in user profiles and are never reused or renamed.", "");
  md.push("## Issues", "");
  md.push("| n | id | Name | Committees mapped | Bills tagged |", "| ---: | --- | --- | ---: | ---: |");
  for (const i of core.issues) md.push(`| ${i.n} | \`${i.id}\` | ${cell(i.name)} | ${byIssue.get(i.id)?.length ?? 0} | ${billsPerIssue.get(i.id) ?? 0} |`);
  md.push("", "## Committees", "");
  md.push("| Code | House | Committee | Issue | Bills with this committee |", "| --- | --- | --- | --- | ---: |");
  for (const c of core.committees) {
    md.push(`| ${c.code} | ${c.house === "A" ? "Assembly" : "Senate"} | ${cell(c.name)} | ${c.issueId ? cell(issueName.get(c.issueId) ?? c.issueId) : "none (fiscal or procedural)"} | ${billsPerCommittee.get(c.code) ?? 0} |`);
  }
  md.push("");
  md.push("## Judgment calls to check", "");
  md.push("- `CS56` Labor, Public Employment and Retirement maps to Labor and Employment; the Assembly `CX17` Public Employment and Retirement has its own issue.");
  md.push("- `CS85` Fuel Supply and Price Spikes and `CX84` Petroleum and Gasoline Supply map to Energy and Utilities.");
  md.push("- `CX05` Environmental Safety and Toxic Materials maps to Environmental Quality (with `CS64`).");
  md.push("- `CX02` Accountability and Administrative Review maps to Governmental Organization.");
  md.push("- Inactive Senate committees (`CS51`, `CS67`, `CS73`, `CS80`) appear in LOCATION_CODE_TBL but in no hearing or roll call; they are mapped by subject.");
  md.push("");
  md.push("## Needs a human look", "");
  const committeeByCode = new Map(core.committees.map((c) => [c.code, c]));
  const pairs: Array<[string, string]> = [["CS73", "CX19"], ["CS56", "CX17"]];
  for (const [a, b] of pairs) {
    const ca = committeeByCode.get(a);
    const cb = committeeByCode.get(b);
    if (!ca || !cb) continue;
    const label = (c: { issueId: string | null }): string => (c.issueId ? `${issueName.get(c.issueId) ?? c.issueId} (\`${c.issueId}\`)` : "no issue");
    md.push(`- \`${a}\` ${ca.name} maps to ${label(ca)} while \`${b}\` ${cb.name} maps to ${label(cb)}. Check whether the two should share an issue; the mapping is unchanged.`);
  }
  md.push("");
  await writeFile(join(outDir, "issue-map.md"), md.join("\n"), "utf8");
  console.log(`wrote ${join(outDir, "vote-spot-check.md")} and ${join(outDir, "issue-map.md")}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
