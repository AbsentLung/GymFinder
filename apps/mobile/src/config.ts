// Falls back to localhost for normal local dev. Set EXPO_PUBLIC_API_URL
// (e.g. when tunneling the backend to share a demo) instead of editing
// this file or any of the fetch() calls that use it - Expo inlines
// EXPO_PUBLIC_* env vars into the bundle at build time, so this needs the
// dev server restarted after changing it, same as any other build-time
// config.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
