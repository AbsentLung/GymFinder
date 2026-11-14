// Deliberately tiny - the real split (web vs. native) lives one level
// down, in @/components/gym-map-screen(.web).tsx, not here. Putting the
// .web.tsx suffix directly on a route file didn't work: Expo Router's own
// route discovery doesn't apply Metro's platform-suffix resolution to
// route files the way a plain import does - confirmed live, the real
// Leaflet library code (L.Browser, etc.) still ended up inlined into the
// Android bundle even after renaming this file to map.web.tsx. A plain
// component import, which is the project's own existing pattern
// (app-tabs.tsx/.web.tsx, animated-icon.tsx/.web.tsx), resolves correctly.
export { default } from '@/components/gym-map-screen';
