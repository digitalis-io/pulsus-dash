# Geomap data and location resolution

The geomap's data layer (issue #231, part E step 1a of
[T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md)): how a series' labels
resolve to a place, the two bundled offline assets (a world basemap and a gazetteer), how they are
validated and loaded, and what they cover. It implements
[VIZ-045](../../designs/product/05-visualisation-catalogue.md) and the bundled offline data of
VIZ-046, by the rules T24-080 to T24-087. The map frame that draws them comes in E2 (#234): its
first part adds the rows, the table, the CSV, the facts and the Inspector targets
([below](#the-map-frames-rows-234-part-1)); PulsusIX does not draw a map yet.

The modules live in `client/src/vis/geo/`. The data layer (step 1a: `aliases.ts` to `assets.ts`)
imports nothing outside the directory except types. The map frame's modules (#234 Part 1) do:
`frame.ts` imports `data/frames` (`seriesName`), `vis/reduce` (the merge, the reducer, the cap and
the T22-004 disambiguator), `vis/thresholds`, `engine/canvas2d/seriesColour`, `engine/patterns` and
`i18n/t`; `rows.ts` imports `vis/reduce` (`panelCsv`, `focusOf`, `largestChange`) and
`i18n/format`; `targets.ts` imports only `i18n/t` at run time (its imports of `frame.ts` are
types).

| Module | What it holds |
|---|---|
| `aliases.ts` | `normKey`, the alias lists, `HINT_KEY`, `GEO_AUTO_RULES` and `GEO_ALIAS_KEYS` (no imports) |
| `geohash.ts` | `decodeGeohash` (no imports) |
| `locate.ts` | `locate` and its types `GeoSource`, `GeoPlace`, `LocationResult`, `LocationOption` |
| `types.ts` | `Basemap`, `BasemapCountry`, `Gazetteer` and its rows, `GeoData` |
| `decode.ts` | `decodeBasemap`, `decodeGazetteer` (type-only imports, so `ci:geo-data` runs it in Node) |
| `urls.ts` | `basemapUrl`, `gazetteerUrl`: the assets imported with `?url` (the `geo-assets` build input) |
| `assets.ts` | `geoLoader`, `loadGeoData`; re-exports the decoders |
| `frame.ts` | the map frame's rows (#234 Part 1): `geoRowSet`, `validateGeoRows`, `geoFrame`, `finalLabels`, `valueStatusOf` and their types |
| `rows.ts` | `geoTable`, `geoCsv`, `geoFacts` |
| `targets.ts` | `geoTarget`, `geoPlace` (type-only imports of `frame.ts`, so the shared Inspector can take it alone) |
| `fixtures/series.ts` | the T24 §10.4 and §10.5 fixtures as series (G, H, O, X, Cap, …) and gazetteer T, for the tests |
| `data/basemap.json`, `data/gazetteer.json` | the assets, built by `tools/geo/build.py` ([below](#how-the-assets-are-built)) |

## Resolving a location (`locate`)

```ts
locate(labels: Labels, o: LocationOption, g: Gazetteer | null): LocationResult
```

`locate` reads one series' labels. It is pure, total and deterministic: it never throws, reads only
its arguments, and returns a fresh, deeply frozen result (T24-080).

**Keys.** A label key is compared in its normal form: ASCII capitals are lower-cased and `.` reads
as `_` (`Cloud.Region` is `cloud_region`; `Ünit.X` is `Ünit_x`). An empty value is the same as an
absent key. Two raw keys with one normal form and different values are a **collision**; with equal
values they merge, and the first raw key in UTF-16 order names the merged key.

### Auto mode (`{ mode: 'auto' }`)

The first rule with a present alias decides; there is no fallback to a later rule (T24-081 (c)).
Within a rule the aliases are in precedence order:

| # | Aliases (normal form) | Source |
|---|---|---|
| 1 | lat `lat`, `latitude`, `geo_location_lat`; lon `lon`, `lng`, `longitude`, `geo_location_lon` | coordinates |
| 2 | `geohash`, `geo_hash` | geohash |
| 3 | `cloud_region` (hint `cloud_provider`) | cloud |
| 4 | `geo_region_iso_code`, `region_iso_code` | region (ISO 3166-2) |
| 5 | `geo_country_iso_code`, `country_code`, `country` | country (ISO 3166-1) |
| 6 | `iata`, `iata_code`, `airport` | airport |
| 7 | `region` (hint `cloud_provider`) | cloud or region |

The order of outcomes:

1. **Collisions** count only among the keys the deciding rule reads: its aliases, plus
   `cloud_provider` for rules 3 and 7. A collision elsewhere is ignored.
2. **Coordinates** (rule 1): an axis with no present alias is `incompleteCoords`. Then every
   present alias, the latitude's first, then the longitude's, is checked: a coordinate is a whole
   string matching `^-?\d{1,3}(\.\d{1,12})?$` with |lat| ≤ 90 and |lon| ≤ 180, and the first that
   fails is `invalid: coords` with its key. Only then are an axis's values compared as numbers:
   `10` and `10.0` agree; different numbers are `aliasConflict`.
3. **Geohash** (rule 2): the lower-cased value must match `^[0-9b-hjkmnp-z]{1,12}$`, else
   `invalid: geohash`; different lower-cased hashes are `aliasConflict`. The place is the cell's
   centre, with `cell` its height and width in degrees.
4. **Lookups** (rules 3 to 7): no gazetteer gives `gazetteerUnavailable`. Each present alias is
   looked up in precedence order (unknown, then the hint, then several rows, then one row) and the
   first result that is not `placed` wins. Aliases that place different gazetteer rows (two rows
   that share a code and a name included) are `aliasConflict`.

**Lookups** (T24-084):

- **Country:** a 2-letter value is an alpha-2 code, a 3-letter value an alpha-3 code (both
  upper-cased); anything else is an English name, compared after NFC normalisation and
  `toLowerCase`. Several rows: `sharedCode` for a code, `name` for a name. The place's `code` is
  the alpha-2 code.
- **Region** and **IATA:** upper-cased; several rows are `sharedCode`.
- **Cloud:** the id is lower-cased; `cloud_provider`, lower-cased, then filters the rows. No row
  left is `providerMismatch` with all the id's rows as candidates; several rows are `providers`.
- **Rule 7** (`region`): the hint-filtered cloud rows and the region rows together; rows of both
  kinds are `regionOrCloud`.
- No row: `unknownCode` with the source (rule 7 reports `cloud`) and the value as written.

Candidates are sorted by UTF-16 code units: country `‹a2› ‹name›`, region and IATA `‹code› ‹name›`,
cloud `‹provider› ‹id›`, and `‹raw key›=‹value›` for `keyCollision` and `aliasConflict`.
`place.key` is the raw key of the first present alias (for coordinates, the latitude's).

### Explicit modes

| Option | Reads | Notes |
|---|---|---|
| `{ mode: 'coords', lat, lon }` | the two named fields | none present `noLocation`; one `incompleteCoords`; then as rule 1 |
| `{ mode: 'geohash', field }` | the field | absent `noLocation`; then as rule 2 |
| `{ mode: 'lookup', field, gazetteer, country? }` | the field, and `cloud_provider` for `cloud` | absent `noLocation`; no gazetteer `gazetteerUnavailable`; with `gazetteer: 'region'` and `country`, a value without `-` is prefixed `‹country›-` (`CA` → `US-CA`) |

### One example per status

Against a gazetteer holding the rows named (auto mode unless given):

| Labels | Result |
|---|---|
| `cloud_region=eu-west-1` | `placed`: cloud, `eu-west-1`, aws, Dublin, lat 53.34, lon −6.25 |
| `service=web` | `noLocation` |
| `cloud_region=eu-west-1` with no gazetteer | `gazetteerUnavailable` (coordinates and geohashes still place) |
| `lat=91 lon=0` | `invalid: coords`, key `lat` |
| `latitude=10` | `invalid: incompleteCoords`, key `latitude` |
| `geohash=U4PA` | `invalid: geohash` (`a` is not a geohash character) |
| `cloud_region=mars-north-1` | `unknownCode`: cloud, `cloud_region`, `mars-north-1` |
| `cloud_provider=gcp cloud_region=eu-west-1` | `providerMismatch`: `cloud_region`, gcp, [`aws eu-west-1`] |
| `cloud.region=eu-west-1 cloud_region=eu-west-2` | `ambiguous: keyCollision` |
| `lat=10 latitude=11 lon=5` | `ambiguous: aliasConflict` [`lat=10`, `latitude=11`] |
| `country=ZZ` (two `ZZ` rows) | `ambiguous: sharedCode` |
| `country=atlantis` (two rows of that name) | `ambiguous: name` |
| `cloud_region=xx-dup-1` (two providers) | `ambiguous: providers` |
| `region=xx-dup` (a region and a cloud id) | `ambiguous: regionOrCloud` |

### Precision

| Source | Position |
|---|---|
| Coordinates | exactly the label's numbers (`-0` places at 0) |
| Geohash | the cell's centre; `cell` gives its size (11 characters ≈ 1.3 × 10⁻⁶ degrees) |
| Gazetteer | the row's label point, quantised to 0.01°: a country's Natural Earth label point, a region's, an airport's position, a cloud region's metro (below) |

## The assets

Both files are compact UTF-8 JSON with the keys in the listed order (`v`, `q`, then the data
members) and a trailing LF (T24 §5.12). Coordinates are integers x = round(lon · 100) and
y = round(lat · 100), rounded half away from zero; the basemap's latitudes are clamped to ±85.0511.

- **`basemap.json`** (Natural Earth 110m Admin 0, 177 features): `countries` (a2, a3, English name,
  polygons; each polygon an outer ring counter-clockwise and its holes clockwise, as delta arrays),
  `coast` and `border` polylines. An edge shared by two features is drawn once as border; the
  ±85.0511 closures and the ±180° seams are never stroked.
- **`gazetteer.json`**: `country` (238 rows), `region` (4 408 rows, ISO 3166-2), `iata` (3 245
  rows: large and medium airports with scheduled service) and `cloud` (134 rows: aws 34, gcp 43,
  azure 57). A code may repeat (60 region codes have two or more Natural Earth rows): such a
  lookup is `sharedCode`, not a guess.

Sizes: 138 106 and 260 490 bytes raw; 31 441 and 91 842 bytes brotli, inside the `geoBasemap`
(40 000) and `geoGazetteer` (104 000) budgets of `ci:bundle-size`
([bundle budgets](../development/build-and-ci.md#bundle-budgets)).

### Cloud regions

`tools/geo/cloud-regions.csv` holds 134 regions (aws 34, gcp 43, azure 57), sorted by provider and
id, as of the date on its first line (`# as of 2026-11-26`). It was reconciled on that date with
each provider's published public-cloud region list, named by title in each record's `source`:

| Provider | Published list (`source`) | Date the page shows | Included |
|---|---|---|---|
| aws | AWS Regions - AWS Regions and Availability Zones | none | every row of "Available AWS Regions" (opt-in regions included) |
| gcp | Regions and zones - Compute Engine | 2026-11-25 | every region with zones |
| azure | List of Azure Regions - Microsoft Learn | 2026-10-13 | every row, restricted-access regions included (`australiacentral2`, `brazilsoutheast`, `francesouth`, `germanynorth`, `norwaywest`, `southafricawest`, `switzerlandwest`, `uaecentral`): they are deployable sites whose ids telemetry carries |

`client/src/vis/geo/fixtures/cloud-inventory.json` is the same dated id list, and
`unit:geo-assets` checks the gazetteer against it exactly. **Excluded:**

- preview and announced regions: azure `saudiarabiaeast`, `southeastasia3`, `taiwannorth`; aws
  `me-west-1` and `sa-west-1`, which SDK endpoint data names but the AWS list does not;
- ids that are not on the published list: azure `jioindiacentral`, `jioindiawest`;
- the government, sovereign and China partitions: aws GovCloud (`us-gov-*`), ISO (`us-iso*`),
  China (`cn-*`) and the European Sovereign Cloud (`eusc-*`); azure Government (`usgov*`,
  `usdod*`) and China (`china*`); gcp sovereign and partner-operated clouds.

An unlisted id resolves to `unknownCode`. A region added later needs a new dated reconciliation
([refreshing the data](supply-chain.md#geo-data)).

**Places.** `place` is the provider's published location in the provider's spelling (`St.
Ghislain`, `Queretaro`, `Tokyo, Saitama`) where that is a city or a campus. Where the provider gives
only a country or a state, `place` is a **curated city**, not a provider statement: the provider's
metro where it is known, else the obvious data-centre metro, always a Natural Earth populated place,
so the name and the position agree. `unit:geo-assets` fails if any place is a bare country or a US
or Australian state name (Hong Kong and Singapore are cities too). The curated choices:

| Region | Provider location | Curated city (and position) |
|---|---|---|
| aws `us-east-1` | N. Virginia | Alexandria (the Ashburn area; Natural Earth has no Ashburn) |
| aws `us-east-2`; `us-west-1` | Ohio; N. California | Columbus; San Jose |
| aws `us-west-2` | Oregon | Pendleton (the nearest Oregon place to the Boardman campus) |
| aws `ca-central-1`; `mx-central-1` | Canada; Mexico | Montréal; Querétaro |
| aws `ap-southeast-5`, `-6`, `-7` | Malaysia; New Zealand; Thailand | Kuala Lumpur; Auckland; Bangkok |
| aws `eu-west-1`; `eu-south-2` | Ireland; Spain | Dublin; Zaragoza (Aragón) |
| aws `me-central-1`; `me-south-1` | United Arab Emirates; Bahrain | Abu Dhabi; Manama |
| azure `eastus`; `eastus2` | Virginia | Roanoke (at the provider's published coordinates); Danville (the nearest Virginia place to the Boydton campus) |
| azure `centralus`; `northcentralus`; `southcentralus` | Iowa; Illinois; Texas | Des Moines; Chicago; San Antonio |
| azure `westus`; `westus2`; `westcentralus` | California; Washington; Wyoming | San Francisco; Wenatchee (by the Quincy campus); Cheyenne |
| azure `australiaeast`; `australiasoutheast` | New South Wales; Victoria | Sydney; Melbourne |
| azure `brazilsouth`; `mexicocentral` | Sao Paulo State; Querétaro State | São Paulo; Querétaro |
| azure `northeurope`; `westeurope` | Ireland; Netherlands | Dublin; Amsterdam |
| azure `norwayeast`; `norwaywest`; `israelcentral` | Norway; Norway; Israel | Oslo; Stavanger; Tel Aviv |

**Positions.** For every other region the position is the Natural Earth populated place `ne_id` of
the published location; where that location is not one (a campus or a district), it is a curated
populated place in the same country, the named city where there is one, else the nearest:

| Region | Place | Natural Earth place used |
|---|---|---|
| gcp `us-east4` | Ashburn | Alexandria |
| gcp `asia-east1`; `asia-south2` | Changhua County; Delhi | Changhua; New Delhi |
| gcp `asia-southeast1`; `southamerica-east1` | Jurong West; Osasco | Singapore; São Paulo |
| gcp `europe-north1`; `europe-west1`; `europe-west4` | Hamina; St. Ghislain; Eemshaven | Kouvola; Mons; Groningen |
| gcp `us-east1`; `us-west1` | Moncks Corner; The Dalles | Charleston; Vancouver (WA) |
| azure `brazilsoutheast`; `japaneast` | Rio; Tokyo, Saitama | Rio de Janeiro; Tokyo |

Spelling-only differences (Osaka and Ōsaka, Zurich and Zürich, Quebec and Québec, Copenhagen and
København, Queretaro and Querétaro) are not listed.

## Validation (T24-087)

`decodeBasemap` and `decodeGazetteer` validate the whole asset and return null on the first
violation; they never throw and never return part of an asset:

- exactly the §5.12 top-level keys; integer `v` 1 and `q` 100; every field's type and pattern
  (a2 `[A-Z]{2}` or `-99` and a3 `[A-Z]{3}` or `-99` in the basemap; region codes
  `[A-Z]{2}-[A-Z0-9]{1,3}`, IATA `[A-Z]{3}`, providers `[a-z][a-z0-9]{1,15}`, ids `[a-z0-9-]{1,40}`);
  names 1–100 code points; exact gazetteer row lengths;
- integers only, |x| ≤ 18000, |y| ≤ 8505 (basemap) or 9000 (gazetteer);
- even delta arrays; each ring ≥ 3 distinct points with no repeated consecutive point (the closing
  edge included); outer area > 0, hole area < 0; no empty polygon list;
- holes, exact on the integers: every hole vertex strictly inside its outer (a point on the boundary
  fails); no hole edge sharing any point with an outer edge or another hole's edge (crossing,
  touching or collinear overlap); no hole inside another;
- ring edges |Δx| ≤ 18000, except a polar closure (both ends on the same y = ±8505); polylines
  ≥ 2 points, no repeated consecutive point, |Δx| ≤ 18000.

The decoded basemap holds absolute interleaved `Int32Array` rings and polylines; the gazetteer holds
frozen rows in file order and six indexes (`countryByA2`, `countryByA3`, `countryByName` keyed by
the NFC lower-cased name, `regionByCode`, `iataByCode`, `cloudById`), each value in file order.

## Loading (`loadGeoData`)

```ts
loadGeoData(): Promise<GeoData>   // { basemap: Basemap | null; gazetteer: Gazetteer | null }
geoLoader(get, { basemap, gazetteer }): () => Promise<GeoData>   // the same over any fetch, for tests
```

The first call fetches both assets in parallel from the same origin (`fetch(url, { cache:
'force-cache' })`); every later call on the page returns that same promise and makes no request.
The promise never rejects. An asset whose GET fails or is not `ok`, whose body is not JSON, or that
does not validate is null, and one `console.debug` line `geo-data: basemap.json unavailable` (or
`gazetteer.json`) names it; the other asset is unaffected. There is no retry and no cancellation
(the request is shared): a failed asset stays null until the page reloads (T24 §9). With a null
basemap the frame (E2) shows "Map data unavailable"; with a null gazetteer every lookup is
`gazetteerUnavailable`, while coordinates and geohashes still place.

The asset files are content-hashed by the build: `urls.ts` imports both with `?url` and is the
`geo-assets` input of `vite.config.ts`, so the build emits `assets/basemap-<hash>.json` and
`assets/gazetteer-<hash>.json` and the signed asset manifest
([ADR-0016](../../designs/adr/0016-asset-integrity-verified-by-bff.md)) lists them. Until a route
imports `urls.ts` its entry chunk is empty and the initial JS is unchanged. No label leaves the
browser: the data is public and same-origin (T24 §8).

## How the assets are built

`tools/geo/build.py` (Python standard library only) builds both assets from five pinned public
domain sources and the tracked `tools/geo/cloud-regions.csv`; the sources, their digests and the
refresh procedure are in [the supply chain page](supply-chain.md#geo-data), and the make targets in
[Build, test and CI](../development/build-and-ci.md#geo-data). In outline (T24-085, T24-086):

- **Gazetteer.** Countries from Natural Earth 10m Admin 0 (`ISO_A2_EH`, `ISO_A3_EH`, `NAME_EN`,
  `LABEL_X`/`LABEL_Y`; a `-99` code drops the feature; of several features with one alpha-2 code
  the one whose `ADM0_A3` equals its alpha-3 code, if exactly one does, else all). Regions from
  Admin 1 (`iso_3166_2`; name `name_en`, else `name`, else the code; codes outside the pattern
  dropped). Airports from OurAirports (`large_airport` or `medium_airport`, scheduled service,
  `iata_code` `[A-Z]{3}`; place `municipality`, else `name`, else the code). Cloud rows joined on
  `ne_id` with Natural Earth populated places; an unknown `ne_id` or an `iso_a2` other than the
  place's fails the build.
- **Basemap.** Shapefile rings (outer clockwise; a hole joins the outer holding its first vertex).
  Assertions: no edge over 180° of longitude except a polar closure; vertices at |lat| ≥ 85.0511
  only in Antarctica. Then clamp, quantise and remove consecutive duplicates; a ring that collapses
  (fewer than 3 distinct points or zero area) is dropped and written to `tools/geo/report.txt`
  (today: one PRK sliver), unless it is its feature's largest polygon or covers ≥ 10⁻⁴ deg², which
  fails the build. Rings are oriented, rotated to their smallest point and checked with the hole
  predicate above; the strokes follow.

A build error prints `geo-build: ‹message›` (for example `PPP: hole not strictly inside its outer
ring`) and exits 2; `--check` exits 1 naming each file that differs from the rebuild.

## The map frame's rows (#234 Part 1)

```ts
geoRowSet(series, source: 'instant' | 'range', o: GeomapOptions, th: Thresholds | null,
  g: Gazetteer | null, q: Completeness): GeoRowSet
validateGeoRows(s: GeoRowSet, th: Thresholds | null): FrameDataIssue | null
geoFrame(s: GeoRowSet, b: Basemap, seq: number): GeoFrame
```

`geoRowSet` makes one `GeoRow` per series (T24-089). It merges duplicate series first (T22-003: an
instant result keeps the max on a tie and counts a conflict), then sorts by key in UTF-16 code
units, so the same series in any order give the same row set. Each row has:

- **`value`**: an instant result's one sample, or a range result reduced by `o.reducer`;
- **`valueStatus`** (T21-012): `noValue` (NaN), `infinite` (±Infinity), `outOfRange` (not 0, and
  smaller than 1e−290 or larger than 1e290 in size) or `ok`;
- **`state`**: null without thresholds; with them `unknown` for a value that is not `ok`, else the
  threshold state (`vis/thresholds.ts`);
- **`location`**: `locate(labels, o.location, g)` ([above](#resolving-a-location-locate));
- **`draw`**, the first that holds (zoom-independent):

| Draw status | When | Example (T24 §10.4 fixture G) |
|---|---|---|
| `notPlaced` | the location is not `placed` | `cloud_region=mars-north-1` (unknown code) |
| `outsideMap` | placed, but \|lat\| > 85.0511 | `lat=-89.9 lon=0` |
| `excluded` | placed on the map, but the value is not `ok` (the row is in the table and the meter only) | `lat=10 lon=10` with no value |
| `capped` | left out by the cap: above 5 000 drawable rows, `capMarks` keeps the max, the min, the worst state's rows (up to 500) and then the rest in key order (T22-006) | the Cap fixture's `c4999`–`c5001` |
| `shown` | drawn | `cloud_region=eu-west-1` (Dublin) |

`geoFrame(s, basemap, seq)` adds `shown`, the indices of the `shown` rows.

**Groups and labels (T24-090).** A row's group id is `{series: key}` without `groupBy`, else
`{present: true, value}` or `{present: false}` (the label is absent). Groups are numbered by first
appearance in key order. With 8 or more ids, ids 0–6 keep their own group and the rest join one
aggregate, group 7: id `{other: true}`, label `other (n)` (n = its member groups), pattern `grid`,
colour `category-other` (`colourIndex` null), with `members` (the ids) and `memberLabels` (their
final labels) in first-appearance order; an aggregated row keeps its own id. One group has the
`solid` pattern; several have `CATEGORY_PATTERNS[j]`. The colour is `seriesColourIndex` without
`groupBy`, else j mod 8. Labels:

- a series group: the series name (`{cloud_region="eu-west-1"}`);
- a present value: plain (`prod`), or `JSON.stringify` when it starts with `"`, equals `other` or
  `‹L› absent`, ends with ` (‹digits›)` or holds a control character (`"other (2)"`);
- an absent label: `‹L› absent` (`env absent`).

`finalLabels` then runs over every group and member label together: labels with the same base get
T22-004's distinguishing parts (`{lat="1", lon="2"} · __name__ absent`), and a label still shared,
or equal to the aggregate's, gets ` (n)`, n from 1 in key order, skipping labels in use. The
aggregate is never suffixed. So labels never collide.

**Coverage (T24 §4.11).** Counted before the cap: `total` (the drawable rows: `shown` or `capped`),
`drawn` (`shown`), what the cap kept, the worst state of the drawable rows and how many of them
were capped, the merge counts, the run's completeness and `geo`: `notPlaced` (not placed, ambiguous
and `gazetteerUnavailable` apart), `ambiguous`, `locationsUnavailable`, `outsideMap`, `noValue`,
`infinite` and `outOfRange`. The meter reads, for fixture G with a truncated run and two warnings:
`truncated · limited (2 warnings) · 3 not placed · 1 ambiguous · 1 outside the map · 4 without a
usable value (2 missing, 1 infinite, 1 out of range) · 1 duplicate series combined; 1 conflicts (max
kept)`.

**Validation.** `validateGeoRows` returns the first failing check as `{code: 'geo', detail}`, in
this order: `order` (keys non-empty and strictly increasing), `value`, `state` (against the
panel's thresholds), `draw` (recomputed with the cap), `group` (indices, ids, patterns, colours and
the aggregate's members) and `coverage` (every count recounted). A chart shows it as "Invalid map
data (‹detail›)".

**Table and CSV (T24-094, §4.14).** `geoTable(s, unit)` has one row per `GeoRow`, ordered by name
then key, with the columns `name, key, value, value_status, state, location_status,
location_detail, source, code, provider, place, lat, lon, group, group_member, draw_status`. The
cells are raw: `value` is `String(v)` (NaN empty, `Infinity`, `5e-300`); `location_detail` is
`‹reason› ‹key›` (invalid), `‹source› ‹key›=‹value›` (unknown code), `‹provider›: c1; c2` (provider
mismatch) or `‹reason›: c1; c2` (ambiguous); `place` is `geoPlace`; `group` is the drawn group's
label (`other (n)` for an aggregate member) and `group_member` the member's own label. `geoCsv` is
the same through `panelCsv`: RFC 4180, CRLF, every cell through `csvCell`, so a place `-89.9000,
0.0000` becomes `"'-89.9000, 0.0000"` while a number such as `-30` stays as it is.

**Facts (T22-014).** `geoFacts(title, s, series, instant, unit)` reads the rows with an `ok` value
(before the cap, any draw status): the focus is the worst state, then the higher value, then the
lower key; `current` its value and name, `change` (a range result) its series' largest step,
`extent` the min and max, `baselineRatio` null. With no `ok` value it is null.

**Inspector targets (T24-092, §4.13).** `geoTarget(s, frameSeq, ref)` builds a snapshot, so a
refetch never changes an open one: a `marker` (its row, no members), a `cluster`
(`cluster:‹seed›`, "Cluster of n", the keys' rows and one member per row), the `aggregate`
(`other:geo`, its rows and one member per member group with its label and label map) or a `group`
of an aggregate's entry (`group:` + the id as JSON, built from that target's snapshot only).
Every target carries the row set it came from (`set`). `geoPlace(row)` is the gazetteer's name,
else `lat, lon` to 4 places, else `''`.

## Tests

| Gate | Where | What |
|---|---|---|
| `unit:geo-locate` | `src/vis/geo/locate.test.ts` | the T24 §10.3 fixtures L, C, E and G0, coordinate aliases X1–X3, row identity, the normal form, 500 random label maps |
| `unit:geo-geohash` | `src/vis/geo/geohash.test.ts` | cell centres and sizes; `''`, 13 characters and `u4pa` are null |
| `unit:geo-decode` | `src/vis/geo/assets.test.ts` | the build fixtures decode (round trip); M1–M15, the ×100 hole cases and G1–G8 are null |
| `unit:geo-assets` | same | the bundled assets decode, the counts, the cloud inventory and exclusions, Dublin, St. Ghislain and Amsterdam, the manifest digests |
| `unit:geo-load` | same | one shared promise, two `force-cache` requests, a failed asset nulls only itself with one debug line |
| `unit:geo-build`, `unit:geo-gazetteer-build` | `tools/geo/test_build.py` (`make geo-test`) | the exact build outputs and errors of T24 §10.3, assembly, the gazetteer rules, digests before parsing, `--check`, the fixtures, the notices |
| `ci:geo-data` | `scripts/check-geo-data.ts` (`make geo-data`) | the committed assets match `tools/geo/manifest.json` and decode |
| `unit:geo-rows`, `unit:geo-identity` | `src/vis/geo/frame.test.ts` | fixture G's statuses with and without thresholds, each invalid set's detail, order independence; the groups, labels, patterns and colours of G, H, H′, A, O, Q, D, U, one row and S |
| `unit:geo-coverage` | `src/vis/reduce.test.ts` | G's meter line; the Cap selection and "showing 5,000 of 5,003; kept min, max" |
| `unit:geo-table-csv`, `unit:geo-facts` | `src/vis/geo/rows.test.ts` | CSV G and CSV X byte for byte, the unguarded table cells; the facts block |
| `unit:geo-targets` (builder rows) | `src/vis/geo/targets.test.ts` | the marker, cluster, O2 aggregate and `e8` group targets; `geoPlace` |

The client build fixtures under `src/vis/geo/fixtures/build/` are written by `build.py --fixtures`
from `tools/geo/fixtures/basemap-cases.json`; `unit:geo-build` checks they are current.
