# Notes

Decision log, unconfirmed assumptions and known limitations. One line each: decision / alternative / trade-off.

## Location names (LOCATION_NAMES.md)
- Stacked the PR on #33 (top of the restructure stack), not main / main has no backend yet / retarget to main once the stack merges.
- Boundaries from geoBoundaries CGAZ ADM0-2 + gbOpen ADM3 (allowed licenses only) / OSM admin_level extracts / one clean global CC BY 4.0 set, but city coverage is patchy and attribution is required.
- Loading with `shp2pgsql` (ships with PostGIS) / an npm shapefile parser / no new dependency, but the full seed needs PostGIS CLI tools on the machine.
- `.dbf` names read as raw bytes and decoded per name (UTF-8, else Windows-1252) / trust the file's declared encoding / the declared 1252 is wrong for most names and right for a few.
- Territories folded into a parent (HK, MO, PR, GU, AS, MP, VI, AX) promoted to country level by an explicit list / leave them under the parent / keeps their own currency; list must be maintained by hand.
- Kept `gyms.country_code`, now set from polygons at insert and by the job / derive currency from `area_id` / currency code untouched, small duplication of the country.
- Area lookup one level at a time, deepest first / one query over all levels / the single query made seed linking take 8+ min (huge country outlines tested for every point); more round trips per lookup.
- Photon job waits for a limiter slot instead of re-queueing itself / re-queue with delay / pg-boss's exclusive policy would drop a re-queue of the still-active job.
- Unapproved add_gym rows resolve `place` with a read-time polygon lookup / a stored area_id on gym_changes / no extra column; local indexed query, not geocoding.
- `place` type kept in server and app separately / Zod schema in packages/shared / packages/shared is still an unused placeholder; using it would add Zod to the app bundle.
- Country display name from the ISO code (Intl.DisplayNames) / CGAZ's own names / CGAZ uses "Korea, South" style.
- Fixed while testing: approving any add_gym failed (categories interpolated as a value list, "()" when empty). Now bound as text[] like category edits.
- Assumption (unconfirmed): showing "City, Region, Country" under the address (same "Address" label, also when there's no address) counts as Joey's OK for that visible change, since the brief asks for it.
- Stubbed: Photon is stubbed in the integration tests; the real service is never called by tests.
- Limitation (blocking, open question 0): CGAZ ADM1/ADM2 are heavily simplified (Shanghai Municipality = 21 vertices), so central Shanghai, Hong Kong Island, central Lisbon and coastal San Juan miss their region/county. Roadmap item left unchecked until the boundary source is decided.
- Limitation: no city wherever no allowed ADM3 polygon exists (incl. Indonesia, Thailand, USA, Vietnam), see open question 1.
- Limitation: territories with no polygon at all (Réunion, French Polynesia, Aruba, ...) get country_code from Photon but no area.
- Limitation: postcode only from OSM addr:postcode; Google Maps / website don't expose a structured postcode yet.
- Limitation: a pg-boss gym-area job already queued/active for a gym drops a second enqueue (exclusive policy); a move during that window waits for the next refresh or backfill.
- Limitation: no geoBoundaries attribution in the app yet (visible change, needs Joey's OK).
