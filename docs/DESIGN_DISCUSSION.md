# Gym Finder: High-Level Design Discussion

Phase 2 of the roadmap, step 1: **high-level architecture only**. Stack details, schema and API come in later docs. Requirement IDs (FR-x, NFR-x) refer to [REQUIREMENTS.md](./REQUIREMENTS.md).

Fixed constraint: one Expo (Expo Router, TypeScript) client for Web, Android and iOS (NFR-3). Everything below is about what sits behind it.

## 1. Are the requirements realistic?

Yes. 10,000 daily users (NFR-1) is a modest load that one small server plus a database can handle, and every functional requirement has been built in some form already in the demo code on this branch. Reviewing them against the design, with Joey's decisions from the PR review:

| Requirement | Verdict | What the design does about it |
|---|---|---|
| FR-11 Google Maps sweeps | **Decided: we scrape Google Maps.** This breaks Google's Terms of Service; Joey has accepted that risk (risk: blocked IPs, account bans, legal letters). | The sweep is still a *pluggable data source*, so the Google Maps scraper sits behind the same interface as Overpass. If it gets blocked or we need to stop, the Places API or another source swaps in without touching the rest of the system. Regional sources (OOS-1) slot in the same way. |
| NFR-2 1,000 bot req/s | **Realistic as an intake rate, using queues.** Bot requests are accepted into a queue at up to 1,000/s and *drained* at a much slower, controlled rate by workers. | Separate queues with different drain rates: "find more gyms" sweeps drain slowly (they hit Google Maps), per-gym requests (chat, bot review) drain faster. Same-area sweep requests are merged so the backlog stays bounded. Workers on each queue **auto-scale and run in parallel**, adding copies as the queue grows. See section 5.3. |
| FR-4 "every gym in the world" | **Realistic as a number that grows with use.** Every search, OSM refresh and bot sweep adds gyms. | Lazy per-tile OSM refresh + daily coverage job + sweeps + user submissions. |
| FR-8/9 AI chatbot | **Realistic.** Demo mode runs Ollama on our own server (no per-call bill); scale mode switches to Claude once there are users and premium accounts (section 6.1). | Behind one LLM interface, so switching is config. In demo mode the limit is our server's compute: a queue caps how many LLM jobs run at once, and answers are saved on the gym record (FR-9) so repeat questions skip the LLM. Kept behind one LLM interface. |

**Bottom line:** on board. The options below all assume these decisions.

## 2. What every option has to handle

Whatever the shape, the system has the same five jobs. The options differ in how these are split into deployable pieces.

```mermaid
flowchart LR
    U([Expo app<br/>Web / Android / iOS])
    U --> R1[Map reads<br/>gyms in view, filters<br/>FR-4,5,10]
    U --> R2[Gym details + AI chat<br/>FR-6,7,8,9]
    U --> R3[Accounts + roles<br/>FR-13,14,15]
    U --> R4[Submissions + approval<br/>FR-16,17,18]
    U --> R5[Area sweeps<br/>FR-11,12]
    R1 --- note1[high volume, cacheable, fast]
    R2 --- note2[slow LLM calls, costly]
    R4 --- note4[low volume, needs audit trail]
    R5 --- note5[slow, rate-limited by external sources]
```

The key insight is that **map reads** are by far the most frequent and are easy to cache, while **chat, sweeps and bot review** are slow, call external services, and should never block a request thread. Splitting "fast reads" from "slow background work" matters much more than splitting by feature.

## 3. Architecture options

### Option A: Single modular monolith

One Node API server does everything: serves map data, runs chat calls inline, runs sweeps and the coverage job in-process. This is roughly what the demo `server/index.js` is today.

```mermaid
flowchart TB
    App([Expo app]) --> API
    subgraph API[Node API server - one process]
        M[Map / gyms module]
        C[Chat module]
        S[Sweep module]
        A[Auth + admin module]
        J[In-process timers<br/>coverage job]
    end
    API --> PG[(Postgres + PostGIS)]
    C --> LLM[LLM provider<br/>Ollama demo / Claude scale]
    S --> SRC[Data sources<br/>Overpass, Places API]
    J --> SRC
```

**Pros**
- Simplest to build, deploy and debug: one process, one log, one deploy.
- Cheapest to host (fits the near-free GCP e2-micro idea).
- Closest to the existing demo code, so least rework.

**Cons**
- A slow sweep or LLM call ties up the same server that serves the map. Ten people chatting at once could make the map feel sluggish.
- Can't scale chat separately from reads. Adding servers to handle chat also duplicates the in-process timers (two coverage jobs running at once).
- A crash in a sweep takes down the whole app.
- Doesn't meet NFR-4 ("scale without a rewrite") well: getting out of it later means pulling background work out anyway.

### Option B: Modular monolith API + background workers via a queue (chosen)

Same single codebase, but deployed as two kinds of process. The **API** only does fast things (reads, auth, accepting requests). Anything slow (chat replies, sweeps, bot review, Overpass refresh, coverage job) becomes a **job on a queue** that **workers** pick up. Redis does double duty as cache and queue. The app gets results by polling or a push/stream.

