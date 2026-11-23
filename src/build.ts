import { join } from "node:path";
import {
  analysisShardKey,
  SCHEMA_VERSION,
  type AnalysisEntry,
  type AnalysisShardFile,
  type Bill,
  type BillVersionRef,
  type CoreFile,
  type DigestEntry,
  type DigestsFile,
  type House,
  type MeasureType,
  type PassageWithoutRollCall,
  type RollCall,
  type Session,
  type SessionCounts,
  type VoteKind,
  type VotesFile,
} from "../schema/snapshot-v1.ts";
import { parseAnalysisSections } from "./analysis.ts";
import {
  FloorClassifier,
  isAssemblyUrgencyMotion,
  loadFloorClassTable,
  normaliseFileLocation,
  type ExclusionReason,
} from "./classify.ts";
import { assertSourceNotEmpty, assertSourceReadable } from "./checks.ts";
import { applyHistoryRules, type HistoryUpgrade } from "./historyKinds.ts";
import { loadCommitteesTable, loadIssuesTable, resolveIssues } from "./issues.ts";
import { FloorActionIndex, historyPassage, parseTally, type PassageKind } from "./passages.ts";
import { loadPeopleTable, resolvePeople } from "./people.ts";
import { Rescissions } from "./rescind.ts";
import type { SourceReader } from "./reader.ts";
import { committeeHouse, computeStage, houseFromName, isClearingCommitteeVote, STAGE_RANK } from "./stage.ts";
import { loadTables, rollCallKey, type AnalysisRow, type BillRow, type HistoryRow, type SourceTables, type SummaryVoteRow } from "./tables.ts";
import { docxToText, extractDigest } from "./text.ts";
import { IngestError, compareNumericStrings, compareStrings, ordinal } from "./util.ts";
import { chooseVersionForVote, sameDayOrder, sortVersionsOldestFirst, type SameDayOrder } from "./versions.ts";

export const IN_SCOPE_TYPES: readonly MeasureType[] = ["AB", "SB", "ACA", "SCA"];
const TYPE_ORDER: Record<string, number> = { AB: 0, ACA: 1, SB: 2, SCA: 3 };

export interface BuildOptions {
  session: string;
  /** ISO 8601 UTC, the "Data as of" date of the source file. */
  sourceDate: string;
  /** Directory holding people-<session>.json, floor-vote-classification.json, issues.json, committees-<session>.json. */
  tablesDir: string;
  /** Fraction of source roll calls whose member rows must reproduce the official tallies. */
  tallyThreshold: number;
  /** Minimum members on a counted floor roll call. */
  minMembers: Record<House, number>;
}

export const DEFAULT_MIN_MEMBERS: Record<House, number> = { A: 75, S: 37 };
export const DEFAULT_TALLY_THRESHOLD = 0.999;

export interface BuildStats {
  counts: SessionCounts;
  inScopeBills: number;
  droppedBillsByType: Record<string, number>;
  floorRollCallsInSource: number;
  floorRollCallsInScope: number;
  emittedByKind: Record<string, number>;
  excludedByReason: Record<string, number>;
  finalRollCalls: number;
  versionInferred: number;
  urgency: { excludedAsDuplicate: number; keptAsOnlyVote: number; keptAsOnlyVoteSamples: string[]; excludedSamples: string[] };
  /** Roll calls in the history-decided locations (W/O REF. TO FILE and no file_location), each with its outcome. */
  historyDecisions: Array<{ group: string; billId: string; house: House; date: string; ayes: number; noes: number; motionText: string; kind: VoteKind | null; reason: string | null; historyLine: string | null }>;
  /** Per history-matched location group, the number of roll calls by resulting kind or exclusion reason. */
  historyGroups: Record<string, Record<string, number>>;
  /** Roll calls in a history-decided location that no history action matched. */
  noHistoryMatch: Array<{ group: string; id: string; motionText: string; ayes: number; noes: number; keptAs: VoteKind | null }>;
  /** Roll calls of the Senate consent locations that the bill history made concurrences. */
  consentBecameConcurrence: Record<string, number>;
  /** Senate roll calls in other locations whose motion text names the urgency clause (reported, not reclassified). */
  urgencyClauseOutsideHistoryGroups: Record<string, number>;
  tally: { total: number; matching: number; mismatching: Array<{ id: string; ayes: number; noes: number; memberAyes: number; memberNoes: number }> };
  memberCounts: { minAssembly: number | null; minSenate: number | null };
  noRollCall: PassageWithoutRollCall[];
  /** History passages with no final roll call of the matching kind, before the same-day tally match. */
  /**
   * History passages that have no counted roll call of their kind but for which the source holds a floor roll call
   * of the same bill, house, date and tally (excluded by a rule). They are not reported in `noRollCall`.
   */
  noRollCallNeedsLook: Array<{
    billId: string;
    house: House;
    kind: PassageKind;
    date: string;
    historyAction: string;
    billHistoryId: string;
    rollCalls: Array<{ id: string; group: string; fileLocation: string | null; kind: VoteKind | null; motionText: string }>;
  }>;
  /** Roll calls on a day that has a version of the bill: how the history orders the amendment and the passage. */
  sameDayVersionOrder: Record<string, number>;
  /** Roll calls whose version differs from what the previous-version rule alone would pick. */
  sameDayVersionChanged: Array<{ id: string; billId: string; house: House; date: string; from: string; to: string }>;
  /** Third-reading or consent roll calls that would be final but for a later rescission of the passage in that house. */
  rescindedFinals: Array<{
    id: string;
    billId: string;
    house: House;
    kind: VoteKind;
    date: string;
    ayes: number;
    noes: number;
    rescindedOn: string;
    historyAction: string;
    billHistoryId: string;
  }>;
  /** Second-reading roll calls counted as third reading or concurrence because a history action has the same tally. */
  secondReadingUpgrades: HistoryUpgrade[];
  /** Roll calls filed under a motion to reconsider, counted because a history passage has the same bill, house, date and tally. */
  reconsiderationUpgrades: HistoryUpgrade[];
  analyses: {
    billsWithAnalysis: number;
    unreadableLatest: number;
    fellBackToEarlier: number;
    withDigest: number;
    withSupport: number;
    withSupportEmpty: number;
    withOpposition: number;
    withOppositionEmpty: number;
    withPositionsVerified: number;
    withArgumentsInSupport: number;
    withArgumentsInOpposition: number;
  };
  digests: { billsWithDigest: number; billsWithoutDigest: number };
  stages: Record<string, number>;
  outcomes: Record<string, number>;
  stageDifferencesIfEveryPassingCommitteeVoteCounted: number;
  nullFileLocationRollCalls: number;
  /** Committee referrals in the bill history and how many resolved to a committee code from the row's own location fields. */
  referrals: {
    rows: number;
    resolved: number;
    unresolved: number;
    unresolvedStrings: string[];
    multiCommitteeRows: number;
    /** Committees named after the first one in "Referred to Coms. on A and B"; the row carries a single code. */
    multiCommitteeExtraNames: string[];
    billsWithReferralCommittee: number;
    billsWithOnlyReferralCommittees: number;
    billsWithNoCommittee: number;
  };
}

