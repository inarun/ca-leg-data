import { unzipSync } from "fflate";

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED[body] ?? whole;
  });
}

/**
 * Text of a .docx analysis. Paragraph ends and line breaks become "\n", tabs "\t". Word field
 * instructions (MERGEFIELD ...) are not visible text and are left out; everything else in
 * word/document.xml is kept.
 */
export function docxToText(docx: Uint8Array): string {
  const files = unzipSync(docx, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("not a .docx: word/document.xml is missing");
  const doc = new TextDecoder("utf-8").decode(xml);
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<\/w:p>|<w:instrText(?:\s[^>]*)?>[^<]*<\/w:instrText>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const token = m[0];
    if (m[1] !== undefined) out.push(decodeEntities(m[1]));
    else if (token === "<w:tab/>") out.push("\t");
    else if (token.startsWith("<w:instrText")) continue;
    else out.push("\n");
  }
  return out.join("");
}

/**
 * Legislative Counsel's Digest from a bill version's XML: the paragraphs of
 * <caml:DigestText>, tags removed, whitespace inside a paragraph collapsed, paragraphs joined
 * with a blank line. Null when the version has no digest text.
 */
export function extractDigest(xml: string): string | null {
  const m = /<caml:DigestText>([\s\S]*?)<\/caml:DigestText>/.exec(xml);
  if (!m) return null;
  const body = m[1] as string;
  const clean = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  const paragraphs: string[] = [];
  const pRe = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g;
  let p: RegExpExecArray | null;
  while ((p = pRe.exec(body)) !== null) {
    const t = clean(p[1] as string);
    if (t !== "") paragraphs.push(t);
  }
  if (paragraphs.length === 0) {
    const t = clean(body);
    if (t !== "") paragraphs.push(t);
  }
  return paragraphs.length > 0 ? paragraphs.join("\n\n") : null;
}
