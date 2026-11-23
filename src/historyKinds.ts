import type { House, VoteKind } from "../schema/snapshot-v1.ts";
import { isUrgencyClauseMotion, type ExclusionReason } from "./classify.ts";
import type { FloorAction, FloorActionIndex, PassageKind } from "./passages.ts";
import { IngestError } from "./util.ts";

/** The fields of a floor roll call that the history rule reads; `kind` and nothing else is written. */
export interface HistoryCandidate {
  key: string;
  billId: string;
  house: House;
  date: string;
  ayes: number;
  noes: number;
  motionText: string;
  kind: VoteKind | null;
  /**
   * "required": W/O REF. TO FILE and no file_location. "refine": Senate consent locations.
   * "optional": second-reading locations. null: not history-decided.
   */
  history: "required" | "refine" | "optional" | null;
  /** Report label, e.g. "S W/O REF. TO FILE". */
  group: string;
  /** BILL_SUMMARY_VOTE_TBL.file_location verbatim (reported only). */
  fileLocation: string | null;
  /** Excluded by its motion text or location before any history rule. */
  excluded: boolean;
  /** For "optional": the exclusion reason when no history action matches (default "location"). */
  noMatchReason?: ExclusionReason;
  /** The motion text names a reconsideration: never counts as another roll call's duplicate. */
  reconsideration?: boolean;
}

export interface HistoryDecision {
  group: string;
  billId: string;
  house: House;
  date: string;
  ayes: number;
  noes: number;
  motionText: string;
  kind: VoteKind | null;
  reason: ExclusionReason | null;
  /** BILL_HISTORY_TBL.action of the matching row, verbatim; null when none matched. */
  historyLine: string | null;
}

/** A second-reading roll call that the history made a third reading or a concurrence. */
export interface HistoryUpgrade {
  group: string;
  id: string;
  billId: string;
  house: House;
  date: string;
  fileLocation: string | null;
  motionText: string;
  ayes: number;
  noes: number;
  kind: VoteKind;
  /** Why the roll call would otherwise be excluded: "location" (second reading) or "reconsideration". */
  wouldBeExcludedAs: ExclusionReason;
  /** BILL_HISTORY_TBL.action of the matching row, verbatim, and its id. */
  historyLine: string;
  billHistoryId: string;
}

export interface HistoryRuleResult {
  /** Second-reading roll calls counted because of a matching history action. */
  upgrades: HistoryUpgrade[];
  /** Per location group, the number of roll calls by resulting kind or exclusion reason. */
  groups: Record<string, Record<string, number>>;
  /** Every roll call of a "required" location, with its outcome. */
  decisions: HistoryDecision[];
  /** Roll calls of a history-decided location that no history action matched. */
  noMatch: Array<{ group: string; id: string; motionText: string; ayes: number; noes: number; keptAs: VoteKind | null }>;
  /** Roll calls of the consent locations that the history made concurrences, by group. */
  consentBecameConcurrence: Record<string, number>;
  /** Senate roll calls outside the history-decided locations whose motion text names the urgency clause. */
  urgencyClauseOutside: Record<string, number>;
  /** Exclusions made here, by reason. */
  excludedByReason: Record<string, number>;
}

const inc = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

/**
 * Decides the kind of every roll call in a history-decided location. The roll call's official tally
 * is looked up among the bill's history actions of the same house and date:
 * - "concurred in" makes it a concurrence;
 * - "Read third time" with "Passed", or "Adopted and to Assembly." / "Adopted and to Senate." (a constitutional
 *   amendment's floor vote), makes it a third reading (W/O REF. TO FILE, no file_location)
 *   and leaves a consent location as consent;
 * - no matching action excludes a "required" location (no-history-match), leaves a consent location as
 *   consent and leaves a second-reading location excluded (a second-reading location counts only with a match).
 * A Senate roll call on the urgency clause is a separate vote: it is excluded (urgency-clause) when
 * another roll call of the bill, house and date matched the history; if it is the only one, the
 * rules above apply to it. A tally matching both a concurrence and a passage fails the build.
 * A roll call filed under a motion to reconsider counts like a second-reading one (only with a matching action), unless
 * another counted roll call of the same bill, house, date and tally already stands for that passage: then it is the
 * reconsideration vote itself, a second vote on the same question, and stays excluded.
 */
