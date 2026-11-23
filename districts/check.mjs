// Validate the built district files and measure their accuracy.
//   npm run check
// 1. structure: counts, district numbers, ring validity, islands kept
// 2. accuracy of the simplified files against the UNSIMPLIFIED CRC shapefiles (seeded random points)
// 3. the same comparison against the Census TIGER files (independent check)
// 4. writes out/ACCURACY.md including a recommended boundary margin
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OUT, OUT_FILES, SOURCES, BoundarySegments, DistrictIndex, ensureDownloads, extract, mulberry32,
  percentile, polygonsOf, readGeojsonFeatures, readJson, readShapefile, ringSelfIntersects,
} from './lib.mjs';

const SAMPLES = 20000;
const BBOX = { minLon: -124.48, maxLon: -114.13, minLat: 32.53, maxLat: 42.01 }; // California bounding box
const TARGET_MAX_M = 150; // ticket: every mismatch within 150 m of a boundary
const TARGET_RAW_BYTES = 2_000_000; // "2 MB" read conservatively as decimal megabytes
const SEEDS = { assembly: 20211220, senate: 20211221 };

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL: ${msg}`); };
const fmt = (n) => (n === null || n === undefined ? 'n/a' : n.toFixed(1));

// ---------------------------------------------------------------- 1. structure

function checkStructure(chamber, features, expected, rawFeatures) {
  const label = `${chamber}`;
  const issues = [];
  if (features.length !== expected) issues.push(`expected ${expected} features, found ${features.length}`);
  const seen = new Map();
  for (const f of features) seen.set(f.district, (seen.get(f.district) ?? 0) + 1);
  for (let d = 1; d <= expected; d++) {
    if (seen.get(d) !== 1) issues.push(`district ${d} appears ${seen.get(d) ?? 0} times`);
  }
  for (const d of seen.keys()) if (!Number.isInteger(d) || d < 1 || d > expected) issues.push(`unexpected district number ${d}`);

  const rawParts = new Map(rawFeatures.map((f) => [f.district, polygonsOf(f.geometry).length]));
  const rawRings = new Map(rawFeatures.map((f) => [f.district, polygonsOf(f.geometry).reduce((n, p) => n + p.length, 0)]));
  let vertices = 0, polygons = 0, rawPolygons = 0;
  for (const f of features) {
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') issues.push(`district ${f.district}: geometry ${f.geometry.type}`);
    const polys = polygonsOf(f.geometry);
    polygons += polys.length;
    rawPolygons += rawParts.get(f.district) ?? 0;
    if (polys.length < (rawParts.get(f.district) ?? 0)) issues.push(`district ${f.district}: ${polys.length} polygons, source has ${rawParts.get(f.district)} (island lost)`);
    const rings = polys.reduce((n, p) => n + p.length, 0);
    if (rings < (rawRings.get(f.district) ?? 0)) issues.push(`district ${f.district}: ${rings} rings, source has ${rawRings.get(f.district)} (hole or island lost)`);
    for (const poly of polys) {
      if (poly.length === 0) issues.push(`district ${f.district}: polygon without rings`);
      for (const ring of poly) {
        vertices += ring.length;
        if (ring.length < 4) { issues.push(`district ${f.district}: ring with ${ring.length} positions`); continue; }
        const a = ring[0], b = ring[ring.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) issues.push(`district ${f.district}: ring not closed`);
        let area2 = 0, bad = false;
        for (let i = 0; i < ring.length; i++) {
          const [x, y] = ring[i];
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) bad = true;
          else if (x < BBOX.minLon - 0.5 || x > BBOX.maxLon + 0.5 || y < BBOX.minLat - 0.5 || y > BBOX.maxLat + 0.5) bad = true;
          if (Math.abs(x * 1e5 - Math.round(x * 1e5)) > 1e-6 || Math.abs(y * 1e5 - Math.round(y * 1e5)) > 1e-6) bad = true;
          if (i > 0 && ring[i - 1][0] === x && ring[i - 1][1] === y) bad = true; // consecutive duplicate
          if (i > 0) area2 += ring[i - 1][0] * y - x * ring[i - 1][1];
        }
        if (bad) issues.push(`district ${f.district}: ring has out-of-range, over-precise or duplicate coordinates`);
        if (area2 === 0) issues.push(`district ${f.district}: zero-area ring`);
        if (ringSelfIntersects(ring)) issues.push(`district ${f.district}: ring self-intersects`);
      }
    }
  }
  for (const msg of issues.slice(0, 20)) fail(`${label}: ${msg}`);
  if (issues.length > 20) fail(`${label}: ... ${issues.length - 20} more structural issues`);
  console.log(`[${label}] structure: ${features.length} features, ${polygons} polygons (source ${rawPolygons}), ${vertices} positions, ${issues.length} issues`);
  return { features: features.length, polygons, rawPolygons, vertices, issues: issues.length };
}

// ---------------------------------------------------------------- 2/3. accuracy

function distStats(list) {
  const sorted = list.slice().sort((a, b) => a - b);
  return { n: sorted.length, max: sorted.length ? sorted[sorted.length - 1] : null, p99: percentile(sorted, 99), p50: percentile(sorted, 50) };
}

function samplePoints(primaryIdx, seed) {
  const rnd = mulberry32(seed);
  const pts = [];
  let drawn = 0;
  while (pts.length < SAMPLES) {
    const lon = BBOX.minLon + rnd() * (BBOX.maxLon - BBOX.minLon);
    const lat = BBOX.minLat + rnd() * (BBOX.maxLat - BBOX.minLat);
    drawn++;
    const d = primaryIdx.find(lon, lat);
    if (d !== null) pts.push({ lon, lat, ref: d });
  }
  return { pts, drawn };
}

function compare(points, refOf, simpIdx, segs) {
  let mismatches = 0, refNone = 0, simpNone = 0;
  const dists = [];
  const cases = [];
  for (const p of points) {
    const ref = refOf(p);
    if (ref === null) { refNone++; }
    const s = simpIdx.find(p.lon, p.lat);
    if (ref === null) continue; // reference has no district here (outside its coverage): not comparable
    if (s !== ref) {
      mismatches++;
      if (s === null) simpNone++;
      const d = segs.distance(p.lon, p.lat);
      dists.push(d);
      cases.push({ lon: p.lon, lat: p.lat, ref, simp: s, d });
    }
  }
  return { compared: points.length - refNone, refNone, mismatches, simpNone, ...distStats(dists), worst: cases.sort((a, b) => b.d - a.d).slice(0, 3) };
}

async function accuracy(key, simplified, primaryRaw, censusRaw) {
  const primaryIdx = new DistrictIndex(primaryRaw);
  const censusIdx = new DistrictIndex(censusRaw);
  const simpIdx = new DistrictIndex(simplified);
  const segs = new BoundarySegments(simplified);
  const { pts, drawn } = samplePoints(primaryIdx, SEEDS[key]);

  // Gaps/overlaps inside the simplified file (topology consistency)
  let overlaps = 0;
  for (const p of pts) if (simpIdx.count(p.lon, p.lat) > 1) overlaps++;

  const vsPrimary = compare(pts, (p) => p.ref, simpIdx, segs);
  const censusAt = new Map();
  const vsCensus = compare(pts, (p) => { const c = censusIdx.find(p.lon, p.lat); censusAt.set(p, c); return c; }, simpIdx, segs);
  // baseline: how much the unsimplified CRC and Census files differ from each other
  // (distance is to the nearest boundary of the unsimplified CRC file: how far the two sources' borders sit apart)
  let crcVsCensus = 0;
  let crcVsCensusMaxM = null;
  const primarySegs = new BoundarySegments(primaryRaw);
  for (const p of pts) {
    const c = censusAt.get(p);
    if (c === null || c === p.ref) continue;
    crcVsCensus++;
    crcVsCensusMaxM = Math.max(crcVsCensusMaxM ?? 0, primarySegs.distance(p.lon, p.lat));
  }
  return { drawn, overlaps, vsPrimary, vsCensus, crcVsCensus, crcVsCensusMaxM };
}

// ---------------------------------------------------------------- main

async function main() {
  await ensureDownloads(() => {});
  const prov = readJson(join(OUT, 'PROVENANCE.json'));
  const tol = prov.processing.common.toleranceMeters;
  const result = {};
  const structure = {};

  for (const [key, chamber] of [['assembly', 'Assembly'], ['senate', 'Senate']]) {
    const src = SOURCES[key];
    const simplified = readGeojsonFeatures(OUT_FILES[key]);
    const primaryRaw = await readShapefile(extract(key), src.field);
    const censusKey = `census_${key}`;
    const censusRaw = await readShapefile(extract(censusKey), SOURCES[censusKey].field);
    structure[key] = checkStructure(chamber, simplified, src.expected, primaryRaw);
    console.log(`[${chamber}] sampling ${SAMPLES} points (seed ${SEEDS[key]}) ...`);
    result[key] = await accuracy(key, simplified, primaryRaw, censusRaw);
    const r = result[key];
    console.log(`[${chamber}] vs unsimplified CRC: ${r.vsPrimary.mismatches}/${r.vsPrimary.compared} differ; max ${fmt(r.vsPrimary.max)} m, p99 ${fmt(r.vsPrimary.p99)} m (to nearest simplified boundary)`);
    console.log(`[${chamber}] vs Census TIGER 2026: ${r.vsCensus.mismatches}/${r.vsCensus.compared} differ (${r.vsCensus.refNone} points outside Census polygons); max ${fmt(r.vsCensus.max)} m, p99 ${fmt(r.vsCensus.p99)} m`);
    console.log(`[${chamber}] unsimplified CRC vs Census: ${r.crcVsCensus} points differ (max ${fmt(r.crcVsCensusMaxM)} m from the CRC boundary); simplified overlap points: ${r.overlaps}`);
    if (r.vsPrimary.max !== null && r.vsPrimary.max > TARGET_MAX_M) fail(`${chamber}: simplified mismatch ${fmt(r.vsPrimary.max)} m exceeds ${TARGET_MAX_M} m`);
    if (r.overlaps > 0) fail(`${chamber}: ${r.overlaps} sample points fall in more than one simplified district`);
  }

  const totalRaw = prov.outputs.total.bytesRaw;
  const totalGzip = prov.outputs.total.bytesGzip;
  if (totalRaw >= TARGET_RAW_BYTES) fail(`outputs total ${totalRaw} bytes, target < ${TARGET_RAW_BYTES}`);

  // Recommended margin: the larger of (a) the theoretical bound tolerance + rounding + datum slack and
  // (b) the worst mismatch distance observed against the unsimplified CRC data, rounded up to 5 m.
  const ROUNDING_M = 1; // 5-decimal coordinates move a vertex by <= ~0.8 m
  const DATUM_M = 2; // NAD83 vs WGS84 difference in California is about 1-2 m
  const bound = tol + ROUNDING_M + DATUM_M;
  const observed = Math.max(0, ...['assembly', 'senate'].map((k) => result[k].vsPrimary.max ?? 0));
  const margin = Math.ceil(Math.max(bound, observed) / 5) * 5;

  const row = (name, s) => `| ${name} | ${s.mismatches} / ${s.compared} | ${fmt(s.max)} | ${fmt(s.p99)} | ${s.simpNone} |`;
  const md = [
    '# Accuracy report',
    '',
    `Generated by \`npm run check\`. Simplified files: tolerance ${tol} m (Douglas-Peucker, topology-preserving), coordinates rounded to ${prov.processing.common.coordinateDecimals} decimals.`,
    '',
    '## Method',
    '',
    `- ${SAMPLES.toLocaleString('en-US')} points per chamber, drawn uniformly from California's bounding box (lon ${BBOX.minLon} to ${BBOX.maxLon}, lat ${BBOX.minLat} to ${BBOX.maxLat}) with a seeded PRNG (mulberry32, seeds ${SEEDS.assembly} Assembly / ${SEEDS.senate} Senate); only points that fall inside some district of the unsimplified CRC file are kept (${result.assembly.drawn} and ${result.senate.drawn} draws needed).`,
    '- Each point is looked up in the simplified file and in the reference. A mismatch is a different district number (or no district in the simplified file).',
    '- Distances are metres from the point to the nearest boundary segment of the simplified file (local equirectangular approximation). For a mismatch that distance is how far the point sits from the boundary it was misassigned across.',
    '',
    '## Result against the unsimplified CRC shapefiles (primary source)',
    '',
    '| Chamber | Mismatches | Max distance m | 99th pct m | Points with no simplified district |',
    '|---|---|---|---|---|',
    row('Assembly', result.assembly.vsPrimary),
    row('Senate', result.senate.vsPrimary),
    '',
    `Points falling in more than one simplified district (overlap): Assembly ${result.assembly.overlaps}, Senate ${result.senate.overlaps}.`,
    '',
    '## Result against Census TIGER/Line 2026 (independent cross-check)',
    '',
    '| Chamber | Mismatches | Max distance m | 99th pct m | Points with no simplified district |',
    '|---|---|---|---|---|',
    row('Assembly', result.assembly.vsCensus),
    row('Senate', result.senate.vsCensus),
    '',
    `Points not covered by any Census polygon were skipped (Assembly ${result.assembly.vsCensus.refNone}, Senate ${result.senate.vsCensus.refNone}). Unsimplified CRC versus Census, same points: Assembly ${result.assembly.crcVsCensus} differ (max ${fmt(result.assembly.crcVsCensusMaxM)} m from the CRC boundary), Senate ${result.senate.crcVsCensus} differ (max ${fmt(result.senate.crcVsCensusMaxM)} m). Census boundaries are digitised separately from the CRC's; the largest such disagreement is reported here as measured and was not investigated further.`,
    '',
    '## File sizes',
    '',
    `Total ${totalRaw} bytes raw, ${totalGzip} bytes gzipped (target under ${TARGET_RAW_BYTES} raw). Assembly ${prov.outputs.assembly.bytesRaw} / ${prov.outputs.assembly.bytesGzip}, Senate ${prov.outputs.senate.bytesRaw} / ${prov.outputs.senate.bytesGzip}.`,
    '',
    '## Recommended boundary margin',
    '',
    `**${margin} m.** If the located point is within ${margin} m of any district boundary, the app should ask the user to confirm the district instead of trusting the lookup.`,
    '',
    `Basis: simplification tolerance ${tol} m + ${ROUNDING_M} m coordinate rounding + ${DATUM_M} m NAD83/WGS84 datum slack = ${bound} m; worst observed mismatch against the unsimplified CRC data ${fmt(observed)} m; the larger value is rounded up to the next 5 m. This covers the file only. It does not include the error of the device location or of a geocoder, which the app must add to the margin.`,
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'ACCURACY.md'), md);
  console.log(`recommended boundary margin: ${margin} m (bound ${bound} m, observed max ${fmt(observed)} m)`);
  console.log('wrote out/ACCURACY.md');

  if (failures.length) {
    console.log(`\nCHECK FAILED: ${failures.length} problem(s)`);
    process.exit(1);
  }
  console.log('\nCHECK PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
