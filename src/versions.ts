import type { BillVersionRef, VersionId } from "../schema/snapshot-v1.ts";
import { IngestError, compareStrings } from "./util.ts";

/** Oldest first: by date, then by version_num descending (version_num counts down from 99). */
export function sortVersionsOldestFirst<T extends { date: string; num: number; id: string }>(versions: T[]): T[] {
  return [...versions].sort((a, b) => compareStrings(a.date, b.date) || b.num - a.num || compareStrings(a.id, b.id));
}

const isVotable = (v: BillVersionRef): boolean => v.action === "Introduced" || v.action.startsWith("Amended");

/**
 * Version a vote was on (spec rule 5). Only Introduced and Amended* versions are candidates, never
 * Enrolled or Chaptered. The newest candidate dated strictly before the vote wins. When a candidate
 * carries the vote's own date, the order within that day is unknown, so the pick is flagged inferred.
 * With no candidate strictly earlier, the Introduced version is used, flagged inferred.
 */
export function chooseVersionForVote(
  billId: string,
  versionsOldestFirst: BillVersionRef[],
  voteDate: string,
): { versionId: VersionId; inferred: boolean } {
  const candidates = versionsOldestFirst.filter(isVotable);
  const earlier = candidates.filter((v) => v.date < voteDate);
  if (earlier.length > 0) {
    const sameDay = candidates.some((v) => v.date === voteDate);
    return { versionId: (earlier[earlier.length - 1] as BillVersionRef).id, inferred: sameDay };
  }
  const introduced = candidates.find((v) => v.action === "Introduced") ?? candidates[0];
  if (!introduced) throw new IngestError("no-version", `${billId} has no Introduced or Amended version to attach a vote to`);
  return { versionId: introduced.id, inferred: true };
}