export function applyHistoryRules(candidates: HistoryCandidate[], index: FloorActionIndex): HistoryRuleResult {
  const result: HistoryRuleResult = { upgrades: [], groups: {}, decisions: [], noMatch: [], consentBecameConcurrence: {}, urgencyClauseOutside: {}, excludedByReason: {} };

  const matchOf = (c: HistoryCandidate): PassageKind | null => {
    const kinds = new Set(index.find(c.billId, c.house, c.date, c.ayes, c.noes).map((a) => a.kind));
    if (kinds.size > 1) {
      throw new IngestError("history-ambiguous", `${c.key}: the bill history has both a concurrence and a passage with tally ${c.ayes}-${c.noes} on ${c.date}`);
    }
    return [...kinds][0] ?? null;
  };

  const sameDay = new Map<string, HistoryCandidate[]>();
  for (const c of candidates) {
    const k = `${c.billId}|${c.house}|${c.date}`;
    const list = sameDay.get(k) ?? [];
    list.push(c);
    sameDay.set(k, list);
  }
  for (const c of candidates) {
    if (c.history === null && c.house === "S" && c.kind !== null && isUrgencyClauseMotion(c.motionText)) inc(result.urgencyClauseOutside, c.group);
  }

  // Matches are read before any kind is written, so the outcome does not depend on the order.
  const matches = new Map<HistoryCandidate, PassageKind | null>();
  for (const c of candidates) if (c.history !== null && !c.excluded) matches.set(c, matchOf(c));
  const matched = (c: HistoryCandidate): PassageKind | null => (matches.has(c) ? (matches.get(c) as PassageKind | null) : matchOf(c));

  // Another roll call of the bill, house, date and tally that counts on its own: one outside the history-decided
  // locations with a kind, or one the history matched.
  const countedElsewhere = (c: HistoryCandidate): boolean =>
    (sameDay.get(`${c.billId}|${c.house}|${c.date}`) ?? []).some(
      (o) => o !== c && !o.excluded && !o.reconsideration && o.ayes === c.ayes && o.noes === c.noes && (o.history === null ? o.kind !== null : matched(o) !== null),
    );

  for (const c of candidates) {
    if (c.history === null || c.excluded) continue;
    let kind: VoteKind | null;
    let reason: ExclusionReason | null = null;
    const m = matches.get(c) ?? null;
    const duplicateOfAnother =
      c.house === "S" &&
      isUrgencyClauseMotion(c.motionText) &&
      (sameDay.get(`${c.billId}|${c.house}|${c.date}`) ?? []).some(
        (o) => o !== c && !o.excluded && !o.reconsideration && !isUrgencyClauseMotion(o.motionText) && matched(o) !== null,
      );
    if (duplicateOfAnother) {
      kind = null;
      reason = "urgency-clause";
    } else if (c.history === "required") {
      kind = m;
      if (kind === null) {
        reason = "no-history-match";
        result.noMatch.push({ group: c.group, id: c.key, motionText: c.motionText, ayes: c.ayes, noes: c.noes, keptAs: null });
      }
    } else if (c.history === "optional") {
      kind = c.reconsideration && countedElsewhere(c) ? null : m;
      if (kind === null) reason = c.noMatchReason ?? "location";
      else {
        const a = index.find(c.billId, c.house, c.date, c.ayes, c.noes)[0] as FloorAction;
        result.upgrades.push({
          group: c.group,
          id: c.key,
          billId: c.billId,
          house: c.house,
          date: c.date,
          fileLocation: c.fileLocation,
          motionText: c.motionText,
          ayes: c.ayes,
          noes: c.noes,
          kind,
          wouldBeExcludedAs: c.noMatchReason ?? "location",
          historyLine: a.row.action,
          billHistoryId: a.row.historyId,
        });
      }
    } else {
      kind = m === "concurrence" ? "concurrence" : "consent";
      if (m === null) result.noMatch.push({ group: c.group, id: c.key, motionText: c.motionText, ayes: c.ayes, noes: c.noes, keptAs: "consent" });
      if (kind === "concurrence") inc(result.consentBecameConcurrence, c.group);
    }
    c.kind = kind;
    inc((result.groups[c.group] ??= {}), kind ?? (reason as string));
    if (reason) inc(result.excludedByReason, reason);
    if (c.history === "required") {
      result.decisions.push({ group: c.group, billId: c.billId, house: c.house, date: c.date, ayes: c.ayes, noes: c.noes, motionText: c.motionText, kind, reason, historyLine: index.find(c.billId, c.house, c.date, c.ayes, c.noes)[0]?.row.action ?? null });
    }
  }
  return result;
}
