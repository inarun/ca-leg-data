import { afterAll, describe, expect, it } from "vitest";
import { chooseVersionForVote, sortVersionsOldestFirst } from "../src/versions.ts";
import { computeStage, isClearingCommitteeVote, type StageInput } from "../src/stage.ts";
import { cleanTemp, ingestArgs, readSnapshot, runIngest, tempDir } from "./helpers.ts";

afterAll(cleanTemp);

const base: StageInput = {
  currentStatus: "In Committee Process",
  originHouse: "A",
  currentHouse: "A",
  clearedCommitteeInCurrentHouse: false,
  nextHearing: null,
  sessionEnded: false,
};

describe("computeStage (spec rule 7)", () => {
  it("finished outcomes come from current_status", () => {
    expect(computeStage({ ...base, currentStatus: "Chaptered" })).toEqual({ stage: "finished", outcome: "chaptered" });
    expect(computeStage({ ...base, currentStatus: "Vetoed" })).toEqual({ stage: "finished", outcome: "vetoed" });
    expect(computeStage({ ...base, currentStatus: "Died" })).toEqual({ stage: "finished", outcome: "died" });
    expect(computeStage({ ...base, currentStatus: "Failed" })).toEqual({ stage: "finished", outcome: "failed" });
    expect(computeStage({ ...base, currentStatus: "Failed Passage in Committee" })).toEqual({ stage: "finished", outcome: "failed" });
  });
  it("every other bill is finished as session_ended once the session has ended", () => {
    expect(computeStage({ ...base, sessionEnded: true, currentStatus: "In Floor Process" })).toEqual({ stage: "finished", outcome: "session_ended" });
    expect(computeStage({ ...base, sessionEnded: true, currentStatus: "Chaptered" }).outcome).toBe("chaptered");
  });
  it("orders floor, passed_house, cleared_committee, hearing_scheduled, introduced", () => {
    expect(computeStage({ ...base, currentStatus: "In Floor Process", currentHouse: "S" }).stage).toBe("floor");
    expect(computeStage({ ...base, currentStatus: "Passed" }).stage).toBe("passed_house");
    expect(computeStage({ ...base, currentStatus: "Enrolled" }).stage).toBe("passed_house");
    expect(computeStage({ ...base, currentHouse: "S" }).stage).toBe("passed_house");
    expect(computeStage({ ...base, clearedCommitteeInCurrentHouse: true, nextHearing: "2026-12-01" }).stage).toBe("cleared_committee");
    expect(computeStage({ ...base, nextHearing: "2026-12-01" }).stage).toBe("hearing_scheduled");
    expect(computeStage({ ...base, currentStatus: "Pending Referral" }).stage).toBe("introduced");
  });
  it("suspense-file, reconsideration and failed-passage committee votes do not clear a bill", () => {
    expect(isClearingCommitteeVote("(PASS)", "Do pass")).toBe(true);
    expect(isClearingCommitteeVote("(PASS)", "Be adopted. To Consent Calendar.")).toBe(true);
    expect(isClearingCommitteeVote("(PASS)", "Placed on suspense file")).toBe(false);
    expect(isClearingCommitteeVote("(PASS)", "Reconsideration.")).toBe(false);
    expect(isClearingCommitteeVote("(PASS)", "[Committee] hearing set for [date]: Failed passage in Committee. Reconsideration granted")).toBe(false);
    expect(isClearingCommitteeVote("(FAIL)", "Do pass")).toBe(false);
  });
});

describe("source date drives hearings and session end", () => {
  it("nextHearing is the earliest hearing on or after the source date", async () => {
    const out = await tempDir("early-");
    await runIngest(ingestArgs({ out, sourceDate: "2026-03-01T00:00:00Z" }));
    const s = await readSnapshot(out);
    const b = s.core.bills.find((x) => x.id === "202520260AB1719");
    expect(b?.nextHearing).toBe("2026-03-18");
    expect(b?.stage).toBe("cleared_committee"); // cleared_committee outranks hearing_scheduled
    expect(s.core.sessions[0]?.status).toBe("current");
    expect(s.manifest.snapshotId.startsWith("20260301T000000Z-")).toBe(true);
  });

  it("after 30 November of the second year the session is ended and open bills finish as session_ended", async () => {
    const out = await tempDir("late-");
    await runIngest(ingestArgs({ out, sourceDate: "2026-12-01T00:00:00Z" }));
    const s = await readSnapshot(out);
    expect(s.core.sessions[0]?.status).toBe("ended");
    const open = ["202520260AB212", "202520260AB1719", "202520260AB2757", "202520260SB773", "202520260SB1152"];
    for (const id of open) {
      const b = s.core.bills.find((x) => x.id === id);
      expect([b?.stage, b?.outcome, b?.stageRank], id).toEqual(["finished", "session_ended", 6]);
    }
    expect(s.core.bills.find((x) => x.id === "202520260AB550")?.outcome).toBe("chaptered");
  });

  it("on 30 November itself the session has not yet ended", async () => {
    const out = await tempDir("edge-");
    await runIngest(ingestArgs({ out, sourceDate: "2026-11-30T23:59:59Z" }));
    expect((await readSnapshot(out)).core.sessions[0]?.status).toBe("current");
  });
});

describe("version voted on (spec rule 5)", () => {
  const v = (id: string, date: string, action: string, num: number) => ({ id, date, action, num });
  // Version rows copied from BILL_VERSION_TBL: AB 550.
  const ab550 = sortVersionsOldestFirst([
    v("20250AB55094CHP", "2026-09-20", "Chaptered", 94),
    v("20250AB55099INT", "2025-02-11", "Introduced", 99),
    v("20250AB55096AMD", "2026-06-25", "Amended Senate", 96),
    v("20250AB55095ENR", "2026-08-30", "Enrolled", 95),
    v("20250AB55098AMD", "2025-04-07", "Amended Assembly", 98),
    v("20250AB55097AMD", "2025-05-06", "Amended Assembly", 97),
  ]);
  it("sorts oldest first", () => {
    expect(ab550.map((x) => x.id)).toEqual(["20250AB55099INT", "20250AB55098AMD", "20250AB55097AMD", "20250AB55096AMD", "20250AB55095ENR", "20250AB55094CHP"]);
  });
  it("takes the newest Introduced/Amended version strictly before the vote, never Enrolled or Chaptered", () => {
    expect(chooseVersionForVote("b", ab550, "2026-08-26")).toEqual({ versionId: "20250AB55096AMD", inferred: false });
    expect(chooseVersionForVote("b", ab550, "2025-06-02")).toEqual({ versionId: "20250AB55097AMD", inferred: false });
    expect(chooseVersionForVote("b", ab550, "2026-12-01")).toEqual({ versionId: "20250AB55096AMD", inferred: false });
  });
  it("same-day amendment: picks the one before it and flags it inferred", () => {
    expect(chooseVersionForVote("b", ab550, "2025-05-06")).toEqual({ versionId: "20250AB55098AMD", inferred: true });
  });
  it("a vote on the introduction date or earlier falls back to the Introduced version, inferred", () => {
    expect(chooseVersionForVote("b", ab550, "2025-02-11")).toEqual({ versionId: "20250AB55099INT", inferred: true });
    expect(chooseVersionForVote("b", ab550, "2025-01-01")).toEqual({ versionId: "20250AB55099INT", inferred: true });
  });
  it("fails when a bill has no votable version", () => {
    expect(() => chooseVersionForVote("b", ab550.filter((x) => x.action === "Chaptered"), "2026-12-01")).toThrow(/no-version/);
  });
});
