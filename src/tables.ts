import { parseDat, req, type Cell } from "./dat.ts";
import type { SourceReader } from "./reader.ts";

export interface BillRow {
  billId: string;
  sessionYear: string;
  sessionNum: string;
  measureType: string;
  measureNum: number;
  chapterYear: string | null;
  chapterType: string | null;
  chapterNum: string | null;
  latestVersionId: string | null;
  currentHouse: string | null;
  currentStatus: string | null;
}

export interface VersionRow {
  versionId: string;
  billId: string;
  versionNum: number;
  date: string; // YYYY-MM-DD
  action: string;
  subject: string | null;
  lob: string | null;
}

export interface AuthorRow {
  versionId: string;
  type: string;
  name: string | null;
  contribution: string | null;
}

export interface HistoryRow {
  billId: string;
  historyId: string;
  date: string; // YYYY-MM-DD
  action: string;
  sequence: number;
  status: string | null;
  primaryLocation: string | null;
  /** BILL_HISTORY_TBL.secondary_location, e.g. "Committee". */
  secondaryLocation: string | null;
  /** BILL_HISTORY_TBL.ternary_location: a LOCATION_CODE_TBL code (e.g. "CX24") on committee actions. */
  ternaryLocation: string | null;
}

export interface SummaryVoteRow {
  billId: string;
  locationCode: string;
  voteDateTime: string; // verbatim "YYYY-MM-DD HH:MM:SS"
  voteDateSeq: string; // verbatim
  motionId: string; // verbatim
  ayes: number;
  noes: number;
  abstain: number;
  result: string; // verbatim, e.g. "(PASS)"
  fileLocation: string | null;
}

/** Member rows of one roll call, in file order. */
export interface DetailVotes {
  names: string[];
  codes: string[];
}

export interface AnalysisRow {
  analysisId: string;
  billId: string;
  house: string;
  type: string;
  committeeName: string;
  analysisDateTime: string; // verbatim
  lob: string;
}

export interface HearingRow {
  billId: string;
  date: string; // YYYY-MM-DD
  locationCode: string;
}

export interface LegislatorRow {
  district: string;
  sessionYear: string | null;
  legislatorName: string | null;
  house: string;
  authorName: string | null;
  firstName: string | null;
  lastName: string | null;
  party: string | null;
  activeLegislator: string | null;
}

export interface LocationRow {
  sessionYear: string | null;
  code: string;
  type: string;
  description: string | null;
  longDescription: string | null;
}

export interface SourceTables {
  session: string;
  bills: BillRow[];
  versions: VersionRow[];
  authors: AuthorRow[];
  history: HistoryRow[];
  motions: Map<string, string>;
  summaryVotes: SummaryVoteRow[];
  detailVotes: Map<string, DetailVotes>;
  analyses: AnalysisRow[];
  hearings: HearingRow[];
  legislators: LegislatorRow[];
  locations: LocationRow[];
  /** Raw row counts for all tables of the session (all measure types). */
  counts: { bills: number; versions: number; rollCalls: number; memberVotes: number; analyses: number };
}

export function rollCallKey(
  billId: string,
  locationCode: string,
  voteDateTime: string,
  voteDateSeq: string,
  motionId: string,
): string {
  return `${billId}|${locationCode}|${voteDateTime}|${voteDateSeq}|${motionId}`;
}

const datePart = (s: string): string => s.slice(0, 10);
const num = (s: string, what: string): number => {
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`${what}: not a number: ${s}`);
  return v;
};

async function each(
  reader: SourceReader,
  name: string,
  minCols: number,
  fn: (c: Cell[], rowNumber: number) => void,
): Promise<void> {
  if (!reader.has(name)) throw new Error(`source is missing ${name}`);
  const text = await reader.readText(name);
  parseDat(text, (cells, span) => {
    if (cells.length < minCols) {
      throw new Error(`${name}: row ${span.row} has ${cells.length} columns, expected at least ${minCols}`);
    }
    fn(cells, span.row);
  });
}

