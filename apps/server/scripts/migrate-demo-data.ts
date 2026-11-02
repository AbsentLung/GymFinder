// One-off migration from the vibe-coded demo DB (OLD_DATABASE_URL) into
// the real schema (DATABASE_URL). Read-only against the old DB.
//
// Idempotent: every insert is keyed on a natural/constructed unique key,
// so a re-run updates in place. Whole thing runs in one transaction.
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
  // Dropped - no row created.
  skipped: { oldId: unknown; reason: string }[]
  // Migrated OK, but with a caveat worth surfacing. Not in `skipped`.
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

    // id->label lookup for categories[] below - the new schema has no
    // standalone categories table.
    const { rows: oldCategories } = await oldPool.query("SELECT id, label FROM categories")
    const categoryLabelById = new Map<number, string>(oldCategories.map((c) => [c.id, c.label]))

    // --- users -------------------------------------------------------
    // password_hash is bcrypt, same scheme auth.ts verifies - carried
    // over as-is, no reset needed.
    const usersRpt = report("users")
    const { rows: oldUsers } = await oldPool.query(
      "SELECT id, email, name, password_hash, auth_provider, is_admin FROM users ORDER BY id"
    )
    usersRpt.oldCount = oldUsers.length
    const oldUserIdToNewId = new Map<number, number>()
    for (const u of oldUsers) {
      if (u.auth_provider !== "email" || !u.password_hash) {
        // A stubbed google/facebook signup has no real OAuth token to
        // carry over - needs a password reset instead.
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
    // Idempotency via gym_source_refs: OSM-sourced gyms key on their
    // real osm_id; others get a synthetic `demo_gym` ref keyed on the
    // old numeric id, so a re-run updates in place.
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

      // `rating` is a scraped Google rating, distinct from the app's own
      // review average - kept under its own key so they don't get confused.
      const details: Record<string, unknown> = {}
      if (g.rating != null) details.externalRating = Number(g.rating)
      if (g.trial_details) details.trialDetails = g.trial_details

      const hasTrial = g.trial_days == null ? null : g.trial_days > 0

      let gymId: number
      if (existing.rows[0]) {
        gymId = existing.rows[0].gym_id
        await client.query(
          `UPDATE gyms SET name = $1, location = ST_SetSRID(ST_MakePoint($2, $3), 4326),
             address = COALESCE(address, $4), description = COALESCE(description, $5),
             accepts_drop_in = COALESCE(accepts_drop_in, $6), has_trial = COALESCE(has_trial, $7),
             details = details || $8::jsonb
           WHERE id = $9`,
          [g.name, g.lng, g.lat, g.address, g.description, g.accepts_drop_in, hasTrial, JSON.stringify(details), gymId]
        )
      } else {
        const { rows } = await client.query(
          `INSERT INTO gyms (name, location, address, description, accepts_drop_in, has_trial, details)
           VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6, $7, $8)
           RETURNING id`,
          [g.name, g.lng, g.lat, g.address, g.description, g.accepts_drop_in, hasTrial, JSON.stringify(details)]
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

      // Confirmed prices on the old row -> verified gym_prices. Already
      // stored in USD cents, so amount_minor/usd_cents are the same number.
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

      // categories[] (gym_categories join -> text[])
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
    // No natural unique key (free-text `author`, no user_id) - (gym_id,
    // rating, created_at) is a practical dedup key here. Linked to a
    // user only on an exact name match; else stays unlinked.
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
        reviewsRpt.notes.push({ oldId: r.id, note: `migrated, but author "${r.author}" has no matching user - left unlinked` })
      }
    }

    // --- gym_submissions -> requests + gym_changes --------------------
    // 'admin_request' is dropped - "apply to be admin" no longer exists.
    // Everything else becomes a request + gym_changes pair, or a bare
    // gym_changes row when the old submission has no user (requests.user_id
    // is NOT NULL per FR-15, but gym_changes allows a null request_id).
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
      // approved_by = 0 is the seed data's bot sentinel; a real id = a human.
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
          note: "migrated to gym_changes, but no `requests` row - no submitted_by_user_id to satisfy requests.user_id (FR-15)",
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
    // No geohash concept in the old bbox tables - each bbox becomes one
    // row keyed on a synthetic geohash, just to carry the audit fact
    // forward. Real geohash4/5 coverage starts fresh from Phase 5 on.
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
