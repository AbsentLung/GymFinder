// Hackathon demo server - not the real backend. Talks to Postgres directly,
// one endpoint, no auth, no Redis, no queue. Plan.md has the real design.
import "dotenv/config"
import express from "express"
import cors from "cors"
import pg from "pg"
import { chromium } from "playwright"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import {
  looksLikeRealCoordinates,
  isDuplicateMatch,
  isWithinStaleWindow,
  getCountryCurrency,
  convertToUsdCents,
  extractLatLngFromMapsHref,
  bboxToGoogleMapsZoom,
  categoriesFromRawText,
  osmTagsToGymFields,
  GYM_CATEGORIES,
  validateSignupInput,
  requireDescription,
} from "./lib.js"
import { runAgentTurn, AI_PROVIDER, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL } from "./ai.js"

const pool = new pg.Pool({ database: "travelapp" })
console.log(`AI provider: ${AI_PROVIDER}${AI_PROVIDER === "ollama" ? " (local, free - set AI_PROVIDER=anthropic for production)" : ""}`)
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error("JWT_SECRET is not set - see .env.example")
const app = express()
app.use(cors())
app.use(express.json())
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" })
}

function toPublicUser(row) {
  return { id: row.id, email: row.email, name: row.name, authProvider: row.auth_provider, isAdmin: row.is_admin }
}

// Re-reads is_admin from Postgres on every request rather than trusting
// whatever the token said at login time - an admin application approved
// after a user's last sign-in should take effect immediately, not after
// they sign out and back in.
async function authenticate(req, res, next) {
  const header = req.headers.authorization
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: "Sign in required." })
  let payload
  try {
    payload = jwt.verify(token, JWT_SECRET)
  } catch (e) {
    return res.status(401).json({ error: "Session expired or invalid - sign in again." })
  }
  const { rows } = await pool.query("SELECT id, email, name, auth_provider, is_admin FROM users WHERE id = $1", [payload.userId])
  if (!rows[0]) return res.status(401).json({ error: "Account no longer exists." })
  req.user = toPublicUser(rows[0])
  next()
}

function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: "Admin access required." })
  next()
}

app.post("/api/auth/signup", async (req, res) => {
  const { email, password, name } = req.body
  const error = validateSignupInput({ email, password, name })
  if (error) return res.status(400).json({ error })

  const normalizedEmail = email.toLowerCase()
  const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail])
  if (existing[0]) return res.status(409).json({ error: "An account with that email already exists." })

  const passwordHash = await bcrypt.hash(password, 10)
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, auth_provider) VALUES ($1, $2, $3, 'email')
     RETURNING id, email, name, auth_provider, is_admin`,
    [normalizedEmail, passwordHash, name.trim()]
  )
  res.status(201).json({ token: signToken(rows[0].id), user: toPublicUser(rows[0]) })
})

app.post("/api/auth/signin", async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." })

  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [String(email).toLowerCase()])
  const user = rows[0]
  if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Incorrect email or password." })
  }
  res.json({ token: signToken(user.id), user: toPublicUser(user) })
})

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: req.user }))

// Would run once real Facebook OAuth exists and a user signs up through
// it, per the explicit request that a Facebook signup should also post
// an announcement to the user's timeline. Meta only grants that publish
// permission to an app that's been through App Review - not something
// achievable from code alone - so this stays a logging no-op until a
// reviewed app and real permission exist; nothing calls it yet since
// Facebook sign-in itself is still just a disabled button on the
// frontend pending real OAuth credentials.
async function postSignupAnnouncementToFacebook(user, accessToken) {
  console.log(`[facebook-post stub] Would post signup announcement for ${user.name} - needs Meta App Review before this can call the real Graph API.`)
}

// Stub - logs the composed email instead of sending it, until a real
// provider (SendGrid, Resend, Mailgun, Postmark, etc.) and API key are
// wired in here. Keeping the call site and the actual composed content
// real now means swapping in a real send is the only change needed later.
const SUBMISSION_TYPE_LABELS = { new_gym: "gym creation", edit: "gym edit", admin_request: "admin application" }
async function sendSubmissionDecisionEmail(user, submission, decision) {
  console.log(
    `[email stub] To: ${user.email}\n` +
      `Subject: Your ${SUBMISSION_TYPE_LABELS[submission.submission_type]} request was ${decision}\n\n` +
      `Hi ${user.name},\n\nYour request ("${submission.description}") was ${decision}.\n\n- TravelApp`
  )
}

app.get("/api/gyms/:id/reviews", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, author, rating, body, created_at FROM reviews WHERE gym_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  )
  res.json(rows)
})

app.post("/api/gyms/:id/reviews", async (req, res) => {
  const { author, rating, body } = req.body
  const { rows } = await pool.query(
    "INSERT INTO reviews (gym_id, author, rating, body) VALUES ($1, $2, $3, $4) RETURNING id, author, rating, body, created_at",
    [req.params.id, author, rating, body]
  )
  res.status(201).json(rows[0])
})

// looksLikeRealCoordinates imported from ./lib.js - used as the fallback
// check below when the scrape itself fails (not when it just finds
// nothing - see looksLegit's comment further down).

// The real check Plan.md always called for: does a place matching this
// name actually exist near these coordinates on Google Maps? A real
// Playwright scrape, not an API call - the submitter asked for a bot that
// scrapes, not one that pays for Google's official Places API.
//
// The @lat,lng,zoom URL segment biases Google Maps to resolve directly to
// a single place near that point rather than a disambiguation list.
// First cut of this checked the page <title> for "<Name> - Google Maps" -
// wrong, verified live: Google echoes the search text into <title> even
// when nothing matches and it falls back to a results list ("Zzxqplorf
// Fitness Nonexistent" got a title as if it resolved, then silently
// approved itself unchanged - caught by testing the rejection path, not
// by inspection). The DOM signal that's actually reliable: a confidently
// resolved single place renders exactly one <h1> holding the real place
// name; a fallen-back results list renders an <h1> that just says
// "Results" (plus an empty one) - checked both cases live before trusting
// this. Separately, the reviews UI Google serves automated browsers is a
// stripped "limited view" with no reviews tab at all - irrelevant here
// since this never clicks into reviews, only reads what's already on the
// resolved place's own page.
async function findGoogleMapsMatch(name, lat, lng) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat},${lng},15z?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 8000,
    })
    await page.waitForTimeout(1500) // h1/address render async after the place resolves
    const h1Texts = await page.locator("h1").allInnerTexts()
    const placeName = h1Texts.map((t) => t.trim()).find((t) => t && t !== "Results")
    if (!placeName) return null

    // [data-item-id="address"] - confirmed live, a stable, specific
    // selector Google Maps uses for the address button on a resolved
    // place's page (not a guess from body-text position, which would be
    // fragile to layout changes).
    const addressTexts = await page.locator('[data-item-id="address"]').allInnerTexts()
    // Google renders a small icon (a pin glyph) inline before the address
    // text using its own icon font - scraped as plain text with no icon
    // font loaded, that comes through as a garbage Private Use Area
    // character (U+E0C8 in a real test). .trim() doesn't strip it since
    // it isn't whitespace; stripping the PUA range explicitly first does.
    const address = addressTexts[0]?.replace(/^[\u{E000}-\u{F8FF}\s]+/u, "").trim() || null

    // button[jsaction*="category"] - the one-line category text under a
    // place's name (e.g. "Muay Thai boxing gym") - confirmed live. This
    // was already sitting on the exact page bot-sweep/find-more-gyms
    // already loads to verify a name, just never read before; no reason
    // to ask an AI to guess a gym's type when Google already states it.
    const rawCategory = (await page.locator('button[jsaction*="category"]').first().innerText().catch(() => null))?.trim() || null
    const categories = categoriesFromRawText(rawCategory)

    return { name: placeName, address, categories }
  } finally {
    await browser.close()
  }
}

// Merge, not replace - a gym's existing categories (from an earlier bot
// sweep, chat finding, or admin edit) shouldn't get wiped out just
// because a later pass found a different, also-true tag. Matching by
// label against the categories table rather than trusting caller-
// supplied ids also means a garbage/hallucinated tag name (anything not
// in GYM_CATEGORIES) is silently dropped instead of needing its own
// validation at every call site - the same "match against what's
// actually valid" defense already used for hallucinated tool names.
async function addGymCategories(gymId, categories) {
  if (!categories?.length) return
  await pool.query(
    `INSERT INTO gym_categories (gym_id, category_id)
     SELECT $1, id FROM categories WHERE label = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [gymId, categories]
  )
}

// Correlated subquery, not a GROUP BY - keeps every other column in
// whatever SELECT this gets spliced into a plain per-row value instead
// of needing the whole query restructured around one aggregate. `g` is
// the expected alias for the gyms row in scope wherever this is used.
const GYM_CATEGORIES_SELECT =
  "(SELECT COALESCE(array_agg(c.label ORDER BY c.label), ARRAY[]::text[]) FROM gym_categories gc JOIN categories c ON c.id = gc.category_id WHERE gc.gym_id = g.id) AS categories"

