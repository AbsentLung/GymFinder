# Notes

Decision log, unconfirmed assumptions and known limitations. One line each: decision / alternative / trade-off.

## Location names (LOCATION_NAMES.md)
- Stacked the PR on #33 (top of the restructure stack), not main / main has no backend yet / retarget to main once the stack merges.
- Regions only, no cities (Joey, 2026-11-07) / country → region → county → city hierarchy (built first, then cut) / ~3,200 rows and 141 MB instead of ~133k rows and ~1 GB, no parent chain; "Region, Country" only.
- Region outlines from geoBoundaries CGAZ ADM1 for now (my reading of Joey's "go" on the recommended option) / OpenStreetMap state boundaries / no new loading path, but simplified outlines miss some city centres and coasts.
- Loading with `shp2pgsql` (ships with PostGIS) / an npm shapefile parser / no new dependency, but the full seed needs PostGIS CLI tools on the machine.
- `.dbf` names read as raw bytes and decoded per name (UTF-8, else Windows-1252) / trust the file's declared encoding / the declared 1252 is wrong for most names and right for a few.
- Territory regions (HK, MO, PR, GU, AS, MP, VI, AX) get their own country code from an explicit list / keep the parent's code / keeps their own currency; list maintained by hand.
- Country name from `gyms.country_code` (Intl.DisplayNames), not from the region / store countries too / one source for currency and display; Photon-only gyms still show a country.
- Photon job waits for a limiter slot instead of re-queueing itself / re-queue with delay / pg-boss's exclusive policy would drop a re-queue of the still-active job.
- Unapproved add_gym rows resolve `place` with a read-time polygon lookup / a stored region_id on gym_changes / no extra column; local indexed query, not geocoding.
- `place` type kept in server and app separately / Zod schema in packages/shared / packages/shared is still an unused placeholder; using it would add Zod to the app bundle.
- Assumption (unconfirmed): showing "Region, Country" under the address (same "Address" label, also when there's no address) counts as Joey's OK for that visible change, since the brief asks for it.
- Stubbed: Photon is stubbed in the integration tests; the real service is never called by tests.
- Limitation: CGAZ outlines are coarse; 15/20 spot-checked places matched; central Shanghai, Hong Kong and coastal San Juan fall back to Photon (country set, region only if names match).
- Limitation: Photon state names are matched exactly (case-insensitive), so "Shanghai" ≠ "Shanghai Municipality".
- Limitation: territories with no polygon (Réunion, French Polynesia, Aruba, ...) get country_code from Photon but no region.
- Limitation: a few source names are already corrupted ("Hà N?i"), not repairable.
- Limitation: postcode only from OSM addr:postcode; Google Maps / website don't expose a structured postcode yet.
- Limitation: a pg-boss gym-region job already queued/active for a gym drops a second enqueue (exclusive policy); a move during that window waits for the next refresh or backfill.
- Limitation: no geoBoundaries attribution in the app yet (visible change, needs Joey's OK).
