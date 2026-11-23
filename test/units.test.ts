import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseAnalysisSections } from "../src/analysis.ts";
import { FloorClassifier, isUrgencyClauseMotion, loadFloorClassTable, motionExclusion, normaliseFileLocation } from "../src/classify.ts";
import { parseDat, readRows } from "../src/dat.ts";
import { makeFixture, rangesOf } from "../src/fixture.ts";
import { FloorActionIndex, floorAction, historyPassage, parseTally } from "../src/passages.ts";
import { applyHistoryRules, type HistoryCandidate } from "../src/historyKinds.ts";
import { openSource } from "../src/reader.ts";
import { loadTables } from "../src/tables.ts";
import { docxToText, extractDigest } from "../src/text.ts";
import { asciiSlug, compareNumericStrings, stableStringify } from "../src/util.ts";
import { cleanTemp, FIXTURE, SESSION, TABLES, tempDir } from "./helpers.ts";

afterAll(cleanTemp);

describe(".dat parser", () => {
  it("reads backtick strings, NULL and bare values, keeping backticks and line breaks inside strings", () => {
    const text = "`a`\tNULL\t12\t`b`c`\n`x\ny`\t2026-01-01 00:00:00\tNULL\t`z`\n";
    expect(readRows(text)).toEqual([
      ["a", null, "12", "b`c"],
      ["x\ny", "2026-01-01 00:00:00", null, "z"],
    ]);
  });

  it("handles CRLF line ends and a missing final newline, and reports row spans", () => {
    const text = "`a`\t`b`\r\n`c`\tNULL";
    const spans: Array<[number, number, number]> = [];
    const rows: Array<Array<string | null>> = [];
    parseDat(text, (cells, s) => {
      rows.push(cells);
      spans.push([s.row, s.start, s.end]);
    });
    expect(rows).toEqual([
      ["a", "b"],
      ["c", null],
    ]);
    expect(spans.map(([r]) => r)).toEqual([1, 2]);
    expect(text.slice(spans[1]?.[1], spans[1]?.[2])).toBe("`c`\tNULL");
  });

  it("parses every fixture table with a constant number of columns", async () => {
    const widths: Record<string, number> = {
      "BILL_TBL.dat": 19,
      "BILL_VERSION_TBL.dat": 18,
      "BILL_SUMMARY_VOTE_TBL.dat": 15,
      "BILL_DETAIL_VOTE_TBL.dat": 12,
      "BILL_HISTORY_TBL.dat": 13,
      "BILL_MOTION_TBL.dat": 4,
      "BILL_ANALYSIS_TBL.dat": 15,
      "BILL_VERSION_AUTHORS_TBL.dat": 10,
      "COMMITTEE_HEARING_TBL.dat": 7,
      "LEGISLATOR_TBL.dat": 16,
      "LOCATION_CODE_TBL.dat": 10,
    };
    for (const [name, w] of Object.entries(widths)) {
      const rows = readRows(await readFile(join(FIXTURE, name), "utf8"));
      expect(rows.length, name).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.length)), name).toEqual(new Set([w]));
    }
  });
});

