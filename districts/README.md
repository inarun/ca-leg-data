# districts

Boundary files for California's 80 Assembly and 40 Senate districts (Citizens Redistricting Commission final 2021 maps), small enough for on-device point-in-polygon lookup.

## Outputs (`out/`, committed)

| File | Content |
|---|---|
| `ca-assembly-2021.geojson` | FeatureCollection, 80 features, `properties: { district: <1..80> }`, Polygon or MultiPolygon, WGS84 lon/lat, 5 decimals |
| `ca-senate-2021.geojson` | Same, 40 features, `district: <1..40>` |
| `PROVENANCE.json` | Source URLs, download date, SHA-256 of each zip, tolerance, tool versions, counts, sizes (raw and gzip) |
| `ACCURACY.md` | Accuracy of the simplified files against the unsimplified CRC and Census data, and the recommended boundary margin |

`spot-check.md` lists ten coordinates for a human to compare with https://findyourrep.legislature.ca.gov/ .

## Rebuild

Requires Node 24 and npm. Everything installs locally in this folder.

```
cd districts
npm install
npm run build        # downloads sources to .work/ if absent, simplifies, writes out/
npm run check        # structure checks, accuracy vs unsimplified CRC and Census, writes out/ACCURACY.md
npm run spot-check   # regenerates spot-check.md
```

`TOLERANCE_M=40 npm run build` overrides the simplification tolerance for experiments (the default is in `build.mjs`). `npm run check` reads the tolerance from `out/PROVENANCE.json`.

## How the files are made

1. The CRC Assembly and Senate shapefiles are downloaded and unzipped into their own directories under `.work/` (git-ignored). Nothing from the downloads is executed.
2. The district number comes from the shapefile attribute `DISTRICT` (a string in the source; stored as an integer).
3. `mapshaper` (build tool only, MPL-2.0, not shipped) runs `-simplify dp interval=<tolerance> keep-shapes`. Simplification works on the shared-border topology, so neighbouring districts stay consistent, and `keep-shapes` keeps every polygon, so islands survive. Coordinates are rounded to 5 decimals (about 1.1 m).
4. The sources are geographic NAD83 and are used as WGS84 lon/lat without a datum shift (about 1 to 2 m in California). A projected source would be reprojected.

## Sources and terms

Primary (CRC final maps, from https://wedrawthelines.ca.gov/final-maps/):

- Assembly: https://wedrawthelines.ca.gov/wp-content/uploads/sites/64/2023/01/OneDrive_2023-01-19-5.zip
- Senate: https://wedrawthelines.ca.gov/wp-content/uploads/sites/64/2023/01/OneDrive_2023-01-19-3.zip

Terms: the site states that "information presented on this website, unless otherwise indicated, is considered to exist in the public domain" (https://wedrawthelines.ca.gov/conditions_of_use/).

Cross-check only, never shipped (US Census Bureau TIGER/Line, public domain):

- https://www2.census.gov/geo/tiger/TIGER2026/SLDL/tl_2026_06_sldl.zip
- https://www2.census.gov/geo/tiger/TIGER2026/SLDU/tl_2026_06_sldu.zip

Build and check dependencies (dev only): `mapshaper` (MPL-2.0), `shapefile` (BSD-3-Clause).

## Using the files

Do not trust a lookup that lands within the boundary margin of a border: see `out/ACCURACY.md` for the recommended margin and ask the user to confirm the district in that case.
