# Gym Finder Requirements

Phase 1 of the [roadmap](./ROADMAP.md). This doc says **what** Gym Finder must do, not **how**. Tool and API choices (map library, database, hosting, LLM, etc.) are decided in phase 2 (Design), so they are left out here on purpose. The only named services below are ones that are part of the requirement itself.

Each requirement has an ID so later docs (`DESIGN.md`, PRs, tests) can point at it.

## Functional requirements

### Home page

- **FR-1** The home page lets a user start by either searching for a location (city, area, address) or using their current location.
- **FR-2** Choosing either option takes the user to the map, centered on that location.
- **FR-3** If the user declines location permission, the app still works through search.

### Map

- **FR-4** A traversable map (pan and zoom) that shows every gym in the world that our data sources know about.
- **FR-5** Gyms load for the area the user is looking at as they move around the map.
- **FR-6** Selecting a gym on the map opens its details.

### Gym details

- **FR-7** A gym's details include, where known: name, location, costs (drop-in / day pass, trial, membership), description, category, and opening hours.
- **FR-8** The details section includes an AI chatbot that looks up and answers questions about that specific gym's data (e.g. "is there a free trial?", "how much is a day pass?"). It may use our database, the gym's own website, its Google Maps page, and a web search. Anything it finds outside the gym's own website or a recent price menu is unverified (FR-24, FR-25).
- **FR-9** Useful facts the chatbot finds can be saved to the gym's record so the next user sees them without asking again (subject to FR-17).

### Filtering and search

- **FR-10** Users can filter the gyms shown in the current map view by:
  - drop-ins allowed
  - trial hacks (free or cheap trial offers)
  - gym category (e.g. commercial, CrossFit, climbing, martial arts, yoga)
  - a text search over gym details

### Sharing the map

- **FR-28** The map's URL always describes what the user is looking at: map position and zoom, the open gym (if any), and the active filters. It updates as the user pans, zooms, opens or closes a gym, or changes a filter, without adding a browser history entry for every pan.
- **FR-29** Opening a shared link shows the same view: same position and zoom, the same gym panel open, and the same filters applied. It works without an account.
- **FR-30** On Android and iOS, a Share button sends the current view as a web link. Opening that link on a phone with the app installed opens it in the app; otherwise it opens on the web.

### Area sweeps by bot

- **FR-11** Beyond free data sources, a user can request that a bot sweeps an area on Google Maps to find gyms that are missing from the map. This does not require an account (Joey, 2026-11-03).
- **FR-12** Gyms found by a sweep go through the same approval flow as user submissions (FR-16, FR-17).
- **FR-22** If the user is signed in, each sweep request and its status (pending, completed, failed) is saved, and shown on the same page as their add/update gym requests (FR-18).
- **FR-23** Users are told when their sweep request fails.

### Accounts and roles

- **FR-13** Users can sign up, log in, and log out.
- **FR-14** Some users are recognized as admins.
- **FR-15** Browsing the map and viewing gym details do not require an account. Submitting or requesting changes does. Requesting a sweep ("Find more gyms", FR-11) does not.

### Adding and updating gyms

- **FR-16** Logged-in users can request that a gym be added to the map, or that an existing gym's details be updated.
- **FR-17** Each request is reviewed first by a bot. If the bot can verify it (FR-24, FR-25), it goes live without admin approval. If it is obvious junk, the bot rejects it (FR-26). Otherwise it waits for an admin to approve it (FR-27).
- **FR-18** Users can see the status of their requests (pending, approved, rejected).
- **FR-24** A price change counts as bot-verified if the bot finds the new price on the gym's own website (no date check), or in a price menu photo posted on Google Maps less than a year ago. Any other price (a user's edit, or one the chatbot found in a review or elsewhere on the web) is stored as **unverified**, shown at the bottom of the price list, and only an admin can verify it.
- **FR-25** A non-price change counts as bot-verified when:
  - **new gym** (from a user, a sweep or pre-seeding): the gym exists in OpenStreetMap, on Google Maps, or on its own website within about 50 m of the given location, with a matching name, and isn't already on the map;
  - **name, address, opening hours, categories, drop-ins, trial**: the bot finds the new value on the gym's own website or its Google Maps listing.
  A value found only in a review, a chat answer or elsewhere on the web is not verified. **Marking a gym closed or removing it always needs an admin.**
- **FR-26** The bot may reject a request on its own, telling the user why, when it is spam or abusive, is missing a name or location, has an impossible location (e.g. in the sea), or exactly duplicates an existing gym (the user is pointed to the existing gym instead).
- **FR-27** A non-price change waiting for an admin is not shown to other users until approved. (Unverified prices are the exception: they are shown, labelled unverified, per FR-24.)

### Pre-seeding gym data

- **FR-19** A script populates all gyms in a given area (e.g. a city or a bounding box), so the map already has data there before any user visits.
- **FR-20** Before release, the script is run on about the top 100 backpacker destinations, from a fixed list we write, so launch users don't land on an empty map.
- **FR-21** The script can be re-run on an area without creating duplicate gyms, so seeded data can be refreshed.

## Non-functional requirements

- **NFR-1 Users:** expect 10,000 daily active users.
- **NFR-2 Bot load:** expect up to 1,000 bot requests per second.
- **NFR-3 Platforms:** Web, Android and iOS.
- **NFR-4 Growth:** the design can scale past these numbers without a rewrite.

## Out of scope (for now)

- **OOS-1 Regional map sources:** the sweep bot uses the best map source for each region, e.g. Yandex Maps in post-Soviet countries and Baidu Maps in China, choosing automatically from the location being swept.
- **OOS-2 Premium:** a paid premium version.

## Answered questions

These were the open questions from phase 1. All are answered (Joey, 2026-10-31 to 2026-11-02); details are in [DESIGN_DISCUSSION.md](./DESIGN_DISCUSSION.md), [STACK_AND_SCHEMA.md](./STACK_AND_SCHEMA.md) and [API.md](./API.md).

1. **Google Maps sweeps (FR-11) and its Terms of Service.** Decided: sweeps scrape Google Maps; Joey accepts the ToS risk. The scraper sits behind a pluggable source interface so it can be swapped. Never pay for proxies.
2. **What is a "bot request" in NFR-2?** Decided: 1,000/s is the intake rate. Requests go into separate queues (slow for sweeps, faster for per-gym jobs) that drain at controlled rates, with duplicate requests merged.
3. **"Every gym in the world" (FR-4).** Decided: coverage grows with use (Overpass refreshes, sweeps, submissions, pre-seeding); some regions may start sparse.
4. **Bot approval (FR-17).** Decided: FR-24 (prices), FR-25 (other changes), FR-26 (bot rejections), FR-27 (pending changes hidden). The menu's date is the date the photo was posted on Google Maps.
5. **Chatbot sources (FR-8).** Decided: our database, the gym's website, its Google Maps page and web search. Only the gym's website and recent menu photos verify a price; everything else is unverified. Chats themselves are temporary and never stored.
6. **Filter scope (FR-10).** Decided: filters and text search apply to the gyms loaded in the current map view, exactly as in the vibe-coded app; no search outside the view.
7. **Which destinations to pre-seed (FR-20)?** Decided: a fixed list we write of about the top 100 backpacker destinations.
