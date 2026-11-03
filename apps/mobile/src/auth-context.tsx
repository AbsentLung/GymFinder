import { createContext, useContext, type ReactNode } from 'react';

import { authClient, getAuthCookie } from '@/auth-client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signUp: (email: string, password: string, name: string) => Promise<{ error?: string }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  // Async, unlike the old bcrypt+JWT version's authHeaders - on native
  // this reads the Expo client's stored cookie (SecureStore), which has
  // no synchronous API. Every raw fetch() call site spreads
  // `...(await authHeaders())` now. Returns {} on web: a browser
  // already holds and sends its own cookie automatically given
  // `credentials: 'include'` on the fetch call itself (see each call
  // site), it's not something this app reads or attaches by hand there.
  authHeaders: () => Promise<Record<string, string>>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const user: AuthUser | null = session?.user
    ? {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        // additionalFields.role (apps/server/src/auth.ts) - not on
        // Better Auth's own default user shape, so TypeScript doesn't
        // know about it from createAuthClient's inferred type alone.
        isAdmin: (session.user as { role?: string }).role === 'admin',
      }
    : null;

  const signUp = async (email: string, password: string, name: string) => {
    const { error } = await authClient.signUp.email({ email, password, name });
    return error ? { error: error.message ?? 'Sign up failed.' } : {};
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await authClient.signIn.email({ email, password });
    return error ? { error: error.message ?? 'Sign in failed.' } : {};
  };

  const signOut = async () => {
    await authClient.signOut();
  };

  const authHeaders = async (): Promise<Record<string, string>> => {
    const cookie = await getAuthCookie();
    return cookie ? { Cookie: cookie } : {};
  };

  return (
    <AuthContext.Provider value={{ user, loading: isPending, signUp, signIn, signOut, authHeaders }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
