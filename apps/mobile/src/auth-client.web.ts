import { createAuthClient } from 'better-auth/react';
import { API_BASE_URL } from '@/config';

// A browser attaches its own cookies automatically - credentials:
// 'include' on each fetch() is all that's needed, nothing to configure here.
export const authClient = createAuthClient({ baseURL: API_BASE_URL, basePath: '/v1/auth' });

// Nothing to return - the browser already holds and sends the real cookie.
export async function getAuthCookie(): Promise<string | null> {
  return null;
}
