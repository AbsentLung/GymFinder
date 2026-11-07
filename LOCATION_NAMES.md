# Location names for gyms

Status: building (branch `phase-6-location-names-slice`, stacked on #33). Linked from [DESIGN.md](./DESIGN.md) and the [README roadmap](./README.md#roadmap).

## Goal

The gym view (including gyms with no address yet), My requests and the admin approval list all show **"City, Region, Country"** for every gym instantly. Nothing is geocoded at read time: names come from our own Postgres.

Today the admin list calls Photon live for every row (`routes/admin.ts`), and `gyms.country_code` is filled by a synchronous Photon call inside the insert path. Both go away.

## Schema

**New table `areas`**: one row per boundary polygon.

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `name` | text, not null | English or local name as the source gives it |
| `level` | text, not null | `country` / `region` / `county` / `city` (check constraint) |
| `parent_id` | bigint, FK → `areas.id`, nullable | Null only for countries |
| `country_code` | text, not null | ISO 3166-1 alpha-2 |
| `geom` | `geometry(MultiPolygon, 4326)`, not null | GiST index |
| `source_ref` | text, unique, not null | e.g. `geoBoundaries:<shapeID>`, so the seed can be re-run as an upsert and ids stay stable |

**`gyms` gets two columns:**
- `area_id`: nullable FK → `areas.id` (`ON DELETE SET NULL`), the most specific area that contains the gym.
- `postcode`: nullable free text (formats vary; many countries have none).

City, region and country text is **not** copied onto `gyms`. Read paths walk `parent_id` up from `area_id` in one recursive query.

The existing `gyms.country_code` stays, because it drives which currency a price is shown in. It is now set from the boundaries (a local `ST_Contains` on country polygons at insert) instead of from Photon, and the fill job keeps it in step with the area's country.

The word "admin" is kept out of these names on purpose (it clashes with the admin role).

## Boundary data

| Level | Source | Coverage |
|---|---|---|
| `country` | geoBoundaries **CGAZ ADM0** | World |
| `region` (state / province / island) | geoBoundaries **CGAZ ADM1** | World |
| `county` | geoBoundaries **CGAZ ADM2** | World where the country has an ADM2 level |
| `city` | geoBoundaries **gbOpen ADM3**, per country | Only countries where gbOpen has ADM3 under an allowed license (see below) |

- CGAZ ("Comprehensive Global Administrative Zones") is one gap-filled global composite. Disputed areas follow US Department of State definitions. It comes as shapefile zips (about 100–150 MB each) from `github.com/wmgeolab/geoBoundaries/raw/main/releaseData/CGAZ/`.
- **License:** geoBoundaries is CC BY 4.0. **Attribution is required.** In an app that means "geoBoundaries" (or `www.geoboundaries.org`) shown prominently, e.g. in the credits next to the OpenStreetMap attribution (README roadmap Phase 7). Adding it to the UI is a visible change, so it waits for Joey's OK (see open questions).
- gbOpen licenses vary per country, e.g. "CC BY 3.0 IGO". The seed only loads a gbOpen boundary if its `boundaryLicense` is CC0, public domain, CC BY (any version, including IGO) or ODbL. It logs and skips everything else.
- Loading uses `shp2pgsql`, which ships with PostGIS (Homebrew and the `postgis/postgis` image), so no new npm dependency. Downloads go to a temp dir and are never committed.

**Seed script** (`npm run seed:areas --workspace apps/server`), separate from migrations:
- `--fixture`: loads `apps/server/scripts/fixtures/areas.geojson`, a few small hand-made polygons with no download. Tests and CI use this.
- No flag: downloads CGAZ ADM0/1/2 (+ allowed gbOpen ADM3), loads each into a staging table, then upserts into `areas` by `source_ref`:
  - `ST_Multi(ST_MakeValid(geom))`
  - ISO3 → ISO2 country codes
  - `parent_id` = the area one level up whose polygon contains `ST_PointOnSurface(child)`
- Optional `--countries=THA,IDN` limits the load, for local dev.

## Flow

```mermaid
flowchart LR
  W[Gym inserted or location moved] --> J1[[gym-area job]]
  J1 -->|ST_Contains, deepest level wins| A[(gyms.area_id)]
  J1 -->|no polygon matched| J2[[gym-area-photon job]]
  J2 -->|rate-limited, retried| P[Photon reverse]
  P -->|match names onto existing areas| A
  B[[area-backfill job]] -->|gyms with area_id NULL, batches| J1
```

1. **Fill on write.** After a gym row is committed, the writer enqueues `gym-area { gymId }` (dedup `jobId` = `gym-area:<id>`). The writers are:
   - `gym-upsert.ts`, for Overpass refresh and sweeps, on insert and whenever the weekly refresh actually moves `location`;
   - `bot-review.ts`, when an approved `add_gym` is inserted.

   The job runs one query: `SELECT id FROM areas WHERE ST_Contains(geom, gym.location) ORDER BY level depth DESC LIMIT 1`, and sets `area_id` (and `country_code` if the area has one).
2. **Photon fallback.** If no polygon matched (e.g. a gym on a pier just outside a simplified coastline), the job enqueues `gym-area-photon { gymId }` with retries and backoff.
   - The job calls `https://photon.komoot.io/reverse` at most **1 request per second across all workers**. It uses the cache-backed limiter (Redis in scale mode); a job over the limit re-queues itself with a short delay instead of using up a retry.
   - It maps Photon's `countrycode`, `state`, `county` and `city` onto **existing** areas, matching each level by case-insensitive name under the parent it found, and sets `area_id` to the deepest match.
   - When retries run out, or nothing maps, `area_id` stays null. The gym is still saved and shown; the location line is just missing.
3. **Postcode.** Overpass `addr:postcode` → `RawGym.postcode` → `gyms.postcode` (COALESCE, never overwriting). The Google Maps scraper and gym-website research don't extract a structured postcode today, so they don't fill it yet (known limitation, not parsed from free-text addresses).
4. **Backfill.** `npm run backfill:areas --workspace apps/server` enqueues one `area-backfill` job. It pages through `gyms WHERE area_id IS NULL` by id (500 per batch) and enqueues `gym-area` for each. Re-run it after loading more boundary data. It is idempotent thanks to the dedup `jobId`.

Every job only carries IDs; Postgres stays the source of truth. Both jobs run on pg-boss (demo) or BullMQ (scale) through `QueueInterface`, which gains `retries` and `retryDelayMs` options.

## API fields

Every response below gains a `place` object (Zod schema `PlaceSchema` in `packages/shared`, every field nullable):

```json
"place": { "city": "Ubud", "region": "Bali", "county": "Gianyar", "country": "Indonesia", "countryCode": "ID", "postcode": "80571" }
```

- `GET /v1/gyms/{id}`: `place` on the gym.
- `GET /v1/me/requests` and `GET /v1/requests/{id}`: each change gets `gymId`, `gymName` and `place`.
  - `add_gym` changes that haven't created a gym yet use the proposal's own lat/lng, resolved with a read-time `ST_Contains` against `areas`. That is a local indexed query, not geocoding.
- `GET /v1/admin/changes`: `place` per row, which replaces `locationLabel`. It uses the same rule for unapproved `add_gym` rows.

A gym with no `area_id` returns `place` with every name null (postcode may still be set).

**App:** "City, Region, Country" is shown where the address is already shown: the gym panel on web and native, and the admin queue row. If the gym has no address, the place line takes its place. Any null part is skipped. My requests currently shows no gym location at all, so it gets the fields in the API but no new UI (layout unchanged).

## Test plan

- **Unit** (`npm test`):
  - Photon-properties → area-name picking;
  - `formatPlace`;
  - gbOpen license allow-list;
  - ISO3 → ISO2.
- **Integration** (`npm run test:integration`, needs PostGIS and Redis):
  - Runs twice, `MODE=demo` (pg-boss) and `MODE=scale` (BullMQ on Redis), against a throwaway `gymfinder_test` database: migrate, then `seed:areas --fixture`.
  - Checks:
    - a gym inside a fixture city gets that city;
    - a gym in a county with no city gets the county;
    - a gym outside every polygon falls back to Photon (Photon is **stubbed** with a fixed response, so tests don't hit the real service);
    - a Photon failure leaves `area_id` null without throwing out of the write path;
    - backfill fills old gyms;
    - the three API responses return `place`.
- `npm run typecheck`, `npm run lint`.

## Open questions

1. **City coverage.** Polygons only give a city where gbOpen has an ADM3 level, and ADM3 isn't "city" in every country (sometimes a sub-district). So many gyms will show "County, Region, Country" or "Region, Country". Options:
   - (a) also run the Photon job when the deepest match isn't a city, and let it create a geometry-less city row under the matched area;
   - (b) load GeoNames populated places (CC BY 4.0) and pick the nearest within a few km;
   - (c) accept the gap.

   **(c) for now**, since the brief maps Photon onto existing areas only.
2. **Name matching for the Photon fallback.** Photon (`lang=en`) and geoBoundaries names don't always agree ("Bali" vs "Provinsi Bali"). Simple case-insensitive matching will miss some. Should we add `unaccent` / prefix stripping?
3. **geoBoundaries attribution in the app**: where and when? Needs Joey's OK because it's visible.
4. **`gyms.country_code` vs the area's country**: keep both (current choice: currency logic stays untouched) or derive currency from `area_id` later?
5. **CI**: there is no test workflow yet (README Phase 3 item). The fixture set and `test:integration` script are ready for one.