describe("floor classification", () => {
  const table = loadFloorClassTable(join(TABLES, "floor-vote-classification.json"));

  // Motion texts below are copied from BILL_MOTION_TBL.
  it("classifies by location and motion text", async () => {
    const c = new FloorClassifier(await table);
    expect(c.classify("A", "AF0240", "AB 550 Petrie-Norris Assembly Third Reading").kind).toBe("third_reading");
    expect(c.classify("A", "AF0250", "SB 329 Blakespear Senate Third Reading By Dixon").kind).toBe("third_reading");
    expect(c.classify("A", "AF0280", "AB 604 Berman Consent Calendar Second Day Regular Session").kind).toBe("consent");
    expect(c.classify("A", "AF0180", "AB 550 Petrie-Norris Concurrence in Senate Amendments").kind).toBe("concurrence");
    expect(c.classify("A", "AF0160", "SB 851 Cervantes Senate Second Reading By Pellerin").kind).toBeNull();
    expect(c.classify("S", "Senate 3rd Reading (Supplemental File 1)", "Senate 3rd Reading SB1058 McNerney").kind).toBe("third_reading");
    expect(c.classify("S", "Special Consent", "Special Consent SB329 Blakespear et al.").kind).toBe("consent");
    expect(c.classify("S", "Consent Calendar 2nd", "Consent Calendar 2nd SB1080 Valladares").kind).toBe("consent");
    expect(c.classify("S", "Assembly 2nd Reading", "Assembly 2nd Reading AB1098 Fong et al. By Padilla").kind).toBeNull();
  });

  it("Unfinished Business counts as concurrence only when the motion says Concurrence", async () => {
    const c = new FloorClassifier(await table);
    expect(c.classify("S", "Unfinished Business (Supplemental File 1)", "Unfinished Business SB627 Wiener et al. Concurrence").kind).toBe("concurrence");
    expect(c.classify("S", "Unfinished Business", "Unfinished Business SB627 Wiener et al.").kind).toBeNull();
  });

  it("W/O REF. TO FILE and a missing file_location are left to the bill history, whatever the motion text says", async () => {
    const c = new FloorClassifier(await table);
    expect(c.classify("S", "W/O REF. TO FILE", "W/O REF. TO FILE SB1050 Ashby")).toMatchObject({ kind: null, reason: null, history: "required" });
    expect(c.classify("S", null, "Assembly 3rd Reading AB1250 Papan By Strickland")).toMatchObject({ kind: null, reason: null, history: "required" });
    expect(c.classify("S", "W/O REF. TO FILE", "W/O REF. TO FILE Concurrence SB1 Someone")).toMatchObject({ history: "required" });
    // A motion exclusion still applies first.
    expect(c.classify("S", "W/O REF. TO FILE", "W/O REF. TO FILE SB1 Someone Motion to Reconsider")).toMatchObject({ kind: null, reason: "reconsideration" });
  });

  it("the Senate consent locations are consent unless the history says concurrence", async () => {
    const c = new FloorClassifier(await table);
    expect(c.classify("S", "Special Consent", "Special Consent SB1438 Someone")).toMatchObject({ kind: "consent", history: "refine" });
    expect(c.classify("S", "Consent Calendar 2nd", "Consent Calendar 2nd SB1 Someone")).toMatchObject({ kind: "consent", history: "refine" });
    expect(c.classify("A", "AF0280", "AB 604 Berman Consent Calendar Second Day Regular Session")).toMatchObject({ kind: "consent", history: null });
    expect(isUrgencyClauseMotion("W/O REF. TO FILE SB254 Becker Urgency Clause")).toBe(true);
    expect(isUrgencyClauseMotion("W/O REF. TO FILE SB254 Becker")).toBe(false);
  });

  it("every history-decided entry in the table carries a rule note", async () => {
    const t = await table;
    for (const e of t.entries) if (e.kind === "by_history" || e.history) expect(e.rule, `${e.house} ${e.fileLocation}`).toMatch(/history/);
  });

  it("excludes reconsideration, amendment, withdraw, re-refer and lay-on-the-table motions at any location", async () => {
    const c = new FloorClassifier(await table);
    const amend = "SB 280 Cervantes Third Reading Urgency By Pellerin Amend By GALLAGHER Set #2 Motion to Lay on the Table By AGUIAR-CURRY";
    expect(c.classify("A", "AF0250", amend)).toMatchObject({ kind: null, reason: "amendment" });
    expect(c.classify("S", "Senate 3rd Reading", "Senate 3rd Reading SB274 Cervantes Motion to Reconsider")).toMatchObject({ kind: null, reason: "reconsideration" });
    expect(motionExclusion("AB 1 Someone Motion to Withdraw")).toBe("withdraw");
    expect(motionExclusion("AB 1 Someone re-refer to committee")).toBe("re-refer");
    expect(motionExclusion("AB 1 Someone Motion to Lay on the Table")).toBe("lay-on-the-table");
    // "Amendments" is not the word Amend.
    expect(motionExclusion("AB 550 Petrie-Norris Concurrence in Senate Amendments")).toBeNull();
  });

  it("strips the Supplemental File suffix", () => {
    expect(normaliseFileLocation("Unfinished Business (Supplemental File 4)")).toBe("Unfinished Business");
    expect(normaliseFileLocation("AF0240")).toBe("AF0240");
    expect(normaliseFileLocation(null)).toBeNull();
  });

  it("the table covers every floor file_location in the slice", async () => {
    const c = new FloorClassifier(await table);
    const reader = await openSource(FIXTURE);
    const t = await loadTables(reader, SESSION);
    await reader.close();
    const floor = t.summaryVotes.filter((r) => r.locationCode === "AFLOOR" || r.locationCode === "SFLOOR");
    expect(floor.length).toBeGreaterThan(30);
    for (const r of floor) expect(c.has(r.locationCode === "AFLOOR" ? "A" : "S", r.fileLocation), `${r.billId} ${r.fileLocation}`).toBe(true);
  });
});

