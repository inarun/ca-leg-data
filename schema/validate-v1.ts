/**
 * Runtime validators for snapshot schema v1. They mirror schema/snapshot-v1.ts field for field;
 * the type assertions at the bottom stop compiling if the two drift apart. Unknown keys are
 * rejected, and every record that the contract says carries `src` requires it.
 */
import { z } from "zod";
import type {
  AnalysisShardFile,
  CoreFile,
  DigestsFile,
  Manifest,
  VotesFile,
} from "./snapshot-v1.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const time = z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "expected HH:MM:SS");
const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "expected ISO 8601 UTC");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase hex SHA-256");
const nonEmpty = z.string().min(1);
const nat = z.number().int().nonnegative();
const house = z.enum(["A", "S"]);
const schemaVersion = z.literal(1);

const fileRef = z.strictObject({ path: nonEmpty, sha256, bytes: nat });

const sourceFile = z.strictObject({
  session: nonEmpty,
  file: nonEmpty,
  sourceFileDate: isoUtc,
  etag: z.string().nullable(),
});

const sessionCounts = z.strictObject({
  session: nonEmpty,
  bills: nat,
  versions: nat,
  rollCalls: nat,
  memberVotes: nat,
  analyses: nat,
});

export const ManifestSchema = z.strictObject({
  schemaVersion,
  snapshotId: nonEmpty,
  generatedAt: isoUtc,
  minAppVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "expected semver"),
  sources: z.array(sourceFile),
  counts: z.array(sessionCounts),
  files: z.strictObject({
    core: fileRef,
    votes: fileRef,
    digests: fileRef,
    analysis: z.array(fileRef.extend({ shard: nonEmpty })),
  }),
  previous: z.array(nonEmpty),
});

// ---------------------------------------------------------------- core

const session = z.strictObject({
  id: nonEmpty,
  label: nonEmpty,
  status: z.enum(["current", "ended"]),
  endDate: date,
});

const issue = z.strictObject({
  id: nonEmpty,
  n: z.number().int().min(1).max(63),
  name: nonEmpty,
});

const committee = z.strictObject({
  session: nonEmpty,
  code: nonEmpty,
  house,
  name: nonEmpty,
  issueId: z.string().nullable(),
});

const personTerm = z.strictObject({
  session: nonEmpty,
  house,
  district: nonEmpty,
  voteNames: z.array(nonEmpty),
  displayName: nonEmpty,
  party: z.string().nullable(),
  seated: z.boolean(),
  src: z.strictObject({
    table: z.literal("LEGISLATOR_TBL"),
    district: nonEmpty,
    legislatorName: nonEmpty,
  }),
});

const person = z.strictObject({ id: nonEmpty, terms: z.array(personTerm) });

const stage = z.enum(["floor", "passed_house", "cleared_committee", "hearing_scheduled", "introduced", "finished"]);
const outcome = z.enum(["chaptered", "vetoed", "failed", "died", "session_ended"]);

const billVersionRef = z.strictObject({
  id: nonEmpty,
  num: z.number().int(),
  date,
  action: nonEmpty,
});

const bill = z.strictObject({
  id: nonEmpty,
  session: nonEmpty,
  sessionNum: nonEmpty,
  type: z.enum(["AB", "SB", "ACA", "SCA"]),
  num: z.number().int().positive(),
  label: nonEmpty,
  title: z.string(),
  leadAuthors: z.array(nonEmpty),
  house,
  status: z.string(),
  stage,
  stageRank: z.number().int().min(1).max(6),
  outcome: outcome.nullable(),
  chapter: z.string().nullable(),
  lastActionDate: date.nullable(),
  lastAction: z.string().nullable(),
  nextHearing: date.nullable(),
  committees: z.array(nonEmpty),
  issueIds: z.array(nonEmpty),
  versions: z.array(billVersionRef).min(1),
  latestVersionId: nonEmpty,
  hasDigest: z.boolean(),
  analysisShard: z.string().nullable(),
  src: z.strictObject({ table: z.literal("BILL_TBL"), billId: nonEmpty }),
});

export const CoreFileSchema = z.strictObject({
  schemaVersion,
  snapshotId: nonEmpty,
  sessions: z.array(session),
  issues: z.array(issue),
  committees: z.array(committee),
  people: z.array(person),
  bills: z.array(bill),
});