export async function loadTables(reader: SourceReader, session: string): Promise<SourceTables> {
  const bills: BillRow[] = [];
  await each(reader, "BILL_TBL.dat", 19, (c, r) => {
    if (c[1] !== session) return;
    bills.push({
      billId: req(c, 0, "BILL_TBL", r),
      sessionYear: req(c, 1, "BILL_TBL", r),
      sessionNum: req(c, 2, "BILL_TBL", r),
      measureType: req(c, 3, "BILL_TBL", r),
      measureNum: num(req(c, 4, "BILL_TBL", r), "BILL_TBL.measure_num"),
      chapterYear: c[6] ?? null,
      chapterType: c[7] ?? null,
      chapterNum: c[9] ?? null,
      latestVersionId: c[10] ?? null,
      currentHouse: c[16] ?? null,
      currentStatus: c[17] ?? null,
    });
  });
  const billIds = new Set(bills.map((b) => b.billId));

  const versions: VersionRow[] = [];
  await each(reader, "BILL_VERSION_TBL.dat", 15, (c, r) => {
    const billId = req(c, 1, "BILL_VERSION_TBL", r);
    if (!billIds.has(billId)) return;
    versions.push({
      versionId: req(c, 0, "BILL_VERSION_TBL", r),
      billId,
      versionNum: num(req(c, 2, "BILL_VERSION_TBL", r), "BILL_VERSION_TBL.version_num"),
      date: datePart(req(c, 3, "BILL_VERSION_TBL", r)),
      action: req(c, 4, "BILL_VERSION_TBL", r),
      subject: c[6] ?? null,
      lob: c[14] ?? null,
    });
  });
  const versionIds = new Set(versions.map((v) => v.versionId));

  const authors: AuthorRow[] = [];
  await each(reader, "BILL_VERSION_AUTHORS_TBL.dat", 5, (c, r) => {
    const versionId = req(c, 0, "BILL_VERSION_AUTHORS_TBL", r);
    if (!versionIds.has(versionId)) return;
    authors.push({
      versionId,
      type: req(c, 1, "BILL_VERSION_AUTHORS_TBL", r),
      name: c[3] ?? null,
      contribution: c[4] ?? null,
    });
  });

  const history: HistoryRow[] = [];
  await each(reader, "BILL_HISTORY_TBL.dat", 13, (c, r) => {
    const billId = c[0];
    if (billId === null || billId === undefined || !billIds.has(billId)) return;
    history.push({
      billId,
      historyId: req(c, 1, "BILL_HISTORY_TBL", r),
      date: datePart(req(c, 2, "BILL_HISTORY_TBL", r)),
      action: c[3] ?? "",
      sequence: c[6] === null || c[6] === undefined ? 0 : num(c[6], "BILL_HISTORY_TBL.action_sequence"),
      status: c[8] ?? null,
      primaryLocation: c[9] ?? null,
      secondaryLocation: c[10] ?? null,
      ternaryLocation: c[11] ?? null,
    });
  });

  const motions = new Map<string, string>();
  await each(reader, "BILL_MOTION_TBL.dat", 2, (c, r) => {
    motions.set(req(c, 0, "BILL_MOTION_TBL", r), c[1] ?? "");
  });

  const summaryVotes: SummaryVoteRow[] = [];
  await each(reader, "BILL_SUMMARY_VOTE_TBL.dat", 13, (c, r) => {
    const billId = req(c, 0, "BILL_SUMMARY_VOTE_TBL", r);
    if (!billIds.has(billId)) return;
    summaryVotes.push({
      billId,
      locationCode: req(c, 1, "BILL_SUMMARY_VOTE_TBL", r),
      voteDateTime: req(c, 2, "BILL_SUMMARY_VOTE_TBL", r),
      voteDateSeq: req(c, 3, "BILL_SUMMARY_VOTE_TBL", r),
      motionId: req(c, 4, "BILL_SUMMARY_VOTE_TBL", r),
      ayes: num(c[5] ?? "0", "BILL_SUMMARY_VOTE_TBL.ayes"),
      noes: num(c[6] ?? "0", "BILL_SUMMARY_VOTE_TBL.noes"),
      abstain: num(c[7] ?? "0", "BILL_SUMMARY_VOTE_TBL.abstain"),
      result: c[8] ?? "",
      fileLocation: c[12] ?? null,
    });
  });

  const detailVotes = new Map<string, DetailVotes>();
  let memberVotes = 0;
  await each(reader, "BILL_DETAIL_VOTE_TBL.dat", 7, (c, r) => {
    const billId = req(c, 0, "BILL_DETAIL_VOTE_TBL", r);
    if (!billIds.has(billId)) return;
    memberVotes += 1;
    const key = rollCallKey(
      billId,
      req(c, 1, "BILL_DETAIL_VOTE_TBL", r),
      req(c, 3, "BILL_DETAIL_VOTE_TBL", r),
      req(c, 4, "BILL_DETAIL_VOTE_TBL", r),
      req(c, 6, "BILL_DETAIL_VOTE_TBL", r),
    );
    let d = detailVotes.get(key);
    if (!d) {
      d = { names: [], codes: [] };
      detailVotes.set(key, d);
    }
    d.names.push(req(c, 2, "BILL_DETAIL_VOTE_TBL", r));
    d.codes.push(c[5] ?? "");
  });

  const analyses: AnalysisRow[] = [];
  await each(reader, "BILL_ANALYSIS_TBL.dat", 11, (c, r) => {
    const billId = req(c, 1, "BILL_ANALYSIS_TBL", r);
    if (!billIds.has(billId)) return;
    analyses.push({
      analysisId: req(c, 0, "BILL_ANALYSIS_TBL", r),
      billId,
      house: c[2] ?? "",
      type: c[3] ?? "",
      committeeName: c[5] ?? "",
      analysisDateTime: c[7] ?? "",
      lob: req(c, 10, "BILL_ANALYSIS_TBL", r),
    });
  });

  const hearings: HearingRow[] = [];
  await each(reader, "COMMITTEE_HEARING_TBL.dat", 5, (c) => {
    const billId = c[0];
    if (billId === null || billId === undefined || !billIds.has(billId)) return;
    if (c[3] === null || c[3] === undefined || c[4] === null || c[4] === undefined) return;
    hearings.push({ billId, date: datePart(c[3]), locationCode: c[4] });
  });

  const legislators: LegislatorRow[] = [];
  await each(reader, "LEGISLATOR_TBL.dat", 16, (c, r) => {
    if (c[1] !== session) return;
    legislators.push({
      district: req(c, 0, "LEGISLATOR_TBL", r),
      sessionYear: c[1] ?? null,
      legislatorName: c[2] ?? null,
      house: c[3] ?? "",
      authorName: c[4] ?? null,
      firstName: c[5] ?? null,
      lastName: c[6] ?? null,
      party: c[11] ?? null,
      activeLegislator: c[15] ?? null,
    });
  });

  const locations: LocationRow[] = [];
  await each(reader, "LOCATION_CODE_TBL.dat", 6, (c, r) => {
    locations.push({
      sessionYear: c[0] ?? null,
      code: req(c, 1, "LOCATION_CODE_TBL", r),
      type: c[2] ?? "",
      description: c[4] ?? null,
      longDescription: c[5] ?? null,
    });
  });

  return {
    session,
    bills,
    versions,
    authors,
    history,
    motions,
    summaryVotes,
    detailVotes,
    analyses,
    hearings,
    legislators,
    locations,
    counts: {
      bills: bills.length,
      versions: versions.length,
      rollCalls: summaryVotes.length,
      memberVotes,
      analyses: analyses.length,
    },
  };
}