describe("history passages", () => {
  const row = (action: string, primaryLocation: string | null, status = "Applied") => ({
    billId: "x",
    historyId: "1",
    date: "2026-06-25",
    action,
    sequence: 1,
    status,
    primaryLocation,
    secondaryLocation: null,
    ternaryLocation: null,
  });
  // Actions below are copied from BILL_HISTORY_TBL.
  it("recognises a third-reading passage and a concurrence and takes the house from primary_location", () => {
    expect(historyPassage(row("Read third time. Passed. (Ayes 73. Noes  0. Page 5864.) Ordered to the Senate.", "Assembly"))).toMatchObject({ kind: "third_reading", house: "A" });
    expect(historyPassage(row("Assembly amendments concurred in. (Ayes 40. Noes  0. Page 5986.) Ordered to engrossing and enrolling", "Senate"))).toMatchObject({ kind: "concurrence", house: "S" });
    expect(historyPassage(row("Read third time. Urgency clause adopted. Passed. (Ayes 60. Noes 19. Page 3447.) Ordered to the Senate.", "Assembly"))?.kind).toBe("third_reading");
  });
  it("ignores committee recommendations and passages that were reconsidered or rescinded", () => {
    expect(historyPassage(row("From committee: That the Assembly amendments be concurred in. (Ayes 6. Noes 0.) (August 25).", "Senate"))).toBeNull();
    expect(historyPassage(row("Read third time. Passed. (Ayes 30. Noes  6. Page 4360.) Ordered to the Assembly.", null, "Reconsidered"))).toBeNull();
    expect(historyPassage(row("Read third time. Refused passage. (Ayes 35. Noes 12. Page 1657.).", "Assembly"))).toBeNull();
  });
  it("falls back to the wording when primary_location is empty", () => {
    expect(historyPassage(row("Read third time. Passed. (Ayes 30. Noes  6. Page 4360.) Ordered to the Assembly.", null))?.house).toBe("S");
  });
  it("floorAction takes the house of an adoption from primary_location, not from the words", () => {
    // Wordings copied from BILL_HISTORY_TBL (ACA 21): the Senate adopts and sends it to the Assembly, and the reverse.
    expect(floorAction(row("Adopted and to Assembly. (Ayes 35. Noes  0. Page 5018.)", "Senate"))).toMatchObject({ kind: "third_reading", house: "S", ayes: 35, noes: 0 });
    expect(floorAction(row("Adopted and to Senate. (Ayes 71. Noes  0. Page 5866.)", "Assembly"))).toMatchObject({ kind: "third_reading", house: "A", ayes: 71, noes: 0 });
    // With no primary_location there is nothing to decide the house from for this wording.
    expect(floorAction(row("Adopted and to Assembly. (Ayes 35. Noes  0. Page 5018.)", null))).toBeNull();
    expect(floorAction(row("Adopted and to Assembly. (Ayes 35. Noes  0. Page 5018.)", "Senate", "Rescinded"))).toBeNull();
  });
  it("floorAction reads concurrence and passage from the wording, with the tally and the house", () => {
    expect(floorAction(row("Read third time. Urgency clause adopted. Passed. Ordered to the Assembly. (Ayes 29. Noes  4.).", "Senate"))).toMatchObject({ kind: "third_reading", house: "S", ayes: 29, noes: 4 });
    expect(floorAction(row("Assembly amendments concurred in. (Ayes 40. Noes  0. Page 5986.) Ordered to engrossing and enrolling", "Senate"))).toMatchObject({ kind: "concurrence", house: "S", ayes: 40, noes: 0 });
    expect(floorAction(row("From committee: That the Assembly amendments be concurred in. (Ayes 6. Noes 0.) (August 25).", "Senate"))).toBeNull();
    expect(floorAction(row("Read third time. Passed. (Ayes 30. Noes  6. Page 4360.) Ordered to the Assembly.", "Senate", "Reconsidered"))).toBeNull();
    expect(floorAction(row("Read. Adopted. (Ayes 40. Noes  0. Page 5.) Ordered to the Assembly.", "Senate"))).toBeNull();
    expect(floorAction(row("Read third time. Passed.", "Senate"))).toBeNull();
  });
  it("FloorActionIndex finds actions by bill, house, date and tally", () => {
    const idx = new FloorActionIndex([row("Assembly amendments concurred in. (Ayes 40. Noes  0. Page 5986.) Ordered to engrossing and enrolling", "Senate")]);
    expect(idx.find("x", "S", "2026-06-25", 40, 0)).toHaveLength(1);
    expect(idx.find("x", "S", "2026-06-25", 40, 1)).toHaveLength(0);
    expect(idx.find("x", "A", "2026-06-25", 40, 0)).toHaveLength(0);
    expect(idx.find("x", "S", "2026-06-26", 40, 0)).toHaveLength(0);
  });
  it("reads the tally", () => {
    expect(parseTally("Read third time. Passed. (Ayes 73. Noes  0. Page 5864.) Ordered to the Senate.")).toEqual({ ayes: 73, noes: 0 });
    expect(parseTally("Enrolled and presented to the Governor at  2 p.m.")).toBeNull();
  });
});

