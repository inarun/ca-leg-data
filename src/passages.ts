import type { House } from "../schema/snapshot-v1.ts";
import type { HistoryRow } from "./tables.ts";

export type PassageKind = "third_reading" | "concurrence";

export interface HistoryPassage {
  kind: PassageKind;
  house: House;
  row: HistoryRow;
}

const TALLY = /\(Ayes\s+\d+\.\s+Noes\s+\d+\./;
const READ_THIRD_PASSED = /Read third time\.\s+(?:Urgency clause adopted\.\s+)?Passed\./;
const CONCURRED = /(?:Senate|Assembly) amendments concurred in\./;

/**
 * A bill-history action that records a passage with a tally. Committee recommendations such as
 * "From committee: That the Senate amendments be concurred in. (Ayes 6. Noes 0.)" are not floor
 * passages, and only actions still in force (status "Applied") count.
 * The house is the history row's primary_location, which always agrees with the wording
 * ("Ordered to the Senate" is an Assembly action); the wording is the fallback when it is empty.
 */
export function historyPassage(row: HistoryRow): HistoryPassage | null {
  const a = row.action;
  if (row.status !== "Applied") return null;
  if (!TALLY.test(a) || a.startsWith("From committee")) return null;
  let kind: PassageKind | null = null;
  if (READ_THIRD_PASSED.test(a)) kind = "third_reading";
  else if (CONCURRED.test(a)) kind = "concurrence";
  if (kind === null) return null;
  const house = passageHouse(row, kind);
  if (house === null) return null;
  return { kind, house, row };
}

export function passageHouse(row: HistoryRow, kind: PassageKind): House | null {
  if (row.primaryLocation === "Assembly") return "A";
  if (row.primaryLocation === "Senate") return "S";
  const a = row.action;
  if (kind === "third_reading") {
    if (/Ordered to (?:the )?Senate/.test(a)) return "A";
    if (/Ordered to (?:the )?Assembly/.test(a)) return "S";
  } else {
    if (/Senate amendments concurred in/.test(a)) return "A";
    if (/Assembly amendments concurred in/.test(a)) return "S";
  }
  return null;
}

export function parseTally(action: string): { ayes: number; noes: number } | null {
  const m = /\(Ayes\s+(\d+)\.\s+Noes\s+(\d+)\./.exec(action);
  return m ? { ayes: Number(m[1]), noes: Number(m[2]) } : null;
}

/** A history action recording a floor passage or concurrence together with its official tally. */
export interface FloorAction {
  kind: PassageKind;
  house: House;
  ayes: number;
  noes: number;
  row: HistoryRow;
}

/**
 * The looser reading used to classify ambiguous floor roll calls: an action still in force, with a
 * tally, that contains "concurred in" (concurrence) or "Read third time" and "Passed" (passage), or "Adopted and to <house>." (a constitutional amendment).
 * "From committee" actions are not floor votes.
 */
export function floorAction(row: HistoryRow): FloorAction | null {
  const a = row.action;
  if (row.status !== "Applied" || a.startsWith("From committee")) return null;
  const tally = parseTally(a);
  if (!tally) return null;
  let kind: PassageKind | null = null;
  if (/concurred in/.test(a)) kind = "concurrence";
  else if (/Read third time/.test(a) && /Passed/.test(a)) kind = "third_reading";
  // Constitutional amendments are adopted rather than passed. The file words the floor vote
  // "Adopted and to Assembly." / "Adopted and to Senate." (e.g. ACA 21, Senate, 2026-06-25).
  else if (/^Adopted and to (?:Assembly|Senate)\./.test(a)) kind = "third_reading";
  if (kind === null) return null;
  const house = passageHouse(row, kind);
  if (house === null) return null;
  return { kind, house, ayes: tally.ayes, noes: tally.noes, row };
}

/** Floor actions of every bill, looked up by bill, house, date and official tally. */
export class FloorActionIndex {
  private readonly byKey = new Map<string, FloorAction[]>();
  constructor(history: Iterable<HistoryRow>) {
    for (const row of history) {
      const f = floorAction(row);
      if (!f) continue;
      const key = FloorActionIndex.key(row.billId, f.house, row.date, f.ayes, f.noes);
      const list = this.byKey.get(key) ?? [];
      list.push(f);
      this.byKey.set(key, list);
    }
  }
  static key(billId: string, house: House, date: string, ayes: number, noes: number): string {
    return `${billId}|${house}|${date}|${ayes}|${noes}`;
  }
  find(billId: string, house: House, date: string, ayes: number, noes: number): FloorAction[] {
    return this.byKey.get(FloorActionIndex.key(billId, house, date, ayes, noes)) ?? [];
  }
}
