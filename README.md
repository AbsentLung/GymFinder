# TravelApp

An all-in-one travel app. Built on TypeScript, React Native (Expo), PostgreSQL, and eventually AWS.

## Gym Finder

For broke backpackers: find gym trial hacks and the cheapest nearby walk-ins, anywhere in the world, weighted toward backpacker and digital-nomad hubs - search any city, no fixed destination list. At its core, it finds all nearby gyms with OpenStreetMap; click a gym to ask a bot for details on cost, free trials, etc., and that gets stored into a database. See [docs/gym-data-design.md](./docs/gym-data-design.md) for how gym data is sourced, and [Plan.md](./Plan.md) for the full design.

Demo: https://photos.app.goo.gl/GRBmorkgwwYUKwzo6

# Roadmap

Each phase finishes before the next one starts, unless noted. Check items off as they're done.

## 1. Requirements

- [x] List functional requirements
- [x] List non-functional requirements (performance, scale to thousands of users, cost, privacy, offline behavior)
- [x] List the riskiest unknowns (e.g. limits of whichever map/gym data source we pick, cost and hosting of the chatbot's LLM, moderating user-submitted gym data)
- [x] Ask Claude to research whether the requirements and unknowns are realistic
- [x] Decide what's in scope for beta / demos and what's saved for later

> The full requirements are in [REQUIREMENTS.md](./REQUIREMENTS.md).

## 2. Design

Expo (SDK, Expo Router, TypeScript) is already in the repo, so treat it as a constraint going in.

- [x] High-level design: ask Claude for several options with pros and cons, debate until we land on the best one
- [x] Choose everything Expo doesn't cover, driven by the high-level design: where the backend runs (e.g. Expo API routes or a separate server), database, cache, hosting, the map and gym data source, and the chatbot's LLM
- [x] Database schema: ask Claude for several variations, debate until we land on the best one
- [x] API design: compare variations and their trade-offs, then approve a final design
- [x] Clean up into a presentable [`DESIGN.md`](./DESIGN.md) for others to read
- [x] Update [`CLAUDE.md`](./CLAUDE.md) so Claude stays on track and builds things the way we planned
  - [x] Include an absolute rule: Claude must **never** commit secrets (API keys, tokens, passwords, `.env` files) to the repo

> The full design is in [DESIGN.md](./DESIGN.md).

## 3. Environment

- [ ] Separate dev, staging and production setups, with secrets kept out of the repo
- [ ] Local database and cache (whatever phase 2 picks) running via Docker, one command to start
- [ ] Install packages
- [ ] Linting, formatting and test frameworks (unit, integration, end-to-end) set up before any feature code
- [ ] CI/CD pipelines (lint, type-check, tests on every PR; deploys per environment)
- [ ] GitHub branch protection, so nothing merges without the required reviews and green checks
- [ ] Automate the review bots on every PR: CodeRabbit, and the second Claude review via the Claude Code GitHub Action (`/install-github-app` in the Claude CLI sets it up)
- [ ] Error tracking and logging

## 4. Build

Every section ships with unit, integration and automated tests, and runs on **web, Android and iOS** as it's built (Expo gives us all three from one codebase).

Review gate for every section:
- CodeRabbit approval
- Second Claude approval
- Human approval

Parallel work: features that aren't tightly coupled to others are built in parallel with Orca, one Claude CLI per feature. Each Claude CLI opens its own pull request for its feature, which goes through the review gate on its own. Tightly coupled features are built one after another.

Steps:
- [ ] Walking skeleton, end to end: search a city → fetch nearby gyms from the chosen data source → cache them → show them on the map
- [ ] Routing
- [ ] Initial frontend and backend structure built out from the skeleton
- [ ] Features (in parallel where they're independent, see above):
  - [ ] The map
  - [ ] Homepage
  - [ ] Find by search
  - [ ] Find by current location
  - [ ] Filters
  - [ ] Individual gym sidebar
  - [ ] "Find More Gyms"
  - [ ] Individual gym chatbot
  - [ ] Anything else that came up in phases 1 and 2
- [ ] Polish for mobile web, Android and iOS specifics

## 5. Release

- [ ] Start the Google Play closed test early (new personal accounts need 12 testers for 14 days before going public)
- [ ] Buy an Apple Developer account ($99/year)
- [ ] Write a privacy policy
- [ ] Add OpenStreetMap attribution in the app (required by its license)
- [ ] Prepare store listings (Google Play and App Store)
- [ ] Buy the cheapest possible environment for a demo release on web and Android
- [ ] Test everything thoroughly and keep fixing things until we're ready to leave beta
- [ ] Once iOS is thoroughly tested, release the beta to the App Store
- [ ] Confirm web, mobile web, Android and iOS all work correctly
- [ ] Buy all resources needed for the full release
- [ ] Deploy final versions

---

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Set up the database (Postgres - see [Database setup](#database-setup) below if you don't have this running yet)

   ```bash
   createdb travelapp
   psql -d travelapp -f apps/server/db/schema.sql
   psql -d travelapp -f apps/server/db/seed.sql
   ```

3. Set up your `.env`

   ```bash
   cp apps/server/.env.example apps/server/.env
   # then edit apps/server/.env and fill in ANTHROPIC_API_KEY (needed for
   # the "Ask me questions about this gym" chat feature) and JWT_SECRET
   # (signs login session tokens - any long random string works,
   # .env.example shows how to generate one)
   ```

4. Start the backend API server (in one terminal, stays running)

   ```bash
   npm run server
   ```

5. Start the app (in another terminal)

   ```bash
   npm run mobile
   ```

This is an npm-workspaces monorepo (`apps/mobile`, `apps/server`, `packages/shared`, `infra/` - see the [Roadmap](#roadmap)'s Phase 2). Steps 4-5 above run each app's own script from the repo root; `cd apps/mobile` or `cd apps/server` and run their scripts directly works the same way.

### Database setup

Needs a local Postgres server running. On macOS with Homebrew:

```bash
brew install postgresql@16
brew services start postgresql@16
```

Then run the three commands in step 2 above. `apps/server/db/schema.sql` is a full schema dump (tables, the `gym_data_source` enum, indexes, foreign keys, the `pg_trgm` extension used for gym-name duplicate matching); `apps/server/db/seed.sql` adds the couple of reference rows the app actually needs to run (submission status labels, the bot's sentinel admin row) - it does *not* seed any gym data. Gyms populate live the same way they do for everyone: search a city and the server pulls real gyms from OpenStreetMap on the fly. This is the demo schema (`GymFinderVibeCoded`'s `server/`, `db/`); the real schema from STACK_AND_SCHEMA.md part 2 lands in Phase 3.

If your Postgres setup needs a specific host/user/password (not just your local default), set the standard `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGPORT` environment variables - `apps/server/server/index.js` doesn't hardcode a connection beyond the database name, so it picks those up automatically.

### Accounts and admins

Signing up (email+password only for now - Google/Facebook sign-in need real OAuth app credentials from each provider before they can be built) is only required for adding a gym or suggesting an edit. Anyone can apply to become an admin from their profile page, but approving that first application needs an existing admin - there isn't one yet on a fresh database. Bootstrap the first admin directly in Postgres after signing up once in the app:

```bash
psql -d travelapp -c "UPDATE users SET is_admin = true WHERE email = 'you@example.com';"
psql -d travelapp -c "INSERT INTO admins (id, name) SELECT id, name FROM users WHERE email = 'you@example.com' ON CONFLICT (id) DO NOTHING;"
```

From there, that admin can approve everyone else (including other admin applications) from `/admin` in the app. Approval/denial emails and the "post to Facebook on signup" hook are both stubbed for this demo - they log what they would have sent/posted to the server console rather than actually sending, since real email delivery needs a provider+API key and real Facebook posting needs Meta App Review on a registered app, neither of which exists here.

### Local AI (free, for development)

The chat/research/edit-verification features normally call the real Anthropic API, which costs real money per request. Set `AI_PROVIDER=ollama` in `.env` to run a free local model instead while developing:

```bash
brew install ollama
brew services start ollama
ollama pull qwen2.5:3b   # or whatever OLLAMA_MODEL is set to in .env
```

This is a genuine tradeoff, not a free upgrade: a small local model is noticeably less reliable than Anthropic's hosted one at actually calling the right tool with the right data (expect more "found a price but didn't record it"-type misses), and it has no real web search of its own - `apps/server/server/ai.js` gives it a DuckDuckGo-HTML-scraping tool to stand in for Anthropic's hosted search, which works but is an unofficial surface that could break if DuckDuckGo changes their markup. Flip `AI_PROVIDER` back to `anthropic` (or just unset it) for anything you want to trust, including production.

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **src/app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **example** directory and create a blank **src/app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
