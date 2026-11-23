import { readFile } from "node:fs/promises";
import type { House, VoteKind } from "../schema/snapshot-v1.ts";
import { IngestError } from "./util.ts";

/**
 * One floor `file_location` value. `kind` null means excluded. "by_history" means the bill history
 * decides (W/O REF. TO FILE and a missing file_location): the roll call counts as the passage or
 * concurrence whose history action carries the same official tally, and is excluded when none does.
 * `history: true` on a second-reading location (`kind` null) counts the roll call only when the history has a
 * third-reading or concurrence action with the same tally, and otherwise leaves it excluded.
 * `history: true` on a consent location keeps `consent` unless the history action with the same tally
 * is a concurrence. `requiresMotionText` keeps the entry's kind only when the motion text contains that word.
 */
export interface FloorClassEntry {
  house: House;
  /** Normalised file_location (Senate "(Supplemental File N)" suffix removed); null = no file_location. */
  fileLocation: string | null;
  kind: VoteKind | "by_history" | null;
  requiresMotionText?: string;
  /**
   * Consent locations: a same-tally concurrence in the bill history makes the roll call a concurrence.
   * Excluded (kind null) second-reading locations: a same-tally passage or concurrence counts it.
   */
  history?: boolean;
  /** Short note on how a history-matched entry is decided. */
  rule?: string;
  /** LOCATION_CODE_TBL.description where the code exists there, else null. */
  description: string | null;
  /** LOCATION_CODE_TBL.long_description where the code exists there, else null. */
  longDescription: string | null;
}

export interface FloorClassTable {
  session: string;
  entries: FloorClassEntry[];
}

export type ExclusionReason =
  | "location"
  | "motion-text"
  | "reconsideration"
  | "amendment"
  | "withdraw"
  | "re-refer"
  | "lay-on-the-table"
  | "appeal"
  | "previous-question"
  | "urgency-duplicate"
  | "urgency-clause"
  | "no-history-match";

export interface Classification {
  kind: VoteKind | null;
  /** Why the roll call is excluded; null when the location rule counts it. */
  reason: ExclusionReason | null;
  /**
   * "required": kind is decided by the bill history (kind is null until then).
   * "refine": kind is "consent" unless the bill history says concurrence.
   * "optional": excluded (second reading, or a motion to reconsider) unless the bill history has an applied
   * same-tally passage or concurrence of the same bill, house and date.
   * null: the location decides.
   */
  history: "required" | "refine" | "optional" | null;
  /** For "optional": why the roll call stays excluded when the history has no matching action. */
  noMatchReason?: ExclusionReason;
}

const SUPPLEMENTAL = /\s*\(Supplemental File \d+\)\s*$/;

export function normaliseFileLocation(location: string | null): string | null {
  if (location === null) return null;
  return location.replace(SUPPLEMENTAL, "");
}

export async function loadFloorClassTable(path: string): Promise<FloorClassTable> {
  const raw = JSON.parse(await readFile(path, "utf8")) as FloorClassTable;
  if (!raw || !Array.isArray(raw.entries) || typeof raw.session !== "string") {
    throw new IngestError("floor-table", `${path} is not a floor vote classification table`);
  }
  return raw;
}

export function floorTableKey(house: House, fileLocation: string | null): string {
  return `${house}|${fileLocation === null ? "\u0000null" : fileLocation}`;
}

/** Motion-text exclusions that apply to every floor roll call, whatever its location. */
const EXCLUSIONS: Array<[ExclusionReason, RegExp]> = [
  ["reconsideration", /reconsider/i],
  ["amendment", /\bamend\b/i],
  ["withdraw", /withdraw/i],
  ["re-refer", /re-?refer/i],
  ["lay-on-the-table", /lay on the table/i],
  // Procedural votes on the Speaker's ruling and on ending debate are not votes on the measure.
  ["appeal", /\bappeal\b/i],
  ["previous-question", /previous question/i],
];

export function motionExclusion(motionText: string): ExclusionReason | null {
  for (const [reason, re] of EXCLUSIONS) if (re.test(motionText)) return reason;
  return null;
}

export class FloorClassifier {
  private readonly byKey = new Map<string, FloorClassEntry>();
  constructor(readonly table: FloorClassTable) {
    for (const e of table.entries) {
      const key = floorTableKey(e.house, e.fileLocation);
      if (this.byKey.has(key)) throw new IngestError("floor-table", `duplicate entry for ${e.house} ${JSON.stringify(e.fileLocation)}`);
      this.byKey.set(key, e);
    }
  }

  has(house: House, fileLocation: string | null): boolean {
    return this.byKey.has(floorTableKey(house, normaliseFileLocation(fileLocation)));
  }

  /** The caller checks `has` first; an unknown location throws. */
  classify(house: House, fileLocation: string | null, motionText: string): Classification {
    const entry = this.byKey.get(floorTableKey(house, normaliseFileLocation(fileLocation)));
    if (!entry) {
      throw new IngestError("floor-location", `floor file_location ${JSON.stringify(fileLocation)} (${house}) is not in the classification table`);
    }
    const history = entry.kind === "by_history" ? "required" : entry.history ? (entry.kind === null ? "optional" : "refine") : null;
    const excluded = motionExclusion(motionText);
    // A roll call filed under a motion to reconsider can be the passage vote itself (the motion text is
    // shared with the first, reconsidered vote). It counts only when an applied history passage matches it.
    if (excluded === "reconsideration") return { kind: null, reason: null, history: "optional", noMatchReason: "reconsideration" };
    if (excluded) return { kind: null, reason: excluded, history };
    if (entry.kind === null) return { kind: null, reason: history === "optional" ? null : "location", history };
    if (entry.kind === "by_history") return { kind: null, reason: null, history };
    if (entry.requiresMotionText !== undefined && !new RegExp(entry.requiresMotionText, "i").test(motionText)) {
      return { kind: null, reason: "motion-text", history };
    }
    return { kind: entry.kind, reason: null, history };
  }
}

/** An Assembly motion such as "AB 311 McKinnor Third Reading Urgency". */
export function isAssemblyUrgencyMotion(motionText: string): boolean {
  return /third reading urgency/i.test(motionText);
}

/** A Senate roll call on the urgency clause, a vote separate from the vote on the measure. */
export function isUrgencyClauseMotion(motionText: string): boolean {
  return /urgency clause/i.test(motionText);
}