describe("text extraction", () => {
  it("docx text: paragraphs as lines, field codes dropped (AB 550 concurrence analysis)", async () => {
    const text = docxToText(new Uint8Array(await readFile(join(FIXTURE, "BILL_ANALYSIS_TBL_20762.lob"))));
    expect(text).not.toContain("MERGEFIELD");
    expect(text.split("\n")[0]?.trim() === "" || text.startsWith("CONCURRENCE IN SENATE AMENDMENTS")).toBe(true);
    expect(text).toContain("CONCURRENCE IN SENATE AMENDMENTS");
    expect(text).toContain("Arguments in Support\n");
    expect(text).toContain("ASSEMBLY FLOOR:  76-0-3\n");
  });

  it("digest: paragraphs joined by a blank line, tags and indentation removed (AB 550 chaptered version)", async () => {
    const xml = await readFile(join(FIXTURE, "BILL_VERSION_TBL_18950.lob"), "utf8");
    const d = extractDigest(xml);
    expect(d).not.toBeNull();
    const paragraphs = (d as string).split("\n\n");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]?.startsWith("This bill would also allow the department to authorize by permit the take of a species proposed for listing")).toBe(true);
    expect(d).not.toMatch(/[<>\t]/);
    expect(d).toContain("if specified conditions are met, including that");
  });

  it("digest is null when the XML has none", () => {
    expect(extractDigest("<caml:MeasureDoc></caml:MeasureDoc>")).toBeNull();
  });
});