```mermaid
flowchart TB
    App([Expo app]) --> CDN[CDN cache<br/>map tiles of gym data]
    CDN --> API
    App --> API[Node API<br/>stateless, 1..N copies]
    API --> RC[(Redis<br/>cache + job queue)]
    API --> PG[(Postgres + PostGIS<br/>source of truth)]
    RC --> W[Workers<br/>1..N copies]
    W --> PG
    W --> LLM[LLM interface<br/>Ollama demo / Claude scale]
    W --> SRCS[Data source plugins<br/>Overpass, Places API, ...]
    SCH[Scheduler<br/>coverage job, weekly refresh] --> RC
```

**Pros**
- Map stays fast no matter how many chats or sweeps are running.
- API and workers scale independently: add workers when chat gets busy, add API copies when map traffic grows.
- Queue gives natural rate limiting, so we never exceed Overpass fair-use or LLM budget, and retries for flaky sources.
- Still one codebase and one language, so it's nearly as simple to work on as Option A.
- Uses pieces already agreed (Postgres+PostGIS, Redis, LLM behind one interface).

**Cons**
- More moving parts than A: two process types plus Redis to run and monitor.
- Chat and sweeps become asynchronous, so the app needs a "working on it..." state and a way to get the result (polling or streaming).
- Slightly more hosting cost than A (Redis free tier covers the start).

### Option C: Microservices / serverless functions

Each feature becomes its own service (or set of cloud functions) with its own deploy, talking through an API gateway and an event bus.

```mermaid
flowchart TB
    App([Expo app]) --> GW[API gateway]
    GW --> GS[Gym service]
    GW --> CS[Chat service]
    GW --> SS[Sweep service]
    GW --> AS[Auth service]
    GW --> MS[Moderation service]
    GS --> GDB[(Gyms DB<br/>PostGIS)]
    AS --> UDB[(Users DB)]
    MS --> MDB[(Submissions DB)]
    CS --> LLM[LLM]
    SS --> SRC[Data sources]
    GS & CS & SS & MS <--> BUS{{Event bus}}
```

**Pros**
- Each piece scales and deploys fully independently.
- Strong isolation: a broken sweep service can't affect anything else.
- Fits large teams where different people own different services.

**Cons**
- Heavy overhead for a one-person project at 10k DAU: many deploys, network calls between services, distributed debugging.
- Data is split across services, so simple things (approving a submission updates a gym) become cross-service workflows.
- Serverless functions have time limits and cold starts that fit badly with long sweeps and LLM calls.
- Highest cost and complexity for no benefit at the expected load.

### Option D: Backend-as-a-Service (e.g. Supabase) + a worker

Use a hosted platform that bundles Postgres+PostGIS, auth, row-level permissions and auto-generated APIs. The app reads gyms directly from it. Only the slow work (chat, sweeps, bot review) runs in a small custom worker.

```mermaid
flowchart TB
    App([Expo app]) --> BaaS
    subgraph BaaS[Hosted BaaS]
        AUTH[Auth + roles]
        REST[Auto REST API<br/>+ row-level security]
        DB[(Postgres + PostGIS)]
        FN[Edge functions]
    end
    App -->|start chat / sweep| FN
    FN --> Q[(Queue table / Redis)]
    Q --> W[Custom worker]
    W --> DB
    W --> LLM[LLM interface]
    W --> SRC[Data source plugins]
```

**Pros**
- Auth, sign-up, password reset and roles (FR-13, 14) come built in, so less security code to write ourselves.
- Generous free tier, managed backups, PostGIS supported.
- Fastest path to a working product.

**Cons**
- Vendor lock-in: auth and permission rules live in the platform, so moving off it later is real work.
- Business rules (approval flow, filters) split between database policies, edge functions and the worker, which is harder to reason about than one codebase.
- Throws away the existing Express server and auth code.
- Less control over caching and how queries scale.

## 4. Comparison

| | A. Monolith | **B. Monolith + workers** | C. Microservices | D. BaaS + worker |
|---|---|---|---|---|
| Build effort now | Lowest | Low | High | Low |
| Reuses demo code | Most | Most | Little | Little |
| Map stays fast under chat/sweep load | No | Yes | Yes | Yes |
| Scales past 10k DAU without rewrite (NFR-4) | Weak | Good | Best | Good, within vendor limits |
| Hosting cost at start | ~Free | ~Free (same single server as A in demo mode, section 6.1) | Highest | ~Free |
| Ops complexity | Lowest | Medium | Highest | Low |
| Lock-in | None | None | Low | High |

## 5. Building-block choices

The options above are the overall *shape*. Inside any shape, three building blocks change how the system behaves the most: **which database**, **where caches go**, and **where queues go**. Each one is laid out below as variations with a diagram, and why one wins for this app.

### 5.1 Database: PostgreSQL+PostGIS vs NoSQL

