import type { BillVersionRef, VersionId } from "../schema/snapshot-v1.ts";
import type { FloorAction } from "./passages.ts";
import type { HistoryRow } from "./tables.ts";
import { IngestError, compareNumericStrings, compareStrings } from "./util.ts";

/** Oldest first: by date, then by version_num descending (version_num counts down from 99). */
export function sortVersionsOldestFirst<T extends { date: string; num: number; id: string }>(versions: T[]): T[] {
  return [...versions].sort((a, b) => compareStrings(a.date, b.date) || b.num - a.num || compareStrings(a.id, b.id));
}

const isVotable = (v: BillVersionRef): boolean => v.action === "Introduced" || v.action.startsWith("Amended");

/** How the bill history orders an amendment and the floor passage of one house on one day. */
export type SameDayOrder = "amendment-first" | "passage-first" | "unknown";

const AMENDMENT_ACTION = /\bamended\b/i;
const compareRows = (a: HistoryRow, b: HistoryRow): number =>
  compareStrings(a.date, b.date) || a.sequence - b.sequence || compareNumericStrings(a.historyId, b.historyId);

/**
 * Whether the vote's own-day amendment came before the vote. `passages` are the history rows of the floor action(s)
 * with the roll call's bill, house, date and tally; `history` is the bill's history. An applied action of that house
 * and day that says "amended" ("Amended. Ordered to third reading.", "Read second time and amended.") is the amendment.
 * Order is history order (date, action_sequence, history id). It is "unknown" when no such action or no matching
 * passage row exists, or when the passage rows fall on both sides of the amendment.
 */
export function sameDayOrder(history: HistoryRow[], passages: FloorAction[], houseName: "Assembly" | "Senate", date: string): SameDayOrder {
  if (passages.length === 0) return "unknown";
  const amendments = history.filter((h) => h.status === "Applied" && h.date === date && h.primaryLocation === houseName && AMENDMENT_ACTION.test(h.action));
  if (amendments.length === 0) return "unknown";
  const first = [...amendments].sort(compareRows)[0] as HistoryRow;
  const last = [...amendments].sort(compareRows).at(-1) as HistoryRow;
  if (passages.every((p) => compareRows(last, p.row) < 0)) return "amendment-first";
  if (passages.every((p) => compareRows(p.row, first) < 0)) return "passage-first";
  return "unknown";
}

/**
 * Version a vote was on (spec rule 5). Only Introduced and Amended* versions are candidates, never
 * Enrolled or Chaptered. The newest candidate dated strictly before the vote wins. When a candidate
 * carries the vote's own date, the order within that day is unknown, so the pick is flagged inferred.
 * With no candidate strictly earlier, the Introduced version is used, flagged inferred.
 * `order` (from sameDayOrder) refines the same-day case when the bill history settles it: "amendment-first" with a
 * single version dated that day means the vote was on that version (still flagged inferred: the history order is itself
 * an inference, the source records no version on a vote). Any other order keeps the previous-version rule, flagged inferred when a version is dated that day.
 */
export function chooseVersionForVote(
  billId: string,
  versionsOldestFirst: BillVersionRef[],
  voteDate: string,
  order: SameDayOrder = "unknown",
): { versionId: VersionId; inferred: boolean } {
  const candidates = versionsOldestFirst.filter(isVotable);
  const earlier = candidates.filter((v) => v.date < voteDate);
  const sameDayVersions = candidates.filter((v) => v.date === voteDate);
  if (sameDayVersions.length === 1 && sameDayVersions[0]?.action.startsWith("Amended") && order === "amendment-first") {
    return { versionId: (sameDayVersions[0] as BillVersionRef).id, inferred: true };
  }
  if (earlier.length > 0) {
    return { versionId: (earlier[earlier.length - 1] as BillVersionRef).id, inferred: sameDayVersions.length > 0 };
  }
  const introduced = candidates.find((v) => v.action === "Introduced") ?? candidates[0];
  if (!introduced) throw new IngestError("no-version", `${billId} has no Introduced or Amended version to attach a vote to`);
  return { versionId: introduced.id, inferred: true };
}
