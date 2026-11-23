import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateFile } from "../schema/validate-v1.ts";
import { assertAllRecordsHaveSrc, crossCheck } from "../src/checks.ts";
import type { IngestArgs } from "../src/ingest.ts";
import { IngestError, stableStringify } from "../src/util.ts";
import {
  cleanTemp,
  editRows,
  fixtureCopy,
  ingestArgs,
  listFiles,
  readSnapshot,
  runIngest,
  tablesCopy,
  tempDir,
  type Snapshot,
} from "./helpers.ts";

let base: Snapshot;
beforeAll(async () => {
  const out = await tempDir("base-");
  await runIngest(ingestArgs({ out }));
  base = await readSnapshot(out);
});
afterAll(cleanTemp);

/** Runs an ingest that must fail with `code`, and checks that the output directory stayed empty. */
async function expectFailure(over: Partial<Omit<IngestArgs, "out">>, code: string, text?: RegExp): Promise<IngestError> {
  const out = await tempDir("fail-");
  let error: unknown;
  try {
    await runIngest(ingestArgs({ ...over, out }));
  } catch (e) {
    error = e;
  }
  expect(error, "the ingest should have failed").toBeInstanceOf(IngestError);
  const err = error as IngestError;
  expect(err.code).toBe(code);
  if (text) expect(err.message).toMatch(text);
  expect(await listFiles(out)).toEqual([]);
  return err;
}