async function runBotSweep(submissionId, createdByUserId) {
  const { rows } = await pool.query("SELECT * FROM gym_submissions WHERE id = $1", [submissionId])
  const payload = rows[0].payload

  const { rows: nearby } = await pool.query(
    `SELECT id, name, similarity(name, $3) AS name_similarity,
       (6371 * acos(GREATEST(-1, LEAST(1,
         cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) +
         sin(radians($1)) * sin(radians(lat))
       )))) AS distance_km
     FROM gyms
     ORDER BY distance_km ASC
     LIMIT 5`,
    [payload.lat, payload.lng, payload.name]
  )
  const duplicate = nearby.find((g) => isDuplicateMatch(g.distance_km, g.name_similarity))

  // Skip the scrape entirely when it's already a duplicate - no point
  // spending a browser launch on a submission we're rejecting anyway.
  let scrapeMatch = null
  let scrapeFailed = false
  if (!duplicate) {
    try {
      scrapeMatch = await findGoogleMapsMatch(payload.name, payload.lat, payload.lng)
    } catch (e) {
      console.error("Google Maps scrape failed:", e.message)
      scrapeFailed = true
    }
  }

  // A scrape that ran and found nothing is a real "no" - reject it. A
  // scrape that broke (network blip, Playwright crash) isn't evidence of
  // anything, so fall back to the old plausibility-only check rather than
  // sending every submission to admin review just because scraping itself
  // had a bad moment.
  const looksLegit = scrapeFailed
    ? !!payload.name?.trim() && looksLikeRealCoordinates(payload.lat, payload.lng)
    : !!scrapeMatch

  if (!duplicate && looksLegit) {
    // Location (lat/lng) stays whatever the submitter pinned - the scrape
    // only establishes a canonical name, address, and category, not
    // canonical coordinates.
    const finalName = scrapeMatch?.name ?? payload.name
    const { rows: gymRows } = await pool.query(
      `INSERT INTO gyms (name, lat, lng, address, data_source, created_by_user_id) VALUES ($1, $2, $3, $4, 'bot_verified', $5) RETURNING id`,
      [finalName, payload.lat, payload.lng, scrapeMatch?.address ?? null, createdByUserId]
    )
    await addGymCategories(gymRows[0].id, scrapeMatch?.categories ?? [])
    await pool.query(
      "UPDATE gym_submissions SET status_id = 3, gym_id = $1, approved_by = 0, approved_at = now() WHERE id = $2",
      [gymRows[0].id, submissionId]
    )
    return {
      statusId: 3,
      gymId: gymRows[0].id,
      reason: null,
      name: finalName,
      address: scrapeMatch?.address ?? null,
      categories: scrapeMatch?.categories ?? [],
    }
  }

  await pool.query("UPDATE gym_submissions SET status_id = 2 WHERE id = $1", [submissionId])
  return {
    statusId: 2,
    gymId: null,
    reason: duplicate
      ? `possible duplicate of "${duplicate.name}"`
      : scrapeFailed
        ? "couldn't confirm this is a real, in-bounds gym"
        : "couldn't find a matching place on Google Maps nearby",
  }
}

// A new-gym submission only ever collects a name (plus the location the
// submitter dropped a pin at) - everything else arrives later through an
// edit request, per Plan.md's "Users can also request metadata updates".
// Requires sign-in (authenticate) and a description, per the explicit
// request that adding/editing a gym needs an account and every such
// request carries a description.
app.post("/api/gyms/submissions", authenticate, async (req, res) => {
  const { name, lat, lng, description } = req.body
  const descError = requireDescription(description)
  if (descError) return res.status(400).json({ error: descError })

  const payload = { name, lat, lng }
  const { rows } = await pool.query(
    `INSERT INTO gym_submissions (submitted_by_name, submitted_by_user_id, submission_type, description, payload)
     VALUES ($1, $2, 'new_gym', $3, $4)
     RETURNING id, created_at`,
    [req.user.name, req.user.id, description.trim(), JSON.stringify(payload)]
  )
  const submissionId = rows[0].id
  const sweep = await runBotSweep(submissionId, req.user.id)
  const { rows: statusRows } = await pool.query(
    "SELECT label FROM gym_submission_statuses WHERE id = $1",
    [sweep.statusId]
  )
  // Carries the FINAL name/address back (bot-corrected, not the raw
  // submission) - without these, the frontend's optimistic merge has
  // nothing but the submitter's own typed name to show immediately, so a
  // corrected spelling ("Dang Muay Thai" -> the real canonical listing
  // name) wouldn't appear until the next full reload picked it up from
  // Postgres instead.
  res.status(201).json({
    id: submissionId,
    createdAt: rows[0].created_at,
    statusId: sweep.statusId,
    statusLabel: statusRows[0]?.label,
    gymId: sweep.gymId,
    botReason: sweep.reason,
    gymName: sweep.name ?? name,
    gymAddress: sweep.address ?? null,
    categories: sweep.categories ?? [],
  })
})

// docs/gym-data-design.md: per-area Overpass fetch, merged into Postgres,
// refreshed on lookup when an area is stale. Backend-only for now - no
// location-search UI calls this yet (that's Photon, built separately).
const AREA_STALE_MS = 7 * 24 * 60 * 60 * 1000

// overpass-api.de is a free, shared public server that genuinely runs
// out of capacity at times ("All query workers are busy and the request
// queue is full", confirmed live via its own 502 response body, which
// explicitly recommends exponential-backoff retries). A mirror fallback
// was tried first (same shape as Photon -> Nominatim elsewhere in this
// file) but overpass.osm.ch, despite responding fast with valid JSON,
// turned out to have an empty/stale database (confirmed live: zero
// restaurants in central London, which isn't a real answer) - silently
// "succeeding" with wrong data is worse than a clear failure, since it'd
// get cached as "this area has no gyms." Retrying the one real instance
// is the honest fix Overpass's own error message asks for.
const OVERPASS_URL = "https://overpass-api.de/api/interpreter"
const OVERPASS_MAX_ATTEMPTS = 3
const OVERPASS_RETRY_DELAY_MS = 4000

