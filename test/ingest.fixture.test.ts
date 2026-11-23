import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bill, RollCall } from "../schema/snapshot-v1.ts";
import { openSource } from "../src/reader.ts";
import { loadTables, rollCallKey, type SourceTables } from "../src/tables.ts";
import { cleanTemp, FIXTURE, ingestArgs, readSnapshot, runIngest, SESSION, SOURCE_DATE, tempDir, type Snapshot } from "./helpers.ts";
import type { BuildStats } from "../src/build.ts";

let snap: Snapshot;
let stats: BuildStats;
let src: SourceTables;

const bill = (num: string): Bill => {
  const b = snap.core.bills.find((x) => x.id === `${SESSION}${num}`);
  if (!b) throw new Error(`bill ${num} not in the snapshot`);
  return b;
};
const calls = (num: string): RollCall[] => snap.votes.rollCalls.filter((r) => r.billId === `${SESSION}${num}`);

beforeAll(async () => {
  const out = await tempDir("out-");
  const res = await runIngest(ingestArgs({ out }));
  stats = res.stats;
  snap = await readSnapshot(out);
  const reader = await openSource(FIXTURE);
  src = await loadTables(reader, SESSION);
  await reader.close();
});
afterAll(cleanTemp);

describe("scope", () => {
  it("keeps AB, SB, ACA, SCA and drops the resolution, still counting it", () => {
    expect(snap.core.bills).toHaveLength(40);
    expect(snap.core.bills.some((b) => b.id === "202520260SCR15")).toBe(false);
    expect(src.bills.map((b) => b.billId)).toContain("202520260SCR15");
    expect(snap.manifest.counts[0]).toMatchObject({ session: SESSION, bills: 41 });
    expect(stats.droppedBillsByType).toEqual({ SCR: 1 });
    expect(new Set(snap.core.bills.map((b) => b.type))).toEqual(new Set(["AB", "SB", "ACA"]));
  });

  it("counts raw source rows for the session, all measure types", () => {
    const c = snap.manifest.counts[0];
    expect(c).toEqual({
      session: SESSION,
      bills: src.bills.length,
      versions: src.versions.length,
      rollCalls: src.summaryVotes.length,
      memberVotes: [...src.detailVotes.values()].reduce((n, d) => n + d.names.length, 0),
      analyses: src.analyses.length,
    });
  });

  it("records the source file and its Last-Modified date in the manifest", () => {
    expect(snap.manifest.sources).toEqual([{ session: SESSION, file: "pubinfo_2025.zip", sourceFileDate: SOURCE_DATE, etag: null }]);
    expect(snap.manifest.snapshotId).toMatch(/^20261116T052636Z-[0-9a-f]{8}$/);
    expect(snap.core.snapshotId).toBe(snap.manifest.snapshotId);
  });

  it("labels the special-session bill", () => {
    const b = bill("1SB3");
    expect(b.label).toBe("SB 3 (1st Ex. Session)");
    expect(b.sessionNum).toBe("1");
    expect(b.analysisShard).toBe("20252026-1-SB-00");
    expect(bill("0AB550").label).toBe("AB 550");
  });
});

describe("stage and outcome", () => {
  const expected: Array<[string, string, string, string | null]> = [
    ["0AB212", "In Committee Process", "passed_house", null],
    ["0AB379", "Chaptered", "finished", "chaptered"],
    ["0AB435", "Chaptered", "finished", "chaptered"],
    ["0AB550", "Chaptered", "finished", "chaptered"],
    ["0AB1250", "Chaptered", "finished", "chaptered"],
    ["0AB1506", "Died", "finished", "died"],
    ["0AB1647", "Vetoed", "finished", "vetoed"],
    ["0AB1719", "In Committee Process", "cleared_committee", null],
    ["0AB1863", "Failed", "finished", "failed"],
    ["0AB2757", "Pending Referral", "introduced", null],
    ["0ACA21", "Chaptered", "finished", "chaptered"],
    ["0SB274", "Vetoed", "finished", "vetoed"],
    ["0SB280", "Chaptered", "finished", "chaptered"],
    ["0SB329", "Chaptered", "finished", "chaptered"],
    ["0SB532", "Died", "finished", "died"],
    ["0SB627", "Chaptered", "finished", "chaptered"],
    ["0SB773", "In Floor Process", "floor", null],
    ["0SB1058", "Chaptered", "finished", "chaptered"],
    ["0SB1080", "Chaptered", "finished", "chaptered"],
    ["0SB1152", "In Committee Process", "introduced", null],
    ["0SB1212", "Failed Passage in Committee", "finished", "failed"],
    ["0SB1438", "Chaptered", "finished", "chaptered"],
    ["1SB3", "Chaptered", "finished", "chaptered"],
  ];
  it.each(expected)("%s (%s) is %s / %s", (num, status, stage, outcome) => {
    const b = bill(num);
    expect(b.status).toBe(status);
    expect(b.stage).toBe(stage);
    expect(b.outcome).toBe(outcome);
    expect(b.stageRank).toBe({ floor: 1, passed_house: 2, cleared_committee: 3, hearing_scheduled: 4, introduced: 5, finished: 6 }[b.stage]);
  });

  it("reports the chapter text", () => {
    expect(bill("0AB550").chapter).toBe("Chapter 357, Statutes of 2026");
    expect(bill("1SB3").chapter).toBe("Chapter 2, Statutes of 2025");
    expect(bill("0ACA21").chapter).toBe("Res. Chapter 131, Statutes of 2026");
    expect(bill("0AB1647").chapter).toBeNull();
  });

  it("marks the session as current while the source date is before 30 November 2026", () => {
    expect(snap.core.sessions).toEqual([{ id: SESSION, label: "2025–26", status: "current", endDate: "2026-11-30" }]);
  });

  it("takes committees from hearings and committee roll calls in order of first appearance, and derives issues", () => {
    // The referral to CX16 (Natural Resources) comes first: it is the history row "Referred to Com. on  NAT. RES." of 2025-02-24.
    expect(bill("0AB550").committees).toEqual(["CX16", "CX24", "CX25", "CS55", "CS61"]);
    expect(bill("0AB550").issueIds).toEqual(["natural-resources-and-water"]);
    expect(bill("0SB274").committees).toEqual(["CS58", "CS53", "CS72", "CS61", "CX22", "CX32", "CX25"]);
    expect(bill("0SB274").issueIds).toEqual(["judiciary", "public-safety", "transportation", "privacy-and-consumer-protection"]);
    expect(bill("0AB2757").committees).toEqual([]);
  });
});