What the data looks like decides this. Gym Finder's data is:
- **Geographic.** The main query is "gyms inside this map rectangle, filtered by category / drop-in / trial / text" (FR-5, FR-10).
- **Relational.** Users → submissions → gyms → reviews → admin decisions (FR-16 to FR-18). Approving a submission must update the gym *and* the submission together, or neither.
- **Moderate in size.** Probably a few million gyms worldwide, at most. That fits one Postgres server comfortably.

**Variation 1: PostgreSQL + PostGIS (relational with a geo extension)**

```mermaid
flowchart LR
    API --> PG[(Postgres + PostGIS)]
    subgraph PG_inside[One database]
        G[gyms<br/>GIST index on location<br/>full-text index on details]
        S[submissions] --> G
        U[users] --> S
        R[reviews] --> G
    end
    PG --- PG_inside
```

- ✅ PostGIS is the industry standard for geo queries: bounding box, radius, nearest, clustering, all indexed.
- ✅ Transactions: "approve submission + update gym" is atomic, so no half-applied changes.
- ✅ Filters, joins and full-text search in one query, no second system needed for FR-10.
- ✅ JSONB columns give NoSQL-style flexibility for the messy, varying gym details (prices in many currencies, odd opening hours).
- ✅ Already chosen in earlier decisions and used by the demo code.
- ❌ Scaling writes past one server is harder than with NoSQL (needs partitioning or sharding). Not a concern at this size: gym data is read-heavy, and read replicas cover reads.

**Variation 2: Document NoSQL (MongoDB, Firestore)**

```mermaid
flowchart LR
    API --> MDB[(MongoDB / Firestore)]
    subgraph docs[Collections of JSON documents]
        G2[gyms<br/>2dsphere geo index<br/>embedded prices, hours, reviews]
        S2[submissions<br/>copy of gym data inside]
        U2[users]
    end
    MDB --- docs
```

- ✅ Flexible schema: each gym document can hold whatever fields are known.
- ✅ MongoDB has decent geo queries (2dsphere). Firestore syncs live to mobile apps, which is attractive for Expo.
- ✅ Scales writes horizontally out of the box.
- ❌ Firestore's geo support is weak (needs geohash workarounds, one range filter per query), so "gyms in view + filters" gets awkward and expensive (billed per document read, so every map pan costs money).
- ❌ Relations (submission → gym → reviewer) must be duplicated or joined in app code, so data drifts out of sync.
- ❌ Multi-document transactions exist in MongoDB but are second-class; approval flow is more fiddly.

**Variation 3: Wide-column / key-value NoSQL (DynamoDB, Cassandra)**

```mermaid
flowchart LR
    API --> DDB[(DynamoDB)]
    DDB --- K[partition key = geohash cell<br/>sort key = gym id]
    API --> OS[(Search engine<br/>for filters + text)]
    DDB -. stream changes .-> OS
```

- ✅ Near-unlimited scale with predictable latency; pay-per-request.
- ✅ Geohash-cell partition keys map neatly onto the tile idea.
- ❌ Only fast for the queries you designed keys for. Filters and text search need a second system (OpenSearch), so two stores to keep in sync.
- ❌ No joins, limited transactions; the approval flow needs careful design.
- ❌ Built for millions of requests per second, which this app won't have. All of the cost of that scale, none of the benefit.

**Verdict (decided by Joey, 2026-10-31):** PostgreSQL + PostGIS. The data is geographic and relational, the size fits one server, and JSONB covers the "flexible fields" argument that usually favours NoSQL. NoSQL would win if we had huge write volume or no relations, and we have neither.

### 5.2 Caching: where should caches go?

Caches help when the *same* answer is requested many times. Here that's map tiles (everyone looking at Bali sees the same gyms) and gym details. They don't help for per-user data (my submissions) or rare queries.

```mermaid
flowchart LR
    App([Expo app]) -->|1| CC[Client cache<br/>tiles already seen]
    CC -->|2| CDN[CDN / edge cache<br/>public tile responses]
    CDN -->|3| API
    API -->|4| RD[(Redis<br/>tiles, gym details,<br/>LLM answers)]
    RD -->|5| PG[(Postgres)]
    W[Workers] -->|6| EXT[External APIs<br/>Overpass, Places, LLM]
    W --> PG
```

| Variation | Where | Pros | Cons |
|---|---|---|---|
| **No cache** | Every request hits Postgres | Simplest; always fresh | Postgres does all the work; fine at launch, first thing to strain under growth |
| **Client cache only** (layer 1) | In the app (e.g. React Query) | Free; instant re-pans | Each user still hits the server once per tile; no sharing between users |
| **Redis in front of Postgres** (layer 4) | Server side | Shared between all users; also caches LLM answers and rate-limit counters; easy to invalidate on approval | One more service to run; must invalidate on every gym change |
| **CDN for tile responses** (layer 2) | At the edge, near users | Absorbs most map traffic before it reaches our servers; fastest for users worldwide; cheap | Only works because tiles are public and identical per user; stale until TTL expires or a purge |
| **All layers** (1+2+4) | Everywhere | Best scale and speed | Most invalidation to think about |
| **Persistent cache of external data** (layer 6, Postgres itself) | Storing Overpass/Places results | Protects external rate limits and cost; this is what `fetched_areas` already does | Data goes stale; needs the weekly refresh |