async function fetchOverpassGyms({ minLat, minLng, maxLat, maxLng }) {
  const query = `[out:json];nwr["leisure"="fitness_centre"](${minLat},${minLng},${maxLat},${maxLng});out center tags;`
  let lastError
  for (let attempt = 1; attempt <= OVERPASS_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: {
          "User-Agent": "TravelApp-GymFinder-Demo/1.0 (hackathon demo)",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "data=" + encodeURIComponent(query),
      })
      if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`)
      const data = await res.json()
      return data.elements
        .map((el) => ({
          osmId: el.id,
          name: el.tags?.name?.trim() || null,
          lat: el.lat ?? el.center?.lat ?? null,
          lng: el.lon ?? el.center?.lon ?? null,
          // Already came back in this same response ("out center tags;"
          // asks for it) - free enrichment when a mapper happened to add
          // an address/description/sport tag, which most gyms won't
          // have, but costs nothing to use when it's there.
          ...osmTagsToGymFields(el.tags),
        }))
        .filter((g) => g.name && g.lat != null && g.lng != null)
    } catch (e) {
      console.error(`Overpass attempt ${attempt}/${OVERPASS_MAX_ATTEMPTS} failed:`, e.message)
      lastError = e
      if (attempt < OVERPASS_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, OVERPASS_RETRY_DELAY_MS * attempt))
    }
  }
  throw lastError
}

async function mergeGymsIntoDb(gyms) {
  for (const g of gyms) {
    // The original one-time Bali seed never captured osm_id, so matching
    // only on osm_id would insert a fresh duplicate for every gym that
    // predates this fetch-and-merge path. Fall back to the same
    // name+proximity match already used for duplicate detection in the
    // bot sweep, and adopt the osm_id onto that legacy row instead of
    // inserting a new one.
    const { rows: legacyMatch } = await pool.query(
      `SELECT id FROM gyms
       WHERE osm_id IS NULL
         AND similarity(name, $1) > 0.6
         AND (6371000 * acos(GREATEST(-1, LEAST(1,
               cos(radians($2)) * cos(radians(lat)) * cos(radians(lng) - radians($3)) +
               sin(radians($2)) * sin(radians(lat))
             )))) < 100
       ORDER BY similarity(name, $1) DESC
       LIMIT 1`,
      [g.name, g.lat, g.lng]
    )

    // address/description use COALESCE - fill the gap only, never
    // overwrite something already on file. Unlike name/lat/lng (which
    // this already treats as authoritative from OSM and always
    // overwrites), address/description also come from the bot scrape,
    // chat research, and admin edits - a periodic 7-day re-fetch
    // shouldn't clobber a better answer one of those already gave with
    // whatever (usually nothing, occasionally present) OSM happens to
    // have. Categories merge the same additive way addGymCategories
    // already does everywhere else - adding a tag never removes one.
    if (legacyMatch[0]) {
      await pool.query(
        `UPDATE gyms SET osm_id = $1, name = $2, lat = $3, lng = $4, data_source = 'osm',
           address = COALESCE(address, $6), description = COALESCE(description, $7)
         WHERE id = $5`,
        [g.osmId, g.name, g.lat, g.lng, legacyMatch[0].id, g.address, g.description]
      )
      await addGymCategories(legacyMatch[0].id, g.categories)
      continue
    }

    // Same name+proximity heuristic as the bot-sweep/find-more-gyms
    // duplicate checks, but here checking against rows that already
    // HAVE a different osm_id - not the legacyMatch case above. Caught
    // live: OSM itself sometimes maps the same real-world gym twice
    // under two different element IDs (e.g. "Income Gym" as two
    // separate nodes ~4m apart in Chiang Mai), which ON CONFLICT
    // (osm_id) can never catch since neither element's ID collides with
    // the other's - every sync kept re-affirming both rows as distinct,
    // permanently. Merging into the match here instead of inserting
    // means the second OSM element just keeps topping up the same gym
    // row every sync rather than ever getting its own.
    const { rows: nearDuplicate } = await pool.query(
      `SELECT id, similarity(name, $1) AS name_similarity,
         (6371 * acos(GREATEST(-1, LEAST(1,
           cos(radians($2)) * cos(radians(lat)) * cos(radians(lng) - radians($3)) +
           sin(radians($2)) * sin(radians(lat))
         )))) AS distance_km
       FROM gyms
       WHERE osm_id IS NOT NULL AND osm_id != $4
       ORDER BY distance_km ASC
       LIMIT 3`,
      [g.name, g.lat, g.lng, g.osmId]
    )
    const duplicate = nearDuplicate.find((row) => isDuplicateMatch(row.distance_km, row.name_similarity))
    if (duplicate) {
      await pool.query(
        `UPDATE gyms SET address = COALESCE(address, $2), description = COALESCE(description, $3) WHERE id = $1`,
        [duplicate.id, g.address, g.description]
      )
      await addGymCategories(duplicate.id, g.categories)
      continue
    }

    const { rows: gymRows } = await pool.query(
      `INSERT INTO gyms (osm_id, name, lat, lng, data_source, address, description)
       VALUES ($1, $2, $3, $4, 'osm', $5, $6)
       ON CONFLICT (osm_id) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
         address = COALESCE(gyms.address, EXCLUDED.address), description = COALESCE(gyms.description, EXCLUDED.description)
       RETURNING id`,
      [g.osmId, g.name, g.lat, g.lng, g.address, g.description]
    )
    await addGymCategories(gymRows[0].id, g.categories)
  }
}

// Fully contained in a previously-fetched box, and that fetch isn't stale
// -> skip Overpass entirely. Otherwise fetch this exact box and merge.
// Deliberately synchronous (no waiting-room polling) - there's no UI
// consuming this yet, and a single await here is simpler until real
// latency under concurrent requests actually shows up as a problem.
// "Already covered" is inherently a fuzzy question, not a bit-for-bit
// one - caught live: the exact same "Near me" spot re-triggered a full
// ~35s Overpass refetch because the new bbox's edge was
// -74.03999999999999 against a stored -74.04 (or vice versa - two
// floating-point computations that are mathematically the same number
// to any human, built different doubles: one path divided a rounded
// integer by 100, the other subtracted 0.1 from that result - IEEE 754
// doesn't guarantee those land on the identical bit pattern). No amount
// of "round more carefully" upstream fully closes this - floats just
// aren't exact, so the containment check itself needs slack, not the
// inputs to it. ~11m of tolerance, negligible next to the ~11km search
// radius this is comparing.
const AREA_MATCH_EPSILON = 0.0001

async function ensureAreaFresh(bbox) {
  const { rows } = await pool.query(
    `SELECT id, last_fetched_at FROM fetched_areas
     WHERE min_lat <= $1::double precision + $5::double precision
       AND max_lat >= $2::double precision - $5::double precision
       AND min_lng <= $3::double precision + $5::double precision
       AND max_lng >= $4::double precision - $5::double precision
     ORDER BY last_fetched_at DESC LIMIT 1`,
    [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, AREA_MATCH_EPSILON]
  )
  const covering = rows[0]
  const isFresh = covering && Date.now() - new Date(covering.last_fetched_at).getTime() < AREA_STALE_MS
  if (isFresh) return { refreshed: false }

  // Overpass is a shared public server - a 502/timeout on a large or busy
  // area is a real, expected failure mode, not exceptional. Falling
  // through to serve whatever's already in Postgres (possibly stale,
  // possibly empty) beats failing the whole request outright - and
  // fetched_areas is deliberately left unwritten so the next lookup tries
  // the refresh again instead of treating a failed attempt as done.
  try {
    const gyms = await fetchOverpassGyms(bbox)
    await mergeGymsIntoDb(gyms)
    await pool.query(
      `INSERT INTO fetched_areas (min_lat, min_lng, max_lat, max_lng) VALUES ($1, $2, $3, $4)`,
      [bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng]
    )
    return { refreshed: true, count: gyms.length }
  } catch (e) {
    console.error("Overpass refresh failed, serving existing data instead:", e.message)
    return { refreshed: false, refreshFailed: true }
  }
}

// Distinct from fetched_areas above: that one tracks the passive OSM
// auto-fetch-on-pan, this tracks the deliberate "Find more gyms" click
// (Google Maps scrape + per-gym research). Never goes stale/re-expires -
// unlike Overpass data, "has a human ever asked us to scan here" doesn't
// get less true over time, so there's no staleness window to check.
async function isAreaScanned(bbox) {
  const { rows } = await pool.query(
    `SELECT 1 FROM scanned_areas
     WHERE min_lat <= $1::double precision + $5::double precision
       AND max_lat >= $2::double precision - $5::double precision
       AND min_lng <= $3::double precision + $5::double precision
       AND max_lng >= $4::double precision - $5::double precision
     LIMIT 1`,
    [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, AREA_MATCH_EPSILON]
  )
  return rows.length > 0
}

// Used by the frontend on first arrival at a location (via search or
// "near me" - never on a plain pan, which never touches these params) to
// decide whether to show the "no one has scanned this area yet" nudge.
app.get("/api/gyms/area-scanned", async (req, res) => {
  const { minLat, minLng, maxLat, maxLng } = req.query
  if ([minLat, minLng, maxLat, maxLng].some((v) => v === undefined)) {
    return res.status(400).json({ error: "minLat, minLng, maxLat, maxLng are all required" })
  }
  const bbox = { minLat: Number(minLat), minLng: Number(minLng), maxLat: Number(maxLat), maxLng: Number(maxLng) }
  res.json({ scanned: await isAreaScanned(bbox) })
})

app.get("/api/gyms/by-area", async (req, res) => {
  const { minLat, minLng, maxLat, maxLng } = req.query
  if ([minLat, minLng, maxLat, maxLng].some((v) => v === undefined)) {
    return res.status(400).json({ error: "minLat, minLng, maxLat, maxLng are all required" })
  }
  const bbox = { minLat: Number(minLat), minLng: Number(minLng), maxLat: Number(maxLat), maxLng: Number(maxLng) }
  const sweepResult = await ensureAreaFresh(bbox)
  const { rows } = await pool.query(
    `SELECT g.id, g.osm_id, g.name, g.lat, g.lng, g.rating, g.description, g.address, g.accepts_drop_in,
            g.day_pass_price_cents, g.week_pass_price_cents, g.month_pass_price_cents,
            g.trial_days, g.trial_details,
            u.day_pass_price_cents AS suggested_day_pass_price_cents,
            ${GYM_CATEGORIES_SELECT}
     FROM gyms g
     LEFT JOIN unverified_gym_data u ON u.gym_id = g.id
     WHERE g.lat BETWEEN $1 AND $2 AND g.lng BETWEEN $3 AND $4`,
    [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng]
  )
  res.json({ gyms: rows, areaRefreshed: sweepResult.refreshed, refreshFailed: !!sweepResult.refreshFailed })
})

// Backs the live "N gyms tracked" stat on the homepage - a real count,
// not a hardcoded marketing number, so it grows as submissions/merges add
// rows. Plain COUNT(*) rather than anything reltuples/index-based: Postgres
// can't satisfy COUNT(*) from a btree index alone (MVCC visibility means
// every candidate row still needs a heap check), but that distinction only
// matters at multi-million-row scale - at the low hundreds of thousands
// this tops out at, a sequential count is a few milliseconds either way.
app.get("/api/gyms/count", async (req, res) => {
  const { rows } = await pool.query("SELECT count(*) FROM gyms")
  res.json({ count: Number(rows[0].count) })
})

// Every gym worldwide, unfiltered by viewport - fetched once by the
// frontend instead of re-querying per pan/zoom. At the ~500-row demo scale
// this is trivially cheap; at the full ~109k-gym global scale worked out
// earlier (docs/gym-data-design.md), it's still a few MB fetched once, not
// per-pan, which is what actually keeps this cheap - supercluster indexes
// the whole set client-side and only recomputes per viewport locally.
// Doesn't call ensureAreaFresh - that stays tied to by-area, triggered by
// an actual search, not by this bulk read.
app.get("/api/gyms/all", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT g.id, g.osm_id, g.name, g.lat, g.lng, g.rating, g.description, g.address, g.accepts_drop_in,
            g.day_pass_price_cents, g.week_pass_price_cents, g.month_pass_price_cents,
            g.trial_days, g.trial_details,
            u.day_pass_price_cents AS suggested_day_pass_price_cents,
            ${GYM_CATEGORIES_SELECT}
     FROM gyms g
     LEFT JOIN unverified_gym_data u ON u.gym_id = g.id`
  )
  res.json({ gyms: rows })
})

// Live Google Maps reviews turned out to be a dead end two different ways:
// scraping the UI hit a hard wall (Google explicitly requires sign-in to
// see reviews - not a selector problem, confirmed by Google's own "Sign
// in to read reviews" prompt), and the Places API alternative was
// explicitly declined. The chat stays grounded in on-file reviews only;
// no live review lookup at all anymore.

