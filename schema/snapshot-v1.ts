/**
 * Snapshot schema, version 1. This file is the contract between the ingest job (this repo)
 * and the apps (which vendor a pinned copy). Change it only with a schemaVersion bump or a
 * strictly additive optional field.
 *
 * Conventions
 * - Every id that comes from the official bulk files is copied verbatim (bill_id,
 *   bill_version_id, analysis_id, location codes). Nothing is invented.
 * - Dates are "YYYY-MM-DD". Times are "HH:MM:SS" or null when the source has none.
 * - Timestamps we generate are ISO 8601 UTC.
 * - Every displayed record carries `src`. The build fails if one is missing.
 */

export const SCHEMA_VERSION = 1 as const;

/** "20252026" */
export type SessionId = string;
/** pubinfo bill_id, e.g. "202520260AB550" (session year + session number + type + number). */
export type BillId = string;
/** pubinfo bill_version_id, e.g. "20250AB55096AMD". */
export type VersionId = string;
/** Stable person id from tables/people-<session>.json, e.g. "ca-a-petrie-norris". */
export type PersonId = string;
export type House = "A" | "S";
export type MeasureType = "AB" | "SB" | "ACA" | "SCA";

export interface FileRef {
  /** Path relative to the directory holding latest.json. Contains the content hash. */
  path: string;
  /** Lowercase hex SHA-256 of the uncompressed file bytes. */
  sha256: string;
  bytes: number;
}

export interface SourceFile {
  session: SessionId;
  /** e.g. "pubinfo_daily_Sun.zip" or "pubinfo_2025.zip" */
  file: string;
  /** HTTP Last-Modified of the source file, ISO 8601 UTC. This is the "Data as of" date. */
  sourceFileDate: string;
  etag: string | null;
}

export interface SessionCounts {
  session: SessionId;
  /** Raw counts in the source for this session (all measure types), used by the fail-closed check. */
  bills: number;
  versions: number;
  rollCalls: number;
  memberVotes: number;
  analyses: number;
}

/** latest.json and manifests/<snapshotId>.json */
export interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION;
  /** e.g. "20261122T122333Z-1a2b3c4d" (latest sourceFileDate + first 8 hex of the core hash). */
  snapshotId: string;
  generatedAt: string;
  /** Apps older than this must ask the user to update. Semver. */
  minAppVersion: string;
  sources: SourceFile[];
  counts: SessionCounts[];
  files: {
    core: FileRef;
    votes: FileRef;
    digests: FileRef;
    /** One entry per shard key. */
    analysis: Array<FileRef & { shard: string }>;
  };
  /** Older snapshot ids still published, newest first. */
  previous: string[];
}

// ---------------------------------------------------------------- core

export interface Session {
  id: SessionId;
  /** "2025–26" */
  label: string;
  /** "ended" once the constitutional end date has passed relative to the newest sourceFileDate. */
  status: "current" | "ended";
  /** "2026-11-30" */
  endDate: string;
}

export interface Issue {
  /** Stable id stored in user profiles. Never reused or renamed. */
  id: string;
  /** Stable small integer (1..63) used by the portable profile code. Never reused. */
  n: number;
  name: string;
}

export interface Committee {
  session: SessionId;
  /** pubinfo location_code, e.g. "CX03" */
  code: string;
  house: House;
  name: string;
  /** null for fiscal and procedural committees. */
  issueId: string | null;
}

export interface PersonTerm {
  session: SessionId;
  house: House;
  /** "AD73" / "SD02" as in LEGISLATOR_TBL.district */
  district: string;
  /** The exact strings this person appears under in vote rows. */
  voteNames: string[];
  /** "Cottie Petrie-Norris" (first + last from LEGISLATOR_TBL) */
  displayName: string;
  /** "Democratic" | "Republican" | other text as mapped from the source code; null if absent. */
  party: string | null;
  /** LEGISLATOR_TBL.active_legislator === "Y" */
  seated: boolean;
  src: { table: "LEGISLATOR_TBL"; district: string; legislatorName: string };
}

export interface Person {
  id: PersonId;
  terms: PersonTerm[];
}

export type Stage =
  | "floor" // 1: on a floor calendar / in floor process
  | "passed_house" // 2: passed its first chamber (or both, awaiting the Governor)
  | "cleared_committee" // 3
  | "hearing_scheduled" // 4
  | "introduced" // 5: introduced, pending referral, at the desk, or in committee with nothing scheduled
  | "finished"; // 6

export type Outcome = "chaptered" | "vetoed" | "failed" | "died" | "session_ended";

export interface BillVersionRef {
  id: VersionId;
  /** pubinfo version_num (counts down from 99). */
  num: number;
  date: string;
  /** "Introduced" | "Amended Assembly" | "Amended Senate" | "Enrolled" | "Chaptered" */
  action: string;
}