export interface BuiltSnapshot {
  /** snapshotId is "" until the files are sealed (see seal in output.ts). */
  core: CoreFile;
  votes: VotesFile;
  digests: DigestsFile;
  analysisShards: AnalysisShardFile[];
  session: string;
  sourceDate: string;
  counts: SessionCounts;
  stats: BuildStats;
}

const inc = (m: Record<string, number>, k: string, by = 1): void => {
  m[k] = (m[k] ?? 0) + by;
};

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

function sessionEndDate(session: string): string {
  return `${session.slice(4, 8)}-11-30`;
}

function sessionLabel(session: string): string {
  return `${session.slice(0, 4)}–${session.slice(6, 8)}`;
}

interface Candidate {
  row: SummaryVoteRow;
  house: House;
  billId: string;
  date: string;
  time: string | null;
  seq: number;
  motionText: string;
  kind: VoteKind | null;
  urgency: boolean;
  key: string;
  /** Location rule that needs the bill history, else null. */
  history: "required" | "refine" | "optional" | null;
  /** Report label of the history-decided location, e.g. "S W/O REF. TO FILE". */
  group: string;
  fileLocation: string | null;
  /** Excluded by its motion text or location, before any history rule. */
  excluded: boolean;
  noMatchReason?: ExclusionReason;
  reconsideration: boolean;
  ayes: number;
  noes: number;
}

const compareCandidates = (a: Candidate, b: Candidate): number =>
  compareStrings(a.date, b.date) || compareStrings(a.time ?? "", b.time ?? "") || a.seq - b.seq || compareStrings(a.key, b.key);

const REFERRAL = /referred to Coms?\./i;
const REFERRAL_MULTI_ROW = /referred to Coms\./i;
const MULTI_REFERRAL = /referred to Coms\.\s+on\s+(.+)$/i;

/** A committee referral still in force. Rescinding actions only mention the referral they undo. */
export function isReferral(h: HistoryRow): boolean {
  return h.status === "Applied" && REFERRAL.test(h.action) && !/^Action rescinded/i.test(h.action);
}

/** Names after the first in a multi-committee referral, e.g. ["JUD."] for "Referred to Coms. on  B. P. & E.D. and  JUD.". */
export function extraReferralNames(action: string): string[] {
  const m = MULTI_REFERRAL.exec(action);
  if (!m) return [];
  const names = (m[1] as string).replace(/\s+pursuant to .*$/i, "").split(/\s+and\s+/).map((x) => x.trim());
  return names.slice(1);
}