// Pricing is different - "search the internet for the current price" is a
// real web search, not something blocked behind a login wall the way
// reviews are. Uses Anthropic's hosted web search tool (executed on
// Anthropic's side, not scraped by us) plus one custom tool that lets
// Claude record what it finds. That write goes to unverified_gym_data,
// never the canonical day/week/month_pass_price_cents columns - same
// provenance split this app already uses everywhere else for
// review-mined pricing (see the "Unverified - based on reviews" section
// of the price list). A web search result isn't admin-verified just
// because an AI found it; wrong pricing in a travel app is worse than no
// answer, same reasoning the system prompt below already leans on.
//
// Whether to offer these tools at all is gated purely on what's still
// missing for this gym (see usePriceTools/useInfoTools below), not on
// keywords in the current message - a prior version only searched when
// the question happened to mention price/address/etc. by name, which
// meant it never helped unless you asked the right way.
const CHAT_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  FETCH_URL_TOOL,
  GOOGLE_MAPS_WEBSITE_TOOL,
  {
    name: "record_price_finding",
    description:
      "Record a day/week/month pass price you found via web search, so it can be reviewed before it's shown as confirmed. Only call this for a specific price from a credible source (the gym's own site, a listing site) - not a guess. Report the price in its ORIGINAL currency - do not convert it to USD yourself. A prior version of this tool asked the model to convert currencies by hand and it got a real price wrong by about 20% doing that mental math; this app now does the conversion itself with a live exchange rate, so your job is just to report the number and currency exactly as the source stated them.",
    input_schema: {
      type: "object",
      properties: {
        price_type: { type: "string", enum: ["day", "week", "month"] },
        original_amount: {
          type: "number",
          description: "The numeric price exactly as the source stated it, in its OWN currency - e.g. 200 for '200 THB' or '฿200'. Do not convert this.",
        },
        original_currency: {
          type: "string",
          description: "The 3-letter ISO 4217 code for whatever currency the source used, e.g. 'THB', 'IDR', 'USD'.",
        },
        source_url: { type: "string" },
        recent_source: {
          type: "boolean",
          description:
            "True only if you can confirm the source is less than 1 year old - an explicit 'last updated'/posted date on the page, or a clear freshness signal from the search result itself. False if the source has no date, an old date, or you're just not sure. A recent source is treated as a CONFIRMED price shown to travelers as fact; anything else stays unverified pending human review - so default to false rather than guessing true.",
        },
      },
      required: ["price_type", "original_amount", "original_currency", "source_url", "recent_source"],
    },
  },
  {
    name: "record_gym_info",
    description:
      "Record a gym's description or address. Unlike pricing, this doesn't need a recency check - a gym's street address doesn't go stale the way a day-pass fee does, so this writes straight through as the gym's confirmed info.\n\nAddress is a FACT - only record it if you actually found it (web search, or already given in the facts below), never invent one.\n\nDescription is different - it doesn't need a citation. Write a short, honest, appealing one- or two-sentence blurb using whatever you actually know about this gym (its category, rating, on-file reviews, anything found via search) - composing a nice description from real facts is fine and encouraged, just don't invent specific claims you have no basis for (don't claim amenities, certifications, or opening dates you don't actually know about).",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["description", "address"] },
        value: { type: "string" },
        source_url: { type: "string", description: "Where this came from, if there was a specific source. Omit for a composed description with no single source." },
      },
      required: ["field", "value"],
    },
  },
  {
    name: "record_gym_categories",
    description: `Record which of this app's fixed categories a gym falls under - a gym can have more than one. Only include a tag you're actually confident applies (from the gym's own description/site, reviews, or Google's own category for it) - never guess just to fill one in. Valid tags: ${GYM_CATEGORIES.join(", ")}.`,
    input_schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string", enum: GYM_CATEGORIES } },
      },
      required: ["categories"],
    },
  },
  {
    name: "record_drop_in_status",
    description:
      "Override whether this gym accepts drop-ins/walk-ins. By default, having any day/week/month pass price on file is assumed to mean drop-ins are accepted - most gyms with a day rate let you just show up and pay it. Only call this when you found something that actually CONTRADICTS or explicitly CONFIRMS that default - e.g. a source saying you need to buy a membership or pay a one-time signup fee before the day rate even applies (that means drop-ins are NOT simply accepted, despite a price existing), or a source explicitly confirming casual walk-ins are welcome with no catch. Don't call this just to restate the default assumption - only when you have a real reason to confirm or override it.",
    input_schema: {
      type: "object",
      properties: {
        accepts_drop_in: { type: "boolean" },
        reason: { type: "string", description: "Why - e.g. 'requires a one-time signup fee before the day rate applies', or 'site explicitly says walk-ins welcome'" },
      },
      required: ["accepts_drop_in", "reason"],
    },
  },
  {
    name: "record_trial_status",
    description:
      "Record whether this gym offers a trial period, based on a specific, credible answer you found via web search - not a guess. trial_days: 0 means you confirmed there is NO trial; a positive number is the length of a confirmed trial.",
    input_schema: {
      type: "object",
      properties: {
        trial_days: { type: "integer", description: "0 for a confirmed no-trial, otherwise the trial length in days." },
        trial_details: { type: "string", description: "Any relevant detail (e.g. 'first class free', 'new members only'). Omit if there's nothing more to add." },
        source_url: { type: "string" },
      },
      required: ["trial_days"],
    },
  },
]

const PRICE_COLUMNS = { day: "day_pass_price_cents", week: "week_pass_price_cents", month: "month_pass_price_cents" }
const GYM_INFO_COLUMNS = { description: "description", address: "address" }

// The one shared place that writes a bot/AI-sourced description,
// address, or gym-type finding back to an EXISTING gym - this is the
// "internal API the bot calls" in the sense that matters: not a new HTTP
// endpoint (nothing outside this process ever calls it - Claude only
// ever returns a tool-call *intent*, which this same server process
// decides whether to execute), but one real shared function instead of
// ad-hoc SQL scattered across call sites.
async function recordGymInfo(gymId, { field, value, source_url }) {
  const column = GYM_INFO_COLUMNS[field]
  if (!column) return "Unrecognized field - not recorded."
  await pool.query(
    `UPDATE gyms SET ${column} = $1,
       data_source = CASE WHEN data_source = 'admin_verified' THEN data_source ELSE 'bot_verified' END
     WHERE id = $2`,
    [value, gymId]
  )
  return `Recorded ${field}.`
}

// accepts_drop_in stays NULL by default - the frontend derives "accepts
// drop-ins" from day/week/month pricing existing at all (see
// acceptsDropIn in the map screen), and only reads this column when it's
// explicitly set, overriding that default in either direction. This is
// the one place that sets it away from NULL.
async function recordDropInStatus(gymId, { accepts_drop_in, reason }) {
  await pool.query(
    `UPDATE gyms SET accepts_drop_in = $1,
       data_source = CASE WHEN data_source = 'admin_verified' THEN data_source ELSE 'bot_verified' END
     WHERE id = $2`,
    [accepts_drop_in, gymId]
  )
  return `Recorded accepts_drop_in = ${accepts_drop_in} (${reason}).`
}

// Caught live: asked the chat "does PureGym Clinton Hill have a trial?",
// it correctly answered "no trial" in its reply, but there was no tool
// for it to call to persist that - trial_days stayed NULL forever, so
// the same question would need researching again next time. Mirrors
// recordDropInStatus's shape exactly.
async function recordTrialStatus(gymId, { trial_days, trial_details, source_url }) {
  await pool.query(
    `UPDATE gyms SET trial_days = $1, trial_details = $2,
       data_source = CASE WHEN data_source = 'admin_verified' THEN data_source ELSE 'bot_verified' END
     WHERE id = $3`,
    [trial_days, trial_details ?? null, gymId]
  )
  return `Recorded trial_days = ${trial_days}.`
}

// Bug caught live: asked the chatbot to look up "Power Gym"'s pricing and
// it searched the web for just the name, with no city/country - there
// are several real gyms called "Power Gym" worldwide, so it had nothing
// to disambiguate with. The gym's lat/lng were already in hand but never
// made it into the facts the model sees. Reusing Photon (already a
// dependency for location search) to turn coordinates into a real
// city/country string the model can fold into its search query, rather
// than hoping it free-associates raw numbers to the right place.
// Photon-first, Nominatim fallback - same pattern already proven for the
// homepage's forward search (location-search.tsx). Caught live: this
// Photon outage has been going on long enough that it was now breaking a
// THIRD thing downstream of reverseGeocode (edit-request verification,
// after price-finding research and the chat endpoint) - without a
// location, the model correctly refuses to search blind for a gym name
// that isn't unique worldwide, so the whole verification just stalls.
// Fixing it once here instead of patching each caller's symptom.
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&lang=en`)
    if (!res.ok) throw new Error(`Photon reverse failed: ${res.status}`)
    const data = await res.json()
    const p = data.features?.[0]?.properties
    if (p) return [p.city || p.district, p.state, p.country].filter(Boolean).join(", ")
  } catch (e) {
    console.error("Photon reverse-geocode failed, falling back to Nominatim:", e.message)
  }

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&accept-language=en`, {
      headers: { "User-Agent": "TravelApp-GymFinder-Demo/1.0 (hackathon demo)" },
    })
    if (!res.ok) throw new Error(`Nominatim reverse failed: ${res.status}`)
    const data = await res.json()
    const a = data.address
    if (!a) return null
    return [a.city || a.town || a.village, a.state, a.country].filter(Boolean).join(", ")
  } catch (e) {
    console.error("Nominatim reverse-geocode fallback also failed:", e.message)
    return null
  }
}

// Not exhaustive - covers the regions this app's traffic actually
// concentrates in (SE Asia especially, plus the rest of the common
// backpacker/travel map). Anything missing falls back to USD rather than
// failing the request.
const COUNTRY_TO_CURRENCY = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN",
  CR: "CRC", PA: "PAB", GT: "GTQ", DO: "DOP", JM: "JMD",
  GB: "GBP", IE: "EUR", FR: "EUR", DE: "EUR", ES: "EUR", PT: "EUR", IT: "EUR", NL: "EUR",
  BE: "EUR", AT: "EUR", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", FI: "EUR", PL: "PLN",
  CZ: "CZK", HU: "HUF", GR: "EUR", TR: "TRY", RU: "RUB", UA: "UAH",
  TH: "THB", ID: "IDR", VN: "VND", PH: "PHP", MY: "MYR", SG: "SGD", KH: "KHR", LA: "LAK",
  MM: "MMK", JP: "JPY", KR: "KRW", CN: "CNY", HK: "HKD", TW: "TWD", IN: "INR", PK: "PKR",
  BD: "BDT", LK: "LKR", NP: "NPR",
  AU: "AUD", NZ: "NZD", FJ: "FJD",
  AE: "AED", SA: "SAR", QA: "QAR", IL: "ILS", EG: "EGP", JO: "JOD", LB: "LBP",
  ZA: "ZAR", KE: "KES", NG: "NGN", MA: "MAD", TZ: "TZS", GH: "GHS", ET: "ETB",
}

// All 166 currencies come back in one response from this free, no-key API
// - cached in memory rather than refetched per request, since the rates
// only actually update about once a day anyway.
let fxCache = { rates: null, fetchedAt: 0 }
const FX_CACHE_MS = 6 * 60 * 60 * 1000

async function getFxRates() {
  if (fxCache.rates && Date.now() - fxCache.fetchedAt < FX_CACHE_MS) return fxCache.rates
  const res = await fetch("https://open.er-api.com/v6/latest/USD")
  const data = await res.json()
  if (data.result !== "success") throw new Error("FX rate fetch failed")
  fxCache = { rates: data.rates, fetchedAt: Date.now() }
  return fxCache.rates
}

