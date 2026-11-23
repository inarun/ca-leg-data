import { readFile } from "node:fs/promises";
import type { House, Person, PersonId, PersonTerm } from "../schema/snapshot-v1.ts";
import type { LegislatorRow } from "./tables.ts";
import { IngestError, asciiSlug, compareStrings } from "./util.ts";

/** One entry of tables/people-<session>.json. */
export interface PersonMapEntry {
  id: PersonId;
  house: House;
  /** Exact strings this person appears under in vote rows of that house. */
  voteNames: string[];
  /** LEGISLATOR_TBL rows, written `${district}|${legislator_name}`. */
  rows: string[];
}

export interface PeopleTable {
  session: string;
  people: PersonMapEntry[];
}

export function legislatorRowKey(r: { district: string; legislatorName: string | null }): string {
  return `${r.district}|${r.legislatorName ?? ""}`;
}

export function isNamedRow(r: LegislatorRow): boolean {
  return r.legislatorName !== null && r.authorName !== null && r.authorName !== "";
}

export function houseOfLegislatorRow(r: LegislatorRow): House {
  if (r.house === "A" || r.house === "S") return r.house;
  throw new IngestError("people-house", `LEGISLATOR_TBL row ${legislatorRowKey(r)} has house_type ${JSON.stringify(r.house)}`);
}

export function personIdFor(house: House, authorName: string): PersonId {
  return `ca-${house.toLowerCase()}-${asciiSlug(authorName)}`;
}

export function mapParty(code: string | null): string | null {
  if (code === null || code === "") return null;
  if (code === "DEM") return "Democratic";
  if (code === "REP") return "Republican";
  return code;
}

export async function loadPeopleTable(path: string): Promise<PeopleTable> {
  const raw = JSON.parse(await readFile(path, "utf8")) as PeopleTable;
  if (!raw || !Array.isArray(raw.people) || typeof raw.session !== "string") {
    throw new IngestError("people-table", `${path} is not a people table`);
  }
  return raw;
}

/**
 * Draft a people table from LEGISLATOR_TBL: one person per (house, author_name), vote name =
 * author_name. Cases the file cannot tell (a name spelt two ways, a short vote name) are left for
 * hand editing; `unmappedVoteNames` lists the vote names the draft does not cover.
 */