export async function buildSnapshot(reader: SourceReader, opts: BuildOptions): Promise<BuiltSnapshot> {
  const session = opts.session;
  const sourceDay = opts.sourceDate.slice(0, 10);
  const sessionEnded = sourceDay > sessionEndDate(session);
  const t = await loadTables(reader, session);

  const peopleTable = await loadPeopleTable(join(opts.tablesDir, `people-${session}.json`));
  const floorTable = await loadFloorClassTable(join(opts.tablesDir, "floor-vote-classification.json"));
  const issuesTable = await loadIssuesTable(join(opts.tablesDir, "issues.json"));
  const committeesTable = await loadCommitteesTable(join(opts.tablesDir, `committees-${session}.json`));

  const people = resolvePeople(session, peopleTable, t.legislators);
  const classifier = new FloorClassifier(floorTable);

  // A referral resolves to the committee code that the history row itself carries in
  // ternary_location, provided LOCATION_CODE_TBL has that code and it is a committee.
  const locationCodes = new Set(t.locations.map((l) => l.code));
  const referralCode = (h: HistoryRow): string | null =>
    h.ternaryLocation !== null && locationCodes.has(h.ternaryLocation) && committeeHouse(h.ternaryLocation) !== null ? h.ternaryLocation : null;
  const codesInUse = new Set<string>();
  for (const h of t.history) if (isReferral(h)) {
    const code = referralCode(h);
    if (code !== null) codesInUse.add(code);
  }
  for (const h of t.hearings) codesInUse.add(h.locationCode);
  for (const r of t.summaryVotes) if (committeeHouse(r.locationCode) !== null) codesInUse.add(r.locationCode);
  const issuesResolved = resolveIssues(session, issuesTable, committeesTable, t.locations, codesInUse);

  // ------------------------------------------------------------ scope
  const inScope = (b: BillRow): boolean => (IN_SCOPE_TYPES as readonly string[]).includes(b.measureType);
  const billRows = t.bills.filter(inScope).sort(
    (a, b) =>
      compareNumericStrings(a.sessionNum, b.sessionNum) ||
      (TYPE_ORDER[a.measureType] ?? 9) - (TYPE_ORDER[b.measureType] ?? 9) ||
      a.measureNum - b.measureNum,
  );
  const inScopeIds = new Set(billRows.map((b) => b.billId));
  const droppedBillsByType: Record<string, number> = {};
  for (const b of t.bills) if (!inScope(b)) inc(droppedBillsByType, b.measureType);
  assertSourceNotEmpty({ counts: { session, ...t.counts }, inScopeBills: billRows.length });

  const versionsByBill = new Map<string, BillVersionRef[]>();
  const versionRowsById = new Map<string, (typeof t.versions)[number]>();
  for (const v of t.versions) {
    versionRowsById.set(v.versionId, v);
    if (!inScopeIds.has(v.billId)) continue;
    const list = versionsByBill.get(v.billId) ?? [];
    list.push({ id: v.versionId, num: v.versionNum, date: v.date, action: v.action });
    versionsByBill.set(v.billId, list);
  }
  for (const [id, list] of versionsByBill) versionsByBill.set(id, sortVersionsOldestFirst(list));

  // ------------------------------------------------------------ floor roll calls
  const rosters = people.rosters;
  const rosterIndex: Record<House, Map<string, number>> = { A: new Map(), S: new Map() };
  for (const h of ["A", "S"] as House[]) rosters[h].forEach((id, i) => rosterIndex[h].set(id, i));

  const unclassified = new Set<string>();
  const floorRows = t.summaryVotes.filter((r) => r.locationCode === "AFLOOR" || r.locationCode === "SFLOOR");
  const candidates: Candidate[] = [];
  const excludedByReason: Record<string, number> = {};
  const floorActions = new FloorActionIndex(t.history);
  let nullFileLocation = 0;
  for (const r of floorRows) {
    const house: House = r.locationCode === "AFLOOR" ? "A" : "S";
    if (!classifier.has(house, r.fileLocation)) {
      unclassified.add(`${house} ${r.fileLocation === null ? "(NULL)" : JSON.stringify(r.fileLocation)}`);
      continue;
    }
    if (!inScopeIds.has(r.billId)) continue;
    const motionText = t.motions.get(r.motionId);
    if (motionText === undefined) throw new IngestError("motion", `roll call ${r.billId} ${r.voteDateTime} refers to unknown motion ${r.motionId}`);
    const c = classifier.classify(house, r.fileLocation, motionText);
    const time = r.voteDateTime.slice(11, 19);
    const cand: Candidate = {
      row: r,
      house,
      billId: r.billId,
      date: r.voteDateTime.slice(0, 10),
      time: time === "00:00:00" ? null : time,
      seq: Number(r.voteDateSeq),
      motionText,
      kind: c.kind,
      urgency: house === "A" && isAssemblyUrgencyMotion(motionText),
      key: rollCallKey(r.billId, r.locationCode, r.voteDateTime, r.voteDateSeq, r.motionId),
      history: c.history,
      group: `${house} ${r.fileLocation === null ? "(no file_location)" : normaliseFileLocation(r.fileLocation)}`,
      fileLocation: r.fileLocation,
      excluded: c.reason !== null,
      noMatchReason: c.noMatchReason,
      reconsideration: c.noMatchReason === "reconsideration",
      ayes: r.ayes,
      noes: r.noes,
    };
    candidates.push(cand);
    if (c.kind === null && c.reason) inc(excludedByReason, c.reason);
  }
  if (unclassified.size > 0) {
    throw new IngestError("floor-location", "floor file_location values missing from tables/floor-vote-classification.json", [...unclassified].sort(compareStrings));
  }

  // Roll calls in the history-decided locations are classified from the bill history (historyKinds.ts).
  const history = applyHistoryRules(candidates, floorActions);
  for (const [reason, n] of Object.entries(history.excludedByReason)) inc(excludedByReason, reason, n);
  const { groups: historyGroups, decisions: historyDecisions, noMatch: noHistoryMatch, consentBecameConcurrence, urgencyClauseOutside } = history;

  // Urgency: an Assembly "Third Reading Urgency" roll call is dropped when the same bill has an
  // ordinary third-reading roll call in that house on the same date; if it is the only one it counts.
  const urgency: BuildStats["urgency"] = { excludedAsDuplicate: 0, keptAsOnlyVote: 0, keptAsOnlyVoteSamples: [], excludedSamples: [] };
  const trByBillHouseDate = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.kind !== "third_reading") continue;
    const k = `${c.billId}|${c.house}|${c.date}`;
    const list = trByBillHouseDate.get(k) ?? [];
    list.push(c);
    trByBillHouseDate.set(k, list);
  }
  for (const c of candidates) {
    if (!c.urgency || c.kind !== "third_reading") continue;
    const same = trByBillHouseDate.get(`${c.billId}|${c.house}|${c.date}`) ?? [];
    if (same.some((o) => o !== c && !o.urgency)) {
      c.kind = null;
      urgency.excludedAsDuplicate += 1;
      inc(excludedByReason, "urgency-duplicate" satisfies ExclusionReason);
      if (urgency.excludedSamples.length < 10) urgency.excludedSamples.push(`${c.key} | ${c.motionText}`);
    } else {
      urgency.keptAsOnlyVote += 1;
      if (urgency.keptAsOnlyVoteSamples.length < 10) urgency.keptAsOnlyVoteSamples.push(`${c.key} | ${c.motionText}`);
    }
  }

  // final flags
  const finals = new Set<Candidate>();
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.kind === null) continue;
    const group = c.kind === "concurrence" ? "concurrence" : "passage";
    const k = `${c.billId}|${c.house}|${group}`;
    const list = groups.get(k) ?? [];
    list.push(c);
    groups.set(k, list);
  }
  // A passage later rescinded in its house, with no later passage roll call, is not final (rescind.ts).
  const rescissions = new Rescissions(t.history);
  const rescindedFinals: BuildStats["rescindedFinals"] = [];
  for (const [k, list] of groups) {
    const last = [...list].sort(compareCandidates).at(-1) as Candidate;
    if (!k.endsWith("|passage")) {
      finals.add(last);
      continue;
    }
    const by = rescissions.rescindedBy(last.billId, last.house, last.date, last.ayes, last.noes);
    if (by === null) finals.add(last);
    else {
      rescindedFinals.push({ id: last.key, billId: last.billId, house: last.house, kind: last.kind as VoteKind, date: last.date, ayes: last.ayes, noes: last.noes, rescindedOn: by.date, historyAction: by.action, billHistoryId: by.historyId });
    }
  }
  rescindedFinals.sort((a, b) => compareStrings(a.billId, b.billId) || compareStrings(a.house, b.house) || compareStrings(a.date, b.date));

  // ------------------------------------------------------------ emit roll calls
  const rollCalls: RollCall[] = [];
  const problems: string[] = [];
  const emittedByKind: Record<string, number> = {};
  let versionInferred = 0;
  const historyRowsByBill = new Map<string, HistoryRow[]>();
  for (const h of t.history) {
    if (!inScopeIds.has(h.billId)) continue;
    const list = historyRowsByBill.get(h.billId) ?? [];
    list.push(h);
    historyRowsByBill.set(h.billId, list);
  }
  const sameDayVersionOrder: Record<string, number> = {};
  const sameDayVersionChanged: BuildStats["sameDayVersionChanged"] = [];
  let minA: number | null = null;
  let minS: number | null = null;
  const unmappedNames = new Set<string>();
  for (const c of candidates) {
    if (c.kind === null) continue;
    const r = c.row;
    const detail = t.detailVotes.get(c.key);
    const members = detail ? detail.names.length : 0;
    if (c.house === "A") minA = minA === null ? members : Math.min(minA, members);
    else minS = minS === null ? members : Math.min(minS, members);
    if (members < opts.minMembers[c.house]) {
      problems.push(`${c.key} has ${members} member rows, fewer than ${opts.minMembers[c.house]} (${c.house})`);
      continue;
    }
    const d = detail as NonNullable<typeof detail>;
    const roster = rosters[c.house];
    const codes = new Array<string>(roster.length).fill("-");
    let ayes = 0;
    let noes = 0;
    d.names.forEach((name, i) => {
      const id = people.byVoteName.get(`${c.house}|${name}`);
      if (id === undefined) {
        unmappedNames.add(`${c.house} ${JSON.stringify(name)}`);
        return;
      }
      const idx = rosterIndex[c.house].get(id);
      if (idx === undefined) {
        problems.push(`${c.key}: ${id} is not on the ${c.house} roster`);
        return;
      }
      if (codes[idx] !== "-") problems.push(`${c.key}: ${id} appears twice`);
      const code = d.codes[i];
      if (code === "AYE") {
        codes[idx] = "A";
        ayes += 1;
      } else if (code === "NOE") {
        codes[idx] = "N";
        noes += 1;
      } else if (code === "ABS") {
        codes[idx] = "X";
      } else {
        problems.push(`${c.key}: unknown vote code ${JSON.stringify(code)}`);
      }
    });
    const refs = versionsByBill.get(c.billId);
    if (!refs) throw new IngestError("no-version", `${c.billId} has no versions`);
    // A version dated the day of the vote: the bill history may order its amendment before or after the passage.
    let order: SameDayOrder = "unknown";
    if (refs.some((v) => v.date === c.date && (v.action === "Introduced" || v.action.startsWith("Amended")))) {
      order = sameDayOrder(historyRowsByBill.get(c.billId) ?? [], floorActions.find(c.billId, c.house, c.date, r.ayes, r.noes), c.house === "A" ? "Assembly" : "Senate", c.date);
      inc(sameDayVersionOrder, order);
    }
    const plain = chooseVersionForVote(c.billId, refs, c.date);
    const chosen = chooseVersionForVote(c.billId, refs, c.date, order);
    if (chosen.versionId !== plain.versionId) sameDayVersionChanged.push({ id: c.key, billId: c.billId, house: c.house, date: c.date, from: plain.versionId, to: chosen.versionId });
    if (chosen.inferred) versionInferred += 1;
    const result = r.result === "(PASS)" ? "PASS" : r.result === "(FAIL)" ? "FAIL" : null;
    if (result === null) {
      problems.push(`${c.key}: unknown vote_result ${JSON.stringify(r.result)}`);
      continue;
    }
    const tallyMatches = ayes === r.ayes && noes === r.noes;
    if (r.fileLocation === null) nullFileLocation += 1;
    inc(emittedByKind, c.kind);
    rollCalls.push({
      id: c.key,
      billId: c.billId,
      house: c.house,
      date: c.date,
      time: c.time,
      kind: c.kind,
      fileLocation: r.fileLocation,
      motionText: c.motionText,
      ayes: r.ayes,
      noes: r.noes,
      noVoteRecorded: r.abstain,
      result,
      tallyMatches,
      versionId: chosen.versionId,
      versionInferred: chosen.inferred,
      final: finals.has(c),
      v: codes.join(""),
      src: {
        table: "BILL_SUMMARY_VOTE_TBL",
        billId: c.billId,
        locationCode: r.locationCode,
        voteDateTime: r.voteDateTime,
        voteDateSeq: r.voteDateSeq,
        motionId: r.motionId,
      },
    });
  }
  if (unmappedNames.size > 0) {
    throw new IngestError("vote-name", "vote names in counted floor roll calls are not in the people table", [...unmappedNames].sort(compareStrings));
  }
  if (problems.length > 0) throw new IngestError("roll-call", "floor roll calls failed checks", problems);
  rollCalls.sort(
    (a, b) =>
      compareStrings(a.billId, b.billId) ||
      compareStrings(a.date, b.date) ||
      compareStrings(a.time ?? "", b.time ?? "") ||
      compareNumericStrings(a.src.voteDateSeq, b.src.voteDateSeq) ||
      compareStrings(a.id, b.id),
  );

  // Tallies over every roll call in the source for the session (all measure types and locations).
  const tally: BuildStats["tally"] = { total: 0, matching: 0, mismatching: [] };
  for (const r of t.summaryVotes) {
    tally.total += 1;
    const d = t.detailVotes.get(rollCallKey(r.billId, r.locationCode, r.voteDateTime, r.voteDateSeq, r.motionId));
    let a = 0;
    let n = 0;
    if (d) for (const code of d.codes) (code === "AYE" ? a++ : code === "NOE" ? n++ : 0);
    if (d && a === r.ayes && n === r.noes) tally.matching += 1;
    else tally.mismatching.push({ id: rollCallKey(r.billId, r.locationCode, r.voteDateTime, r.voteDateSeq, r.motionId), ayes: r.ayes, noes: r.noes, memberAyes: a, memberNoes: n });
  }
  if (tally.total > 0 && tally.matching / tally.total < opts.tallyThreshold) {
    throw new IngestError(
      "tally",
      `only ${tally.matching} of ${tally.total} roll calls (${((100 * tally.matching) / tally.total).toFixed(3)}%) have member rows matching the official ayes and noes; the threshold is ${(opts.tallyThreshold * 100).toFixed(1)}%`,
      tally.mismatching.slice(0, 20).map((m) => `${m.id}: official ${m.ayes}-${m.noes}, members ${m.memberAyes}-${m.memberNoes}`),
    );
  }

  // ------------------------------------------------------------ bills
  const historyByBill = new Map<string, typeof t.history>();
  for (const h of t.history) {
    if (!inScopeIds.has(h.billId)) continue;
    const list = historyByBill.get(h.billId) ?? [];
    list.push(h);
    historyByBill.set(h.billId, list);
  }
  const hearingsByBill = new Map<string, typeof t.hearings>();
  for (const h of t.hearings) {
    if (!inScopeIds.has(h.billId)) continue;
    const list = hearingsByBill.get(h.billId) ?? [];
    list.push(h);
    hearingsByBill.set(h.billId, list);
  }
  const committeeVotesByBill = new Map<string, Array<{ row: SummaryVoteRow; motion: string }>>();
  for (const r of t.summaryVotes) {
    if (!inScopeIds.has(r.billId) || committeeHouse(r.locationCode) === null) continue;
    const list = committeeVotesByBill.get(r.billId) ?? [];
    list.push({ row: r, motion: t.motions.get(r.motionId) ?? "" });
    committeeVotesByBill.set(r.billId, list);
  }
  const authorsByVersion = new Map<string, string[]>();
  for (const a of t.authors) {
    if (a.contribution !== "LEAD_AUTHOR" || a.name === null) continue;
    const list = authorsByVersion.get(a.versionId) ?? [];
    if (!list.includes(a.name)) list.push(a.name);
    authorsByVersion.set(a.versionId, list);
  }

  const analysesByBill = new Map<string, AnalysisRow[]>();
  for (const a of t.analyses) {
    if (!inScopeIds.has(a.billId)) continue;
    const list = analysesByBill.get(a.billId) ?? [];
    list.push(a);
    analysesByBill.set(a.billId, list);
  }
  for (const list of analysesByBill.values()) {
    list.sort((x, y) => compareStrings(y.analysisDateTime, x.analysisDateTime) || compareNumericStrings(y.analysisId, x.analysisId));
  }

  const stageStats: Record<string, number> = {};
  const outcomeStats: Record<string, number> = {};
  let stageDiffs = 0;
  let billsWithReferralCommittee = 0;
  let billsWithOnlyReferralCommittees = 0;
  let billsWithNoCommittee = 0;
  const hearingVoteCodes = (billId: string): Set<string> => {
    const s = new Set<string>();
    for (const h of hearingsByBill.get(billId) ?? []) s.add(h.locationCode);
    for (const v of committeeVotesByBill.get(billId) ?? []) s.add(v.row.locationCode);
    return s;
  };
  const bills: Bill[] = [];
  for (const b of billRows) {
    const versions = versionsByBill.get(b.billId);
    if (!versions || versions.length === 0) throw new IngestError("no-version", `${b.billId} has no versions`);
    if (b.latestVersionId === null || !versions.some((v) => v.id === b.latestVersionId)) {
      throw new IngestError("latest-version", `${b.billId} latest_bill_version_id ${b.latestVersionId} is not one of its versions`);
    }
    if (b.currentStatus === null) throw new IngestError("status", `${b.billId} has no current_status`);
    const latestRow = versionRowsById.get(b.latestVersionId) as NonNullable<ReturnType<typeof versionRowsById.get>>;
    const origin: House = b.measureType === "AB" || b.measureType === "ACA" ? "A" : "S";
    const currentHouse = houseFromName(b.currentHouse);

    const hist = [...(historyByBill.get(b.billId) ?? [])].sort(
      (x, y) => compareStrings(x.date, y.date) || x.sequence - y.sequence || compareNumericStrings(x.historyId, y.historyId),
    );
    const last = hist.at(-1) ?? null;

    // First appearance across referral, hearing and committee vote, by date; on one date in that order.
    const events: Array<{ date: string; order: number; time: string; code: string }> = [];
    const referralCodes = new Set<string>();
    for (const h of hist) {
      if (!isReferral(h)) continue;
      const code = referralCode(h);
      if (code === null) continue;
      referralCodes.add(code);
      events.push({ date: h.date, order: -1, time: String(h.sequence).padStart(8, "0") + h.historyId.padStart(20, "0"), code });
    }
    for (const h of hearingsByBill.get(b.billId) ?? []) events.push({ date: h.date, order: 0, time: "", code: h.locationCode });
    const cvotes = committeeVotesByBill.get(b.billId) ?? [];
    for (const v of cvotes) events.push({ date: v.row.voteDateTime.slice(0, 10), order: 1, time: v.row.voteDateTime.slice(11, 19), code: v.row.locationCode });
    events.sort((x, y) => compareStrings(x.date, y.date) || x.order - y.order || compareStrings(x.time, y.time));
    const committees: string[] = [];
    for (const e of events) if (!committees.includes(e.code)) committees.push(e.code);
    if (referralCodes.size > 0) billsWithReferralCommittee += 1;
    if (committees.length === 0) billsWithNoCommittee += 1;
    else if (committees.every((c) => !hearingVoteCodes(b.billId).has(c))) billsWithOnlyReferralCommittees += 1;
    const issueIds: string[] = [];
    for (const code of committees) {
      const issueId = issuesResolved.issueByCommittee.get(code);
      if (issueId && !issueIds.includes(issueId)) issueIds.push(issueId);
    }

    const nextHearing =
      (hearingsByBill.get(b.billId) ?? [])
        .map((h) => h.date)
        .filter((d) => d >= sourceDay)
        .sort(compareStrings)[0] ?? null;

    const clears = (literal: boolean): boolean =>
      cvotes.some(
        (v) =>
          committeeHouse(v.row.locationCode) === currentHouse &&
          (literal ? v.row.result === "(PASS)" : isClearingCommitteeVote(v.row.result, v.motion)),
      );
    const base = {
      currentStatus: b.currentStatus,
      originHouse: origin,
      currentHouse,
      nextHearing,
      sessionEnded,
    };
    const { stage, outcome } = computeStage({ ...base, clearedCommitteeInCurrentHouse: clears(false) });
    if (computeStage({ ...base, clearedCommitteeInCurrentHouse: clears(true) }).stage !== stage) stageDiffs += 1;
    inc(stageStats, stage);
    if (outcome) inc(outcomeStats, outcome);

    const type = b.measureType as MeasureType;
    const label =
      b.sessionNum === "0"
        ? `${type} ${b.measureNum}`
        : `${type} ${b.measureNum} (${ordinal(Number(b.sessionNum))} Ex. Session)`;
    let chapter: string | null = null;
    if (b.currentStatus === "Chaptered" && b.chapterNum !== null && b.chapterYear !== null) {
      chapter = `${b.chapterType === "CHR" ? "Res. Chapter" : "Chapter"} ${b.chapterNum}, Statutes of ${b.chapterYear}`;
    }
    bills.push({
      id: b.billId,
      session,
      sessionNum: b.sessionNum,
      type,
      num: b.measureNum,
      label,
      title: latestRow.subject ?? "",
      leadAuthors: authorsByVersion.get(b.latestVersionId) ?? [],
      house: origin,
      status: b.currentStatus,
      stage,
      stageRank: STAGE_RANK[stage],
      outcome,
      chapter,
      lastActionDate: last ? last.date : null,
      lastAction: last ? last.action : null,
      nextHearing,
      committees,
      issueIds,
      versions,
      latestVersionId: b.latestVersionId,
      hasDigest: false,
      analysisShard: null,
      src: { table: "BILL_TBL", billId: b.billId },
    });
  }

  // ------------------------------------------------------------ digests
  const digests: Record<string, DigestEntry> = {};
  await mapPool(bills, 8, async (bill) => {
    const row = versionRowsById.get(bill.latestVersionId);
    if (!row || row.lob === null) return;
    const xml = await reader.readText(row.lob);
    const text = extractDigest(xml);
    if (text !== null) {
      digests[bill.id] = { versionId: bill.latestVersionId, text, src: { table: "BILL_VERSION_TBL", billVersionId: bill.latestVersionId } };
    }
  });
  for (const bill of bills) bill.hasDigest = digests[bill.id] !== undefined;

  // ------------------------------------------------------------ analyses
  const analysisStats: BuildStats["analyses"] = {
    billsWithAnalysis: 0,
    unreadableLatest: 0,
    fellBackToEarlier: 0,
    withDigest: 0,
    withSupport: 0,
    withSupportEmpty: 0,
    withOpposition: 0,
    withOppositionEmpty: 0,
    withPositionsVerified: 0,
    withArgumentsInSupport: 0,
    withArgumentsInOpposition: 0,
  };
  const entries = new Map<string, AnalysisEntry>();
  await mapPool(bills, 8, async (bill) => {
    const rows = analysesByBill.get(bill.id);
    if (!rows) return;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as AnalysisRow;
      let text: string;
      try {
        text = docxToText(await reader.read(row.lob));
      } catch {
        if (i === 0) analysisStats.unreadableLatest += 1;
        continue;
      }
      if (i > 0) analysisStats.fellBackToEarlier += 1;
      if (row.house !== "A" && row.house !== "S") {
        throw new IngestError("analysis-house", `analysis ${row.analysisId} has house ${JSON.stringify(row.house)}`);
      }
      const s = parseAnalysisSections(text);
      entries.set(bill.id, {
        analysisId: row.analysisId,
        house: row.house,
        type: row.type,
        committee: row.committeeName,
        date: row.analysisDateTime.slice(0, 10),
        text,
        ...s,
        src: { table: "BILL_ANALYSIS_TBL", analysisId: row.analysisId },
      });
      return;
    }
  });
  const shards = new Map<string, Record<string, AnalysisEntry>>();
  for (const bill of bills) {
    const entry = entries.get(bill.id);
    if (!entry) continue;
    const shard = analysisShardKey(bill);
    bill.analysisShard = shard;
    const map = shards.get(shard) ?? {};
    map[bill.id] = entry;
    shards.set(shard, map);
    analysisStats.billsWithAnalysis += 1;
    if (entry.digest !== null) analysisStats.withDigest += 1;
    if (entry.support !== null) (entry.support.length === 0 ? analysisStats.withSupportEmpty++ : analysisStats.withSupport++);
    if (entry.opposition !== null) (entry.opposition.length === 0 ? analysisStats.withOppositionEmpty++ : analysisStats.withOpposition++);
    if (entry.positionsVerified !== null) analysisStats.withPositionsVerified += 1;
    if (entry.argumentsInSupport !== null) analysisStats.withArgumentsInSupport += 1;
    if (entry.argumentsInOpposition !== null) analysisStats.withArgumentsInOpposition += 1;
  }
  const analysisShards: AnalysisShardFile[] = [...shards.keys()].sort(compareStrings).map((shard) => ({
    schemaVersion: SCHEMA_VERSION,
    snapshotId: "",
    shard,
    analyses: sortedRecord(shards.get(shard) as Record<string, AnalysisEntry>),
  }));

  assertSourceReadable({
    billsWithoutHistory: billRows.filter((b) => !historyByBill.has(b.billId)).map((b) => b.billId),
    analysisBills: analysesByBill.size,
    analysesRead: entries.size,
    unreadableLatest: analysisStats.unreadableLatest,
  });

  // ------------------------------------------------------------ passages without a roll call
  const finalByBillHouse = new Set<string>();
  for (const rc of rollCalls) {
    if (!rc.final) continue;
    finalByBillHouse.add(`${rc.billId}|${rc.house}|${rc.kind === "concurrence" ? "concurrence" : "third_reading"}`);
  }
  // A passage is reported when the bill has no counted (final) roll call of its kind in that house and
  // no floor roll call of that bill, house and date has the passage's official tally, counted or not.
  // The latter are not claimed to be missing; they go to the stats list for a human to look at.
  const tallyKeys = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = `${c.billId}|${c.house}|${c.date}|${c.row.ayes}|${c.row.noes}`;
    tallyKeys.set(k, [...(tallyKeys.get(k) ?? []), c]);
  }
  const noRollCallNeedsLook: BuildStats["noRollCallNeedsLook"] = [];
  const noRollCall: PassageWithoutRollCall[] = [];
  for (const [billId, hist] of historyByBill) {
    const lastBy = new Map<string, { kind: PassageKind; house: House; row: (typeof hist)[number] }>();
    for (const h of [...hist].sort(
      (x, y) => compareStrings(x.date, y.date) || x.sequence - y.sequence || compareNumericStrings(x.historyId, y.historyId),
    )) {
      const p = historyPassage(h);
      if (p) lastBy.set(`${p.house}|${p.kind}`, p);
    }
    for (const p of lastBy.values()) {
      if (finalByBillHouse.has(`${billId}|${p.house}|${p.kind}`)) continue;
      const tally = parseTally(p.row.action);
      const same = tally ? tallyKeys.get(`${billId}|${p.house}|${p.row.date}|${tally.ayes}|${tally.noes}`) : undefined;
      if (same) {
        noRollCallNeedsLook.push({
          billId,
          house: p.house,
          kind: p.kind,
          date: p.row.date,
          historyAction: p.row.action,
          billHistoryId: p.row.historyId,
          rollCalls: same.map((c) => ({ id: c.key, group: c.group, fileLocation: c.fileLocation, kind: c.kind, motionText: c.motionText })),
        });
        continue;
      }
      noRollCall.push({
        billId,
        house: p.house,
        date: p.row.date,
        historyAction: p.row.action,
        src: { table: "BILL_HISTORY_TBL", billId, billHistoryId: p.row.historyId },
      });
    }
  }
  noRollCall.sort((a, b) => compareStrings(a.billId, b.billId) || compareStrings(a.date, b.date) || compareStrings(a.house, b.house));

  // ------------------------------------------------------------ assemble
  const rosterRecord: Record<string, string[]> = {};
  for (const h of ["A", "S"] as House[]) if (rosters[h].length > 0) rosterRecord[`${session}-${h}`] = [...rosters[h]];

  const sessionRecord: Session = {
    id: session,
    label: sessionLabel(session),
    status: sessionEnded ? "ended" : "current",
    endDate: sessionEndDate(session),
  };
  const core: CoreFile = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: "",
    sessions: [sessionRecord],
    issues: issuesResolved.issues,
    committees: issuesResolved.committees,
    people: people.people,
    bills,
  };
  const votes: VotesFile = { schemaVersion: SCHEMA_VERSION, snapshotId: "", rosters: rosterRecord, rollCalls, noRollCall };
  const digestsFile: DigestsFile = { schemaVersion: SCHEMA_VERSION, snapshotId: "", digests: sortedRecord(digests) };
  const counts: SessionCounts = { session, ...t.counts };

  const referrals: BuildStats["referrals"] = {
    rows: 0,
    resolved: 0,
    unresolved: 0,
    unresolvedStrings: [],
    multiCommitteeRows: 0,
    multiCommitteeExtraNames: [],
    billsWithReferralCommittee,
    billsWithOnlyReferralCommittees,
    billsWithNoCommittee,
  };
  const unresolvedStrings = new Set<string>();
  const extraNames = new Set<string>();
  for (const h of t.history) {
    if (!inScopeIds.has(h.billId) || !isReferral(h)) continue;
    referrals.rows += 1;
    if (referralCode(h) !== null) referrals.resolved += 1;
    else {
      referrals.unresolved += 1;
      unresolvedStrings.add(h.action.replace(/\s+/g, " "));
    }
    const extra = extraReferralNames(h.action);
    if (REFERRAL_MULTI_ROW.test(h.action)) referrals.multiCommitteeRows += 1;
    for (const n of extra) extraNames.add(n);
  }
  referrals.unresolvedStrings = [...unresolvedStrings].sort(compareStrings);
  referrals.multiCommitteeExtraNames = [...extraNames].sort(compareStrings);

  const stats: BuildStats = {
    counts,
    inScopeBills: bills.length,
    droppedBillsByType,
    floorRollCallsInSource: floorRows.length,
    floorRollCallsInScope: candidates.length,
    emittedByKind,
    excludedByReason,
    finalRollCalls: rollCalls.filter((r) => r.final).length,
    versionInferred,
    urgency,
    historyDecisions,
    historyGroups,
    noHistoryMatch,
    consentBecameConcurrence,
    urgencyClauseOutsideHistoryGroups: urgencyClauseOutside,
    tally: { total: tally.total, matching: tally.matching, mismatching: tally.mismatching },
    memberCounts: { minAssembly: minA, minSenate: minS },
    noRollCall,
    noRollCallNeedsLook,
    rescindedFinals,
    sameDayVersionOrder,
    sameDayVersionChanged,
    secondReadingUpgrades: history.upgrades.filter((u) => u.wouldBeExcludedAs === "location"),
    reconsiderationUpgrades: history.upgrades.filter((u) => u.wouldBeExcludedAs === "reconsideration"),
    analyses: analysisStats,
    digests: { billsWithDigest: Object.keys(digests).length, billsWithoutDigest: bills.length - Object.keys(digests).length },
    stages: stageStats,
    outcomes: outcomeStats,
    stageDifferencesIfEveryPassingCommitteeVoteCounted: stageDiffs,
    nullFileLocationRollCalls: nullFileLocation,
    referrals,
  };
  return { core, votes, digests: digestsFile, analysisShards, session, sourceDate: opts.sourceDate, counts, stats };
}

export function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec).sort(compareStrings)) out[k] = rec[k] as T;
  return out;
}

export type { SourceTables };