**Verdict:** layers 1, 2, 4 and 6. Fixed geohash tiles are what makes this work: if the app asked for "gyms in this exact rectangle", every pan would be a unique request and no cache would ever hit. Snapping to fixed tiles turns millions of unique rectangles into a small set of reusable keys. Redis is the place to add next once Postgres load matters, which matches the earlier decision to include it now. Do **not** cache per-user data (submission status, admin queue) at the CDN.

### 5.3 Queues: where should queues go?

A queue belongs anywhere work is **slow, flaky, rate-limited, or costly**, so the user shouldn't wait on it and we control how fast it runs.

| Work | Slow? | External limit? | Queue? |
|---|---|---|---|
| Map tile read | No | No | **No**, must be instant |
| Auth, submitting a request | No | No | **No** (but the bot review it triggers: yes) |
| AI chat reply (FR-8) | 2–30 s | LLM cost/throughput | **Yes** |
| Bot review of submissions (FR-17) | Seconds | LLM | **Yes** |
| Area sweep (FR-11) | Minutes | Source rate limits / billing | **Yes** |
| Overpass tile refresh, coverage job | Seconds–minutes | ~100 req/day fair use | **Yes**, with a rate limiter |
| Cache invalidation after approval | No | No | Optional (event) |

**Variation 1: No queue (do it inside the request)**

```mermaid
sequenceDiagram
    participant App
    participant API
    participant LLM
    App->>API: ask chatbot
    API->>LLM: prompt (10-30 s)
    LLM-->>API: answer
    API-->>App: answer
    Note over API: request thread busy the whole time<br/>timeouts, retries and rate limits by hand
```
- ✅ Simplest; the answer comes back in the same request.
- ❌ Long requests hit mobile/proxy timeouts; a burst of chats or sweeps starves map reads; no retries; easy to exceed Overpass/LLM limits.

**Variation 2: Queue in Redis (e.g. BullMQ)**

```mermaid
sequenceDiagram
    participant App
    participant API
    participant Q as Redis queue
    participant W as Worker
    participant LLM
    App->>API: ask chatbot
    API->>Q: add job
    API-->>App: 202 + job id
    W->>Q: take job (max N at once)
    W->>LLM: prompt
    LLM-->>W: answer
    W->>Q: result
    App->>API: poll / stream job id
    API-->>App: answer
```
- ✅ Fast; built-in retries, delays, rate limits, cron-style schedules (coverage job).
- ✅ Reuses Redis we already run for caching.
- ❌ Jobs live in Redis memory: need persistence turned on so a restart doesn't lose them.