describe("analysis section parser", () => {
  it("returns nulls when headings are missing or ambiguous", () => {
    expect(parseAnalysisSections("no headings at all")).toEqual({
      digest: null,
      support: null,
      opposition: null,
      positionsVerified: null,
      argumentsInSupport: null,
      argumentsInOpposition: null,
    });
    const twice = "SUPPORT:\n\tA\nOPPOSITION:\n\tB\n-- END --\nSUPPORT:\n\tC\n-- END --";
    expect(parseAnalysisSections(twice).support).toBeNull();
  });

  it("needs a following heading to know where a list ends", () => {
    expect(parseAnalysisSections("SUPPORT:\nSome Org\nOther Org").support).toBeNull();
    expect(parseAnalysisSections("SUPPORT:\nSome Org\nOPPOSITION:\nNone received\n-- END --")).toMatchObject({
      support: ["Some Org"],
      opposition: [],
    });
  });

  it("reads the verified date and returns null for an impossible one", () => {
    expect(parseAnalysisSections("SUPPORT:\t(Verified 8/13/26)\nOrg\nOPPOSITION:\t(Verified\t8/13/26)\nNone received\n-- END --").positionsVerified).toBe("2026-08-13");
    expect(parseAnalysisSections("SUPPORT:\t(Verified 7/725)\nOrg\nOPPOSITION:\nNone received\n-- END --").positionsVerified).toBeNull();
  });

  describe("digest or summary section", () => {
    const parse = (t: string): string | null => parseAnalysisSections(t).digest;
    it("DIGEST on a line of its own with the text in the following paragraphs", () => {
      expect(parse("DIGEST:\n\tFirst paragraph.\n\nSecond paragraph.\nANALYSIS:\nExisting law:")).toBe("First paragraph.\n\nSecond paragraph.");
    });
    it("SUMMARY with or without a colon, on a line of its own", () => {
      expect(parse("SUMMARY\nThis bill does a thing.\nSenate Amendments\nMore.\nCOMMENTS\nBackground")).toBe("This bill does a thing.\nSenate Amendments\nMore.");
      expect(parse("SUMMARY:\nThis bill does a thing.\nFISCAL EFFECT:\nNone.")).toBe("This bill does a thing.");
    });
    it("the text on the heading's own line, after a colon, spaces or a tab", () => {
      expect(parse("DIGEST:  This bill allows it.\nANALYSIS:\nx")).toBe("This bill allows it.");
      expect(parse("SUMMARY:\tEstablishes a thing.\n\nRequires another.\nEXISTING LAW:\nx")).toBe("Establishes a thing.\n\nRequires another.");
    });
    it("Senate Appropriations 'Bill Summary:' heading", () => {
      expect(parse("Bill Summary:\n  SB 1 would do a thing.\nFiscal Impact:\n  None.")).toBe("SB 1 would do a thing.");
    });
    it("is an exact slice of the text", () => {
      const text = "x\nSUMMARY:\t A  b\u00a0 c.\n\n d  e \nCOMMENTS:\ny";
      const d = parse(text) as string;
      expect(text.includes(d)).toBe(true);
      expect(d).toBe("A  b\u00a0 c.\n\n d  e");
    });
    it("is null when the heading appears twice, no heading follows, or the body is empty", () => {
      expect(parse("SUMMARY:\nA.\nCOMMENTS:\nx\nSUMMARY:\nB.\nCOMMENTS:\ny")).toBeNull();
      expect(parse("DIGEST:\nA.\nANALYSIS:\nx\nSUMMARY:  B.\nCOMMENTS:\ny")).toBeNull();
      expect(parse("SUMMARY:\nThis bill does a thing.")).toBeNull();
      expect(parse("SUMMARY:\nCOMMENTS:\nx")).toBeNull();
      expect(parse("DIGEST:\nNone\nANALYSIS:\nx")).toBeNull();
    });
    it("is not taken from a lower-case word or from the middle of a line", () => {
      expect(parse("Summary: a thing.\nCOMMENTS:\nx")).toBeNull();
      expect(parse("See the SUMMARY: here.\nCOMMENTS:\nx")).toBeNull();
    });
  });
});

