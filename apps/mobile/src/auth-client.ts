import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '@/config';

// React Native's fetch has no cookie jar - the Expo client plugin
// stores the session cookie itself (SecureStore); getCookie() is how a
// raw fetch() attaches it by hand. `scheme` must match app.json's exactly.
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
