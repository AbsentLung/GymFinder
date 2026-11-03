import { createAuthClient } from 'better-auth/react';
import { API_BASE_URL } from '@/config';

// A browser attaches its own cookies automatically on every request to
// the same origin it got them from - credentials: 'include' on the
// individual fetch() calls (see @/auth-context.ts's authHeaders) is
// what makes that work cross-origin too, nothing to configure here.
export const authClient = createAuthClient({ baseURL: API_BASE_URL, basePath: '/v1/auth' });

// Mirrors auth-client.ts's native getAuthCookie, which genuinely has a
// cookie to return (the Expo client stores it itself, since React
// Native's fetch has no cookie jar) - web has nothing to return since
// the browser already holds and sends the real cookie on its own.
export async function getAuthCookie(): Promise<string | null> {
  return null;
}