// Local-currency DISPLAY only - gyms.*_price_cents stays USD cents in
// storage no matter where the gym is; this just tells the frontend what
// to multiply by for showing it to a human. Same reasoning as storing
// money as integer cents in the first place: keep one canonical
// representation, convert only at the point of display, never store a
// converted/rounded value as if it were the source of truth.
// Shared by the /api/fx endpoint below AND the chat endpoint's price
// formatting further down - those used to be two separate code paths,
// and only the map UI's one got fixed to show local currency. The chat
// endpoint had its own hardcoded "$" formatter that nothing here touched,
// so asking the bot about a gym's price kept showing dollars even after
// the map display was already correct. One function now, used both
// places, so there's no second copy to fall out of sync again.
async function getLocalCurrency(lat, lng) {
  const geoRes = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&lang=en`)
  const geoData = await geoRes.json()
  const countryCode = geoData.features?.[0]?.properties?.countrycode
  const currency = getCountryCurrency(countryCode, COUNTRY_TO_CURRENCY)
  if (currency === "USD") return { currency: "USD", rate: 1 }
  const rates = await getFxRates()
  return { currency, rate: rates[currency] || 1 }
}

app.get("/api/fx", async (req, res) => {
  const { lat, lng } = req.query
  try {
    res.json(await getLocalCurrency(Number(lat), Number(lng)))
  } catch (e) {
    console.error("FX lookup failed, defaulting to USD:", e.message)
    res.json({ currency: "USD", rate: 1 })
  }
})

// convertToUsdCents imported from ./lib.js (pure - takes rates as a
// param). Does the USD conversion itself with a live rate, rather than
// trusting the model's own arithmetic - caught it recording ฿200 as
// $7.63 when the live rate says that's actually $5.93, a ~20% error from
// the model doing currency math by hand.

async function recordPriceFinding(gymId, { price_type, original_amount, original_currency, source_url, recent_source }) {
  const column = PRICE_COLUMNS[price_type]
  if (!column) return "Unrecognized price_type - not recorded."

  let price_cents
  try {
    const rates = original_currency === "USD" ? {} : await getFxRates()
    price_cents = convertToUsdCents(original_amount, original_currency, rates)
  } catch (e) {
    console.error("Price finding currency conversion failed:", e.message)
    return `Couldn't convert "${original_currency}" to USD - not recorded. Mention the price in its original currency to the traveler instead of treating it as confirmed.`
  }
  const originalText = `${original_amount} ${original_currency}`

  // Plan.md's rule, extended from price-menu photos to web sources: a
  // source confirmed less than a year old counts as verified, same tier
  // as a human-approved submission - goes straight into the canonical
  // column travelers see as fact. Anything else (no date, old, unsure)
  // stays unverified pending admin review, same as before. Never
  // downgrades an existing admin_verified gym back to bot_verified - a
  // bot finding one field shouldn't erase a human's earlier review of
  // this gym.
  if (recent_source) {
    await pool.query(
      `UPDATE gyms SET ${column} = $1,
         data_source = CASE WHEN data_source = 'admin_verified' THEN data_source ELSE 'bot_verified' END
       WHERE id = $2`,
      [price_cents, gymId]
    )
    return `Recorded as a confirmed price - source was recent (converted from ${originalText}).`
  }

  // originalText kept in the note alongside the converted figure, so a
  // human reviewer can double check this app's own conversion against the
  // source's original number, not just trust the already-converted one.
  await pool.query(
    `INSERT INTO unverified_gym_data (gym_id, ${column}, pricing_note, source, scraped_at)
     VALUES ($1, $2, $3, 'chatbot_web_search', now())
     ON CONFLICT (gym_id) DO UPDATE SET ${column} = EXCLUDED.${column}, pricing_note = EXCLUDED.pricing_note,
       source = EXCLUDED.source, scraped_at = now()`,
    [gymId, price_cents, `Found via web search: "${originalText}" (converted) - ${source_url}`]
  )
  return "Recorded as unverified pricing, pending admin review."
}

// "Ask me questions about this gym" - answers are grounded in whatever we
// actually have on file for this gym by default. The instruction to say
// "don't know" rather than guess matters a lot here: wrong pricing/trial
// info in a travel app is a worse failure than no answer at all. Pricing
// questions are the one exception that gets real tools (web search +
// recording what it finds) - everything else stays facts-only.
app.post("/api/gyms/:id/chat", async (req, res) => {
  const { message, history } = req.body
  if (!message?.trim()) return res.status(400).json({ error: "message is required" })

  const { rows } = await pool.query(
    `SELECT name, lat, lng, description, address, day_pass_price_cents, week_pass_price_cents,
            month_pass_price_cents, trial_days, trial_details, rating, ${GYM_CATEGORIES_SELECT}
     FROM gyms g WHERE g.id = $1`,
    [req.params.id]
  )
  let gym = rows[0]
  if (!gym) return res.status(404).json({ error: "Gym not found" })

  // Not gated on keywords matching the current message anymore - gated
  // purely on "is this still missing," so research happens on whatever
  // question comes in, not just ones that happen to mention price or
  // address by name. This is deliberately proactive rather than
  // reactive: every message is a chance to fill in a gap, not just the
  // ones that ask about it directly. It's naturally self-limiting too -
  // once a gym's price/description/category are all on file, none of
  // these flags trip anymore and tool cost/latency drops back to zero.
  const hasConfirmedPricing = [gym.day_pass_price_cents, gym.week_pass_price_cents, gym.month_pass_price_cents].some(
    (c) => c != null
  )
  const usePriceTools = !hasConfirmedPricing
  const useInfoTools = !gym.description || !gym.address
  const useCategoryTools = gym.categories.length === 0
  const useTrialTools = gym.trial_days == null
  const useTools = usePriceTools || useInfoTools || useCategoryTools || useTrialTools

  // Phase 1: research & record, as its own single-purpose turn - the
  // same shape as researchNewGym/verifyEditRequest elsewhere in this
  // file. Deliberately SEPARATE from phase 2 (actually answering the
  // traveler) rather than one combined turn that both searches/records
  // AND writes a reply: caught live, a combined turn let the model state
  // a specific price it had just found in the gym's own official site
  // text WITHOUT ever calling record_price_finding for it - a real,
  // repeatable miss (confirmed twice), not a one-off worth just
  // rewording the prompt over. Splitting "find and record" into a turn
  // with nothing else to do removes the competing pull that was causing
  // it to skip the tool call, the same way researchNewGym and
  // verifyEditRequest already work reliably.
  let anyToolCalled = false
  let location = null
  if (useTools) {
    try {
      location = await reverseGeocode(gym.lat, gym.lng)
    } catch (e) {
      console.error("Reverse geocode failed:", e.message)
    }

    const researchPrompt = `A traveler is asking questions about the gym "${gym.name}"${
      location ? ` in ${location}` : ""
    }. It's still missing:${usePriceTools ? " its day/week/month pass pricing," : ""}${
      useInfoTools ? " its description and/or address," : ""
    }${
      useCategoryTools ? ` which of these categories it falls under (${GYM_CATEGORIES.join(", ")}) - it can be more than one,` : ""
    }${
      useTrialTools ? " whether it offers a trial," : ""
    } try to find whichever of those you can, and call the matching record_* tool for ANYTHING you find - record_price_finding for a specific price (set recent_source based on whether you can confirm the source is under a year old, don't default to true just because you found a number), record_gym_info for description/address, record_gym_categories for any of the fixed categories that genuinely apply, record_trial_status for a specific, credible trial answer. Always include the gym's location in your search query, not just its name - gym names like this are rarely unique worldwide. Start with web_search; if a result's own snippet doesn't actually show the number/fact you need (snippets are short marketing excerpts, often missing exactly the detail that matters), use fetch_url on that result's real URL to read the actual page - a gym's own pricing page is the best source and snippets routinely don't quote it. If you don't already have a URL for the gym's own site, find_website_on_google_maps looks one up by name/location and reads it in one step. This turn has nothing else to do - there's no reply to write, so if you find something worth stating as fact, calling the tool for it IS the task, not a side step before the real one. Don't force it if nothing comes up quickly; a couple of searches and moving on is fine.`

    // Only offer the record_* tools this gym actually needs - caught
    // live: with the full set always available, the model (searching for
    // trial info on a gym whose pricing was already fully confirmed)
    // stumbled on an unrelated price mention and called
    // record_price_finding with it anyway, with a malformed currency
    // that failed to convert. Harmless here (the bad write was rejected),
    // but needless - there was nothing left to confirm about pricing for
    // this gym, so that tool shouldn't have been on the table at all.
    const neededToolNames = new Set([
      "web_search",
      "fetch_url",
      "find_website_on_google_maps",
      ...(usePriceTools ? ["record_price_finding", "record_drop_in_status"] : []),
      ...(useInfoTools ? ["record_gym_info"] : []),
      ...(useCategoryTools ? ["record_gym_categories"] : []),
      ...(useTrialTools ? ["record_trial_status"] : []),
    ])
    const researchTools = CHAT_TOOLS.filter((t) => neededToolNames.has(t.name))

    try {
      const research = await runAgentTurn({
        system: researchPrompt,
        tools: researchTools,
        messages: [{ role: "user", content: "Research and record whatever you can find for this gym." }],
      })
      for (const toolUse of research.toolUses) {
        // Caught live: Haiku called record_gym_info with a totally
        // different (invalid) input shape in a turn where record_gym_info
        // wasn't even in `researchTools` above - a hallucinated call for a
        // tool name it's seen often in this app's other prompts, not one
        // actually offered this turn. Dispatching by name match alone
        // would still run the real handler on whatever garbage input came
        // with it; checking against what was actually offered rejects it
        // outright instead of relying on each handler's own field
        // validation to happen to catch the mismatch.
        if (!neededToolNames.has(toolUse.name)) {
          console.error(`Chat research pass: ignoring hallucinated tool call "${toolUse.name}" - not offered this turn.`)
          continue
        }
        anyToolCalled = true
        if (toolUse.name === "record_price_finding") await recordPriceFinding(req.params.id, toolUse.input)
        else if (toolUse.name === "record_gym_info") await recordGymInfo(req.params.id, toolUse.input)
        else if (toolUse.name === "record_drop_in_status") await recordDropInStatus(req.params.id, toolUse.input)
        else if (toolUse.name === "record_trial_status") await recordTrialStatus(req.params.id, toolUse.input)
        else if (toolUse.name === "record_gym_categories") await addGymCategories(req.params.id, toolUse.input.categories)
      }
    } catch (e) {
      console.error("Chat research pass failed:", e.message)
    }

    // Re-read before building the facts phase 2 answers from - a tool
    // call just above is a real write already committed to Postgres, and
    // the reply should reflect it immediately, not the pre-research
    // snapshot this request started with.
    if (anyToolCalled) {
      const { rows: freshRows } = await pool.query(
        `SELECT name, lat, lng, description, address, day_pass_price_cents, week_pass_price_cents,
                month_pass_price_cents, trial_days, trial_details, rating, ${GYM_CATEGORIES_SELECT}
         FROM gyms g WHERE g.id = $1`,
        [req.params.id]
      )
      gym = freshRows[0]
    }
  }

  const { rows: reviews } = await pool.query(
    "SELECT author, rating, body FROM reviews WHERE gym_id = $1 ORDER BY created_at DESC LIMIT 5",
    [req.params.id]
  )

  let chatFx = { currency: "USD", rate: 1 }
  try {
    chatFx = await getLocalCurrency(gym.lat, gym.lng)
  } catch (e) {
    console.error("FX lookup for chat failed, defaulting to USD:", e.message)
  }
  const formatPrice = (cents) => {
    if (cents == null) return "not known"
    const local = (cents / 100) * chatFx.rate
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: chatFx.currency }).format(local)
    } catch {
      return `$${(cents / 100).toFixed(2)}`
    }
  }

  const facts = `Gym name: ${gym.name}
Location: ${location || `coordinates ${gym.lat}, ${gym.lng}`}
Description: ${gym.description || "not known"}
Address: ${gym.address || "not known"}
Categories: ${gym.categories.length > 0 ? gym.categories.join(", ") : "not known"}
Day-pass price: ${formatPrice(gym.day_pass_price_cents)}
Week-pass price: ${formatPrice(gym.week_pass_price_cents)}
Month-pass price: ${formatPrice(gym.month_pass_price_cents)}
Trial: ${gym.trial_days == null ? "not known" : gym.trial_days === 0 ? "no trial offered" : `${gym.trial_days}-day trial`}${gym.trial_details ? ` (${gym.trial_details})` : ""}
Rating: ${gym.rating ?? "no rating yet"}
Reviews on file in our database:
${reviews.map((r) => `- ${r.author} (${r.rating}★): ${r.body}`).join("\n") || "none yet"}`

  // Phase 2: answer the traveler's actual question, strictly from
  // whatever's on file now (including anything phase 1 just recorded) -
  // no tools here, so there's nothing left for this turn to find and
  // then forget to record; it can only state what's already a fact in
  // Postgres, or say it doesn't know.
  const systemPrompt = `You are a helpful assistant answering a traveler's questions about one specific gym, "${gym.name}". Only use the facts below for your actual reply - if something isn't covered by them, say you don't know rather than guessing. Keep answers short and conversational.\n\n${facts}`

  try {
    const response = await runAgentTurn({
      system: systemPrompt,
      messages: [...(history || []), { role: "user", content: message }],
    })
    const reply = response.text

    let updatedGym = null
    if (anyToolCalled) {
      const { rows: freshRows } = await pool.query(
        `SELECT g.id, g.osm_id, g.name, g.lat, g.lng, g.rating, g.description, g.address, g.accepts_drop_in,
                g.day_pass_price_cents, g.week_pass_price_cents, g.month_pass_price_cents,
                g.trial_days, g.trial_details, u.day_pass_price_cents AS suggested_day_pass_price_cents,
                ${GYM_CATEGORIES_SELECT}
         FROM gyms g
         LEFT JOIN unverified_gym_data u ON u.gym_id = g.id
         WHERE g.id = $1`,
        [req.params.id]
      )
      updatedGym = freshRows[0] ?? null
    }

    res.json({ reply, gym: updatedGym })
  } catch (e) {
    console.error("Chat request failed:", e.message)
    res.status(500).json({ error: "Chat request failed - is ANTHROPIC_API_KEY set in .env?" })
  }
})

