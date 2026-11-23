// Shared helpers for build.mjs and check.mjs: sources, download, unzip,
// shapefile reading and point-in-polygon / boundary-distance utilities.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import * as shapefile from 'shapefile';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const WORK = join(ROOT, '.work');
export const OUT = join(ROOT, 'out');

// key -> source description. `field` is the shapefile attribute holding the district number.
export const SOURCES = {
  assembly: {
    role: 'primary',
    chamber: 'Assembly',
    label: 'CRC 2021 final Assembly map',
    url: 'https://wedrawthelines.ca.gov/wp-content/uploads/sites/64/2023/01/OneDrive_2023-01-19-5.zip',
    field: 'DISTRICT',
    expected: 80,
  },
  senate: {
    role: 'primary',
    chamber: 'Senate',
    label: 'CRC 2021 final Senate map',
    url: 'https://wedrawthelines.ca.gov/wp-content/uploads/sites/64/2023/01/OneDrive_2023-01-19-3.zip',
    field: 'DISTRICT',
    expected: 40,
  },
  census_assembly: {
    role: 'cross-check',
    chamber: 'Assembly',
    label: 'Census TIGER/Line 2026 SLDL (California)',
    url: 'https://www2.census.gov/geo/tiger/TIGER2026/SLDL/tl_2026_06_sldl.zip',
    field: 'SLDLST',
    expected: 80,
  },
  census_senate: {
    role: 'cross-check',
    chamber: 'Senate',
    label: 'Census TIGER/Line 2026 SLDU (California)',
    url: 'https://www2.census.gov/geo/tiger/TIGER2026/SLDU/tl_2026_06_sldu.zip',
    field: 'SLDUST',
    expected: 40,
  },
};

export const OUT_FILES = {
  assembly: join(OUT, 'ca-assembly-2021.geojson'),
  senate: join(OUT, 'ca-senate-2021.geojson'),
};

const zipPath = (key) => join(WORK, `${key}.zip`);
const dirPath = (key) => join(WORK, `x_${key}`);
const metaPath = join(WORK, 'downloads.json');

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function readMeta() {
  return existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
}