**Variation 3: Queue in Postgres (e.g. pg-boss, or a jobs table with `SKIP LOCKED`)**
- ✅ No extra service; job + data change can be one transaction (e.g. "create submission and its bot-review job" can't half-happen).
- ❌ Adds load to the main database; lower throughput than Redis. Fine at this scale, worse later.

**Variation 4: Managed cloud queue (SQS, Google Pub/Sub, Cloud Tasks)**
- ✅ Zero ops, effectively unlimited scale, durable.
- ❌ Ties us to one cloud; harder to run locally; overkill now.

**Variation 5: Kafka (event log)**
- ✅ Handles millions of messages per second; messages are stored on disk and can be replayed.
- ✅ Good when many different consumers need the same stream of events.
- ❌ It's a log, not a job queue: no built-in per-job retries, delays or rate limits, so we'd build those ourselves.
- ❌ Heavy to run (a cluster, or a paid managed service). 1,000 msg/s is about 0.1% of what it's built for.

#### Why Redis and not Kafka, and what about data loss?

**Scale.** Kafka scales further, but we don't need that. A single Redis instance handles tens of thousands of jobs per second, so 1,000/s uses a few percent of it. Kafka's advantage starts at hundreds of thousands to millions of messages per second.

**Fit.** Our work is *jobs* (do this sweep, answer this chat), and job features matter most here:

| Need | Redis job queue (BullMQ) | Kafka |
|---|---|---|
| Retry a failed job with backoff | Built in | Build it yourself (retry topics) |
| Delay or schedule a job | Built in | Build it yourself |
| Priorities (seed jobs low, user sweeps high) | Built in | Separate topics + custom logic |
| Per-source rate limit (don't get blocked) | Built in | Build it yourself |
| Merge duplicate jobs (same tile) | Built in (job IDs) | Build it yourself |
| Replay history, many independent consumers | No | **Yes, its main strength** |
| Running cost | One small instance / free tier | Cluster or paid managed service |

**Data loss.** Redis keeps data in memory, so a crash *can* lose recent jobs. **Decided by Joey (2026-10-31): bot jobs (sweeps, chat replies, bot review) are allowed to fail or be lost, but the user who asked must be told.** So the design doesn't try to make every job survive; it makes sure no failure is silent:

1. **Every user request is a row in Postgres first.** A `requests` record (sweep, gym submission) with a status of `pending`, `completed` or `failed`, plus a deadline. The queued job only carries the row's ID. A user's own submitted data is never lost, even if its job is.
2. **Workers report the result.** A finished job sets its row to `completed`; one that errors or runs out of retries sets it to `failed` with a short reason.
3. **Timeout watchdog catches lost jobs.** A periodic check marks any `pending` row past its deadline as `failed` (e.g. "timed out"). This covers jobs Redis lost in a crash, since nothing would ever report on them.
4. **The user is told in the app** (decided by Joey, 2026-10-31):
   - **Signed in:** the request is stored against their account and appears on **one "My requests" page**, together with their add-gym and update-gym requests (FR-18). Each shows `pending`, `completed` or `failed`, with a **Retry** button on failed ones and a notification when the status changes.
   - **Chats are the exception (decided by Joey, 2026-11-02): they are temporary and never stored.** A chat answer lives only in the cache for a few minutes and on the screen where it was asked; a failed chat shows an error and a Retry button there. See API.md 1.4.
5. **Persistence still on:** Redis `appendfsync everysec` keeps losses to ~1 second of jobs, so failures stay rare.

```mermaid
sequenceDiagram
    participant App
    participant API
    participant PG as Postgres
    participant Q as Redis queue
    participant W as Worker
    participant WD as Timeout watchdog
    App->>API: request sweep / chat / submission
    API->>PG: INSERT request (pending, deadline)
    API->>Q: enqueue {request_id}
    API-->>App: request_id
    alt job runs
        W->>Q: take job
        W->>PG: status = completed, or failed + reason
    else job lost (Redis crash)
        WD->>PG: every minute: pending past deadline?
        WD->>PG: status = failed ("timed out")
    end
    App->>API: poll / push for request status
    API-->>App: completed, or failed + Retry button
```

**When Kafka (or a managed queue like SQS) would be the better pick:** if volume grows into hundreds of thousands of events per second, if several separate systems need to read the same event stream (analytics, search indexing, notifications), or if we need to replay history. Because the queue sits behind one interface, switching then is a new implementation, not a rewrite.

#### Handling 1,000 bot requests per second (NFR-2)

The idea is to accept requests fast and process them slowly. The queue absorbs the burst; each queue drains at the rate its downstream can take.

```mermaid
flowchart LR
    App([Users / bots<br/>up to 1,000 req/s]) --> API[API<br/>validate, per-user limit,<br/>enqueue, return job id]
    API --> M{Merge duplicates<br/>same tile already queued?}
    M -->|new| QS[["Sweep queue<br/>'find more gyms'<br/>drains SLOW, e.g. a few per minute"]]
    M -->|new| QG[["Gym queue<br/>chat, bot review<br/>drains FAST, limited by LLM capacity"]]
    M -->|duplicate| J[Attach to existing job]
    QS --> WS[Sweep workers] --> GM[Google Maps scraper<br/>+ other source plugins]
    QG --> WG[LLM workers] --> OL[LLM interface<br/>Ollama or Claude]
    WS --> SUB[(Submissions)]
    WG --> PG[(Postgres)]
```

Why the extra pieces matter: at a sustained 1,000/s in and a few per minute out, a sweep queue would grow by ~86 million jobs a day and never empty. Three things keep it bounded:
1. **Merge duplicates:** many users asking to sweep the same area becomes one job (keyed by geohash tile).
2. **Skip fresh tiles:** a tile swept recently is answered from the database, not re-queued.
3. **Per-user limits:** one user or bot can't fill the queue alone.

#### Auto-scaling the workers

Each queue's workers scale on their own, based on how long that queue is. More jobs waiting means more worker copies running in parallel; an empty queue scales down to a minimum (or zero).

```mermaid
flowchart LR
    QG[["Gym queue<br/>depth = 5,000"]] --> AS1{Autoscaler<br/>watches queue depth}
    QS[["Sweep queue<br/>depth = 50,000"]] --> AS2{Autoscaler}
    AS1 -->|scale out| WG1[LLM worker] & WG2[LLM worker] & WG3[LLM worker ...]
    AS2 -->|scale out, but capped| WS1[Sweep worker] & WS2[Sweep worker]
    WS1 & WS2 --> RL[Shared rate limiter<br/>per source, in Redis]
    RL --> GM[Google Maps / Overpass]
```

- ✅ Pay for capacity only when there's a backlog; grows with users without code changes (NFR-4).
- ✅ Gym and sweep queues scale independently, so a seeding run doesn't steal capacity from chat.
- ❌ Sweep workers need a **shared** rate limiter and a max worker count. Without it, scaling out just sends more scrape requests at once and gets us blocked faster. More sweep workers help with parsing and dedupe work, not with going past the source's limit.
- ❌ LLM workers scale only as far as the LLM does: with Ollama that means GPU machines; with Claude it means API rate limits and the bill. Either way it's the main cost lever.
- ❌ Needs a platform that can scale on queue depth (e.g. Kubernetes with KEDA, Cloud Run, Fly.io machines). The near-free single VM can't, so this comes with the move to managed hosting.

**Verdict:** queue chat, bot review, sweeps and external refreshes; never queue map reads. Use separate queues with their own drain rates (slow for sweeps, faster for per-gym jobs), each with workers that auto-scale on queue depth. Redis queues (Variation 2) handle 1,000 jobs/s easily and Redis is already in the plan, so start there. Kafka (Variation 5) is worth it only if we later need very high volume or several systems reading the same event stream; because the queue sits behind one interface, switching later doesn't touch the rest of the code. Postgres-backed queues are a reasonable fallback if we ever want to drop Redis.

### 5.4 Putting the chosen blocks together

```mermaid
flowchart TB
    App([Expo app<br/>client tile cache]) --> CDN[CDN<br/>public tiles]
    CDN --> API[API copies]
    App -->|auth, submissions,<br/>chat job status| API
    API <--> RD[(Redis<br/>cache + queues)]
    API <--> PG[(Postgres + PostGIS)]
    RD --> WC[Chat + bot-review workers]
    RD --> WS[Sweep + refresh workers<br/>rate-limited per source]
    WC --> LLM[LLM interface]
    WS --> SRC[Data source plugins]
    WC --> PG
    WS --> PG
```

## 6. Decision: Option B

**Decided by Joey (2026-10-31):** Option B. It avoids the extra resource costs microservices would bring, costs the same as A in demo mode, and keeps everything scalable.


Option B keeps the simplicity of one codebase but separates the two kinds of work that actually behave differently. It's a short step from the demo code (move slow handlers into job processors), uses the pieces already agreed on, and every scaling move later is "add more copies" rather than a rewrite. Option A is a fine *first deploy* of B's code (run the worker in the same process), but the queue boundary should be in the code from day one.

### 6.1 Two modes: demo and scale

We want to run cheaply now (no paid queues, Ollama), but be able to switch to high-scale mode straight away once there are users and premium accounts. That works if **every piece that differs between modes sits behind an interface, and the mode is picked by config**, not by code changes. Option B fits this well because "API + workers + queue" can all run inside one process in demo mode.

**Demo-mode B costs the same as Option A.** Everything runs on the same single small server A would use: the API and the worker as two processes (or one), the queue as a table in the same Postgres, and Ollama alongside. No Redis, no paid queue, no extra machine. The only difference from A is that slow jobs go through the queue table instead of running inside the request, so a busy chat or sweep can't slow the map down. That separation is what makes the later switch to scale mode a config change instead of a rewrite.

```mermaid
flowchart TB
    subgraph Code[Same codebase]
        LI[LLM interface]
        QI[Queue interface]
        CI[Cache interface]
        SI[Source interface]
    end
    CFG{{MODE = demo / scale}} --> Code
    subgraph Demo[Demo mode: ~free]
        D1[One VM: API + workers<br/>in one process]
        D2[Ollama on same/home box]
        D3[Queue = Postgres table<br/>e.g. pg-boss, no extra service]
        D4[Cache = in-memory + CDN free tier]
        D5[(One Postgres + PostGIS)]
    end
    subgraph Scale[Scale mode]
        S1[API copies + auto-scaled workers]
        S2[Claude API]
        S3[Queue = Redis, Kafka later]
        S4[Cache = Redis + CDN]
        S5[(Managed Postgres + replicas)]
    end
    Code -->|demo| Demo
    Code -->|scale| Scale
```

| Piece | Demo mode | Scale mode | What switching takes |
|---|---|---|---|
| LLM | Ollama | Claude | Config + API key |
| Queue | Postgres table (pg-boss) or in-process | Redis queue (Kafka later) | Config; drain or move jobs still waiting |
| Cache | In-memory per process + free CDN | Redis + CDN | Config + a Redis URL |
| Workers | Same process as API, fixed count | Separate, auto-scaled on queue depth | Deploy config |
| Database | One Postgres+PostGIS | Managed Postgres + read replicas | Dump/restore or managed migration (the only slow step) |

**How the switch works: one setting, chosen at startup, not on/off checks in the code.** A single `MODE=demo|scale` setting (or one flag per piece, e.g. `QUEUE=postgres|redis`, `LLM=ollama|claude`) is read once when the server starts and picks which implementation each interface gets. Business code only ever calls `queue.add(...)`, `llm.ask(...)`, `cache.get(...)` and never checks the mode itself.

```mermaid
flowchart LR
    ENV{{MODE setting<br/>read once at startup}} --> F[Factory]
    F -->|demo| PQ[PostgresQueue] & OL[OllamaLLM] & MC[MemoryCache]
    F -->|scale| RQ[RedisQueue] & CL[ClaudeLLM] & RC[RedisCache]
    PQ & RQ -.implements.-> QI[Queue interface]
    OL & CL -.implements.-> LI[LLM interface]
    MC & RC -.implements.-> CI[Cache interface]
    BIZ[Business code<br/>chat, sweeps, map] --> QI & LI & CI
```

| Approach | Why |
|---|---|
| ✅ **Mode picks the implementation at startup** | One place to change; demo and scale run the exact same business code; adding Kafka later is one more implementation, not edits everywhere. |
| ❌ `if (scaleMode)` checks scattered through the code | Easy to miss one; the demo path and scale path drift apart, so the scale path breaks without anyone noticing until switch day. |
| ❌ **Turning queues *off* in demo mode** (running slow jobs inside the request) | Brings back the problems of Option A: chats and sweeps block the map, no retries, no rate limits on scraping. And the queue code would go untested until switch day. Keep queues **on** in demo mode, just backed by a Postgres table, which costs nothing extra. |

Redis is the piece that can truly be absent in demo mode: the cache falls back to in-memory and the queue to Postgres. Claude vs Ollama is the same pattern.

**CI tests both modes.** The test suite runs twice, once with `MODE=demo` and once with `MODE=scale` (Redis in a test container, Claude stubbed), so neither side can quietly break.

- ✅ Near-zero cost until there's revenue, with no rewrite when we switch.
- ✅ Demo mode still exercises the real queue and cache code paths, so the switch is low-risk.
- ✅ A Postgres-backed queue in demo mode costs nothing extra and keeps jobs safe over restarts (a pure in-memory queue loses them).
- ❌ Two of everything to test. Mitigation: CI runs the test suite in both modes (above).
- ❌ Interfaces must stick to what both sides support (e.g. no Kafka-only or Redis-only features in business logic).
- ❌ "Immediately" applies to config and services; moving the database to a managed host still needs a short planned migration.

### Key flows in Option B

**Map read path (FR-4, 5, 10).** Gyms are grouped into fixed tiles (geohash cells, as agreed earlier). The same tile is the same response for every user, so it caches well at the CDN and in Redis. Postgres is only hit on a cache miss.

```mermaid
sequenceDiagram
    participant App
    participant CDN
    participant API
    participant Redis
    participant PG as Postgres+PostGIS
    participant Q as Job queue
    App->>CDN: GET gyms for tile(s) in view
    alt cached at CDN
        CDN-->>App: gyms
    else miss
        CDN->>API: forward
        API->>Redis: tile cached?
        alt hit
            Redis-->>API: gyms
        else miss
            API->>PG: gyms in tile bbox
            PG-->>API: gyms
            API->>Redis: store tile
        end
        API-->>App: gyms (+ "stale" flag)
        opt tile never fetched or older than ~1 week
            API->>Q: enqueue refresh(tile)
        end
    end
    Note over App: filters (drop-in, trial, category, text)<br/>applied on loaded tiles client-side,<br/>or as query params when tile data is large
```

This also answers the open question in [gym-data-design.md](./gym-data-design.md): a stale tile is served immediately and refreshed in the background, so no user waits on Overpass.

**Pluggable data sources (FR-11, OOS-1).** Sweeps, the coverage job and the weekly refresh all call the same interface. Choosing a source is config, so the Google Maps scraper, Google Places API, Foursquare, or regional sources can be added or swapped without changing anything else.

```mermaid
flowchart LR
    J[Sweep / refresh / coverage job] --> SEL{Source selector<br/>by region + config}
    SEL --> OSM[OverpassSource<br/>free]
    SEL --> GMS[GoogleMapsScraper<br/>sweeps, rate-limited]
    SEL --> GP[GooglePlacesSource<br/>licensed, paid]
    SEL --> FSQ[FoursquareSource<br/>licensed, paid]
    SEL -.later, OOS-1.-> REG[Yandex / Baidu source]
    OSM & GMS & GP & FSQ & REG --> N[Normalize + dedupe<br/>against existing gyms]
    N -->|known source, refresh| PG[(Gyms)]
    N -->|sweep result| SUB[(Submissions<br/>FR-12)]
```

**Pre-release seeding (new requirement: populate top travel destinations before launch).** The seeding script is not a separate system. It is a small command-line tool that turns a list of destinations into sweep jobs, and then reuses the same queue, workers and source plugins as user-requested sweeps.

```mermaid
flowchart LR
    L[Destination list<br/>e.g. top 100 travel cities] --> S[Seed script<br/>CLI, run by us]
    S --> T[Split each destination's area<br/>into geohash tiles]
    T --> QS[["Sweep queue<br/>seed jobs at LOW priority"]]
    U([User 'find more gyms']) --> QS
    QS --> WS[Sweep workers<br/>same rate limits]
    WS --> SRC[Source plugins<br/>Overpass first, then Google Maps scraper]
    SRC --> N[Normalize + dedupe]
    N --> SUB[(Submissions<br/>same approval flow as users)]
    SUB --> BV{Bot can verify?}
    BV -->|yes| PG[(Gyms, live)]
    BV -->|no| AD[Admin review queue]
    AD --> PG
```

- ✅ No new pipeline to build or maintain: seeding is "lots of sweeps", so it tests the real sweep path before launch.
- ✅ Resumable: progress is just which tiles are fresh in `fetched_areas`, so a crashed or blocked run picks up where it stopped.
- ✅ Low priority means user sweeps after launch still jump ahead if seeding is still running.
- ✅ Same rate limits protect us from getting blocked mid-seed.
- ❌ Slow by design. Seeding many cities at a careful scrape rate takes days, so it should start well before release.
- ✅ Thousands of seeded gyms don't swamp admins: anything the bot can verify goes live without admin approval (see the verification rules below). Only the unverifiable ones reach the admin queue.
- ❌ The admin queue after a big seeding run could still be long if many gyms can't be verified; admins can work through it after launch since the verified gyms are already live.

**Submissions and approval (FR-12, 16, 17, 18).** User submissions, sweep results, seed results and chatbot-found facts all enter the same pipeline.

**Decided by Joey (2026-10-31): a change skips admin approval when the bot can verify it.** Anything it can't verify goes to an admin as before.

| Change | Counts as bot-verified when |
|---|---|
| **Price change** (drop-in, trial, membership) | The price is found on **the gym's own website**, or in a **price menu photo posted on Google Maps less than a year ago**. Anything else is stored as unverified and only an admin can verify it (REQUIREMENTS.md FR-24). |
| **New gym** | It exists in OpenStreetMap, on Google Maps or on its own website within about 50 m of the pin, with a matching name, and isn't already on the map (decided by Joey, 2026-11-02; FR-25). |
| **Name, address, hours, categories, drop-ins, trial** | The new value is on the gym's own website or its Google Maps listing. Values found only in reviews, chat answers or elsewhere on the web are unverified (FR-25). |
| **Marking a gym closed / removing it** | Never: always an admin (FR-25). |

The bot may reject on its own (spam, missing name or location, impossible location, exact duplicate) and tells the user why (FR-26). Non-price changes waiting for an admin stay hidden until approved; unverified prices are shown, labelled (FR-27).

Every auto-approved change keeps its **evidence** (source URL, date found, what was matched) on the record, so admins can audit it later and undo a bad one.

```mermaid
stateDiagram-v2
    [*] --> Pending: user submits / sweep finds / chat proposes fact
    Pending --> BotReviewed: worker runs bot review<br/>(spam, duplicate, missing fields)
    BotReviewed --> Rejected: bot rejects obvious junk
    BotReviewed --> Approved: bot verified<br/>(e.g. price on gym's site,<br/>or menu < 1 year old)
    BotReviewed --> AwaitingAdmin: plausible but not verified
    AwaitingAdmin --> Approved: admin approves
    AwaitingAdmin --> Rejected: admin rejects
    Approved --> [*]: change goes live,<br/>tile cache invalidated
    Rejected --> [*]
```

**AI chat (FR-8, 9).** The API accepts the question and returns a job id; a worker calls the LLM through the single LLM interface (Ollama in demo mode, Claude in scale mode) with the gym's record as context, then streams or posts the answer back. The chat itself is temporary and never stored (decided by Joey, 2026-11-02). Useful facts in an answer (a price, a trial offer) are proposed as gym changes through the approval flow, so the next user sees them without asking.

### How Option B scales

| Load | Setup |
|---|---|
| Demo mode, launch → 10k DAU (~30 req/s peak) | One small VM running API + workers in one process, Postgres queue, Ollama, free CDN. |
| Scale mode switch-on | Separate API and auto-scaled workers, Redis cache + queue, Claude, managed Postgres. |
| ~100k DAU (~300 req/s) | 2–4 API copies behind a load balancer, more workers, Postgres read replica. CDN absorbs most map reads. |
| ~1,000 req/s (NFR-2's number) | Map reads are ~all CDN/Redis hits, so API copies scale horizontally. Bot requests are accepted into queues at full speed and drained at each queue's own rate (section 5.3). Workers auto-scale on queue depth; LLM throughput is bounded by Claude's rate limits and budget (scale mode). Sweeps drain slowly on purpose to avoid getting blocked by Google Maps. |

## 7. Decisions

Settled in PR review:
- **FR-11:** sweeps scrape Google Maps; ToS risk accepted. Scraper sits behind the pluggable source interface.
- **NFR-2:** 1,000 bot req/s is handled by queues with separate drain rates, whose workers auto-scale and run in parallel (section 5.3).
- **LLM:** Ollama in demo mode, Claude in scale mode, switched by config.
- **Two modes:** a near-free demo mode and a high-scale mode, switchable by config without code changes (section 6.1).
- **FR-4:** coverage grows with use.
- **Architecture:** Option B, modular monolith API + background workers via a queue.
- **Database:** PostgreSQL + PostGIS (section 5.1).
- **Failed bot jobs:** may fail or be lost; every request is tracked in Postgres with a deadline, and the user is told in-app: signed-in users see pending / completed / failed on one "My requests" page alongside their gym add/update requests; signed-out users see it only in-session (section 5.3).

- **Bot verification skips admin approval** (for seeds, sweeps and user requests alike). Price changes count as verified when found on the gym's own website or on a Google Maps menu photo posted less than a year ago; other changes per REQUIREMENTS.md FR-25 to FR-27; unverified changes go to admin review. Evidence is kept for audit.

Nothing open. Next docs: stack choices, then schema, then API.