// "Find more gyms" - scrapes Google Maps for the generic "gym" category
// across the current viewport, rather than verifying one specific
// submitted name/location like findGoogleMapsMatch above. Each result
// link embeds exact coordinates directly in its href (extractLatLngFromMapsHref,
// confirmed live), so this reads the whole list from one page load - no
// need to click into every result just to find out where it is.
// Google only returns an initial page of results (no scrolling here), so
// this is bounded to whatever's visible on first load, same as a human
// glancing at the map would see.
const FIND_MORE_RESULT_LIMIT = 20

async function findGoogleMapsGymsInArea(bbox) {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2
  const centerLng = (bbox.minLng + bbox.maxLng) / 2
  const zoom = bboxToGoogleMapsZoom(bbox)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`https://www.google.com/maps/search/gym/@${centerLat},${centerLng},${zoom}z?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    })
    await page.waitForTimeout(2000) // result list renders async
    const links = await page.locator('a[href*="/maps/place/"]').all()
    const results = []
    for (const link of links.slice(0, FIND_MORE_RESULT_LIMIT)) {
      const href = await link.getAttribute("href")
      const name = (await link.innerText().catch(() => "")).trim()
      const coords = href ? extractLatLngFromMapsHref(href) : null
      if (name && coords) results.push({ name, lat: coords.lat, lng: coords.lng })
    }
    return results
  } finally {
    await browser.close()
  }
}

// Reuses the chat's own web-search tool rather than scraping Google Maps
// again - Google Maps genuinely doesn't carry pricing data for gyms
// (confirmed earlier: a resolved gym's own page has category/address/
// phone/rating, never a price, unlike restaurants' $ indicators), so a
// second Google Maps scrape would have nothing to find. This is a single
// one-shot call, not the chat's multi-turn loop - there's no reply to
// send back to a user, just a possible tool call as a side effect, and
// the hosted web_search tool can already search multiple times within
// one response on its own.
// Renamed from searchWebForGymPrice - now researches whatever's actually
// missing for a newly-found gym (pricing, description, address,
// category), not just price. A newly-scraped-from-Google-Maps-list gym
// only has name/lat/lng (findGoogleMapsGymsInArea doesn't visit each
// result's own page - see its own comment), so there's usually more than
// just pricing to look for.
// Pulled out of researchNewGym so "find more gyms" can also use it to
// decide which EXISTING gyms in the scanned area are worth researching,
// not just the brand-new ones the Google Maps scrape just turned up.
function whatsMissing(gym) {
  const missing = []
  if (!gym.day_pass_price_cents && !gym.week_pass_price_cents && !gym.month_pass_price_cents) missing.push("pricing")
  if (!gym.description) missing.push("description")
  if (!gym.address) missing.push("address")
  if (gym.categories.length === 0) missing.push("which fixed categories it falls under")
  return missing
}

async function researchNewGym(gym) {
  let location = null
  try {
    location = await reverseGeocode(gym.lat, gym.lng)
  } catch (e) {
    console.error("Reverse geocode for gym research failed:", e.message)
  }

  const missing = whatsMissing(gym)
  if (missing.length === 0) return

  const systemPrompt = `Try to find this gym's ${missing.join(", ")} - "${gym.name}"${
    location ? ` in ${location}` : ""
  }. Include the location in your search query, not just the name - gym names like this are rarely unique worldwide. Start with web_search; a result's own snippet is a short marketing excerpt and often won't actually show the number you need, so use fetch_url on the real URL to read the page itself once you find a promising one. find_website_on_google_maps looks up the gym's own site by name/location and reads it in one step if you don't already have a URL. If you find a specific price from a credible source, call record_price_finding with it. Address is a fact - only call record_gym_info with it if you actually found it, never invent one. If one or more of these fixed categories genuinely applies, call record_gym_categories with them (a gym can have several): ${GYM_CATEGORIES.join(", ")}. Description is different - it doesn't need a citation, write a short honest blurb from whatever you actually know (category, rating, on-file reviews, anything found via search) and call record_gym_info with it; composing a nice description from real facts is fine, just don't invent specific claims you have no basis for. Don't force any of this if nothing comes up quickly - a couple of searches and moving on is fine.`

  const response = await runAgentTurn({
    system: systemPrompt,
    tools: CHAT_TOOLS,
    messages: [{ role: "user", content: "Research and record this gym's info if you can." }],
  })

  for (const toolUse of response.toolUses) {
    if (toolUse.name === "record_price_finding") await recordPriceFinding(gym.id, toolUse.input)
    else if (toolUse.name === "record_gym_info") await recordGymInfo(gym.id, toolUse.input)
    else if (toolUse.name === "record_drop_in_status") await recordDropInStatus(gym.id, toolUse.input)
    else if (toolUse.name === "record_trial_status") await recordTrialStatus(gym.id, toolUse.input)
    else if (toolUse.name === "record_gym_categories") await addGymCategories(gym.id, toolUse.input.categories)
  }
}

// Capped separately from FIND_MORE_RESULT_LIMIT - each research pass is a
// real, billed Anthropic call plus web search(es), not a free side effect
// of the Google Maps scrape. Raised from 5 and now shared between
// brand-new finds AND existing-but-incomplete gyms already in the area
// (previously only new finds got researched at all) - per explicit
// request to have "Find more gyms" make a real effort at filling in
// every gym in the area, not just naming ones Overpass/OSM missed.
// New finds are prioritized first (whatsMissing(gym) that just found a
// gym by name/location alone is guaranteed non-empty), existing gyms fill
// whatever cap room is left.
const FIND_MORE_RESEARCH_LIMIT = 10