describe("fail closed: nothing is written", () => {
  it("an unmapped vote name", async () => {
    const source = await fixtureCopy();
    // Rename one member in one counted floor roll call (AB 550, Assembly concurrence).
    const n = await editRows(
      source,
      "BILL_DETAIL_VOTE_TBL.dat",
      (c) => c[0] === "202520260AB550" && c[1] === "AFLOOR" && c[2] === "Petrie-Norris" && c[3] === "2026-08-26 11:27:01",
      (raw) => raw.replace("`Petrie-Norris`", "`Petrie Norris`"),
    );
    expect(n).toBe(1);
    const err = await expectFailure({ source }, "vote-name");
    expect(err.details).toEqual(['A "Petrie Norris"']);
  });

  it("a name mapped to two people", async () => {
    const tables = await tablesCopy();
    const path = join(tables, "people-20252026.json");
    const t = JSON.parse(await readFile(path, "utf8")) as { people: Array<{ id: string; voteNames: string[] }> };
    t.people.find((p) => p.id === "ca-a-chen")?.voteNames.push("Petrie-Norris");
    await writeFile(path, JSON.stringify(t), "utf8");
    const err = await expectFailure({ tablesDir: tables }, "people-map", /mapped to two people/);
    expect(err.details.join("\n")).toContain('vote name "Petrie-Norris" (A) is mapped to two people');
  });

  it("an unmapped named legislator row", async () => {
    const tables = await tablesCopy();
    const path = join(tables, "people-20252026.json");
    const t = JSON.parse(await readFile(path, "utf8")) as { people: Array<{ id: string; rows: string[] }> };
    const chen = t.people.find((p) => p.id === "ca-a-chen");
    const dropped = chen?.rows.pop();
    expect(dropped).toBe("AD59|Chen, Phillip");
    await writeFile(path, JSON.stringify(t), "utf8");
    const err = await expectFailure({ tablesDir: tables }, "people-map");
    expect(err.details.join("\n")).toContain("named LEGISLATOR_TBL row AD59|Chen, Phillip is not mapped to a person");
  });

  it("a floor file_location that is not in the classification table", async () => {
    const source = await fixtureCopy();
    const n = await editRows(
      source,
      "BILL_SUMMARY_VOTE_TBL.dat",
      (c) => c[0] === "202520260AB550" && c[1] === "AFLOOR" && c[12] === "AF0180",
      (raw) => raw.replace("`AF0180`", "`AF9999`"),
    );
    expect(n).toBe(1);
    const err = await expectFailure({ source }, "floor-location");
    expect(err.details).toEqual(['A "AF9999"']);
  });

  it("a committee code that is not in the committee table", async () => {
    const tables = await tablesCopy();
    const path = join(tables, "committees-20252026.json");
    const t = JSON.parse(await readFile(path, "utf8")) as { committees: Array<{ code: string }> };
    t.committees = t.committees.filter((c) => c.code !== "CX24");
    await writeFile(path, JSON.stringify(t), "utf8");
    const err = await expectFailure({ tablesDir: tables }, "committee-map");
    expect(err.details.join("\n")).toContain("committee code CX24");
  });

  it("a broken tally: roll calls whose members do not reproduce the official count fall under 99.9%", async () => {
    // The unmodified slice already has the one real mismatch (SB 329): 150 of 151 is below 99.9%.
    const err = await expectFailure({ tallyThreshold: undefined }, "tally", /150 of 151/);
    expect(err.details[0]).toContain("202520260SB329|AFLOOR|2026-08-25 11:57:42|1050");
  });

  it("a second broken tally takes the slice under the 99% threshold", async () => {
    const source = await fixtureCopy();
    // Turn one AYE into NOE in AB 550's Assembly concurrence: official 79-0, members 78-1.
    const n = await editRows(
      source,
      "BILL_DETAIL_VOTE_TBL.dat",
      (c) => c[0] === "202520260AB550" && c[1] === "AFLOOR" && c[2] === "Petrie-Norris" && c[3] === "2026-08-26 11:27:01",
      (raw) => raw.replace("`AYE`", "`NOE`").replace(/\tAYE\t/, "\tNOE\t"),
    );
    expect(n).toBe(1);
    const err = await expectFailure({ source, tallyThreshold: 0.99 }, "tally", /149 of 151/);
    expect(err.details.join("\n")).toContain("202520260AB550|AFLOOR|2026-08-26 11:27:01");
  });

  it("a counted floor roll call with too few members", async () => {
    const source = await fixtureCopy();
    let dropped = 0;
    const n = await editRows(
      source,
      "BILL_DETAIL_VOTE_TBL.dat",
      (c) => c[0] === "202520260AB550" && c[1] === "AFLOOR" && c[3] === "2026-08-26 11:27:01" && dropped++ < 10,
      () => null,
    );
    expect(n).toBe(10);
    const err = await expectFailure({ source, tallyThreshold: 0 }, "roll-call", /fewer than 75/);
    expect(err.details.join("\n")).toContain("has 69 member rows");
  });

  it("source counts that fall more than 2% below an earlier manifest", async () => {
    const dir = await tempDir("manifests-");
    const earlier = JSON.parse(JSON.stringify(base.manifest)) as typeof base.manifest;
    earlier.snapshotId = "20260101T000000Z-00000000";
    const c = earlier.counts[0];
    if (!c) throw new Error("no counts");
    c.rollCalls = Math.ceil(c.rollCalls / 0.97); // the new run has 97% of this
    c.bills = Math.floor(c.bills / 0.99); // 99%: allowed
    await writeFile(join(dir, `${earlier.snapshotId}.json`), stableStringify(earlier), "utf8");
    const err = await expectFailure({ manifestsDir: dir }, "count-drop");
    expect(err.details).toHaveLength(1);
    expect(err.details[0]).toMatch(/rollCalls: 151 is below 98%/);
  });

  it("counts at or above 98% of the earlier maximum pass and the manifest is accepted", async () => {
    const dir = await tempDir("manifests-ok-");
    const earlier = JSON.parse(JSON.stringify(base.manifest)) as typeof base.manifest;
    earlier.snapshotId = "20260101T000000Z-00000000";
    (earlier.counts[0] as { rollCalls: number }).rollCalls = Math.floor(151 / 0.985);
    await writeFile(join(dir, `${earlier.snapshotId}.json`), stableStringify(earlier), "utf8");
    const out = await tempDir("ok-");
    const res = await runIngest(ingestArgs({ out, manifestsDir: dir }));
    expect(res.sealed.snapshotId).toBe(base.manifest.snapshotId);
    expect((await listFiles(out)).length).toBeGreaterThan(5);
  });

  it("an unreadable manifests directory", async () => {
    await expectFailure({ manifestsDir: join(await tempDir("none-"), "missing") }, "manifests-dir");
  });
});