/** Download every source zip that is not already in .work/. Returns { key: {url, downloaded, sha256, bytes} }. */
export async function ensureDownloads(log = console.log) {
  mkdirSync(WORK, { recursive: true });
  const meta = readMeta();
  for (const [key, src] of Object.entries(SOURCES)) {
    const p = zipPath(key);
    if (!existsSync(p)) {
      log(`download ${src.url}`);
      const res = await fetch(src.url);
      if (!res.ok) throw new Error(`download failed ${res.status} ${src.url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(p, buf);
      meta[key] = { url: src.url, downloaded: new Date().toISOString().slice(0, 10) };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }
    const buf = readFileSync(p);
    if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${p} is not a zip file`);
    meta[key] = {
      url: src.url,
      downloaded: meta[key]?.downloaded ?? statSync(p).mtime.toISOString().slice(0, 10),
      sha256: sha256(buf),
      bytes: buf.length,
    };
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

/** Minimal zip reader (stored/deflate). Extracts only file basenames into a fresh directory (no path traversal). */
function unzipInto(zipFile, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const buf = readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const base = basename(name.replace(/\\/g, '/'));
    if (!/\.(shp|dbf|shx|prj|cpg)$/i.test(base)) continue; // only the shapefile parts are ever read
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: unsupported method ${method} for ${name}`);
    writeFileSync(join(dir, base), data);
    names.push(base);
  }
  return names;
}

/** Unzip a source into its own empty directory; returns the path to the .shp file. */
export function extract(key) {
  const dir = dirPath(key);
  unzipInto(zipPath(key), dir);
  const shps = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.shp'));
  if (shps.length !== 1) throw new Error(`${key}: expected exactly one .shp, found ${shps.length}`);
  return join(dir, shps[0]);
}

export function readPrj(shpPath) {
  return readFileSync(shpPath.replace(/\.shp$/i, '.prj'), 'utf8').trim();
}

/** Read all features of a shapefile; district number taken from attribute `field`. */
export async function readShapefile(shpPath, field) {
  const src = await shapefile.open(shpPath, shpPath.replace(/\.shp$/i, '.dbf'));
  const features = [];
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    const raw = r.value.properties[field];
    const district = Number.parseInt(String(raw), 10);
    if (!Number.isInteger(district)) throw new Error(`bad district attribute ${field}=${raw}`);
    features.push({ district, geometry: r.value.geometry, properties: r.value.properties });
  }
  return features;
}

export function readGeojsonFeatures(path) {
  const fc = JSON.parse(readFileSync(path, 'utf8'));
  return fc.features.map((f) => ({ district: f.properties.district, geometry: f.geometry }));
}

/** Polygons of a geometry as an array of polygons, each an array of rings. */
export const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

// ---------------------------------------------------------------- point in polygon

/** Ring with a y-bucket edge index so a ray cast only visits nearby edges. */
class IndexedRing {
  constructor(coords) {
    const n = coords.length - 1; // closed ring: last == first
    this.n = n;
    this.xs = new Float64Array(n + 1);
    this.ys = new Float64Array(n + 1);
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i <= n; i++) {
      const [x, y] = coords[i];
      this.xs[i] = x; this.ys[i] = y;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
    }
    this.minX = minX; this.maxX = maxX; this.minY = minY; this.maxY = maxY;
    const nb = Math.max(1, Math.min(512, Math.floor(n / 6)));
    this.nb = nb;
    this.h = (maxY - minY) / nb || 1;
    const lists = Array.from({ length: nb }, () => []);
    for (let i = 0; i < n; i++) {
      const a = this.ys[i], b = this.ys[i + 1];
      const lo = Math.max(0, Math.min(nb - 1, Math.floor((Math.min(a, b) - minY) / this.h)));
      const hi = Math.max(0, Math.min(nb - 1, Math.floor((Math.max(a, b) - minY) / this.h)));
      for (let k = lo; k <= hi; k++) lists[k].push(i);
    }
    this.buckets = lists.map((l) => Int32Array.from(l));
  }
  /** true if (x, y) is inside this ring (even-odd crossing count). */
  contains(x, y) {
    if (y < this.minY || y > this.maxY || x < this.minX || x > this.maxX) return false;
    const k = Math.min(this.nb - 1, Math.floor((y - this.minY) / this.h));
    const { xs, ys } = this;
    let inside = false;
    for (const i of this.buckets[k]) {
      const y1 = ys[i], y2 = ys[i + 1];
      if ((y1 > y) !== (y2 > y)) {
        const xi = xs[i] + ((y - y1) * (xs[i + 1] - xs[i])) / (y2 - y1);
        if (x < xi) inside = !inside;
      }
    }
    return inside;
  }
}

/** Lookup structure: district features -> district number containing a point (or null). */
export class DistrictIndex {
  constructor(features) {
    this.items = features.map((f) => {
      const rings = [];
      for (const poly of polygonsOf(f.geometry)) for (const r of poly) rings.push(new IndexedRing(r));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const r of rings) {
        minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX);
        minY = Math.min(minY, r.minY); maxY = Math.max(maxY, r.maxY);
      }
      return { district: f.district, rings, minX, maxX, minY, maxY };
    });
  }
  /** Even-odd across all rings of a feature handles holes and multipart districts. */
  find(x, y) {
    for (const it of this.items) {
      if (x < it.minX || x > it.maxX || y < it.minY || y > it.maxY) continue;
      let inside = false;
      for (const r of it.rings) if (r.contains(x, y)) inside = !inside;
      if (inside) return it.district;
    }
    return null;
  }
}

DistrictIndex.prototype.count = function count(x, y) {
  let n = 0;
  for (const it of this.items) {
    if (x < it.minX || x > it.maxX || y < it.minY || y > it.maxY) continue;
    let inside = false;
    for (const r of it.rings) if (r.contains(x, y)) inside = !inside;
    if (inside) n++;
  }
  return n;
};

/** True if any two non-adjacent edges of the ring properly cross (self-intersection). */
export function ringSelfIntersects(coords) {
  const n = coords.length - 1;
  const ys = coords.map((c) => c[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const nb = Math.max(1, Math.min(512, Math.floor(n / 4)));
  const h = (maxY - minY) / nb || 1;
  const buckets = Array.from({ length: nb }, () => []);
  for (let i = 0; i < n; i++) {
    const lo = Math.min(nb - 1, Math.floor((Math.min(ys[i], ys[i + 1]) - minY) / h));
    const hi = Math.min(nb - 1, Math.floor((Math.max(ys[i], ys[i + 1]) - minY) / h));
    for (let k = lo; k <= hi; k++) buckets[k].push(i);
  }
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (const list of buckets) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a], j = list[b];
        if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex
        const p1 = coords[i], p2 = coords[i + 1], p3 = coords[j], p4 = coords[j + 1];
        const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2), d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- distances

const R = 6371008.8;
const RAD = Math.PI / 180;

/** Flattened boundary segments of a feature set, for nearest-boundary distance in metres. */
export class BoundarySegments {
  constructor(features) {
    const segs = [];
    for (const f of features) for (const poly of polygonsOf(f.geometry)) for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) segs.push(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    }
    this.s = Float64Array.from(segs);
    this.count = segs.length / 4;
  }
  /** Distance in metres from (lon, lat) to the nearest boundary segment (local equirectangular approximation). */
  distance(lon, lat) {
    const { s } = this;
    const kx = Math.cos(lat * RAD) * RAD * R;
    const ky = RAD * R;
    // Cheap reject: only evaluate segments whose bbox is within `best` of the point.
    let best = Infinity;
    for (let i = 0; i < s.length; i += 4) {
      const ax = (s[i] - lon) * kx, ay = (s[i + 1] - lat) * ky;
      const bx = (s[i + 2] - lon) * kx, by = (s[i + 3] - lat) * ky;
      if (Math.min(ax, bx) > best || Math.max(ax, bx) < -best || Math.min(ay, by) > best || Math.max(ay, by) < -best) continue;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.sqrt(px * px + py * py);
      if (d < best) best = d;
    }
    return best;
  }
}

// ---------------------------------------------------------------- misc

/** Seeded PRNG (mulberry32) so the accuracy sample is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const exists = existsSync;
