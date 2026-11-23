/**
 * Conservative section parser for analysis text. A section is filled only when its heading is
 * found exactly once as a line of its own and a known heading (or an end marker) follows it.
 * Every string returned is an exact slice of the input text; anything doubtful is null.
 */

export interface ParsedSections {
  digest: string | null;
  support: string[] | null;
  opposition: string[] | null;
  /** "YYYY-MM-DD" taken from a "(Verified 8/13/26)" note on the support or opposition heading. */
  positionsVerified: string | null;
  argumentsInSupport: string | null;
  argumentsInOpposition: string | null;
}

interface Line {
  /** Trimmed content. */
  t: string;
  /** Offsets of the trimmed content in the text. */
  start: number;
  end: number;
}

const MAX_ITEM_LENGTH = 400;

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    lines.push({ t, start: pos + lead, end: pos + lead + t.length });
    pos += raw.length + 1;
  }
  return lines;
}

const VERIFIED = String.raw`(?:\s*\(Verified\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\))?`;
const SUPPORT_HEADING = new RegExp(`^SUPPORT:?${VERIFIED}$`, "i");
const OPPOSITION_HEADING = new RegExp(`^OPPOS(?:ITION|ED?):?${VERIFIED}$`, "i");
// The analysis's own summary: "DIGEST" on Senate floor analyses, "SUMMARY" on Assembly analyses and
// "Bill Summary" on Senate Appropriations analyses. The heading is either a line of its own (colon
// optional) or the label and a colon followed by the text on the same line. Spelt as in the documents.
const DIGEST_HEADING = /^(?:DIGEST|SUMMARY|BILL SUMMARY|Bill Summary):?$/;
const DIGEST_INLINE_HEADING = /^(?:DIGEST|SUMMARY|BILL SUMMARY|Bill Summary)\s*:\s*(\S.*)$/;
const ARG_SUPPORT_HEADING = /^ARGUMENTS? IN SUPPORT:?$/i;
const ARG_OPPOSITION_HEADING = /^ARGUMENTS? IN OPPOSITION:?$/i;
const NONE_MARKER = /^none(?: received| on file| known)?\.?$/i;

const KNOWN_HEADINGS = [
  /^(?:DIGEST|ANALYSIS|SUMMARY|BACKGROUND|COMMENTS?|STAFF COMMENTS|EXISTING LAW|THIS BILL|SUPPORT|OPPOSITION|OPPOSED?|REGISTERED SUPPORT \/ OPPOSITION|SUPPORT AND OPPOSITION|POSITIONS|VOTES|UPDATED|PRIOR VOTES|RELATED LEGISLATION|HISTORY|SUBJECT|SOURCE|PURPOSE|EXECUTIVE SUMMARY|PROPOSED CHANGES TO THE LAW|FISCAL|FISCAL COMMENTS|FISCAL EFFECT|FISCAL IMPACT|ARGUMENTS? IN (?:SUPPORT|OPPOSITION))\b[^a-z]{0,3}(?:\(Verified[^)]*\))?$/i,
  /^(?:FISCAL EFFECT|FISCAL IMPACT|FISCAL|SUBJECT|SOURCE|PREPARED BY|ANALYSIS PREPARED BY|CONSULTANT|HEARING DATE|VERSION)\s*:/i,
  /^(?:-- END --|\*+\s*END\s*\*+)$/,
  // Vote and committee lines in capitals, e.g. "ASSEMBLY FLOOR:  76-0-3".
  /^[A-Z][A-Z0-9&.,\/ \-]{2,79}:(?:\s|$)/,
];

const isHeading = (t: string): boolean => t !== "" && KNOWN_HEADINGS.some((re) => re.test(t));

function verifiedDate(m: RegExpExecArray | null): string | null {
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Index of the next heading after `from`, or -1 when none follows. */
function nextHeading(lines: Line[], from: number): number {
  for (let i = from; i < lines.length; i++) if (isHeading((lines[i] as Line).t)) return i;
  return -1;
}

function findOnce(lines: Line[], re: RegExp): { index: number; match: RegExpExecArray } | null {
  let found: { index: number; match: RegExpExecArray } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec((lines[i] as Line).t);
    if (m) {
      if (found) return null; // heading appears more than once: ambiguous
      found = { index: i, match: m };
    }
  }
  return found;
}

/** Body lines (non-empty) between a heading and the next known heading. Null if no heading follows. */
function bodyLines(lines: Line[], headingIndex: number): Line[] | null {
  const stop = nextHeading(lines, headingIndex + 1);
  if (stop === -1) return null;
  return lines.slice(headingIndex + 1, stop).filter((l) => l.t !== "");
}

