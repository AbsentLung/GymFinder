// Phase 4: one-off migration from the vibe-coded demo database
// (apps/server/db/schema.sql, read via OLD_DATABASE_URL) into the real
// schema (apps/server/src/db/schema.ts, written via DATABASE_URL), per
// STACK_AND_SCHEMA.md 2.14. Read-only against the old database - never
// writes, drops or truncates anything there.
//
// Idempotent: every insert is keyed on a natural or constructed unique
// key so re-running after a successful migration updates in place
// rather than duplicating. Runs the whole thing inside one transaction
// (rolled back on any error, so a failed run leaves nothing partial).
//
// Usage:
//   OLD_DATABASE_URL=postgres://localhost:5432/travelapp \
//   DATABASE_URL=postgres://postgres@localhost:5433/gymfinder \
//   npx tsx scripts/migrate-demo-data.ts
import pg from "pg"

const oldPool = new pg.Pool({
  connectionString: process.env.OLD_DATABASE_URL ?? "postgres://localhost:5432/travelapp",
})
const newPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

type Report = {
  entity: string
  oldCount: number
  newCount: number
  // Actually dropped - no row created at all.
  skipped: { oldId: unknown; reason: string }[]
  // Migrated successfully, but with a caveat worth surfacing (e.g. a
  // review that migrated with no linked user). Counted in newCount,
  // NOT in skipped - keeping them separate so the report never implies
  // data was dropped when it wasn't.
  notes: { oldId: unknown; note: string }[]
}
const reports: Report[] = []

function report(entity: string): Report {
  const r: Report = { entity, oldCount: 0, newCount: 0, skipped: [], notes: [] }
  reports.push(r)
  return r
}

