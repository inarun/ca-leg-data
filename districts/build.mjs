// Build simplified California Assembly / Senate district boundaries (WGS84 lon/lat GeoJSON)
// from the Citizens Redistricting Commission 2021 final shapefiles.
//
//   npm run build                 -> default tolerance
//   TOLERANCE_M=20 npm run build  -> override tolerance (metres), for experiments
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT, WORK, OUT, OUT_FILES, SOURCES, ensureDownloads, extract, readPrj, readShapefile, readGeojsonFeatures } from './lib.mjs';

// Douglas-Peucker interval in metres. DP keeps every dropped vertex within this distance of the
// simplified line, so the boundary can move by at most ~TOLERANCE_M (plus ~1 m coordinate rounding).
const DEFAULT_TOLERANCE_M = 30;
const TOLERANCE_M = Number(process.env.TOLERANCE_M ?? DEFAULT_TOLERANCE_M);
const DECIMALS = 5; // 0.00001 degree, about 1.1 m

const MAPSHAPER_BIN = join(ROOT, 'node_modules', 'mapshaper', 'bin', 'mapshaper');
const version = (pkg) => JSON.parse(readFileSync(join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version;

/** Runs the mapshaper CLI; returns its [simplify] log lines (mapshaper reports repaired intersections there). */
function runMapshaper(args) {
  const r = spawnSync(process.execPath, [MAPSHAPER_BIN, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`mapshaper failed: ${r.stderr || r.stdout}`);
  return `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => l.includes('[simplify]')).join('; ');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const meta = await ensureDownloads();
  const provenance = {
    generated: new Date().toISOString(),
    description: 'California Assembly and Senate districts, Citizens Redistricting Commission final 2021 maps, simplified for on-device point-in-polygon lookup.',
    terms: 'CRC website content is public domain unless otherwise indicated: https://wedrawthelines.ca.gov/conditions_of_use/',
    sources: {},
    processing: {},
    outputs: {},
    tools: {
      node: process.version,
      mapshaper: `${version('mapshaper')} (MPL-2.0, build tool only, not shipped)`,
      shapefile: `${version('shapefile')} (BSD-3-Clause, used by check.mjs)`,
    },
  };

  for (const key of ['assembly', 'senate']) {
    const src = SOURCES[key];
    const shp = extract(key);
    const prj = readPrj(shp);
    const geographic = /^GEOGCS\[/.test(prj);
    const usesNad83 = /North_American_1983|NAD83/i.test(prj);
    const raw = await readShapefile(shp, src.field);
    const rawDistricts = raw.map((f) => f.district).sort((a, b) => a - b);
    if (raw.length !== src.expected || rawDistricts.some((d, i) => d !== i + 1)) {
      throw new Error(`${key}: expected districts 1..${src.expected} once each, got ${raw.length} features`);
    }
    const out = join(WORK, `ms_${key}.geojson`);
    const args = ['-i', shp, '-each', `district=parseInt(${src.field},10)`, '-filter-fields', 'district'];
    // Source files are geographic NAD83 (lon/lat); only reproject if a future source is projected.
    if (!geographic) args.push('-proj', 'wgs84');
    args.push(
      '-simplify', 'dp', `interval=${TOLERANCE_M}`, 'keep-shapes', // topology-aware: shared arcs are simplified once
      '-o', out, 'format=geojson', `precision=${(10 ** -DECIMALS).toFixed(DECIMALS)}`, 'rfc7946', 'force',
    );
    const log = runMapshaper(args);
    process.stdout.write(`[${key}] mapshaper: ${log.trim()}\n`);

    const features = readGeojsonFeatures(out).sort((a, b) => a.district - b.district);
    const body = features
      .map((f) => JSON.stringify({ type: 'Feature', properties: { district: f.district }, geometry: f.geometry }))
      .join(',\n');
    const text = `{"type":"FeatureCollection","features":[\n${body}\n]}\n`;
    writeFileSync(OUT_FILES[key], text);

    provenance.sources[key] = {
      role: src.role,
      label: src.label,
      url: src.url,
      downloaded: meta[key].downloaded,
      zipSha256: meta[key].sha256,
      zipBytes: meta[key].bytes,
      shapefile: shp.split(/[\\/]/).pop(),
      districtAttribute: src.field,
      sourceCrs: prj,
      featureCount: raw.length,
    };
    provenance.outputs[key] = {
      file: `out/${OUT_FILES[key].split(/[\\/]/).pop()}`,
      featureCount: features.length,
      bytesRaw: statSync(OUT_FILES[key]).size,
      bytesGzip: gzipSync(text, { level: 9 }).length,
      simplifyLog: log.trim(),
    };
    provenance.processing[key] = { datumNote: usesNad83 ? 'Source is geographic NAD83; coordinates used as WGS84 lon/lat unchanged (difference is about 1-2 m in California).' : 'Reprojected to WGS84.' };
  }

  for (const key of ['census_assembly', 'census_senate']) {
    const src = SOURCES[key];
    provenance.sources[key] = {
      role: src.role,
      label: `${src.label} (cross-check only, not shipped)`,
      url: src.url,
      downloaded: meta[key].downloaded,
      zipSha256: meta[key].sha256,
      zipBytes: meta[key].bytes,
      districtAttribute: src.field,
    };
  }

  const a = provenance.outputs.assembly, s = provenance.outputs.senate;
  provenance.processing.common = {
    algorithm: 'mapshaper -simplify dp (Douglas-Peucker), topology-preserving: shared borders are simplified once so neighbours neither gap nor overlap; keep-shapes retains every polygon (islands)',
    toleranceMeters: TOLERANCE_M,
    coordinateDecimals: DECIMALS,
    output: 'GeoJSON FeatureCollection, WGS84 lon/lat, properties {district: integer}',
  };
  provenance.outputs.total = {
    bytesRaw: a.bytesRaw + s.bytesRaw,
    bytesGzip: a.bytesGzip + s.bytesGzip,
  };
  writeFileSync(join(OUT, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');

  console.log(`tolerance ${TOLERANCE_M} m, ${DECIMALS} decimals`);
  for (const k of ['assembly', 'senate']) {
    const o = provenance.outputs[k];
    console.log(`${o.file}: ${o.featureCount} features, ${o.bytesRaw} bytes raw, ${o.bytesGzip} bytes gzip`);
  }
  console.log(`total: ${provenance.outputs.total.bytesRaw} bytes raw, ${provenance.outputs.total.bytesGzip} bytes gzip`);
}

main().catch((e) => { console.error(e); process.exit(1); });
