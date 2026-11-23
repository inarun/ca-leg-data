import type { House } from "../schema/snapshot-v1.ts";
import { floorAction } from "./passages.ts";
import type { HistoryRow } from "./tables.ts";
import { compareNumericStrings, compareStrings } from "./util.ts";

/**
 * A bill-history action that rescinds a floor passage, in the file's own wording, e.g.
 * "Action rescinded whereby the bill was read third time, passed, and to Assembly." or
 * "Action rescinded whereby bill was read third time, passed, and ordered to the Senate."
 * Rescinded referrals, inactive-file placements and resolution adoptions do not say "passed".
 */
const PASSAGE_RESCISSION = /^Action rescinded whereby\b.*\bpassed\b/i;

export function isPassageRescission(row: HistoryRow): boolean {
  return row.status === "Applied" && PASSAGE_RESCISSION.test(row.action);
}

/**
 * The house whose passage is rescinded: the row's primary_location when it names a house, else the wording
 * ("ordered to the Senate" is an Assembly passage, "and to Assembly" a Senate one).
 */
export function rescissionHouse(row: HistoryRow): House | null {
  if (row.primaryLocation === "Assembly") return "A";
  if (row.primaryLocation === "Senate") return "S";
  if (/\bto (?:the )?Senate\b/i.test(row.action)) return "A";
  if (/\bto (?:the )?Assembly\b/i.test(row.action)) return "S";
  return null;
}

const compareRows = (a: HistoryRow, b: HistoryRow): number =>
  compareStrings(a.date, b.date) || a.sequence - b.sequence || compareNumericStrings(a.historyId, b.historyId);

export interface Rescission {
  row: HistoryRow;
  house: House;
}

/**
 * The passage rescissions in the bill history. A final third-reading or consent roll call is no longer final once a
 * later rescission in its house has no later passage roll call (the caller supplies "final", so a re-passage's roll
 * call, being later, is the final one and is never asked about a rescission that came before it).
 *
 * "Later" is a later date. On the same date the rescission counts only when it follows, in history order, a
 * passage row of the same bill, house, date and tally (whatever that row's status: a rescinded passage is marked
 * "Rescinded") and no such row follows it; when that order cannot be established the roll call stays final.
 */
export class Rescissions {
  private readonly byBillHouse = new Map<string, Rescission[]>();
  private readonly passages = new Map<string, HistoryRow[]>();

  constructor(history: Iterable<HistoryRow>) {
    for (const row of history) {
      if (isPassageRescission(row)) {
        const house = rescissionHouse(row);
        if (house === null) continue;
        const k = `${row.billId}|${house}`;
        const list = this.byBillHouse.get(k) ?? [];
        list.push({ row, house });
        this.byBillHouse.set(k, list);
        continue;
      }
      const f = floorAction({ ...row, status: "Applied" });
      if (f && f.kind === "third_reading") {
        const k = `${row.billId}|${f.house}|${row.date}|${f.ayes}|${f.noes}`;
        const list = this.passages.get(k) ?? [];
        list.push(row);
        this.passages.set(k, list);
      }
    }
  }

  /** The rescission that undoes a third-reading or consent roll call of the bill, house, date and tally, if any. */
  rescindedBy(billId: string, house: House, date: string, ayes: number, noes: number): HistoryRow | null {
    let found: HistoryRow | null = null;
    for (const r of this.byBillHouse.get(`${billId}|${house}`) ?? []) {
      let later = r.row.date > date;
      if (r.row.date === date) {
        const rows = this.passages.get(`${billId}|${house}|${date}|${ayes}|${noes}`) ?? [];
        later = rows.some((p) => compareRows(p, r.row) < 0) && !rows.some((p) => compareRows(p, r.row) > 0);
      }
      if (later && (found === null || compareRows(r.row, found) > 0)) found = r.row;
    }
    return found;
  }
}
