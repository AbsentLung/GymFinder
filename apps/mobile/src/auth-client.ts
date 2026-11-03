import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '@/config';

// React Native's fetch has no cookie jar the way a browser does - the
// Expo client plugin stores the session cookie itself (in SecureStore)
// and getCookie() is how a raw fetch() call (gym-panels.tsx, admin.tsx)
// attaches it by hand, per @/auth-context.ts's authHeaders. `scheme`
// must match app.json's "scheme" exactly - it's how Better Auth's own
// expo() server plugin (apps/server/src/auth.ts) recognizes a request
// as coming from this app's own deep-link callback, not an arbitrary
// origin.
export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  basePath: '/v1/auth',
  plugins: [
    expoClient({
      scheme: 'travelapp',
      storagePrefix: 'travelapp',
      storage: SecureStore,
    }),
  ],
});

export async function getAuthCookie(): Promise<string | null> {
  return authClient.getCookie();
}
