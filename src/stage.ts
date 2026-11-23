import type { House, Outcome, Stage } from "../schema/snapshot-v1.ts";

export const STAGE_RANK: Record<Stage, number> = {
  floor: 1,
  passed_house: 2,
  cleared_committee: 3,
  hearing_scheduled: 4,
  introduced: 5,
  finished: 6,
};

export interface StageInput {
  currentStatus: string | null;
  originHouse: House;
  currentHouse: House | null;
  /** The bill has at least one passing committee roll call in its current house. */
  clearedCommitteeInCurrentHouse: boolean;
  /** Earliest COMMITTEE_HEARING_TBL date on or after the source date, if any. */
  nextHearing: string | null;
  sessionEnded: boolean;
}

export function computeStage(i: StageInput): { stage: Stage; outcome: Outcome | null } {
  switch (i.currentStatus) {
    case "Chaptered":
      return { stage: "finished", outcome: "chaptered" };
    case "Vetoed":
      return { stage: "finished", outcome: "vetoed" };
    case "Died":
      return { stage: "finished", outcome: "died" };
    case "Failed":
    case "Failed Passage in Committee":
      return { stage: "finished", outcome: "failed" };
    default:
      break;
  }
  if (i.sessionEnded) return { stage: "finished", outcome: "session_ended" };
  if (i.currentStatus === "In Floor Process") return { stage: "floor", outcome: null };
  if (
    i.currentStatus === "Passed" ||
    i.currentStatus === "Enrolled" ||
    (i.currentHouse !== null && i.currentHouse !== i.originHouse)
  ) {
    return { stage: "passed_house", outcome: null };
  }
  if (i.clearedCommitteeInCurrentHouse) return { stage: "cleared_committee", outcome: null };
  if (i.nextHearing !== null) return { stage: "hearing_scheduled", outcome: null };
  return { stage: "introduced", outcome: null };
}

export function houseFromName(name: string | null): House | null {
  if (name === "Assembly") return "A";
  if (name === "Senate") return "S";
  return null;
}

/** "CX.." committees belong to the Assembly, "CS.." to the Senate. */
export function committeeHouse(code: string): House | null {
  if (code.startsWith("CX")) return "A";
  if (code.startsWith("CS")) return "S";
  return null;
}

/**
 * A committee roll call that sends the bill on. Suspense-file placements, reconsideration
 * motions and failed-passage entries carry a PASS result but do not clear the bill.
 */
export function isClearingCommitteeVote(result: string, motionText: string): boolean {
  if (result !== "(PASS)") return false;
  return !/suspense|reconsider|failed passage/i.test(motionText);
}