describe("fail closed: validators and src", () => {
  it("the real output passes every validator", () => {
    validateFile("manifest", base.manifest);
    validateFile("core", base.core);
    validateFile("votes", base.votes);
    validateFile("digests", base.digests);
    for (const s of base.shards) validateFile("analysis", s);
    assertAllRecordsHaveSrc(base.core, base.votes, base.digests, base.shards);
    crossCheck(base.core, base.votes, base.digests, base.shards);
  });

  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  it("a record without src is rejected, by the validator and by the src check", () => {
    const votes = clone(base.votes);
    delete (votes.rollCalls[0] as { src?: unknown }).src;
    expect(() => validateFile("votes", votes)).toThrow(/src/);
    expect(() => assertAllRecordsHaveSrc(base.core, votes, base.digests, base.shards)).toThrow(/missing-src/);

    const core = clone(base.core);
    delete (core.bills[0] as { src?: unknown }).src;
    expect(() => validateFile("core", core)).toThrow(/src/);
    expect(() => assertAllRecordsHaveSrc(core, base.votes, base.digests, base.shards)).toThrow(/bill /);

    const digests = clone(base.digests);
    delete (Object.values(digests.digests)[0] as { src?: unknown }).src;
    expect(() => validateFile("digests", digests)).toThrow(/src/);

    const shard = clone(base.shards[0]);
    if (!shard) throw new Error("no shard");
    delete (Object.values(shard.analyses)[0] as { src?: unknown }).src;
    expect(() => validateFile("analysis", shard)).toThrow(/src/);
  });

  it("an out-of-range value or an unknown key fails the validator", () => {
    const core = clone(base.core);
    (core.bills[0] as { stage: string }).stage = "pending";
    expect(() => validateFile("core", core)).toThrow(/stage/);
    const votes = clone(base.votes);
    (votes.rollCalls[0] as { v: string }).v = "AAZ";
    expect(() => validateFile("votes", votes)).toThrow(/vote codes/);
    const extra = clone(base.votes) as unknown as { extra: number };
    extra.extra = 1;
    expect(() => validateFile("votes", extra)).toThrow();
  });

  it("cross-check finds a roll call on a version that is not the bill's", () => {
    const votes = clone(base.votes);
    (votes.rollCalls[0] as { versionId: string }).versionId = "20250AB1CHP";
    expect(() => crossCheck(base.core, votes, base.digests, base.shards)).toThrow(/cross-check/);
  });
});

describe("deterministic output", () => {
  it("the same input gives byte-identical files", async () => {
    const a = await tempDir("det-a-");
    const b = await tempDir("det-b-");
    await runIngest(ingestArgs({ out: a }));
    await runIngest(ingestArgs({ out: b }));
    const filesA = (await listFiles(a)).filter((f) => f.endsWith(".json")).sort();
    const filesB = (await listFiles(b)).filter((f) => f.endsWith(".json")).sort();
    expect(filesA).toEqual(filesB);
    expect(filesA.length).toBeGreaterThan(20);
    for (const f of filesA) expect((await readFile(join(a, f))).equals(await readFile(join(b, f))), f).toBe(true);
  });

  it("only the manifest changes with generatedAt", async () => {
    const a = await tempDir("gen-a-");
    await runIngest(ingestArgs({ out: a, generatedAt: "2030-01-01T00:00:00Z" }));
    const m = await readSnapshot(a);
    expect(m.manifest.generatedAt).toBe("2030-01-01T00:00:00Z");
    expect(m.manifest.files).toEqual(base.manifest.files);
    expect(m.manifest.snapshotId).toBe(base.manifest.snapshotId);
  });

  it("a zip source gives the same files as the directory", async () => {
    const { zipSync } = await import("fflate");
    const { readdir } = await import("node:fs/promises");
    const { FIXTURE } = await import("./helpers.ts");
    const entries: Record<string, Uint8Array> = {};
    for (const name of await readdir(FIXTURE)) {
      if (name === "FIXTURE.md") continue;
      entries[name] = new Uint8Array(await readFile(join(FIXTURE, name)));
    }
    const dir = await tempDir("zip-");
    const zipPath = join(dir, "slice.zip");
    await writeFile(zipPath, zipSync(entries, { level: 0 }));
    const out = await tempDir("zip-out-");
    const res = await runIngest(ingestArgs({ source: zipPath, out }));
    expect(res.sealed.snapshotId).toBe(base.manifest.snapshotId);
    expect(res.sealed.manifest.files).toEqual(base.manifest.files);
  });
});

describe("snapshot id", () => {
  it("changes when only the votes file changes (a motion text), not just when the core file does", async () => {
    const source = await fixtureCopy();
    const n = await editRows(
      source,
      "BILL_MOTION_TBL.dat",
      (c) => (c[1] ?? "").startsWith("W/O REF. TO FILE SB352"),
      (raw) => raw.replace("SB352 Reyes", "SB352 ReyesX"),
    );
    expect(n).toBe(1);
    const out = await tempDir("sid-");
    await runIngest(ingestArgs({ out, source }));
    const changed = await readSnapshot(out);
    expect(changed.core.bills.map((b) => b.id)).toEqual(base.core.bills.map((b) => b.id));
    expect(changed.manifest.files.votes.sha256).not.toBe(base.manifest.files.votes.sha256);
    expect(changed.manifest.snapshotId).not.toBe(base.manifest.snapshotId);
    expect(changed.manifest.snapshotId.slice(0, 16)).toBe(base.manifest.snapshotId.slice(0, 16));
  });
});