// ---------------------------------------------------------------- votes

const rollCall = z.strictObject({
  id: nonEmpty,
  billId: nonEmpty,
  house,
  date,
  time: time.nullable(),
  kind: z.enum(["third_reading", "consent", "concurrence"]),
  fileLocation: z.string().nullable(),
  motionText: z.string(),
  ayes: nat,
  noes: nat,
  noVoteRecorded: nat,
  result: z.enum(["PASS", "FAIL"]),
  tallyMatches: z.boolean(),
  versionId: nonEmpty,
  versionInferred: z.boolean(),
  final: z.boolean(),
  v: z.string().regex(/^[ANX-]*$/, "vote codes are A, N, X or -"),
  src: z.strictObject({
    table: z.literal("BILL_SUMMARY_VOTE_TBL"),
    billId: nonEmpty,
    locationCode: nonEmpty,
    voteDateTime: nonEmpty,
    voteDateSeq: nonEmpty,
    motionId: nonEmpty,
  }),
});

const passageWithoutRollCall = z.strictObject({
  billId: nonEmpty,
  house,
  date,
  historyAction: nonEmpty,
  src: z.strictObject({ table: z.literal("BILL_HISTORY_TBL"), billId: nonEmpty, billHistoryId: nonEmpty }),
});

export const VotesFileSchema = z.strictObject({
  schemaVersion,
  snapshotId: nonEmpty,
  rosters: z.record(z.string(), z.array(nonEmpty)),
  rollCalls: z.array(rollCall),
  noRollCall: z.array(passageWithoutRollCall),
});

// ---------------------------------------------------------------- text

const digestEntry = z.strictObject({
  versionId: nonEmpty,
  text: nonEmpty,
  src: z.strictObject({ table: z.literal("BILL_VERSION_TBL"), billVersionId: nonEmpty }),
});

export const DigestsFileSchema = z.strictObject({
  schemaVersion,
  snapshotId: nonEmpty,
  digests: z.record(z.string(), digestEntry),
});

const analysisEntry = z.strictObject({
  analysisId: nonEmpty,
  house,
  type: z.string(),
  committee: z.string(),
  date,
  text: z.string(),
  digest: z.string().nullable(),
  support: z.array(z.string()).nullable(),
  opposition: z.array(z.string()).nullable(),
  positionsVerified: date.nullable(),
  argumentsInSupport: z.string().nullable(),
  argumentsInOpposition: z.string().nullable(),
  src: z.strictObject({ table: z.literal("BILL_ANALYSIS_TBL"), analysisId: nonEmpty }),
});

export const AnalysisShardFileSchema = z.strictObject({
  schemaVersion,
  snapshotId: nonEmpty,
  shard: nonEmpty,
  analyses: z.record(z.string(), analysisEntry),
});

// ---------------------------------------------------------------- drift guards

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const typesMatch: [
  Mutual<z.infer<typeof ManifestSchema>, Manifest>,
  Mutual<z.infer<typeof CoreFileSchema>, CoreFile>,
  Mutual<z.infer<typeof VotesFileSchema>, VotesFile>,
  Mutual<z.infer<typeof DigestsFileSchema>, DigestsFile>,
  Mutual<z.infer<typeof AnalysisShardFileSchema>, AnalysisShardFile>,
] = [true, true, true, true, true];
void typesMatch;

export type SnapshotFileKind = "manifest" | "core" | "votes" | "digests" | "analysis";

export const SCHEMAS = {
  manifest: ManifestSchema,
  core: CoreFileSchema,
  votes: VotesFileSchema,
  digests: DigestsFileSchema,
  analysis: AnalysisShardFileSchema,
} as const;

/** Parses with the validator for `kind`; throws a readable error listing up to 10 issues. */
export function validateFile<K extends SnapshotFileKind>(kind: K, value: unknown, label = kind): z.infer<(typeof SCHEMAS)[K]> {
  const result = SCHEMAS[kind].safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`${label} fails schema validation:\n  ${issues.join("\n  ")}`);
  }
  return result.data as z.infer<(typeof SCHEMAS)[K]>;
}