app.post("/api/gyms/find-more", async (req, res) => {
  const { minLat, minLng, maxLat, maxLng } = req.body
  if ([minLat, minLng, maxLat, maxLng].some((v) => v === undefined)) {
    return res.status(400).json({ error: "minLat, minLng, maxLat, maxLng are all required" })
  }
  const bbox = { minLat: Number(minLat), minLng: Number(minLng), maxLat: Number(maxLat), maxLng: Number(maxLng) }

  let found
  try {
    found = await findGoogleMapsGymsInArea(bbox)
  } catch (e) {
    // "If Google hasn't found the bot yet" - a scrape that fails outright
    // (blocked, timed out) means we don't know anything new, so there's
    // nothing to research either. Fails the whole request gracefully
    // rather than guessing.
    console.error("Find-more-gyms scrape failed:", e.message)
    return res.json({ newGyms: [], totalFound: 0, researchAttempted: 0, scrapeFailed: true })
  }

  const newGyms = []
  for (const g of found) {
    const { rows: nearby } = await pool.query(
      `SELECT name, similarity(name, $3) AS name_similarity,
         (6371 * acos(GREATEST(-1, LEAST(1,
           cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) +
           sin(radians($1)) * sin(radians(lat))
         )))) AS distance_km
       FROM gyms ORDER BY distance_km ASC LIMIT 3`,
      [g.lat, g.lng, g.name]
    )
    const isDuplicate = nearby.some((row) => isDuplicateMatch(row.distance_km, row.name_similarity))
    if (isDuplicate) continue

    const { rows: gymRows } = await pool.query(
      `INSERT INTO gyms (name, lat, lng, data_source) VALUES ($1, $2, $3, 'bot_verified')
       RETURNING id, osm_id, name, lat, lng, rating, description, address, accepts_drop_in,
                 day_pass_price_cents, week_pass_price_cents, month_pass_price_cents, trial_days, trial_details`,
      [g.name, g.lat, g.lng]
    )
    // Freshly inserted - gym_categories has no rows for it yet, no need
    // to query for an aggregate that's trivially empty.
    newGyms.push({ ...gymRows[0], categories: [] })
  }

  // Existing gyms already in this area (from OSM, an earlier scrape, or a
  // human submission) that are still missing something - these compete
  // for the same research budget as brand-new finds, after new finds are
  // covered, since a brand-new find is guaranteed to be missing
  // everything while an existing gym might already be complete.
  const { rows: areaGyms } = await pool.query(
    `SELECT g.id, g.osm_id, g.name, g.lat, g.lng, g.rating, g.description, g.address, g.accepts_drop_in,
            g.day_pass_price_cents, g.week_pass_price_cents, g.month_pass_price_cents,
            g.trial_days, g.trial_details, ${GYM_CATEGORIES_SELECT}
     FROM gyms g
     WHERE g.lat BETWEEN $1 AND $2 AND g.lng BETWEEN $3 AND $4
       AND g.id != ALL($5::int[])`,
    [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, newGyms.map((g) => g.id)]
  )
  const incompleteExistingGyms = areaGyms.filter((g) => whatsMissing(g).length > 0)

  let researchAttempted = 0
  const researchedExistingIds = []
  const remainingBudget = () => FIND_MORE_RESEARCH_LIMIT - researchAttempted
  for (const gym of newGyms) {
    if (remainingBudget() <= 0) break
    try {
      await researchNewGym(gym)
      researchAttempted++
    } catch (e) {
      console.error(`Research failed for gym ${gym.id}:`, e.message)
    }
  }
  for (const gym of incompleteExistingGyms) {
    if (remainingBudget() <= 0) break
    try {
      await researchNewGym(gym)
      researchAttempted++
      researchedExistingIds.push(gym.id)
    } catch (e) {
      console.error(`Research failed for gym ${gym.id}:`, e.message)
    }
  }

  // Re-fetch rather than return the pre-research snapshot - a finding
  // recorded during the loop above (a real UPDATE already committed to
  // Postgres) would otherwise not show up in this response at all, and
  // the frontend merges this response directly into what's rendered.
  // Same "don't ship a stale answer when a page refresh would show the
  // real one" bug already hit twice this session elsewhere - fixing it
  // here too rather than shipping it a third time.
  let freshNewGyms = newGyms
  let updatedGyms = []
  if (researchAttempted > 0) {
    const { rows } = await pool.query(
      `SELECT g.id, g.osm_id, g.name, g.lat, g.lng, g.rating, g.description, g.address, g.accepts_drop_in,
              g.day_pass_price_cents, g.week_pass_price_cents, g.month_pass_price_cents,
              g.trial_days, g.trial_details, u.day_pass_price_cents AS suggested_day_pass_price_cents,
              ${GYM_CATEGORIES_SELECT}
       FROM gyms g
       LEFT JOIN unverified_gym_data u ON u.gym_id = g.id
       WHERE g.id = ANY($1)`,
      [[...newGyms.map((g) => g.id), ...researchedExistingIds]]
    )
    freshNewGyms = rows.filter((g) => newGyms.some((n) => n.id === g.id))
    updatedGyms = rows.filter((g) => researchedExistingIds.includes(g.id))
  }

  // Marks the whole requested viewport scanned, not just the slice that
  // got researched - "Find more gyms" ran its full scrape+research pass
  // over this exact area, which is the thing the arrival nudge is asking
  // about, regardless of how much of the research budget had to skip.
  await pool.query(`INSERT INTO scanned_areas (min_lat, min_lng, max_lat, max_lng) VALUES ($1, $2, $3, $4)`, [
    bbox.minLat,
    bbox.minLng,
    bbox.maxLat,
    bbox.maxLng,
  ])

  res.json({
    newGyms: freshNewGyms,
    updatedGyms,
    totalFound: found.length,
    researchAttempted,
    researchSkipped: Math.max(0, newGyms.length + incompleteExistingGyms.length - FIND_MORE_RESEARCH_LIMIT),
  })
})

// Requesting an edit to an EXISTING gym - the schema already had this
// designed in (gym_submissions.submission_type's check constraint already
// allowed 'edit', gym_id already nullable+FK'd for exactly this), just
// never had the actual verification logic or endpoint built. Same shape
// as new-gym submissions: the bot tries to verify, auto-applies if it
// can, otherwise queues for admin review (status 2) with the proposed
// change sitting in the submission's payload either way.
//
// Verification here checks reviews/the gym's own website via web search -
// NOT the price-menu-photo channel Plan.md also describes. That's a
// genuinely separate feature (photo upload + vision analysis of the
// photo) that isn't built; this covers the other two verification
// channels with infrastructure that already exists.
const EDITABLE_FIELDS = {
  // Labels are what gets shown to the model in the verification prompt -
  // no unit mentioned here, since formatProposedValue already renders
  // the actual value as a real dollar amount. The newValue the API
  // itself expects is still cents (same storage unit as everywhere else
  // in this app) - that's an API-contract detail, not something the
  // verification prompt needs to state.
  day_pass_price_cents: "day pass price",
  week_pass_price_cents: "week pass price",
  month_pass_price_cents: "month pass price",
  description: "description",
  address: "address",
  category: `category (must be one of: ${GYM_CATEGORIES.join(", ")} - adds this tag, doesn't remove any existing ones)`,
  trial_days: "trial days (0 for no trial)",
  trial_details: "trial details",
}

// Price fields get a DIFFERENT tool than text fields - caught live, the
// first version asked the model to do its own "convert to a rough USD
// estimate" currency math when comparing a found price against the
// proposal, and it got the comparison wrong (same unreliable-mental-math
// failure already fixed once for record_price_finding, reintroduced
// here by accident). This version has the model report what it found in
// its ORIGINAL currency, unconverted, and our own code - reusing the
// same convertToUsdCents already proven correct - does the actual
// comparison deterministically.
const EDIT_VERIFICATION_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  FETCH_URL_TOOL,
  GOOGLE_MAPS_WEBSITE_TOOL,
  {
    name: "confirm_price_finding",
    description: "Report the price you found for comparison against the proposed value - in its ORIGINAL currency, unconverted. Call this once after searching, whether or not you found anything (price_amount null if you found nothing).",
    input_schema: {
      type: "object",
      properties: {
        price_amount: { type: "number", description: "The numeric price you found, in its own currency. Omit/null if you found nothing credible." },
        price_currency: { type: "string", description: "ISO 4217 code for price_amount's currency, e.g. 'IDR', 'USD'. Required if price_amount is given." },
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "confirm_text_edit",
    description: "State your conclusion after searching for evidence (the gym's own website, reviews, listings) about one specific proposed text value. Call this exactly once, after searching - not before.",
    input_schema: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          description: "True ONLY if you found a credible source that actually supports this specific value. False if you found contradicting info, or found nothing either way - don't guess true just because nothing contradicts it.",
        },
        reason: { type: "string" },
      },
      required: ["confirmed", "reason"],
    },
  },
]

const PRICE_FIELDS = new Set(["day_pass_price_cents", "week_pass_price_cents", "month_pass_price_cents"])

function formatProposedValue(field, newValue) {
  return PRICE_FIELDS.has(field) ? `$${(newValue / 100).toFixed(2)} USD` : String(newValue)
}

async function verifyEditRequest(gym, field, newValue) {
  let location = null
  try {
    location = await reverseGeocode(gym.lat, gym.lng)
  } catch (e) {
    console.error("Reverse geocode for edit verification failed:", e.message)
  }

  const isPriceField = PRICE_FIELDS.has(field)
  const systemPrompt = `A traveler has proposed updating the ${EDITABLE_FIELDS[field]} for the gym "${gym.name}"${
    location ? ` in ${location}` : ""
  } to: ${formatProposedValue(field, newValue)}. Try to find credible evidence (the gym's own website, reviews, a listing site) about this - include the location in your search query, not just the name. Start with web_search; its result snippets are short marketing excerpts that often won't show the actual number/fact you need, so use fetch_url on a promising result's real URL to read the page itself, or find_website_on_google_maps if you don't have a URL yet and just know the gym's name/location. Then call ${
    isPriceField ? "confirm_price_finding with whatever price you found, in its original currency - don't convert it yourself" : "confirm_text_edit with your conclusion"
  }.`

  const response = await runAgentTurn({
    system: systemPrompt,
    tools: EDIT_VERIFICATION_TOOLS,
    messages: [{ role: "user", content: "Verify this proposed edit." }],
  })

  const toolName = isPriceField ? "confirm_price_finding" : "confirm_text_edit"
  const toolUse = response.toolUses.find((t) => t.name === toolName)
  if (!toolUse) return { confirmed: false, reason: "Couldn't reach a conclusion." }

  if (!isPriceField) return toolUse.input

  const { price_amount, price_currency, reason } = toolUse.input
  if (price_amount == null || !price_currency) return { confirmed: false, reason: reason || "No price found to compare." }

  let foundCents
  try {
    const rates = price_currency === "USD" ? {} : await getFxRates()
    foundCents = convertToUsdCents(price_amount, price_currency, rates)
  } catch (e) {
    return { confirmed: false, reason: `Found a price (${price_amount} ${price_currency}) but couldn't convert its currency to compare.` }
  }

  // 15% tolerance each way - a price found via search is often slightly
  // stale or rounded, and a small gap shouldn't block an otherwise
  // correct update the way an exact-match requirement would.
  const withinTolerance = Math.abs(foundCents - newValue) <= newValue * 0.15
  const foundUsd = `$${(foundCents / 100).toFixed(2)} USD`
  return {
    confirmed: withinTolerance,
    reason: withinTolerance
      ? `Found ${price_amount} ${price_currency} (${foundUsd}), matches the proposed value.`
      : `Found ${price_amount} ${price_currency} (${foundUsd}), which doesn't match the proposed ${formatProposedValue(field, newValue)}.`,
  }
}