export interface Bill {
  id: BillId;
  session: SessionId;
  /** "0" regular session, "1".. extraordinary sessions. */
  sessionNum: string;
  type: MeasureType;
  num: number;
  /** "AB 550", or "SB 3 (1st Ex. Session)" when sessionNum !== "0". */
  label: string;
  /** BILL_VERSION_TBL.subject of the latest version, verbatim. */
  title: string;
  /** Lead author names, verbatim from BILL_VERSION_AUTHORS_TBL for the latest version. */
  leadAuthors: string[];
  house: House;
  /** BILL_TBL.current_status verbatim. */
  status: string;
  stage: Stage;
  /** 1..6, lower sorts first. */
  stageRank: number;
  /** Set only when stage === "finished". */
  outcome: Outcome | null;
  /** "Chapter 87, Statutes of 2026" when chaptered, else null. */
  chapter: string | null;
  lastActionDate: string | null;
  /** Latest BILL_HISTORY_TBL.action text, verbatim. */
  lastAction: string | null;
  /** Earliest hearing date on or after the newest sourceFileDate, else null. */
  nextHearing: string | null;
  /** Committee location codes the bill was heard in or referred to, in order of first appearance. */
  committees: string[];
  /** Deduplicated issue ids derived from `committees`. May be empty. */
  issueIds: string[];
  /** Oldest first. */
  versions: BillVersionRef[];
  latestVersionId: VersionId;
  hasDigest: boolean;
  /** Shard key holding this bill's analysis, or null if no analysis is on file. */
  analysisShard: string | null;
  src: { table: "BILL_TBL"; billId: BillId };
}

export interface CoreFile {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  sessions: Session[];
  issues: Issue[];
  committees: Committee[];
  people: Person[];
  bills: Bill[];
}

// ---------------------------------------------------------------- votes

export type VoteKind = "third_reading" | "consent" | "concurrence";
/** "A" aye, "N" no, "X" no vote recorded (source code ABS), "-" not on this roll call. */
export type VoteCode = "A" | "N" | "X" | "-";

export interface RollCall {
  /** `${billId}|${locationCode}|${voteDateTime}|${voteDateSeq}|${motionId}`: the source key, unique. */
  id: string;
  billId: BillId;
  house: House;
  date: string;
  time: string | null;
  kind: VoteKind;
  /** BILL_SUMMARY_VOTE_TBL.file_location verbatim; null when the source row has none. */
  fileLocation: string | null;
  /** BILL_MOTION_TBL.motion_text verbatim. */
  motionText: string;
  /** Official tallies from the summary row. */
  ayes: number;
  noes: number;
  noVoteRecorded: number;
  result: "PASS" | "FAIL";
  /** True when the member rows reproduce the official ayes and noes. */
  tallyMatches: boolean;
  /** Version this vote was on, by the inference rule in the spec (section 2.1). */
  versionId: VersionId;
  /** True when a same-day version made the choice ambiguous. */
  versionInferred: boolean;
  /**
   * True for the roll calls that count toward alignment: per bill and house, the last
   * third_reading/consent roll call and the last concurrence roll call.
   */
  final: boolean;
  /** One VoteCode per entry of rosters[`${session}-${house}`], same order. */
  v: string;
  src: {
    table: "BILL_SUMMARY_VOTE_TBL";
    billId: BillId;
    locationCode: string;
    voteDateTime: string;
    voteDateSeq: string;
    motionId: string;
  };
}

/** A passage recorded in the bill history with a tally but no member-level roll call in the source. */
export interface PassageWithoutRollCall {
  billId: BillId;
  house: House;
  date: string;
  /** BILL_HISTORY_TBL.action verbatim. */
  historyAction: string;
  src: { table: "BILL_HISTORY_TBL"; billId: BillId; billHistoryId: string };
}

export interface VotesFile {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  /** Key `${session}-${house}`; value is the ordered list of PersonId for that roster. */
  rosters: Record<string, PersonId[]>;
  rollCalls: RollCall[];
  noRollCall: PassageWithoutRollCall[];
}

// ---------------------------------------------------------------- text

export interface DigestEntry {
  versionId: VersionId;
  /** Legislative Counsel's Digest of that version, verbatim, paragraphs separated by "\n\n". */
  text: string;
  src: { table: "BILL_VERSION_TBL"; billVersionId: VersionId };
}

export interface DigestsFile {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  digests: Record<BillId, DigestEntry>;
}

export interface AnalysisEntry {
  /** BILL_ANALYSIS_TBL.analysis_id */
  analysisId: string;
  house: House;
  /** BILL_ANALYSIS_TBL.analysis_type verbatim, e.g. "FLOOR", "CMTE". */
  type: string;
  /** BILL_ANALYSIS_TBL.committee_name verbatim. */
  committee: string;
  date: string;
  /** Whole analysis text, verbatim, one paragraph per line. */
  text: string;
  /**
   * Parsed sections. Each is null unless the parser found the heading unambiguously.
   * Nothing here is ever written by us: every string is a verbatim slice of `text`.
   */
  digest: string | null;
  support: string[] | null;
  opposition: string[] | null;
  /** "(Verified 8/13/26)" style date as "YYYY-MM-DD", when present. */
  positionsVerified: string | null;
  argumentsInSupport: string | null;
  argumentsInOpposition: string | null;
  src: { table: "BILL_ANALYSIS_TBL"; analysisId: string };
}

export interface AnalysisShardFile {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  shard: string;
  analyses: Record<BillId, AnalysisEntry>;
}

/** Shard key for a bill: session, session number, type and hundreds bucket. e.g. "20252026-0-AB-05". */
export function analysisShardKey(b: { session: SessionId; sessionNum: string; type: string; num: number }): string {
  return `${b.session}-${b.sessionNum}-${b.type}-${String(Math.floor(b.num / 100)).padStart(2, "0")}`;
}
