import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisShardFile, CoreFile, DigestsFile, Manifest, SessionCounts, VotesFile } from "../schema/snapshot-v1.ts";
import { ManifestSchema } from "../schema/validate-v1.ts";
import { IngestError, compareStrings } from "./util.ts";

export const COUNT_FLOOR_RATIO = 0.98;

const COUNT_FIELDS = ["bills", "versions", "rollCalls", "memberVotes", "analyses"] as const;

/** Reads every *.json manifest in `dir` and fails if a count dropped below 98% of the earlier maximum. */
export async function checkCountsAgainstManifests(dir: string, counts: SessionCounts[]): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort(compareStrings);
  } catch {
    throw new IngestError("manifests-dir", `cannot read the manifests directory ${dir}`);
  }
  const best = new Map<string, Record<(typeof COUNT_FIELDS)[number], number>>();
  for (const name of names) {
    let parsed: Manifest;
    try {
      parsed = ManifestSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8"))) as Manifest;
    } catch (e) {
      throw new IngestError("manifests-dir", `${join(dir, name)} is not a valid manifest: ${(e as Error).message.split("\n")[0]}`);
    }
    for (const c of parsed.counts) {
      const cur = best.get(c.session) ?? { bills: 0, versions: 0, rollCalls: 0, memberVotes: 0, analyses: 0 };
      for (const f of COUNT_FIELDS) cur[f] = Math.max(cur[f], c[f]);
      best.set(c.session, cur);
    }
  }
  const drops: string[] = [];
  for (const c of counts) {
    const prior = best.get(c.session);
    if (!prior) continue;
    for (const f of COUNT_FIELDS) {
      if (c[f] < COUNT_FLOOR_RATIO * prior[f]) {
        drops.push(`session ${c.session} ${f}: ${c[f]} is below 98% of the earlier maximum ${prior[f]}`);
      }
    }
  }
  if (drops.length > 0) throw new IngestError("count-drop", "source counts dropped against earlier manifests", drops);
}

interface HasSrc {
  src?: unknown;
}

const srcOk = (r: HasSrc): boolean => {
  const s = r.src;
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  const table = o.table;
  if (typeof table !== "string" || table === "") return false;
  return Object.entries(o).every(([, v]) => typeof v === "string" && v !== "");
};

/** Every displayed record carries a non-empty `src`; otherwise the build fails. */
export function assertAllRecordsHaveSrc(core: CoreFile, votes: VotesFile, digests: DigestsFile, shards: AnalysisShardFile[]): void {
  const missing: string[] = [];
  for (const b of core.bills) if (!srcOk(b)) missing.push(`bill ${b.id}`);
  for (const p of core.people) for (const t of p.terms) if (!srcOk(t)) missing.push(`person ${p.id} term ${t.session} ${t.district}`);
  for (const r of votes.rollCalls) if (!srcOk(r)) missing.push(`roll call ${r.id}`);
  for (const r of votes.noRollCall) if (!srcOk(r)) missing.push(`passage without roll call ${r.billId} ${r.date}`);
  for (const [id, d] of Object.entries(digests.digests)) if (!srcOk(d)) missing.push(`digest ${id}`);
  for (const s of shards) for (const [id, a] of Object.entries(s.analyses)) if (!srcOk(a)) missing.push(`analysis ${id}`);
  if (missing.length > 0) throw new IngestError("missing-src", "records without src", missing);
}

/** References between the files and basic internal consistency. */
export function crossCheck(core: CoreFile, votes: VotesFile, digests: DigestsFile, shards: AnalysisShardFile[]): void {
  const problems: string[] = [];
  const billIds = new Set<string>();
  const billById = new Map(core.bills.map((b) => [b.id, b]));
  for (const b of core.bills) {
    if (billIds.has(b.id)) problems.push(`duplicate bill ${b.id}`);
    billIds.add(b.id);
    if (!b.versions.some((v) => v.id === b.latestVersionId)) problems.push(`${b.id}: latestVersionId is not among its versions`);
  }
  const issueIds = new Set(core.issues.map((i) => i.id));
  const committeeCodes = new Set(core.committees.map((c) => c.code));
  for (const c of core.committees) if (c.issueId !== null && !issueIds.has(c.issueId)) problems.push(`committee ${c.code}: unknown issue ${c.issueId}`);
  for (const b of core.bills) {
    for (const code of b.committees) if (!committeeCodes.has(code)) problems.push(`${b.id}: unknown committee ${code}`);
    for (const id of b.issueIds) if (!issueIds.has(id)) problems.push(`${b.id}: unknown issue ${id}`);
  }
  const personIds = new Set(core.people.map((p) => p.id));
  for (const [key, roster] of Object.entries(votes.rosters)) {
    for (const id of roster) if (!personIds.has(id)) problems.push(`roster ${key}: unknown person ${id}`);
  }
  const rollIds = new Set<string>();
  for (const r of votes.rollCalls) {
    if (rollIds.has(r.id)) problems.push(`duplicate roll call ${r.id}`);
    rollIds.add(r.id);
    const bill = billById.get(r.billId);
    if (!bill) {
      problems.push(`roll call ${r.id}: unknown bill`);
      continue;
    }
    if (!bill.versions.some((v) => v.id === r.versionId)) problems.push(`roll call ${r.id}: version ${r.versionId} is not a version of ${r.billId}`);
    const roster = votes.rosters[`${bill.session}-${r.house}`];
    if (!roster) problems.push(`roll call ${r.id}: no roster for ${bill.session}-${r.house}`);
    else if (roster.length !== r.v.length) problems.push(`roll call ${r.id}: v has ${r.v.length} codes, roster has ${roster.length}`);
  }
  for (const n of votes.noRollCall) if (!billIds.has(n.billId)) problems.push(`noRollCall: unknown bill ${n.billId}`);
  for (const [id, d] of Object.entries(digests.digests)) {
    const bill = billById.get(id);
    if (!bill) problems.push(`digest for unknown bill ${id}`);
    else if (d.versionId !== bill.latestVersionId) problems.push(`digest ${id}: version ${d.versionId} is not the latest ${bill.latestVersionId}`);
  }
  for (const b of core.bills) if (b.hasDigest !== (digests.digests[b.id] !== undefined)) problems.push(`${b.id}: hasDigest disagrees with the digests file`);
  const inShard = new Map<string, string>();
  for (const s of shards) {
    for (const id of Object.keys(s.analyses)) {
      inShard.set(id, s.shard);
      if (!billById.has(id)) problems.push(`analysis shard ${s.shard}: unknown bill ${id}`);
    }
  }
  for (const b of core.bills) {
    if ((b.analysisShard ?? null) !== (inShard.get(b.id) ?? null)) problems.push(`${b.id}: analysisShard disagrees with the shard files`);
  }
  if (problems.length > 0) throw new IngestError("cross-check", "the output files disagree with each other", problems);
}