describe("roll call classification", () => {
  it("AB 550: third reading, then concurrence with the version voted on", () => {
    const r = calls("0AB550");
    expect(r).toHaveLength(3);
    const conc = r.find((x) => x.kind === "concurrence");
    expect(conc).toMatchObject({
      house: "A",
      date: "2026-08-26",
      time: "11:27:01",
      ayes: 79,
      noes: 0,
      noVoteRecorded: 0,
      result: "PASS",
      tallyMatches: true,
      final: true,
      fileLocation: "AF0180",
      versionId: "20250AB55096AMD",
      versionInferred: false,
    });
    const asm = r.find((x) => x.kind === "third_reading" && x.house === "A");
    expect(asm).toMatchObject({ date: "2025-06-02", ayes: 76, noes: 0, noVoteRecorded: 3, versionId: "20250AB55097AMD" });
    const sen = r.find((x) => x.house === "S");
    expect(sen).toMatchObject({ date: "2026-08-25", time: null, ayes: 40, fileLocation: "Assembly 3rd Reading", versionId: "20250AB55096AMD" });
  });

  it("SB 3 (special session): the vote is on the Introduced version, never the same-day Enrolled or Chaptered one", () => {
    const b = bill("1SB3");
    expect(b.versions.map((v) => [v.id, v.action])).toEqual([
      ["20251SB399INT", "Introduced"],
      ["20251SB398ENR", "Enrolled"],
      ["20251SB397CHP", "Chaptered"],
    ]);
    expect(b.latestVersionId).toBe("20251SB397CHP");
    const r = calls("1SB3");
    expect(r).toHaveLength(2);
    for (const x of r) {
      expect(x.date).toBe("2025-01-23");
      expect(x.versionId).toBe("20251SB399INT");
      expect(x.versionInferred).toBe(false);
    }
  });

  it("AB 435: two Assembly third readings, only the later one is final", () => {
    const a = calls("0AB435").filter((x) => x.house === "A" && x.kind === "third_reading");
    expect(a.map((x) => [x.date, x.ayes, x.noes, x.result, x.final])).toEqual([
      ["2025-05-23", 35, 12, "FAIL", false],
      ["2025-06-04", 42, 16, "PASS", true],
    ]);
  });

  it("SB 274: a roll call on a motion to reconsider counts when a history passage has its exact bill, house, date and tally", () => {
    const motion = (id: string): string => src.motions.get(id) ?? "";
    const reconsider = src.summaryVotes.filter((r) => r.billId === "202520260SB274" && /reconsider/i.test(motion(r.motionId)));
    expect(reconsider.length).toBeGreaterThan(0);
    const emittedMotions = calls("0SB274").map((x) => x.motionText);
    expect(emittedMotions.filter((m) => /reconsider/i.test(m))).toHaveLength(1);
    // seq 1098 (27-10) and 1099 (39-0) share the motion text but no history passage has their tally; seq 1100 (26-10) does.
    expect(calls("0SB274").map((x) => [x.house, x.date, x.kind, x.ayes, x.noes, x.final, x.src.voteDateSeq])).toEqual([
      ["S", "2025-06-03", "third_reading", 26, 10, true, "1100"],
      ["S", "2025-09-13", "concurrence", 28, 6, true, "1188"],
      ["A", "2025-09-13", "third_reading", 41, 29, true, "1107"],
    ]);
    expect(reconsider.map((r) => [r.voteDateSeq, r.ayes, r.noes])).toEqual([["1098", 27, 10], ["1099", 39, 0], ["1100", 26, 10]]);
    expect(stats.reconsiderationUpgrades.map((u) => [u.billId, u.house, u.date, u.ayes, u.noes, u.kind])).toEqual([["202520260SB274", "S", "2025-06-03", 26, 10, "third_reading"]]);
    expect(stats.reconsiderationUpgrades[0]?.historyLine).toBe("Read third time. Passed. (Ayes 26. Noes 10. Page 1468.) Ordered to the Assembly.");
    // Two SB 274 roll calls, one on another bill under Unfinished Business (no matching passage) and one on AB 2414 (below).
    expect(stats.excludedByReason["reconsideration"]).toBe(4);
  });

  it("AB 2414: a reconsideration roll call with the same tally as a counted roll call of that day is the reconsideration vote, not a second passage", () => {
    // Senate 2026-08-26: "Assembly 3rd Reading AB2414 Nguyen By Reyes" 40-0 counts; "... By Reyes Motion to Reconsider Reconsider" 40-0 has the
    // same bill, house, date and tally and so would match the same history passage, but another roll call already stands for it.
    const rows = src.summaryVotes.filter((r) => r.billId === "202520260AB2414" && r.locationCode === "SFLOOR" && r.voteDateTime.startsWith("2026-08-26"));
    expect(rows.map((r) => [r.ayes, r.noes, /Reconsider/.test(src.motions.get(r.motionId) ?? "")]).sort()).toEqual([[40, 0, false], [40, 0, true]]);
    expect(calls("0AB2414").filter((x) => x.house === "S").map((x) => [x.date, x.ayes, x.noes, x.kind, x.final])).toEqual([
      ["2026-08-26", 40, 0, "third_reading", false],
      ["2026-08-31", 39, 0, "third_reading", true],
    ]);
    expect(calls("0AB2414").some((x) => /Reconsider/.test(x.motionText))).toBe(false);
    expect(stats.reconsiderationUpgrades.some((u) => u.billId === "202520260AB2414")).toBe(false);
  });

  it("SB 627: concurrence under 'Unfinished Business (Supplemental File 1)', last of two same-day roll calls is final", () => {
    const c = calls("0SB627").filter((x) => x.kind === "concurrence");
    expect(c.map((x) => [x.fileLocation, x.ayes, x.noes, x.final])).toEqual([
      ["Unfinished Business (Supplemental File 1)", 27, 10, false],
      ["Unfinished Business (Supplemental File 1)", 28, 11, true],
    ]);
  });

  it("AB 379: the second-reading amendment roll call is excluded", () => {
    const amend = src.summaryVotes.filter((r) => r.billId === "202520260AB379" && /\bAmend\b/i.test(src.motions.get(r.motionId) ?? ""));
    expect(amend.length).toBeGreaterThan(0);
    expect(calls("0AB379").map((x) => [x.house, x.date, x.final])).toEqual([
      ["A", "2025-05-15", true],
      ["S", "2025-07-14", true],
    ]);
  });

  it("SB 280: the urgency roll call is the only Assembly third reading and counts; the amendment votes do not", () => {
    const a = calls("0SB280").filter((x) => x.house === "A");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "third_reading", ayes: 57, noes: 20, final: true });
    expect(a[0]?.motionText).toMatch(/Third Reading Urgency By Pellerin$/);
    expect(stats.urgency.keptAsOnlyVote).toBeGreaterThan(0);
  });

  it("SB 329: the one tally mismatch is flagged", () => {
    const bad = calls("0SB329").filter((x) => !x.tallyMatches);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ house: "A", ayes: 77, noes: 0 });
    expect(bad[0]?.v.split("").filter((c) => c === "A")).toHaveLength(76);
    expect(stats.tally.mismatching.map((m) => m.id)).toEqual([bad[0]?.id]);
    expect(stats.tally).toMatchObject({ total: 196, matching: 195 });
  });

  it("ACA 21: the Senate W/O REF. TO FILE roll call is counted as the adoption vote, matched from the history", () => {
    const wo = src.summaryVotes.filter((r) => r.billId === "202520260ACA21" && r.fileLocation === "W/O REF. TO FILE");
    expect(wo.length).toBeGreaterThan(0);
    const counted = calls("0ACA21").filter((x) => x.fileLocation === "W/O REF. TO FILE");
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ house: "S", kind: "third_reading", date: "2026-06-25", ayes: 35, noes: 0 });
  });

  it("each bill and house has at most one final passage roll call and one final concurrence (none when the passage was rescinded)", () => {
    const seen = new Map<string, number>();
    for (const r of snap.votes.rollCalls) {
      if (!r.final) continue;
      const k = `${r.billId}|${r.house}|${r.kind === "concurrence" ? "c" : "p"}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const rescinded = new Set(stats.rescindedFinals.map((x) => `${x.billId}|${x.house}`));
    for (const b of snap.core.bills) {
      for (const house of ["A", "S"] as const) {
        const list = snap.votes.rollCalls.filter((r) => r.billId === b.id && r.house === house && r.kind !== "concurrence");
        if (list.length > 0) expect(list.filter((r) => r.final)).toHaveLength(rescinded.has(`${b.id}|${house}`) ? 0 : 1);
      }
    }
  });

  it("flags a version as inferred when the vote shares a day with an amendment, or precedes every version", () => {
    expect(calls("0ACA21").map((r) => r.house).sort()).toEqual(["A", "S"]);
    for (const acaVote of calls("0ACA21")) {
      expect(acaVote.versionId).toBe("20250ACA2199INT");
      expect(acaVote.versionInferred).toBe(true);
    }
    expect(calls("0AB1250").filter((r) => r.versionInferred).map((r) => r.date)).toEqual(["2025-09-03"]);
    expect(stats.versionInferred).toBe(snap.votes.rollCalls.filter((r) => r.versionInferred).length);
  });

  it("every roll call refers to a version of its own bill that is not Enrolled or Chaptered", () => {
    for (const r of snap.votes.rollCalls) {
      const v = bill(r.billId.slice(SESSION.length)).versions.find((x) => x.id === r.versionId);
      expect(v, r.id).toBeDefined();
      expect(v?.action === "Introduced" || v?.action.startsWith("Amended"), r.id).toBe(true);
    }
  });

  it("roll call ids are the source key", () => {
    for (const r of snap.votes.rollCalls) {
      expect(r.id).toBe(rollCallKey(r.src.billId, r.src.locationCode, r.src.voteDateTime, r.src.voteDateSeq, r.src.motionId));
      expect(r.id.startsWith(r.billId + "|")).toBe(true);
    }
  });
});

describe("passages without a member-level roll call", () => {
  it("lists the passages with no counted roll call and no same-tally roll call at all", () => {
    expect(snap.votes.noRollCall.map((n) => [n.billId, n.house, n.date])).toEqual([
      ["202520260SB1058", "A", "2026-06-25"],
      ["202520260SB1080", "A", "2026-06-11"],
      ["202520260SB1438", "A", "2026-06-25"],
    ]);
    const n = snap.votes.noRollCall[0];
    expect(n?.historyAction).toBe("Read third time. Passed. (Ayes 73. Noes  0. Page 5864.) Ordered to the Senate.");
    expect(n?.src).toMatchObject({ table: "BILL_HISTORY_TBL", billId: "202520260SB1058" });
    expect(calls("0SB1058").filter((r) => r.house === "A")).toHaveLength(0);
    expect(calls("0SB1438").filter((r) => r.house === "A")).toHaveLength(0);
  });

  it("SB 274: the Senate passage now has a counted roll call, so it is neither in noRollCall nor in the needs-a-look list", () => {
    expect(stats.noRollCallNeedsLook).toEqual([]);
    expect(snap.votes.noRollCall.some((x) => x.billId === "202520260SB274")).toBe(false);
  });

  it("every passage that has a counted roll call of its kind is absent, and every listed one has none", () => {
    for (const n of snap.votes.noRollCall) {
      const kinds = calls(n.billId.slice(SESSION.length)).filter((r) => r.house === n.house && r.final).map((r) => (r.kind === "concurrence" ? "concurrence" : "third_reading"));
      const passage = /concurred in/.test(n.historyAction) ? "concurrence" : "third_reading";
      expect(kinds).not.toContain(passage);
    }
  });
});

describe("floor roll calls in history-decided locations", () => {
  const find = (num: string, house: "A" | "S", date: string): RollCall => {
    const r = calls(num).find((x) => x.house === house && x.date === date);
    if (!r) throw new Error(`no roll call ${num} ${house} ${date}`);
    return r;
  };

  it("SB 352: a Senate W/O REF. TO FILE roll call whose tally equals the 'concurred in' action is a concurrence", () => {
    const r = find("0SB352", "S", "2025-09-13");
    expect(r).toMatchObject({ kind: "concurrence", fileLocation: "W/O REF. TO FILE", ayes: 29, noes: 6, final: true, tallyMatches: true });
    expect(src.history.some((h) => h.billId === r.billId && h.date === r.date && h.status === "Applied" && h.action.includes("concurred in. (Ayes 29. Noes  6."))).toBe(true);
  });

  it("SB 254: a Senate roll call on the urgency clause that is the only vote gets the history rule (concurrence 30-2)", () => {
    const r = find("0SB254", "S", "2025-09-13");
    expect(r.motionText).toContain("Urgency Clause");
    expect(r).toMatchObject({ kind: "concurrence", fileLocation: "W/O REF. TO FILE", ayes: 30, noes: 2, final: true });
    expect(stats.historyDecisions.find((d) => d.billId === r.billId)).toMatchObject({ kind: "concurrence", reason: null });
  });

  it("AB 113: a Senate roll call with no file_location is a third reading when the history says so; fileLocation is null", () => {
    const r = find("0AB113", "S", "2026-09-01");
    expect(r).toMatchObject({ kind: "third_reading", fileLocation: null, ayes: 29, noes: 4, final: true });
    expect(src.summaryVotes.filter((x) => x.billId === r.billId && x.locationCode === "SFLOOR" && x.fileLocation === null)).toHaveLength(1);
    expect(stats.nullFileLocationRollCalls).toBe(1);
  });

  it("ACA 21: the history words the Senate vote 'Adopted and to Assembly', which the rule accepts for constitutional amendments", () => {
    const h = src.history.filter((x) => x.billId === "202520260ACA21" && x.date === "2026-06-25" && x.primaryLocation === "Senate");
    expect(h.some((x) => x.action === "Adopted and to Assembly. (Ayes 35. Noes  0. Page 5018.)")).toBe(true);
    expect(h.some((x) => /Read third time/.test(x.action))).toBe(false);
    expect(stats.historyDecisions.find((d) => d.billId === "202520260ACA21")).toMatchObject({
      kind: "third_reading",
      ayes: 35,
      noes: 0,
      historyLine: "Adopted and to Assembly. (Ayes 35. Noes  0. Page 5018.)",
    });
    expect(stats.excludedByReason["no-history-match"] ?? 0).toBe(0);
  });

  it("AB 940: a Senate roll call under 'Assembly 2nd Reading' whose tally equals the 'Read third time. Passed.' action is a third reading", () => {
    const r = find("0AB940", "S", "2025-09-12");
    expect(r).toMatchObject({ kind: "third_reading", fileLocation: "Assembly 2nd Reading", ayes: 37, noes: 0, final: true });
    expect(r.motionText).toContain("Assembly 2nd Reading AB940");
    const u = stats.secondReadingUpgrades.find((x) => x.billId === r.billId);
    expect(u).toMatchObject({ kind: "third_reading", historyLine: "Read third time. Passed. Ordered to the Assembly. (Ayes 37. Noes  0. Page 3003.)." });
  });

  it("SB 851: an Assembly roll call under AF0160 (Senate bills, second reading) matching 'Urgency clause adopted. Passed.' is a third reading", () => {
    const r = find("0SB851", "A", "2025-09-13");
    expect(r).toMatchObject({ kind: "third_reading", fileLocation: "AF0160", ayes: 60, noes: 19, final: true });
    expect(stats.secondReadingUpgrades.find((x) => x.billId === r.billId)?.historyLine).toBe(
      "Read third time. Urgency clause adopted. Passed. (Ayes 60. Noes 19. Page 3447.) Ordered to the Senate.",
    );
  });

  it("other second-reading roll calls stay excluded: only the two matched ones are counted", () => {
    expect(stats.secondReadingUpgrades.map((x) => x.billId).sort()).toEqual(["202520260AB940", "202520260SB851"]);
    const secondReading = src.summaryVotes.filter((x) => ["AF0150", "AF0160", "Assembly 2nd Reading", "Senate 2nd Reading"].some((l) => (x.fileLocation ?? "").startsWith(l)));
    const counted = snap.votes.rollCalls.filter((r) => ["AF0150", "AF0160", "Assembly 2nd Reading", "Senate 2nd Reading"].some((l) => (r.fileLocation ?? "").startsWith(l)));
    expect(counted).toHaveLength(2);
    expect(secondReading.length).toBeGreaterThanOrEqual(counted.length);
  });

  it("SB 1438 and SB 329: Special Consent roll calls matching a 'concurred in' action become concurrences", () => {
    expect(find("0SB1438", "S", "2026-08-27")).toMatchObject({ kind: "concurrence", fileLocation: "Special Consent", ayes: 40, noes: 0, final: true });
    expect(find("0SB329", "S", "2026-08-28")).toMatchObject({ kind: "concurrence", fileLocation: "Special Consent" });
    expect(stats.consentBecameConcurrence).toEqual({ "S Special Consent": 3 });
  });

  it("Special Consent and Consent Calendar 2nd roll calls matching a passage, or no action, stay consent", () => {
    expect(find("0SB329", "S", "2025-05-29")).toMatchObject({ kind: "consent", fileLocation: "Special Consent" });
    expect(find("0SB1438", "S", "2026-04-30")).toMatchObject({ kind: "consent", fileLocation: "Consent Calendar 2nd" });
    // AB 1447: the 2025-07-17 third-reading action in the history is "Rescinded", so nothing matches and it stays consent.
    expect(find("0AB1447", "S", "2025-07-17")).toMatchObject({ kind: "consent", fileLocation: "Consent Calendar 2nd", ayes: 35, noes: 0 });
    expect(stats.noHistoryMatch.map((x) => [x.id.split("|")[0], x.group, x.keptAs])).toEqual([["202520260AB1447", "S Consent Calendar 2nd", "consent"]]);
    expect(stats.excludedByReason["no-history-match"] ?? 0).toBe(0);
  });

  it("counts the history-decided roll calls by group and resulting kind", () => {
    expect(stats.historyGroups).toEqual({
      "S Consent Calendar 2nd": { consent: 7 },
      "S Special Consent": { consent: 2, concurrence: 3 },
      "S W/O REF. TO FILE": { concurrence: 2, third_reading: 1 },
      "S (no file_location)": { third_reading: 1 },
      "S Assembly 2nd Reading": { third_reading: 1 },
      "A AF0160": { third_reading: 1 },
      "S Senate 3rd Reading": { third_reading: 1, reconsideration: 2 },
      "S Unfinished Business": { reconsideration: 1 },
      "S Assembly 3rd Reading": { reconsideration: 1 },
    });
  });

  it("the roll call's key still identifies the source row for the null file_location", () => {
    const r = find("0AB113", "S", "2026-09-01");
    expect(r.id).toBe(rollCallKey(r.src.billId, r.src.locationCode, r.src.voteDateTime, r.src.voteDateSeq, r.src.motionId));
  });
});

describe("committee referrals", () => {
  it("resolve through the history row's own committee code and come first by date", () => {
    expect(stats.referrals).toMatchObject({ rows: 174, resolved: 173, unresolved: 1, multiCommitteeRows: 17, billsWithReferralCommittee: 38 });
    expect(stats.referrals.unresolvedStrings).toEqual(["From committee chair, with author's amendments: Amend, and re-refer to committee. Read second time, amended, and re-referred to Com. on L. GOV."]);
    // SB 627 was referred to two committees in the Senate; the other names are not on the row.
    expect(stats.referrals.multiCommitteeExtraNames).toContain("PUB. S.");
  });

  it("a bill whose only committee trace is a referral still has that committee and its issue", () => {
    expect(stats.referrals.billsWithOnlyReferralCommittees).toBe(3);
    expect(bill("0SB1152").committees).toEqual(["CS58"]);
    expect(bill("0AB2757").committees).toEqual([]);
  });
});

describe("people and rosters", () => {
  const person = (id: string) => snap.core.people.find((p) => p.id === id);

  it("AD63 held two different people, both kept", () => {
    const ad63 = snap.core.people.filter((p) => p.terms.some((t) => t.district === "AD63"));
    expect(ad63.map((p) => p.id).sort()).toEqual(["ca-a-essayli", "ca-a-johnson"]);
    expect(person("ca-a-essayli")?.terms[0]).toMatchObject({ displayName: "Bill Essayli", party: "Republican", seated: false });
    expect(person("ca-a-johnson")?.terms[0]).toMatchObject({ displayName: "Natasha Johnson", party: "Republican", seated: true });
  });

  it("AD15 is one person under both spellings, and appears once in the roster", () => {
    const ad15 = snap.core.people.filter((p) => p.terms.some((t) => t.district === "AD15"));
    expect(ad15).toHaveLength(1);
    const p = ad15[0];
    expect(p?.id).toBe("ca-a-avila-farias");
    expect(p?.terms).toHaveLength(1);
    expect(p?.terms[0]?.voteNames).toEqual(["Ávila Farías", "Avila Farias"]);
    expect(snap.votes.rosters[`${SESSION}-A`]?.filter((id) => id === "ca-a-avila-farias")).toHaveLength(1);
  });

  it("votes under each AD15 spelling land on the same roster slot", () => {
    const idx = (snap.votes.rosters[`${SESSION}-A`] as string[]).indexOf("ca-a-avila-farias");
    const early = calls("1SB3").find((r) => r.house === "A") as RollCall; // 2025-01-23, spelt without accents in the source
    const later = calls("0AB212")[0] as RollCall; // spelt with accents in the source
    for (const r of [early, later]) expect(["A", "N", "X"]).toContain(r.v[idx]);
    const names = (r: RollCall): Set<string> => new Set(src.detailVotes.get(r.id)?.names);
    expect(names(early).has("Avila Farias")).toBe(true);
    expect(names(later).has("Ávila Farías")).toBe(true);
  });

  it("a bill voted on by Essayli and one by Johnson", () => {
    const rosterA = snap.votes.rosters[`${SESSION}-A`] as string[];
    const essayli = rosterA.indexOf("ca-a-essayli");
    const johnson = rosterA.indexOf("ca-a-johnson");
    expect(calls("0AB212")[0]?.v[essayli]).not.toBe("-");
    expect(calls("0AB212")[0]?.v[johnson]).toBe("-");
    // ACA 21 has an Assembly roll call and a Senate one (same day); the Senate one has no Assembly members.
    const assembly = calls("0ACA21").find((x) => x.house === "A") as RollCall;
    expect(assembly.v[johnson]).not.toBe("-");
    expect(assembly.v[essayli]).toBe("-");
  });

  it("v has one code per roster entry and codes follow the source", () => {
    const r = calls("0AB550").find((x) => x.kind === "concurrence") as RollCall;
    const roster = snap.votes.rosters[`${SESSION}-A`] as string[];
    expect(r.v).toHaveLength(roster.length);
    expect(r.v.split("").filter((c) => c === "A")).toHaveLength(79);
    expect(r.v.split("").filter((c) => c === "N")).toHaveLength(0);
    const idx = roster.indexOf("ca-a-petrie-norris");
    expect(r.v[idx]).toBe("A");
    const names = src.detailVotes.get(r.id);
    expect(names?.names).toContain("Petrie-Norris");
    expect(names?.codes[names.names.indexOf("Petrie-Norris")]).toBe("AYE");
  });

  it("every named LEGISLATOR_TBL row has a person; the two vacant rows have none", () => {
    expect(snap.core.people).toHaveLength(121);
    const named = src.legislators.filter((l) => l.authorName !== null);
    expect(named).toHaveLength(122);
    expect((snap.votes.rosters[`${SESSION}-A`] as string[]).length + (snap.votes.rosters[`${SESSION}-S`] as string[]).length).toBe(121);
  });

  it("maps party codes", () => {
    expect(person("ca-a-petrie-norris")?.terms[0]).toMatchObject({ displayName: "Cottie Petrie-Norris", party: "Democratic", seated: true, district: "AD73" });
    expect(person("ca-a-chen")?.terms[0]?.party).toBe("Republican");
  });
});

describe("digests and analyses", () => {
  it("digest keeps paragraph breaks", () => {
    const d = snap.digests.digests["202520260AB550"];
    expect(d?.versionId).toBe("20250AB55094CHP");
    expect(d?.text.startsWith("The California Endangered Species Act prohibits the take of an endangered, threatened, or candidate species")).toBe(true);
    expect(d?.text.split("\n\n")).toHaveLength(2);
    expect(bill("0AB550").hasDigest).toBe(true);
  });

  it("picks the latest analysis by date then id", () => {
    const rows = src.analyses.filter((a) => a.billId === "202520260AB550");
    expect(rows.length).toBe(2); // fixture keeps the latest plus one committee analysis
    const a = snap.analyses["202520260AB550"];
    expect(a).toMatchObject({ analysisId: "405279", type: "CSA1", house: "A", date: "2026-08-25" });
    expect(bill("0AB550").analysisShard).toBe("20252026-0-AB-05");
  });

  it("AB 550 analysis: arguments in support and opposition parsed, text verbatim without field codes", () => {
    const a = snap.analyses["202520260AB550"];
    expect(a?.argumentsInSupport?.startsWith("The Large-scale Solar Association, sponsors of this bill, write that")).toBe(true);
    expect(a?.argumentsInOpposition?.startsWith("According to the SFV Alliance, writing in opposition")).toBe(true);
    expect(a?.text).not.toContain("MERGEFIELD");
    expect(a?.text).toContain("Arguments in Support");
    expect(a?.support).toBeNull();
  });

  it("support and opposition lists, 'None received' as an empty list, and the verified date", () => {
    expect(snap.analyses["202520260SB1080"]?.support).toEqual(["California Association of Clerks and Election Officials [SPONSOR]"]);
    expect(snap.analyses["202520260SB1058"]?.support).toEqual([
      "Alameda County Office of Education",
      "California Association of School Business Officials",
      "California School Nutrition Association",
      "Los Angeles County Office of Education",
    ]);
    expect(snap.analyses["202520260SB1058"]?.opposition).toEqual([]);
    expect(snap.analyses["202520260SB329"]?.opposition).toEqual([]);
    expect(snap.analyses["202520260SB329"]?.positionsVerified).toBe("2026-08-24");
    expect(snap.analyses["202520260SB1438"]).toMatchObject({
      support: ["California Association of County Treasurers and Tax Collectors"],
      opposition: [],
      positionsVerified: "2026-06-25",
      digest: "This bill makes various changes to local government investment laws.\nAssembly Amendments\n of 6/1/26 make technical changes.",
    });
  });

  it("bills with no analysis on file have no shard", () => {
    expect(bill("0SB532").analysisShard).toBeNull();
    expect(snap.analyses["202520260SB532"]).toBeUndefined();
    expect(bill("0AB2757").analysisShard).toBeNull();
  });

  it("every parsed section is an exact slice of the analysis text", () => {
    let checked = 0;
    for (const a of Object.values(snap.analyses)) {
      for (const k of ["digest", "argumentsInSupport", "argumentsInOpposition"] as const) {
        const v = a[k];
        if (v !== null) {
          expect(a.text.includes(v), `${a.analysisId} ${k}`).toBe(true);
          checked += 1;
        }
      }
      for (const k of ["support", "opposition"] as const) {
        for (const item of a[k] ?? []) {
          expect(a.text.includes(item), `${a.analysisId} ${k}`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("shards and files", () => {
  it("assigns each analysis to the shard from analysisShardKey and lists every shard in the manifest", () => {
    const listed = snap.manifest.files.analysis.map((a) => a.shard).sort();
    expect(listed).toEqual(snap.shards.map((s) => s.shard).sort());
    for (const s of snap.shards) {
      for (const id of Object.keys(s.analyses)) expect(bill(id.slice(SESSION.length)).analysisShard).toBe(s.shard);
    }
    expect(listed).toContain("20252026-0-AB-05");
    expect(listed).toContain("20252026-1-SB-00");
  });

  it("file names carry the first 8 hex of the content hash recorded in the manifest", () => {
    for (const f of [snap.manifest.files.core, snap.manifest.files.votes, snap.manifest.files.digests, ...snap.manifest.files.analysis]) {
      expect(f.path).toMatch(/-[0-9a-f]{8}\.json$/);
      expect(f.path.endsWith(`-${f.sha256.slice(0, 8)}.json`)).toBe(true);
    }
  });
});

const findCall = (num: string, house: "A" | "S", date: string): RollCall => {
  const r = calls(num).filter((x) => x.house === house && x.date === date);
  if (r.length !== 1) throw new Error(`expected one roll call for ${num} ${house} ${date}, found ${r.length}`);
  return r[0] as RollCall;
};

describe("passages rescinded in the bill history", () => {
  it("AB 1447, SB 1189 and SB 493: a passage rescinded with no later passage roll call is not final", () => {
    // History rows: AB 1447 119025123 (Rescinded) and 119025128 "Action rescinded whereby the bill was read third time, passed, and to Assembly.";
    // SB 1189 118906167 and 118906171 "... ordered to the Senate."; SB 493 118958893 and 118958897 (same wording).
    expect(findCall("0AB1447", "S", "2025-07-17")).toMatchObject({ kind: "consent", ayes: 35, noes: 0, final: false });
    expect(findCall("0SB1189", "A", "2026-06-15")).toMatchObject({ kind: "consent", ayes: 77, noes: 0, final: false });
    expect(findCall("0SB493", "A", "2025-08-28")).toMatchObject({ kind: "third_reading", ayes: 75, noes: 1, final: false });
    expect(stats.rescindedFinals.map((x) => [x.billId, x.house, x.date, x.rescindedOn, x.billHistoryId])).toEqual([
      ["202520260AB1447", "S", "2025-07-17", "2026-08-10", "119025128"],
      ["202520260SB1189", "A", "2026-06-15", "2026-07-02", "118906171"],
      ["202520260SB493", "A", "2025-08-28", "2026-06-08", "118958897"],
    ]);
    // The passage rows are marked Rescinded, so the bill history does not list a passage without a roll call either.
    expect(snap.votes.noRollCall.filter((n) => ["202520260AB1447", "202520260SB1189", "202520260SB493"].includes(n.billId))).toEqual([]);
    expect(snap.votes.noRollCall.map((n) => n.billId)).not.toContain("202520260AB1447");
  });

  it("AB 1250: a passage rescinded and then passed again makes the later roll call final", () => {
    const s = calls("0AB1250").filter((x) => x.house === "S");
    expect(s.map((x) => [x.date, x.ayes, x.noes, x.final])).toEqual([
      ["2025-09-03", 40, 0, false],
      ["2025-09-09", 40, 0, true],
    ]);
    expect(stats.rescindedFinals.some((x) => x.billId === "202520260AB1250")).toBe(false);
  });
});

describe("version of a vote on a day the bill was amended", () => {
  it("ACA 8, Assembly 2025-08-21: 'Amended. Ordered to third reading.' precedes 'Adopted and to Senate.', so the vote was on the 8/21 version", () => {
    // History rows 118189020 (Amended, sequence 8) and 118189022 (Adopted and to Senate. (Ayes 57. Noes 20.)); versions dated 2025-08-18 and 2025-08-21.
    expect(findCall("0ACA8", "A", "2025-08-21")).toMatchObject({ ayes: 57, noes: 20, versionId: "20250ACA897AMD", versionInferred: true });
    expect(src.versions.find((v) => v.versionId === "20250ACA897AMD")).toMatchObject({ date: "2025-08-21" });
    expect(stats.sameDayVersionChanged.map((x) => [x.billId, x.house, x.date, x.from, x.to])).toContainEqual(["202520260ACA8", "A", "2025-08-21", "20250ACA898AMD", "20250ACA897AMD"]);
  });

  it("ACA 8, Senate 2025-08-21: no amendment action of the Senate that day, so the previous version stays", () => {
    expect(findCall("0ACA8", "S", "2025-08-21")).toMatchObject({ ayes: 30, noes: 8, versionId: "20250ACA898AMD", versionInferred: true });
  });

  it("reports how the history orders the same-day amendment and passage for every vote on such a day", () => {
    const total = Object.values(stats.sameDayVersionOrder).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(stats.sameDayVersionOrder["amendment-first"]).toBeGreaterThanOrEqual(1);
    for (const c of stats.sameDayVersionChanged) expect(c.from).not.toBe(c.to);
  });
});

describe("analysis lists the parser cannot trust", () => {
  const a = (num: string) => snap.analyses[`${SESSION}0${num}`];

  it("AB 1097: 'Oppose Unless Amended' inside the support list, so neither list is published", () => {
    expect(a("AB1097")).toMatchObject({ analysisId: "385330", support: null, opposition: null });
  });

  it("AB 2616: 'Opposition (unless amended)' inside the opposition list nulls that list only", () => {
    expect(a("AB2616")?.opposition).toBeNull();
    expect(a("AB2616")?.support).toEqual([
      "Alliance of Californians for Community Empowerment (ACCE Action)",
      "Courage California",
      "Friends Committee on Legislation of California",
      "LA Voice",
      "Legal Aid Foundation of Los Angeles",
      "Rubicon Programs",
      "The W. Haywood Burns Institute",
    ]);
  });

  it("AB 2558 and AB 2746: a 'Last verified' line in a list nulls the list", () => {
    expect(a("AB2558")).toMatchObject({ support: null, opposition: null });
    expect(a("AB2746")).toMatchObject({ support: null, opposition: null });
  });

  it("SB 1420: an organisation named 'Verified Voting' is not a verification line", () => {
    expect(a("SB1420")?.support).toContain("Verified Voting");
    expect(a("SB1420")?.positionsVerified).toBe("2026-08-14");
  });

  it("AB 1723 and AB 387: a 'None submitted' sentence is an empty list, not an organisation", () => {
    expect(a("AB1723")?.opposition).toEqual([]);
    expect(a("AB387")?.opposition).toEqual([]);
    for (const x of Object.values(snap.analyses)) for (const item of [...(x.support ?? []), ...(x.opposition ?? [])]) expect(item).not.toMatch(/^none\b/i);
  });
});