describe("util", () => {
  it("stable JSON sorts keys and keeps array order", () => {
    expect(stableStringify({ b: 1, a: [3, 1, 2], c: { z: null, y: "x" }, d: undefined })).toBe('{"a":[3,1,2],"b":1,"c":{"y":"x","z":null}}');
  });
  it("ascii slug", () => {
    expect(asciiSlug("Ávila Farías")).toBe("avila-farias");
    expect(asciiSlug("Weber Pierson")).toBe("weber-pierson");
    expect(asciiSlug("Mark González")).toBe("mark-gonzalez");
  });
  it("numeric string compare", () => {
    expect(compareNumericStrings("9", "10")).toBeLessThan(0);
  });
  it("row ranges", () => {
    expect(rangesOf([1, 2, 3, 7, 9, 10])).toBe("1-3, 7, 9-10");
  });
});

describe("make-fixture", () => {
  it("copies whole rows verbatim and records the original row numbers", async () => {
    const out = await tempDir("mini-");
    const reader = await openSource(FIXTURE);
    const report = await makeFixture(reader, {
      bills: ["202520260AB550"],
      outDir: out,
      sourceFile: "pubinfo_2025.zip",
      sourceDate: "2026-11-16T05:26:36Z",
      command: "test",
    });
    await reader.close();
    const names = await readdir(out);
    expect(names).toContain("FIXTURE.md");
    expect(names).toContain("BILL_TBL.dat");
    const billRows = readRows(await readFile(join(out, "BILL_TBL.dat"), "utf8"));
    expect(billRows.map((r) => r[0])).toEqual(["202520260AB550"]);
    const md = await readFile(join(out, "FIXTURE.md"), "utf8");
    expect(md).toContain("Source Last-Modified: `2026-11-16T05:26:36Z`");
    // The row numbers refer to the source it read: find the AB 550 row there.
    const srcRows = readRows(await readFile(join(FIXTURE, "BILL_TBL.dat"), "utf8"));
    const rowNumber = srcRows.findIndex((r) => r[0] === "202520260AB550") + 1;
    expect(report.tables.find((t) => t.name === "BILL_TBL.dat")?.rows).toEqual([rowNumber]);
    const analysisRows = readRows(await readFile(join(out, "BILL_ANALYSIS_TBL.dat"), "utf8"));
    expect(analysisRows).toHaveLength(2);
    expect(analysisRows.map((r) => r[0])).toContain("405279");
    expect(report.lobs).toContain("BILL_VERSION_TBL_18950.lob");
  });
});

