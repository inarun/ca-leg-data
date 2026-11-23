import { readFile } from "node:fs/promises";
import type { Committee, House, Issue } from "../schema/snapshot-v1.ts";
import type { LocationRow } from "./tables.ts";
import { IngestError, compareStrings } from "./util.ts";
import { committeeHouse } from "./stage.ts";

export interface IssuesTable {
  issues: Issue[];
}

export interface CommitteeMapEntry {
  /** LOCATION_CODE_TBL.location_code, e.g. "CX03". */
  code: string;
  house: House;
  /** LOCATION_CODE_TBL.long_description, copied for review. */
  name: string;
  issueId: string | null;
}

export interface CommitteesTable {
  session: string;
  committees: CommitteeMapEntry[];
}

export async function loadIssuesTable(path: string): Promise<IssuesTable> {
  const raw = JSON.parse(await readFile(path, "utf8")) as IssuesTable;
  if (!raw || !Array.isArray(raw.issues)) throw new IngestError("issues-table", `${path} is not an issues table`);
  return raw;
}

export async function loadCommitteesTable(path: string): Promise<CommitteesTable> {
  const raw = JSON.parse(await readFile(path, "utf8")) as CommitteesTable;
  if (!raw || !Array.isArray(raw.committees) || typeof raw.session !== "string") {
    throw new IngestError("committees-table", `${path} is not a committees table`);
  }
  return raw;
}

/** Location codes of committees in LOCATION_CODE_TBL (CS.. Senate, CX.. Assembly). */
export function committeeLocations(locations: LocationRow[]): LocationRow[] {
  return locations.filter((l) => committeeHouse(l.code) !== null);
}

export interface ResolvedIssues {
  issues: Issue[];
  committees: Committee[];
  issueByCommittee: Map<string, string | null>;
}

/**
 * Checks the issue list and the committee map and builds the Committee records. Every committee
 * code present in the file (LOCATION_CODE_TBL, hearings, committee roll calls) must be in the map.
 */
export function resolveIssues(
  session: string,
  issuesTable: IssuesTable,
  committeesTable: CommitteesTable,
  locations: LocationRow[],
  codesInUse: Iterable<string>,
): ResolvedIssues {
  const problems: string[] = [];
  const issueIds = new Set<string>();
  const ns = new Set<number>();
  for (const i of issuesTable.issues) {
    if (issueIds.has(i.id)) problems.push(`issue id ${i.id} appears twice`);
    if (ns.has(i.n)) problems.push(`issue number ${i.n} is used twice`);
    if (!Number.isInteger(i.n) || i.n < 1 || i.n > 63) problems.push(`issue ${i.id} has n=${i.n}, expected 1..63`);
    issueIds.add(i.id);
    ns.add(i.n);
  }
  if (committeesTable.session !== session) {
    problems.push(`committees table is for session ${committeesTable.session}, building ${session}`);
  }
  const byCode = new Map<string, CommitteeMapEntry>();
  for (const c of committeesTable.committees) {
    if (byCode.has(c.code)) problems.push(`committee ${c.code} appears twice in the committees table`);
    byCode.set(c.code, c);
    if (c.issueId !== null && !issueIds.has(c.issueId)) problems.push(`committee ${c.code} maps to unknown issue ${c.issueId}`);
    if (committeeHouse(c.code) !== c.house) problems.push(`committee ${c.code} is listed under house ${c.house}`);
  }

  const present = new Set<string>();
  for (const l of committeeLocations(locations)) present.add(l.code);
  for (const code of codesInUse) if (committeeHouse(code) !== null) present.add(code);
  const missing = [...present].filter((code) => !byCode.has(code)).sort(compareStrings);
  for (const code of missing) {
    const loc = locations.find((l) => l.code === code);
    problems.push(`committee code ${code}${loc?.longDescription ? ` (${loc.longDescription})` : ""} is not in the committees table`);
  }
  if (problems.length > 0) throw new IngestError("committee-map", "issues or committees table is incomplete", problems);

  const committees: Committee[] = [];
  for (const code of [...present].sort(compareStrings)) {
    const e = byCode.get(code) as CommitteeMapEntry;
    const loc = locations.find((l) => l.code === code);
    committees.push({
      session,
      code,
      house: e.house,
      name: loc?.longDescription ?? loc?.description ?? e.name,
      issueId: e.issueId,
    });
  }
  const issues = [...issuesTable.issues].sort((a, b) => a.n - b.n);
  return { issues, committees, issueByCommittee: new Map(committees.map((c) => [c.code, c.issueId])) };
}
