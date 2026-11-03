# Gym Finder

Find gyms, free trials and the cheapest walk-ins for budget backpackers, anywhere in the world. Search any city and the map shows nearby gyms from OpenStreetMap plus ones users have added. Open a gym to see day-pass prices, trial offers and reviews, or ask a chatbot about it.

Runs on web, Android and iOS from one Expo codebase.

## Status: beta

Gym Finder is in beta. The working demo was built quickly in the vibe-coded branch, [`GymFinderVibeCoded`](https://github.com/AbsentLung/GymFinder/tree/GymFinderVibeCoded), and is now being rebuilt on `main` to scale to thousands of users while keeping the same UI.

Watch the demo: https://photos.app.goo.gl/GRBmorkgwwYUKwzo6

## Roadmap

Progress, phase by phase, is tracked in [docs/ROADMAP.md](./docs/ROADMAP.md).

## Stack

The rebuild targets TypeScript everywhere: Expo (React Native, Expo Router) for the app, a Fastify API and background workers, Postgres + PostGIS, Redis, MapLibre maps, hosted on AWS. Details in [docs/DESIGN.md](./docs/DESIGN.md).

## Run it locally

```bash
npm install
npx expo start
```

The full setup (database, `.env`, backend server, local AI) is in [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Docs

| Doc | What it covers |
|---|---|
| [ROADMAP.md](./docs/ROADMAP.md) | Phases and progress |
| [REQUIREMENTS.md](./docs/REQUIREMENTS.md) | What the app must do |
| [DESIGN.md](./docs/DESIGN.md) | Design overview, start here |
| [DESIGN_DISCUSSION.md](./docs/DESIGN_DISCUSSION.md) | Architecture options and decisions |
| [STACK_AND_SCHEMA.md](./docs/STACK_AND_SCHEMA.md) | Tools, hosting and database schema |
| [API.md](./docs/API.md) | REST API contract |
| [DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Running the app locally |
| [CLAUDE.md](./CLAUDE.md) | Project rules for Claude sessions (kept at the root so Claude loads it) |

Older notes: [Plan.md](./docs/Plan.md) (the original demo plan) and [gym-data-design.md](./docs/gym-data-design.md), both partly superseded by the docs above.