app.post("/api/gyms/:id/edit-request", authenticate, async (req, res) => {
  const { field, newValue, description } = req.body
  if (!EDITABLE_FIELDS[field]) {
    return res.status(400).json({ error: `Unknown field "${field}" - must be one of ${Object.keys(EDITABLE_FIELDS).join(", ")}` })
  }
  if (field === "category" && !GYM_CATEGORIES.includes(newValue)) {
    return res.status(400).json({ error: `"${newValue}" isn't one of the fixed categories - must be one of ${GYM_CATEGORIES.join(", ")}` })
  }
  const descError = requireDescription(description)
  if (descError) return res.status(400).json({ error: descError })

  const { rows: gymRows } = await pool.query("SELECT * FROM gyms WHERE id = $1", [req.params.id])
  const gym = gymRows[0]
  if (!gym) return res.status(404).json({ error: "Gym not found" })

  // category is multi-valued (gym_categories, not a plain column) -
  // there's no single "previous value" the way a price or address has
  // one, so this just proposes ADDING the tag, never a replacement.
  const payload = { field, newValue, previousValue: field === "category" ? null : gym[field] ?? null }
  const { rows: subRows } = await pool.query(
    `INSERT INTO gym_submissions (gym_id, submitted_by_name, submitted_by_user_id, submission_type, description, payload)
     VALUES ($1, $2, $3, 'edit', $4, $5) RETURNING id, created_at`,
    [req.params.id, req.user.name, req.user.id, description.trim(), JSON.stringify(payload)]
  )
  const submissionId = subRows[0].id

  let verification
  try {
    verification = await verifyEditRequest(gym, field, newValue)
  } catch (e) {
    console.error("Edit verification failed:", e.message)
    verification = { confirmed: false, reason: "Verification itself failed - try again later." }
  }

  if (verification.confirmed) {
    if (field === "category") {
      await addGymCategories(req.params.id, [newValue])
      await pool.query(
        `UPDATE gyms SET updated_by_user_id = $1, data_source = CASE WHEN data_source = 'admin_verified' THEN data_source ELSE 'bot_verified' END WHERE id = $2`,
        [req.user.id, req.params.id]
      )
    } else {
      await pool.query(
        `UPDATE gyms SET ${field} = $1, updated_by_user_id = $2,
           data_source = CASE WHEN data_source = 'admin_verified' THEN data_source ELSE 'bot_verified' END
         WHERE id = $3`,
        [newValue, req.user.id, req.params.id]
      )
    }
    await pool.query(
      "UPDATE gym_submissions SET status_id = 3, approved_by = 0, approved_at = now() WHERE id = $1",
      [submissionId]
    )
    const { rows: freshRows } = await pool.query(
      `SELECT g.id, g.osm_id, g.name, g.lat, g.lng, g.rating, g.description, g.address, g.accepts_drop_in,
              g.day_pass_price_cents, g.week_pass_price_cents, g.month_pass_price_cents, g.trial_days, g.trial_details,
              ${GYM_CATEGORIES_SELECT}
       FROM gyms g WHERE g.id = $1`,
      [req.params.id]
    )
    return res.status(201).json({ id: submissionId, statusId: 3, statusLabel: "Approved", gym: freshRows[0], botReason: null })
  }

  await pool.query("UPDATE gym_submissions SET status_id = 2 WHERE id = $1", [submissionId])
  res.status(201).json({ id: submissionId, statusId: 2, statusLabel: "Pending Admin Approval", gym: null, botReason: verification.reason })
})

// Becoming an admin has no automated verification path (there's no web
// search that confirms someone "deserves" admin access) - every
// application goes straight to Pending Admin Approval, on the same
// gym_submissions queue as gym creation/edit requests, so the admin page
// in gym-map-screen.web.tsx can list and filter all three together.
app.post("/api/users/apply-admin", authenticate, async (req, res) => {
  const { description } = req.body
  const descError = requireDescription(description)
  if (descError) return res.status(400).json({ error: descError })
  if (req.user.isAdmin) return res.status(409).json({ error: "You're already an admin." })

  const { rows: pending } = await pool.query(
    "SELECT id FROM gym_submissions WHERE submission_type = 'admin_request' AND submitted_by_user_id = $1 AND status_id = 2",
    [req.user.id]
  )
  if (pending[0]) return res.status(409).json({ error: "You already have a pending admin request." })

  const { rows } = await pool.query(
    `INSERT INTO gym_submissions (submitted_by_name, submitted_by_user_id, submission_type, description, payload, status_id)
     VALUES ($1, $2, 'admin_request', $3, '{}', 2) RETURNING id, created_at`,
    [req.user.name, req.user.id, description.trim()]
  )
  res.status(201).json({ id: rows[0].id, statusId: 2, statusLabel: "Pending Admin Approval" })
})

// Lists all three submission types (new_gym/edit/admin_request) on one
// queue, filterable by either axis - the admin page is one page with
// filters, not three separate pages, per the explicit request.
app.get("/api/admin/submissions", authenticate, requireAdmin, async (req, res) => {
  const { type, status } = req.query
  const conditions = []
  const params = []
  if (type) {
    params.push(type)
    conditions.push(`s.submission_type = $${params.length}`)
  }
  if (status) {
    params.push(Number(status))
    conditions.push(`s.status_id = $${params.length}`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  const { rows } = await pool.query(
    `SELECT s.id, s.gym_id, g.name AS gym_name, s.submitted_by_name, s.submitted_by_user_id,
            s.submission_type, s.description, s.payload, s.status_id, st.label AS status_label, s.created_at
     FROM gym_submissions s
     LEFT JOIN gyms g ON g.id = s.gym_id
     JOIN gym_submission_statuses st ON st.id = s.status_id
     ${where}
     ORDER BY s.created_at DESC`,
    params
  )
  res.json(rows)
})

// field/newValue in an edit submission's payload were already validated
// against the EDITABLE_FIELDS whitelist when the request was created -
// safe to interpolate into the UPDATE below for the same reason the
// bot-confirmed path above already does.
app.post("/api/admin/submissions/:id/approve", authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM gym_submissions WHERE id = $1", [req.params.id])
  const submission = rows[0]
  if (!submission) return res.status(404).json({ error: "Submission not found" })
  if (submission.status_id !== 2) return res.status(409).json({ error: "This submission isn't pending admin approval." })

  if (submission.submission_type === "new_gym") {
    const { name, lat, lng } = submission.payload
    const { rows: gymRows } = await pool.query(
      `INSERT INTO gyms (name, lat, lng, data_source, created_by_user_id) VALUES ($1, $2, $3, 'admin_verified', $4) RETURNING id`,
      [name, lat, lng, submission.submitted_by_user_id]
    )
    await pool.query(
      "UPDATE gym_submissions SET status_id = 3, gym_id = $1, approved_by = $2, approved_at = now() WHERE id = $3",
      [gymRows[0].id, req.user.id, submission.id]
    )
  } else if (submission.submission_type === "edit") {
    const { field, newValue } = submission.payload
    if (field === "category") {
      await addGymCategories(submission.gym_id, [newValue])
      await pool.query(
        "UPDATE gyms SET updated_by_user_id = $1, data_source = 'admin_verified' WHERE id = $2",
        [submission.submitted_by_user_id, submission.gym_id]
      )
    } else {
      await pool.query(
        `UPDATE gyms SET ${field} = $1, updated_by_user_id = $2, data_source = 'admin_verified' WHERE id = $3`,
        [newValue, submission.submitted_by_user_id, submission.gym_id]
      )
    }
    await pool.query(
      "UPDATE gym_submissions SET status_id = 3, approved_by = $1, approved_at = now() WHERE id = $2",
      [req.user.id, submission.id]
    )
  } else if (submission.submission_type === "admin_request") {
    const { rows: userRows } = await pool.query("SELECT id, name FROM users WHERE id = $1", [submission.submitted_by_user_id])
    const applicant = userRows[0]
    if (applicant) {
      await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [applicant.id])
      // admins is still the FK target gym_submissions.approved_by points
      // at (predates this user system) - a newly-approved admin needs a
      // row here too, keyed by their own user id, so they can later
      // appear as the approver of someone else's submission.
      await pool.query("INSERT INTO admins (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [applicant.id, applicant.name])
    }
    await pool.query(
      "UPDATE gym_submissions SET status_id = 3, approved_by = $1, approved_at = now() WHERE id = $2",
      [req.user.id, submission.id]
    )
  }

  if (submission.submitted_by_user_id) {
    const { rows: userRows } = await pool.query("SELECT email, name FROM users WHERE id = $1", [submission.submitted_by_user_id])
    if (userRows[0]) await sendSubmissionDecisionEmail(userRows[0], submission, "approved")
  }
  res.json({ ok: true })
})

app.post("/api/admin/submissions/:id/deny", authenticate, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM gym_submissions WHERE id = $1", [req.params.id])
  const submission = rows[0]
  if (!submission) return res.status(404).json({ error: "Submission not found" })
  if (submission.status_id !== 2) return res.status(409).json({ error: "This submission isn't pending admin approval." })

  await pool.query("UPDATE gym_submissions SET status_id = 4, approved_by = $1, approved_at = now() WHERE id = $2", [req.user.id, submission.id])

  if (submission.submitted_by_user_id) {
    const { rows: userRows } = await pool.query("SELECT email, name FROM users WHERE id = $1", [submission.submitted_by_user_id])
    if (userRows[0]) await sendSubmissionDecisionEmail(userRows[0], submission, "denied")
  }
  res.json({ ok: true })
})

app.listen(3001, () => console.log("Demo API listening on http://localhost:3001"))