async function migrate() {
  const client = await newPool.connect()
  try {
    await client.query("BEGIN")

    // --- categories (just for the id->label lookup used below; the new
    // schema doesn't have a `categories` table of its own, text[] per
    // STACK_AND_SCHEMA.md 2.8) -------------------------------------
    const { rows: oldCategories } = await oldPool.query("SELECT id, label FROM categories")
    const categoryLabelById = new Map<number, string>(oldCategories.map((c) => [c.id, c.label]))

    // --- users -------------------------------------------------------
    // password_hash is bcrypt, same scheme auth.ts's emailAndPassword
    // config verifies (confirmed live, not assumed) - carried over as-is
    // so existing accounts keep their password with no reset needed.
    const usersRpt = report("users")
    const { rows: oldUsers } = await oldPool.query(
      "SELECT id, email, name, password_hash, auth_provider, is_admin FROM users ORDER BY id"
    )
    usersRpt.oldCount = oldUsers.length
    const oldUserIdToNewId = new Map<number, number>()
    for (const u of oldUsers) {
      if (u.auth_provider !== "email" || !u.password_hash) {
        // Nothing in the real dataset hits this (all 4 demo users are
        // auth_provider='email' with a hash), but the demo's signup form
        // did accept 'google'/'facebook' as a stubbed no-op provider -
        // there's no real OAuth token to carry over for those, so they'd
        // need a password reset instead of a migrated hash. Flagged
        // rather than silently guessed at.
        usersRpt.skipped.push({ oldId: u.id, reason: `auth_provider=${u.auth_provider}, no bcrypt hash to carry over` })
        continue
      }
      const { rows } = await client.query(
        `INSERT INTO users (email, role, name, email_verified)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, name = EXCLUDED.name
         RETURNING id`,
        [u.email, u.is_admin ? "admin" : "user", u.name]
      )
      const newId = rows[0].id
      oldUserIdToNewId.set(u.id, newId)
      await client.query(
        `INSERT INTO account (user_id, account_id, provider_id, password)
         VALUES ($1, $2, 'credential', $3)
         ON CONFLICT (provider_id, account_id) DO UPDATE SET password = EXCLUDED.password`,
        [newId, String(newId), u.password_hash]
      )
      usersRpt.newCount++
    }

    // --- gyms + gym_source_refs + gym_prices + categories[] ----------
    // Idempotency for gyms: gym_source_refs is the natural home for
    // this (STACK_AND_SCHEMA.md 2.11) - OSM-sourced gyms key on their
    // real osm_id (useful for every future Overpass sync too, not just
    // this migration); gyms with no osm_id (bot_verified/admin_verified)
    // get a synthetic `demo_gym` source ref keyed on the old numeric id,
    // purely so a second run of this script recognizes them and updates
    // in place instead of inserting a duplicate.
    const gymsRpt = report("gyms")
    const { rows: oldGyms } = await oldPool.query("SELECT * FROM gyms ORDER BY id")
    gymsRpt.oldCount = oldGyms.length
    const oldGymIdToNewId = new Map<number, number>()

    for (const g of oldGyms) {
      const source = g.osm_id ? "osm" : "demo_gym"
      const externalId = g.osm_id ? String(g.osm_id) : String(g.id)

      const existing = await client.query(
        `SELECT gym_id FROM gym_source_refs WHERE source = $1 AND external_id = $2`,
        [source, externalId]
      )

      // details jsonb: the old `rating` column is a Google Maps scraped
      // rating, a different thing from the app's own review average
      // (which API.md computes from `reviews` at read time, and isn't a
      // stored gyms column at all in this schema) - kept here, not
      // dropped, under its own key so the two never get confused.
      const details: Record<string, unknown> = {}
      if (g.rating != null) details.externalRating = Number(g.rating)
      if (g.trial_details) details.trialDetails = g.trial_details

      const hasTrial = g.trial_days == null ? null : g.trial_days > 0

      let gymId: number
      if (existing.rows[0]) {
        gymId = existing.rows[0].gym_id
        await client.query(
          `UPDATE gyms SET name = $1, location = ST_SetSRID(ST_MakePoint($2, $3), 4326),
             accepts_drop_in = COALESCE(accepts_drop_in, $4), has_trial = COALESCE(has_trial, $5),
             details = details || $6::jsonb
           WHERE id = $7`,
          [g.name, g.lng, g.lat, g.accepts_drop_in, hasTrial, JSON.stringify(details), gymId]
        )
      } else {
        const { rows } = await client.query(
          `INSERT INTO gyms (name, location, accepts_drop_in, has_trial, details)
           VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6)
           RETURNING id`,
          [g.name, g.lng, g.lat, g.accepts_drop_in, hasTrial, JSON.stringify(details)]
        )
        gymId = rows[0].id
        await client.query(
          `INSERT INTO gym_source_refs (gym_id, source, external_id) VALUES ($1, $2, $3)
           ON CONFLICT (source, external_id) DO NOTHING`,
          [gymId, source, externalId]
        )
      }
      oldGymIdToNewId.set(g.id, gymId)
      gymsRpt.newCount++

      // Confirmed prices on the old `gyms` row -> verified gym_prices
      // (STACK_AND_SCHEMA.md 2.14: "the vibe-coded app shows them as
      // confirmed"). usd_cents: these were already stored in USD cents
      // in the old schema (the demo's canonical currency), so
      // amount_minor/currency/usd_cents are all the same number here -
      // a real FX-converted amountMinor only applies to genuinely
      // non-USD prices, which this migration doesn't have (the chatbot's
      // local-currency display was computed at read time, never stored).
      const priceKinds: [string, number | null][] = [
        ["day_pass", g.day_pass_price_cents],
        ["week_pass", g.week_pass_price_cents],
        ["month_pass", g.month_pass_price_cents],
      ]
      for (const [kind, cents] of priceKinds) {
        if (cents == null) continue
        await client.query(
          `INSERT INTO gym_prices (gym_id, kind, amount_minor, currency, usd_cents, source_kind, verified_by, last_seen_at)
           VALUES ($1, $2, $3, 'USD', $3, 'gym_website', 'admin', now())
           ON CONFLICT (gym_id, kind, is_verified) WHERE is_verified
           DO UPDATE SET amount_minor = EXCLUDED.amount_minor, usd_cents = EXCLUDED.usd_cents, last_seen_at = now()`,
          [gymId, kind, cents]
        )
      }

      // categories[] (gym_categories join -> text[], STACK_AND_SCHEMA.md 2.8)
      const { rows: catRows } = await oldPool.query("SELECT category_id FROM gym_categories WHERE gym_id = $1", [g.id])
      const labels = catRows.map((r) => categoryLabelById.get(r.category_id)).filter((l): l is string => !!l)
      if (labels.length > 0) {
        await client.query(`UPDATE gyms SET categories = $1 WHERE id = $2`, [labels, gymId])
      }
    }

    // --- unverified_gym_data -> unverified gym_prices -----------------
    const unverifiedRpt = report("unverified_gym_data")
    const { rows: oldUnverified } = await oldPool.query("SELECT * FROM unverified_gym_data")
    unverifiedRpt.oldCount = oldUnverified.length
    for (const u of oldUnverified) {
      const gymId = oldGymIdToNewId.get(u.gym_id)
      if (!gymId) {
        unverifiedRpt.skipped.push({ oldId: u.gym_id, reason: "gym_id not found among migrated gyms" })
        continue
      }
      const kinds: [string, number | null][] = [
        ["day_pass", u.day_pass_price_cents],
        ["week_pass", u.week_pass_price_cents],
        ["month_pass", u.month_pass_price_cents],
      ]
      let wroteAny = false
      for (const [kind, cents] of kinds) {
        if (cents == null) continue
        wroteAny = true
        await client.query(
          `INSERT INTO gym_prices (gym_id, kind, amount_minor, currency, usd_cents, source_kind, source_url, last_seen_at)
           VALUES ($1, $2, $3, 'USD', $3, 'review', $4, $5)
           ON CONFLICT (gym_id, kind, is_verified) WHERE NOT is_verified
           DO UPDATE SET amount_minor = EXCLUDED.amount_minor, usd_cents = EXCLUDED.usd_cents,
             source_url = EXCLUDED.source_url, last_seen_at = EXCLUDED.last_seen_at`,
          [gymId, kind, cents, u.source ?? null, u.scraped_at]
        )
      }
      if (wroteAny) unverifiedRpt.newCount++
      else unverifiedRpt.skipped.push({ oldId: u.gym_id, reason: "no price fields set - nothing to migrate" })
    }

    // --- reviews -------------------------------------------------------
    // No natural unique key in the old table (just a free-text `author`,
    // no user_id at all) - (gym_id, rating, created_at) stands in as a
    // practical dedup key for this one-time, low-volume migration.
    // "Linked where possible" (the brief's own words) means an exact
    // (case-sensitive) match against a migrated user's name; anything
    // else stays unlinked, same as the old app's anonymous reviews were.
    const reviewsRpt = report("reviews")
    const { rows: oldReviews } = await oldPool.query("SELECT * FROM reviews ORDER BY id")
    reviewsRpt.oldCount = oldReviews.length
    const { rows: newUsersForNameMatch } = await client.query("SELECT id, name FROM users")
    const newUserIdByName = new Map<string, number>(newUsersForNameMatch.map((u) => [u.name, u.id]))
    for (const r of oldReviews) {
      const gymId = oldGymIdToNewId.get(r.gym_id)
      if (!gymId) {
        reviewsRpt.skipped.push({ oldId: r.id, reason: "gym_id not found among migrated gyms" })
        continue
      }
      const matchedUserId = newUserIdByName.get(r.author) ?? null
      const existing = await client.query(
        `SELECT id FROM reviews WHERE gym_id = $1 AND rating = $2 AND created_at = $3`,
        [gymId, r.rating, r.created_at]
      )
      if (existing.rows[0]) continue // already migrated this exact review
      await client.query(
        `INSERT INTO reviews (gym_id, user_id, rating, body, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [gymId, matchedUserId, r.rating, r.body, r.created_at]
      )
      reviewsRpt.newCount++
      if (!matchedUserId) {
        reviewsRpt.notes.push({ oldId: r.id, note: `migrated, but author "${r.author}" has no matching user - left unlinked (user_id null), same as the old app's anonymous reviews` })
      }
    }

    // --- gym_submissions -> requests + gym_changes --------------------
    // 'admin_request' submissions are dropped on purpose: "apply to be
    // admin" is explicitly removed (CLAUDE.md, API.md decision #8) -
    // nothing in the new schema represents that submission kind, and
    // keeping the rows around with nowhere to render them would just be
    // dead data. Everything else (new_gym, edit) becomes a request +
    // gym_changes pair, or a bare gym_changes row when the old row has
    // no submitting user (requests.user_id is NOT NULL per FR-15 - only
    // signed-in users can submit/request, but gym_changes itself allows
    // a null request_id for exactly this kind of orphaned-provenance
    // case, same as a chat-found fact with no request behind it).
    const STATUS_TO_REVIEW: Record<number, string> = {
      1: "pending_bot",
      2: "awaiting_admin",
      3: "approved",
      4: "rejected",
    }
    const requestsRpt = report("gym_submissions -> requests/gym_changes")
    const { rows: oldSubmissions } = await oldPool.query(
      "SELECT * FROM gym_submissions WHERE submission_type != 'admin_request' ORDER BY id"
    )
    const { rows: oldAdminRequests } = await oldPool.query(
      "SELECT count(*) FROM gym_submissions WHERE submission_type = 'admin_request'"
    )
    requestsRpt.oldCount = oldSubmissions.length + Number(oldAdminRequests[0].count)
    requestsRpt.skipped.push({
      oldId: "(admin_request rows)",
      reason: `${oldAdminRequests[0].count} admin_request submission(s) dropped - "apply to be admin" flow is removed`,
    })

    for (const s of oldSubmissions) {
      const marker = `migrated_submission_${s.id}`
      const already = await client.query(`SELECT id FROM gym_changes WHERE evidence->>'migratedFrom' = $1`, [marker])
      if (already.rows[0]) continue

      const kind = s.submission_type === "new_gym" ? "add_gym" : "update_gym"
      const reviewStatus = STATUS_TO_REVIEW[s.status_id] ?? "awaiting_admin"
      // approved_by = 0 is the seed data's bot sentinel admin row (see
      // apps/server/db/seed.sql) - a real admin id means a human decided.
      const decidedBy = s.approved_by == null ? null : s.approved_by === 0 ? "bot" : "admin"
      const newUserId = s.submitted_by_user_id ? oldUserIdToNewId.get(s.submitted_by_user_id) : null
      const gymId = s.gym_id ? oldGymIdToNewId.get(s.gym_id) : null

      let requestId: number | null = null
      if (newUserId) {
        const { rows } = await client.query(
          `INSERT INTO requests (user_id, kind, status, deadline, input, result, created_at)
           VALUES ($1, $2, 'completed', $3, $4, $5, $6)
           RETURNING id`,
          [
            newUserId,
            kind,
            new Date(new Date(s.created_at).getTime() + 10 * 60 * 1000),
            JSON.stringify({ migratedFromSubmissionId: s.id, submittedByName: s.submitted_by_name }),
            JSON.stringify({ reviewStatus }),
            s.created_at,
          ]
        )
        requestId = rows[0].id
      } else {
        requestsRpt.notes.push({
          oldId: s.id,
          note: "migrated to gym_changes, but no `requests` row - requests.user_id is required (FR-15) and this old submission has no submitted_by_user_id",
        })
      }

      await client.query(
        `INSERT INTO gym_changes (request_id, gym_id, proposed, evidence, review_status, decided_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          requestId,
          gymId,
          JSON.stringify(s.payload),
          JSON.stringify({ migratedFrom: marker, description: s.description ?? null, submittedByName: s.submitted_by_name }),
          reviewStatus,
          decidedBy,
          s.created_at,
        ]
      )
      requestsRpt.newCount++
    }

    // --- fetched_areas / scanned_areas -> tile_fetches ------------------
    // No geohash concept existed in the old bbox-based tables, so this
    // can't be a precise per-cell translation - each old bounding box
    // becomes one tile_fetches row keyed on a synthetic geohash built
    // from its own min corner, which is only meant to carry the
    // "this area was fetched/scanned at this time" fact forward for
    // audit purposes. Real geohash4/5 coverage starts fresh from Phase 5
    // onward (every live Overpass/sweep call writes real cells).
    const tileFetchesRpt = report("fetched_areas/scanned_areas -> tile_fetches")
    const { rows: oldFetchedAreas } = await oldPool.query("SELECT * FROM fetched_areas")
    const { rows: oldScannedAreas } = await oldPool.query("SELECT * FROM scanned_areas")
    tileFetchesRpt.oldCount = oldFetchedAreas.length + oldScannedAreas.length
    for (const a of oldFetchedAreas) {
      const geohash = `legacy_bbox_${a.id}`
      await client.query(
        `INSERT INTO tile_fetches (geohash, source, last_fetched_at, status, gyms_found)
         VALUES ($1, 'osm', $2, 'ok', NULL)
         ON CONFLICT (geohash, source) DO UPDATE SET last_fetched_at = EXCLUDED.last_fetched_at`,
        [geohash, a.last_fetched_at]
      )
      tileFetchesRpt.newCount++
    }
    for (const a of oldScannedAreas) {
      const geohash = `legacy_bbox_${a.id}`
      await client.query(
        `INSERT INTO tile_fetches (geohash, source, last_fetched_at, status, gyms_found)
         VALUES ($1, 'google_maps', $2, 'ok', NULL)
         ON CONFLICT (geohash, source) DO UPDATE SET last_fetched_at = EXCLUDED.last_fetched_at`,
        [geohash, a.scanned_at]
      )
      tileFetchesRpt.newCount++
    }

    await client.query("COMMIT")
    return reports
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

async function spotCheck(n: number) {
  const { rows: sample } = await newPool.query(
    `SELECT g.id, g.name, ST_X(g.location) AS lng, ST_Y(g.location) AS lat, g.categories, g.accepts_drop_in, g.has_trial, g.details,
            (SELECT json_agg(json_build_object('kind', kind, 'usdCents', usd_cents, 'verified', is_verified)) FROM gym_prices WHERE gym_id = g.id) AS prices,
            (SELECT array_agg(source || ':' || external_id) FROM gym_source_refs WHERE gym_id = g.id) AS source_refs
     FROM gyms g ORDER BY random() LIMIT $1`,
    [n]
  )
  return sample
}

async function main() {
  console.log("Migrating demo data (read-only against OLD_DATABASE_URL, writes only to DATABASE_URL)...\n")
  const results = await migrate()

  console.log("=== Migration report ===")
  for (const r of results) {
    console.log(`\n${r.entity}: ${r.oldCount} old -> ${r.newCount} migrated, ${r.skipped.length} skipped`)
    for (const s of r.skipped) console.log(`  - SKIPPED (no row created) ${JSON.stringify(s.oldId)}: ${s.reason}`)
    for (const n of r.notes) console.log(`  - note (migrated OK) ${JSON.stringify(n.oldId)}: ${n.note}`)
  }

  console.log("\n=== Spot-check: 10 random migrated gyms ===")
  const sample = await spotCheck(10)
  for (const g of sample) console.log(JSON.stringify(g, null, 2))

  await oldPool.end()
  await newPool.end()
}

main().catch((e) => {
  console.error("Migration FAILED, rolled back:", e)
  process.exitCode = 1
})
