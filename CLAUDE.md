# CLAUDE.md

Gym Finder (TravelApp): helps budget backpackers find nearby gyms, free trials and the cheapest walk-ins.

Expo/React Native rules (SDK version, commands, routing, EAS) live in AGENTS.md:

@AGENTS.md

## Absolute rules

- **Never commit secrets to the repo.** That means API keys, tokens, passwords, private keys, and `.env` files. Keep secrets in env vars or a secrets manager, and only commit placeholder values (like `.env.example`). If a secret is ever committed, stop and tell Joey so it can be rotated.

## Project decisions

These were agreed with Joey. Follow them unless he changes them; update this file when he does.

### Platforms and scale
- Ship on Web, Android and iOS from one Expo codebase. Prefer shared cross-platform code; use `.web.tsx` / platform files only when a platform truly needs it.
- Must scale to thousands of users later. Avoid single-server shortcuts (in-memory state, local files as storage, per-process caches as the source of truth). Keep backend services stateless.

### Location search
- Use the Photon geocoder (photon.komoot.io) with search-as-you-type (debounce requests).
- Never use the public Nominatim server in production.

### Gym data
- Fetch gyms from the Overpass API (`leisure=fitness_centre`) and merge them with user-submitted gyms.
- Postgres + PostGIS is the source of truth: gyms, user-submitted gyms, and `last_fetched` per area.
- The app calls our backend, not Overpass directly.

### Caching and loading
- Split the map into fixed geohash4 cells (~39 × 20 km) for loading and caching; Overpass refreshes and sweeps use geohash5 cells inside them. Load the cells on screen as the user pans/zooms, only at zoom 11 and above (same as `FILTERS_VISIBLE_AT_ZOOM = 11` in the vibe-coded map). Below zoom 11: no tile requests, nothing cached, no gym pins, no filters.
- Refresh stale cells from Overpass (about weekly), using `last_fetched`.
- Saved/submitted gyms are written to Postgres immediately (never only to cache).
- Redis (ElastiCache) is the cache and BullMQ queue in scale mode; demo mode uses an in-memory cache and a pg-boss queue in Postgres. Access both only through small cache and queue interfaces.

### LLM
- The app uses Ollama (local/open models) for now to save money.
- Keep every LLM call behind one interface so it can switch to Claude once the app makes money. No provider-specific calls outside that module.
- Chats are temporary: never store chat questions or answers in Postgres or logs. Answers live in the cache for ~15 minutes only. Facts found by chat may be proposed as gym changes for review.

### UI
- Keep the UI as it is in the vibe-coded app (`GymFinderVibeCoded` branch); Joey is happy with it (2026-11-02). The restructure changes data loading and the map library underneath, not how the app looks or behaves.
- This includes the right sidebar and its collapsible sections (e.g. the trial section), the filter chips, the day-pass price list, the gym details panel and the add/edit gym flows. Reuse the existing components (`gym-panels.tsx` etc.) rather than redesigning them.
- Reviews UI stays as in the vibe-coded app; the only addition is an "Edit" button next to the signed-in user's own review. One review per user per gym, edits overwrite it (no review history).
- No "apply to be admin" flow; admins promote users.
- Any visible change needs Joey's OK first.

### Map filters
- Keep the filters exactly as in the vibe-coded map (`GymFinderVibeCoded` branch): text search (name, description, address, categories), drop-ins only, trials only, category dropdown, all client-side on loaded tiles. No price filter.
- Right sidebar day-pass list: cheapest first, unverified prices at the bottom.

### Shareable map links (decided by Joey 2026-11-02, FR-28 to FR-30)
- The map URL is the map's state: `/map?lat=&lng=&zoom=&gym=<id>&q=&dropin=1&trial=1&cat=a,b` (only set params that are in use). Opening that URL restores the same view, gym panel and filters, signed in or not.
- On web, update it with `history.replaceState` as the view changes (the vibe-coded `ViewportUrlSync` already does this for lat/lng/zoom; extend it, don't drop it in the MapLibre switch). Opening or closing a gym may push a history entry so Back closes the panel.
- On Android/iOS, a Share button shares the same web URL (React Native `Share`). Set up universal links (iOS) and app links (Android) through `app.json` so the link opens in the app when installed.
- Parse and build these URLs in one shared helper so web, Share and deep links agree.

### Hosting
- AWS (decided by Joey 2026-10-31; replaces the earlier Netlify + GCP e2-micro idea).
- Demo mode stays near-free on a single small instance; scale mode moves to managed AWS services. Demo: Lightsail + Docker Compose, S3 + CloudFront + Route 53. Scale: ECS Fargate, RDS Postgres, ElastiCache, AWS CDK. See STACK_AND_SCHEMA.md.
- Keep config in env vars and keep AWS-specific code behind interfaces, so services can be swapped.

### Stack and schema (decided 2026-11-01/02, details in STACK_AND_SCHEMA.md)
- TypeScript everywhere: Fastify API + workers, npm-workspaces monorepo, Zod schemas shared with the app. Drizzle ORM + migrations. Better Auth (users in our Postgres): email, Google and Facebook at launch; add Sign in with Apple before the iOS App Store release (Apple requires it).
- API contract: API.md (REST under `/v1`, Zod schemas, 202 + polling for slow work).
- Map: MapLibre with self-hosted Protomaps tiles. Never use the public OSM tile servers in production.
- Scraper: Playwright in sweep workers. Never pay for proxies or scraping APIs.
- Schema: PostGIS point + GIST + `geohash4` (loading) and `geohash5` (refresh/sweeps) columns; `tile_fetches`; `gym_prices` (current verified + unverified price per kind, no history, `last_seen_at`); `requests` + `gym_changes`; `gym_source_refs`; `users.role`; bigint IDs.
- Price verification: web price = verified; Google Maps menu photo posted < 1 year ago = verified; otherwise admin.
- Non-price verification (REQUIREMENTS.md FR-25 to FR-27): new gym verified if in OSM, on Google Maps or on its own website within ~50 m with a matching name and not a duplicate; name/address/hours/categories/drop-ins/trial verified if found on the gym's website or Google Maps listing; closing/removing a gym always needs an admin. Bot rejects spam, missing name/location, impossible locations, exact duplicates. Pending non-price changes stay hidden until approved.
- The chatbot may use our DB, the gym's website, its Google Maps page and web search; anything outside the gym's website or a recent menu photo is unverified.
- Unverified prices are stored too (`verified_by` empty, at most one verified + one unverified row per gym per kind) and shown below verified ones. They come from user edits or from the chatbot finding a price somewhere unverified (e.g. a review). Only an admin can verify them; approving one makes it the verified row.