describe("applyHistoryRules (synthetic roll calls)", () => {
  const hist = (id: string, action: string, date = "2026-01-05") => ({
    billId: "b1",
    historyId: id,
    date,
    action,
    sequence: Number(id),
    status: "Applied",
    primaryLocation: "Senate",
    secondaryLocation: null,
    ternaryLocation: null,
  });
  const cand = (key: string, motionText: string, ayes: number, noes: number, over: Partial<HistoryCandidate> = {}): HistoryCandidate => ({
    key,
    billId: "b1",
    house: "S",
    date: "2026-01-05",
    ayes,
    noes,
    motionText,
    kind: null,
    history: "required",
    group: "S W/O REF. TO FILE",
    fileLocation: "W/O REF. TO FILE",
    excluded: false,
    ...over,
  });
  const concurred = hist("1", "Assembly amendments concurred in. (Ayes 30. Noes  2. Page 9.) Ordered to engrossing and enrolling.");

  it("a Senate urgency-clause roll call is excluded when another roll call of the bill, house and date matched the history", () => {
    const main = cand("main", "W/O REF. TO FILE SB1 Someone", 30, 2);
    const urgency = cand("urgency", "W/O REF. TO FILE SB1 Someone Urgency Clause", 30, 2);
    const r = applyHistoryRules([urgency, main], new FloorActionIndex([concurred]));
    expect([main.kind, urgency.kind]).toEqual(["concurrence", null]);
    expect(r.decisions.find((d) => d.reason === "urgency-clause")).toMatchObject({ motionText: expect.stringContaining("Urgency Clause") });
    expect(r.excludedByReason).toEqual({ "urgency-clause": 1 });
    // The same answer whatever the order of the rows.
    const main2 = cand("main", "W/O REF. TO FILE SB1 Someone", 30, 2);
    const urgency2 = cand("urgency", "W/O REF. TO FILE SB1 Someone Urgency Clause", 30, 2);
    applyHistoryRules([main2, urgency2], new FloorActionIndex([concurred]));
    expect([main2.kind, urgency2.kind]).toEqual(["concurrence", null]);
  });

  it("an urgency-clause roll call whose tally differs still goes when the main roll call matched", () => {
    const main = cand("main", "W/O REF. TO FILE SB1 Someone", 30, 2);
    const urgency = cand("urgency", "W/O REF. TO FILE SB1 Someone Urgency Clause", 28, 4);
    applyHistoryRules([main, urgency], new FloorActionIndex([concurred]));
    expect([main.kind, urgency.kind]).toEqual(["concurrence", null]);
  });

  it("an urgency-clause roll call that is the only one gets the history rule", () => {
    const urgency = cand("urgency", "W/O REF. TO FILE SB1 Someone Urgency Clause", 30, 2);
    applyHistoryRules([urgency], new FloorActionIndex([concurred]));
    expect(urgency.kind).toBe("concurrence");
    const noMatch = cand("urgency", "W/O REF. TO FILE SB1 Someone Urgency Clause", 31, 1);
    const r = applyHistoryRules([noMatch], new FloorActionIndex([concurred]));
    expect(noMatch.kind).toBeNull();
    expect(r.noMatch).toHaveLength(1);
    expect(r.excludedByReason).toEqual({ "no-history-match": 1 });
  });

  it("an urgency-clause roll call is not a duplicate of a roll call that is itself excluded", () => {
    const reconsider = cand("rc", "W/O REF. TO FILE SB1 Someone Motion to Reconsider", 30, 2, { excluded: true });
    const urgency = cand("urgency", "W/O REF. TO FILE SB1 Someone Urgency Clause", 30, 2);
    applyHistoryRules([reconsider, urgency], new FloorActionIndex([concurred]));
    expect(urgency.kind).toBe("concurrence");
  });

  it("a passage action makes a W/O REF. roll call a third reading, and leaves a consent location as consent", () => {
    const passed = hist("2", "Read third time. Passed. Ordered to the Assembly. (Ayes 38. Noes  0. Page 3.).");
    const wo = cand("wo", "W/O REF. TO FILE SB1 Someone", 38, 0);
    const consent = cand("consent", "Consent Calendar 2nd SB1 Someone", 38, 0, { history: "refine", kind: "consent", group: "S Consent Calendar 2nd" });
    const r = applyHistoryRules([wo, consent], new FloorActionIndex([passed]));
    expect([wo.kind, consent.kind]).toEqual(["third_reading", "consent"]);
    expect(r.consentBecameConcurrence).toEqual({});
  });

  it("only an Applied action in the same house, on the same date, with the same tally matches", () => {
    const wo = (): HistoryCandidate => cand("wo", "W/O REF. TO FILE SB1 Someone", 30, 2);
    const cases: Array<[string, Parameters<typeof hist>[1], Partial<ReturnType<typeof hist>>]> = [
      ["status", concurred.action, { status: "Rescinded" }],
      ["house", concurred.action, { primaryLocation: "Assembly" }],
      ["date", concurred.action, { date: "2026-01-06" }],
    ];
    for (const [name, action, over] of cases) {
      const c = wo();
      applyHistoryRules([c], new FloorActionIndex([{ ...hist("1", action), ...over }]));
      expect(c.kind, name).toBeNull();
    }
  });

  it("a tally that matches both a concurrence and a passage fails the build", () => {
    const passed = hist("2", "Read third time. Passed. Ordered to the Assembly. (Ayes 30. Noes  2. Page 3.).");
    expect(() => applyHistoryRules([cand("wo", "W/O REF. TO FILE SB1 Someone", 30, 2)], new FloorActionIndex([concurred, passed]))).toThrow(/history-ambiguous|both a concurrence and a passage/);
  });

  it("a second-reading roll call counts only when a history action has its tally: passage -> third reading, concurred in -> concurrence", () => {
    const passed = hist("2", "Read third time. Passed. Ordered to the Assembly. (Ayes 38. Noes  0. Page 3.).");
    const group = { history: "optional" as const, group: "S Assembly 2nd Reading", fileLocation: "Assembly 2nd Reading" };
    const tr = cand("tr", "Assembly 2nd Reading AB1 Someone", 38, 0, group);
    const conc = cand("conc", "Assembly 2nd Reading AB1 Someone", 30, 2, group);
    const plain = cand("plain", "Assembly 2nd Reading AB2 Someone", 33, 1, group);
    const r = applyHistoryRules([tr, conc, plain], new FloorActionIndex([passed, concurred]));
    expect([tr.kind, conc.kind, plain.kind]).toEqual(["third_reading", "concurrence", null]);
    expect(r.upgrades.map((u) => [u.id, u.kind, u.historyLine.split(".")[0]])).toEqual([
      ["tr", "third_reading", "Read third time"],
      ["conc", "concurrence", "Assembly amendments concurred in"],
    ]);
    // An ordinary second-reading vote is not an exclusion by "no-history-match" and is not listed there.
    expect(r.noMatch).toEqual([]);
    expect(r.excludedByReason).toEqual({ location: 1 });
  });

  it("a second-reading roll call whose motion text excludes it stays excluded whatever the history says", () => {
    const passed = hist("2", "Read third time. Passed. Ordered to the Assembly. (Ayes 38. Noes  0. Page 3.).");
    const c = cand("rc", "Assembly 2nd Reading AB1 Someone Motion to Reconsider", 38, 0, { history: "optional", excluded: true });
    applyHistoryRules([c], new FloorActionIndex([passed]));
    expect(c.kind).toBeNull();
  });

  it("a constitutional amendment's 'Adopted and to <house>.' action is its passage: W/O REF. roll call -> third reading", () => {
    const adopted = hist("3", "Adopted and to Assembly. (Ayes 35. Noes  0. Page 5018.)");
    const c = cand("aca", "W/O REF. TO FILE ACA1 Someone", 35, 0);
    const r = applyHistoryRules([c], new FloorActionIndex([adopted]));
    expect(c.kind).toBe("third_reading");
    expect(r.excludedByReason).toEqual({});
    expect(r.decisions[0]).toMatchObject({ kind: "third_reading", reason: null });
  });

  it("other 'Adopted' wordings are not a passage: only the anchored 'Adopted and to Assembly/Senate.' with a tally counts", () => {
    for (const action of [
      "Read. Adopted. (Ayes 35. Noes  0. Page 5.) Ordered to the Assembly.",
      "From committee: Be adopted. (Ayes 35. Noes  0.) (May 1).",
      "Motion to take up Adopted and to Assembly. (Ayes 35. Noes  0. Page 5.)",
      "Adopted and to Assembly.",
    ]) {
      const c = cand("wo", "W/O REF. TO FILE ACA1 Someone", 35, 0);
      applyHistoryRules([c], new FloorActionIndex([hist("3", action)]));
      expect(c.kind, action).toBeNull();
    }
  });

  it("counts Senate urgency-clause roll calls outside the history-decided locations without changing them", () => {
    const tr = cand("tr", "Senate 3rd Reading SB1 Someone Urgency Clause", 29, 10, { history: null, kind: "third_reading", group: "S Senate 3rd Reading" });
    const r = applyHistoryRules([tr], new FloorActionIndex([]));
    expect(tr.kind).toBe("third_reading");
    expect(r.urgencyClauseOutside).toEqual({ "S Senate 3rd Reading": 1 });
  });
});