export function draftPeopleTable(
  session: string,
  legislators: LegislatorRow[],
  voteNames: Map<House, Set<string>>,
): { table: PeopleTable; unmappedVoteNames: Array<{ house: House; name: string }> } {
  const byId = new Map<PersonId, PersonMapEntry>();
  for (const r of legislators) {
    if (!isNamedRow(r)) continue;
    const house = houseOfLegislatorRow(r);
    const id = personIdFor(house, r.authorName as string);
    let p = byId.get(id);
    if (!p) {
      p = { id, house, voteNames: [r.authorName as string], rows: [] };
      byId.set(id, p);
    }
    if (!p.voteNames.includes(r.authorName as string)) p.voteNames.push(r.authorName as string);
    p.rows.push(legislatorRowKey(r));
  }
  const people = [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
  const known = new Map<string, PersonId>();
  for (const p of people) for (const n of p.voteNames) known.set(`${p.house}|${n}`, p.id);
  const unmapped: Array<{ house: House; name: string }> = [];
  for (const house of ["A", "S"] as House[]) {
    for (const name of [...(voteNames.get(house) ?? [])].sort(compareStrings)) {
      if (!known.has(`${house}|${name}`)) unmapped.push({ house, name });
    }
  }
  return { table: { session, people }, unmappedVoteNames: unmapped };
}

export interface ResolvedPeople {
  people: Person[];
  /** `${house}|${vote name}` -> person id */
  byVoteName: Map<string, PersonId>;
  /** Ordered person ids per house. */
  rosters: Record<House, PersonId[]>;
}

const districtNumber = (district: string): number => {
  const m = /(\d+)$/.exec(district);
  return m ? Number(m[1]) : 0;
};

/**
 * Checks the table against LEGISLATOR_TBL and builds Person records and rosters.
 * Fails on a named row with no person, a row or vote name mapped to two people, or a duplicate id.
 */
export function resolvePeople(session: string, table: PeopleTable, legislators: LegislatorRow[]): ResolvedPeople {
  const problems: string[] = [];
  if (table.session !== session) {
    throw new IngestError("people-table", `people table is for session ${table.session}, building ${session}`);
  }

  const ids = new Set<PersonId>();
  const rowOwner = new Map<string, PersonId>();
  const voteNameOwner = new Map<string, PersonId>();
  for (const p of table.people) {
    if (ids.has(p.id)) problems.push(`person id ${p.id} appears twice in the people table`);
    ids.add(p.id);
    if (!p.id.startsWith(`ca-${p.house.toLowerCase()}-`)) problems.push(`person id ${p.id} does not match house ${p.house}`);
    for (const row of p.rows) {
      const prev = rowOwner.get(row);
      if (prev !== undefined && prev !== p.id) problems.push(`LEGISLATOR_TBL row ${row} is mapped to two people: ${prev} and ${p.id}`);
      rowOwner.set(row, p.id);
    }
    for (const name of p.voteNames) {
      const key = `${p.house}|${name}`;
      const prev = voteNameOwner.get(key);
      if (prev !== undefined && prev !== p.id) problems.push(`vote name ${JSON.stringify(name)} (${p.house}) is mapped to two people: ${prev} and ${p.id}`);
      voteNameOwner.set(key, p.id);
    }
  }

  const rowsByKey = new Map<string, LegislatorRow[]>();
  for (const r of legislators) {
    if (!isNamedRow(r)) continue;
    const key = legislatorRowKey(r);
    const list = rowsByKey.get(key) ?? [];
    list.push(r);
    rowsByKey.set(key, list);
    if (!rowOwner.has(key)) problems.push(`named LEGISLATOR_TBL row ${key} is not mapped to a person`);
  }
  for (const [key, list] of rowsByKey) {
    if (list.length > 1) problems.push(`LEGISLATOR_TBL has ${list.length} rows with the key ${key}; the people table cannot tell them apart`);
  }
  for (const key of rowOwner.keys()) {
    if (!rowsByKey.has(key)) problems.push(`people table row ${key} is not a named LEGISLATOR_TBL row`);
  }
  if (problems.length > 0) throw new IngestError("people-map", "the people table does not match LEGISLATOR_TBL", problems);

  const people: Person[] = [];
  const rosterEntries: Record<House, Array<{ id: PersonId; district: string }>> = { A: [], S: [] };
  for (const p of [...table.people].sort((a, b) => compareStrings(a.id, b.id))) {
    const rows = p.rows.map((k) => (rowsByKey.get(k) as LegislatorRow[])[0] as LegislatorRow);
    const byDistrict = new Map<string, LegislatorRow[]>();
    for (const r of rows) {
      if (houseOfLegislatorRow(r) !== p.house) problems.push(`person ${p.id} (${p.house}) maps row ${legislatorRowKey(r)} of house ${r.house}`);
      const list = byDistrict.get(r.district) ?? [];
      list.push(r);
      byDistrict.set(r.district, list);
    }
    const terms: PersonTerm[] = [];
    for (const [district, list] of [...byDistrict].sort((a, b) => compareStrings(a[0], b[0]))) {
      // Prefer the row of the currently seated member, otherwise the first row in the file.
      const chosen = list.find((r) => r.activeLegislator === "Y") ?? (list[0] as LegislatorRow);
      const first = chosen.firstName ?? "";
      const last = chosen.lastName ?? "";
      terms.push({
        session,
        house: p.house,
        district,
        voteNames: [...p.voteNames],
        displayName: `${first} ${last}`.trim(),
        party: mapParty(chosen.party),
        seated: list.some((r) => r.activeLegislator === "Y"),
        src: { table: "LEGISLATOR_TBL", district, legislatorName: chosen.legislatorName as string },
      });
    }
    people.push({ id: p.id, terms });
    rosterEntries[p.house].push({ id: p.id, district: (terms[0] as PersonTerm).district });
  }
  if (problems.length > 0) throw new IngestError("people-map", "the people table does not match LEGISLATOR_TBL", problems);

  const rosters = { A: [] as PersonId[], S: [] as PersonId[] };
  for (const house of ["A", "S"] as House[]) {
    rosters[house] = rosterEntries[house]
      .sort((a, b) => districtNumber(a.district) - districtNumber(b.district) || compareStrings(a.id, b.id))
      .map((e) => e.id);
  }
  return { people, byVoteName: voteNameOwner, rosters };
}
