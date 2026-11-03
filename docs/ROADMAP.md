# Roadmap

Back to the [README](../README.md).

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
- [x] Update [`CLAUDE.md`](../CLAUDE.md) so Claude stays on track and builds things the way we planned
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