// A sub-heading inside a list, e.g. "Oppose Unless Amended" or "Opposition (unless amended)": the names below it
// are not plain supporters or opponents. The word that opens the line says which side it speaks for.
const QUALIFIED_SUBHEADING = /^(oppose|opposition|support)\b.*\b(?:unless|if) amended/i;
// A "none" sentence in place of a list: "None submitted.", "None received for this version of the bill."
const NONE_SENTENCE = /^none\b/i;
// A line that dates a verification, e.g. "Last verified 4/18/26" or "Oppose Last verified 4/19/26".
const VERIFIED_DATE_LINE = /\bverified\b[^\n]*\d{1,2}\/\d{1,2}\/\d{2,4}/i;
const VERIFIED_MARKER_LINE = /^\(?\s*(?:last\s+)?verified\s+(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*\)?\.?$/i;

type Side = "support" | "opposition";

interface ListResult {
  list: string[] | null;
  /** The list holds a sub-heading of the other side, so the layout of the paired list cannot be trusted either. */
  mixedSides: boolean;
}

/**
 * The names under a SUPPORT or OPPOSITION heading. The list is null whenever it cannot be read as a plain list of
 * that side: a "none" line among names, a qualified sub-heading ("Oppose Unless Amended"), a line dating a
 * verification (unless it is cleanly the verified marker the heading itself already gave), or an over-long line.
 */
function listSection(lines: Line[], found: { index: number } | null, text: string, side: Side, headingVerified: string | null): ListResult {
  const none: ListResult = { list: null, mixedSides: false };
  if (!found) return none;
  let body = bodyLines(lines, found.index);
  if (!body || body.length === 0) return none;
  if (body.length === 1 && NONE_SENTENCE.test((body[0] as Line).t)) return { list: [], mixedSides: false };
  if (body.some((l) => NONE_SENTENCE.test(l.t))) return none;
  const sub = body.find((l) => QUALIFIED_SUBHEADING.test(l.t));
  if (sub) {
    const subSide: Side = /^support/i.test(sub.t) ? "support" : "opposition";
    return { list: null, mixedSides: subSide !== side };
  }
  const last = body[body.length - 1] as Line;
  const marker = VERIFIED_MARKER_LINE.exec(last.t);
  if (marker && headingVerified !== null && verifiedDate(marker) === headingVerified) body = body.slice(0, -1);
  if (body.some((l) => VERIFIED_DATE_LINE.test(l.t))) return none;
  if (body.length === 0) return none;
  if (body.some((l) => l.t.length > MAX_ITEM_LENGTH)) return none;
  return { list: body.map((l) => text.slice(l.start, l.end)), mixedSides: false };
}

function textSection(lines: Line[], found: { index: number } | null, text: string, allowNone: boolean): string | null {
  if (!found) return null;
  const body = bodyLines(lines, found.index);
  if (!body || body.length === 0) return null;
  if (!allowNone && body.length === 1 && NONE_MARKER.test((body[0] as Line).t)) return null;
  const first = body[0] as Line;
  const last = body[body.length - 1] as Line;
  return text.slice(first.start, last.end);
}

/**
 * The digest/summary section. Every line that is a DIGEST or SUMMARY heading, in either form,
 * counts; the section is filled only when there is exactly one and a known heading follows it.
 * For the inline form the section starts at the first character after the colon.
 */
function digestSection(lines: Line[], text: string): string | null {
  let found: { index: number; inlineStart: number | null } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] as Line).t;
    let hit: { index: number; inlineStart: number | null } | null = null;
    if (DIGEST_HEADING.test(t)) hit = { index: i, inlineStart: null };
    else {
      const m = DIGEST_INLINE_HEADING.exec(t);
      if (m) hit = { index: i, inlineStart: (lines[i] as Line).start + (t.length - (m[1] as string).length) };
    }
    if (hit) {
      if (found) return null; // more than one heading: ambiguous
      found = hit;
    }
  }
  if (!found) return null;
  const stop = nextHeading(lines, found.index + 1);
  if (stop === -1) return null;
  const body = lines.slice(found.index + 1, stop).filter((l) => l.t !== "");
  if (found.inlineStart !== null) {
    const end = body.length > 0 ? (body[body.length - 1] as Line).end : (lines[found.index] as Line).end;
    return text.slice(found.inlineStart, end);
  }
  if (body.length === 0) return null;
  if (body.length === 1 && NONE_MARKER.test((body[0] as Line).t)) return null;
  return text.slice((body[0] as Line).start, (body[body.length - 1] as Line).end);
}

export function parseAnalysisSections(text: string): ParsedSections {
  const lines = splitLines(text);
  const supportH = findOnce(lines, SUPPORT_HEADING);
  const oppositionH = findOnce(lines, OPPOSITION_HEADING);
  const argSupportH = findOnce(lines, ARG_SUPPORT_HEADING);
  const argOppositionH = findOnce(lines, ARG_OPPOSITION_HEADING);

  const dates = [supportH, oppositionH]
    .map((h) => (h ? verifiedDate(h.match) : null))
    .filter((d): d is string => d !== null);
  const positionsVerified = dates.length > 0 && dates.every((d) => d === dates[0]) ? (dates[0] as string) : null;

  const supportList = listSection(lines, supportH, text, "support", positionsVerified);
  const oppositionList = listSection(lines, oppositionH, text, "opposition", positionsVerified);
  // A sub-heading of the other side in a list means the names around it cannot be assigned to a side with
  // confidence, so neither list is published.
  const mixed = supportList.mixedSides || oppositionList.mixedSides;

  return {
    digest: digestSection(lines, text),
    support: mixed ? null : supportList.list,
    opposition: mixed ? null : oppositionList.list,
    positionsVerified,
    argumentsInSupport: textSection(lines, argSupportH, text, false),
    argumentsInOpposition: textSection(lines, argOppositionH, text, false),
  };
}
