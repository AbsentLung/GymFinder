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
  // Async - on native this reads SecureStore, which has no sync API.
  // Returns {} on web; the browser sends its own cookie automatically.
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
        // role is a server-side additionalField, not in the inferred type.
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
