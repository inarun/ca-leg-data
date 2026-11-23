import { createHash } from "node:crypto";

/** Failure that must stop the build with a non-zero exit code and no output written. */
export class IngestError extends Error {
  readonly code: string;
  readonly details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(`${code}: ${message}${details.length ? "\n  " + details.slice(0, 40).join("\n  ") + (details.length > 40 ? `\n  ... and ${details.length - 40} more` : "") : ""}`);
    this.name = "IngestError";
    this.code = code;
    this.details = details;
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted, no whitespace, no trailing newline.
 * Arrays keep their order, so callers sort arrays that need a defined order.
 */
export function stableStringify(value: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null) {
      parts.push("null");
    } else if (typeof v === "string") {
      parts.push(JSON.stringify(v));
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("cannot serialise a non-finite number");
      parts.push(String(v));
    } else if (typeof v === "boolean") {
      parts.push(v ? "true" : "false");
    } else if (Array.isArray(v)) {
      parts.push("[");
      v.forEach((item, i) => {
        if (i > 0) parts.push(",");
        walk(item === undefined ? null : item);
      });
      parts.push("]");
    } else if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareStrings);
      parts.push("{");
      keys.forEach((k, i) => {
        if (i > 0) parts.push(",");
        parts.push(JSON.stringify(k), ":");
        walk(obj[k]);
      });
      parts.push("}");
    } else {
      throw new Error(`cannot serialise a value of type ${typeof v}`);
    }
  };
  walk(value);
  return parts.join("");
}

/** Code-unit string order, independent of locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lowercase ASCII slug: accents stripped, runs of other characters become one hyphen. */
export function asciiSlug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "2026-11-16T05:26:36Z" -> "20261116T052636Z" */
export function compactTimestamp(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(iso);
  if (!m) throw new IngestError("bad-timestamp", `expected an ISO 8601 UTC timestamp ending in Z, got ${iso}`);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Numeric-aware compare of digit strings (ids, sequence numbers). */
export function compareNumericStrings(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
  return compareStrings(a, b);
}
