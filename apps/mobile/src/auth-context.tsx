import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { API_BASE_URL } from '@/config';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  authProvider: 'email' | 'google' | 'facebook';
  isAdmin: boolean;
}

// AsyncStorage's web implementation is backed by localStorage, so this one
// key persists a session across reloads on both web and native with no
// Platform.OS branching needed here.
const STORAGE_KEY = 'travelapp.auth';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  signUp: (email: string, password: string, name: string) => Promise<{ error?: string }>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  applyForAdmin: (description: string) => Promise<{ error?: string }>;
  authHeaders: () => Record<string, string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        setUser(parsed.user);
        setToken(parsed.token);
      })
      .catch((e) => console.error('Failed to restore session', e))
      .finally(() => setLoading(false));
  }, []);

  const persist = async (nextUser: AuthUser | null, nextToken: string | null) => {
    setUser(nextUser);
    setToken(nextToken);
    if (nextUser && nextToken) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ user: nextUser, token: nextToken }));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  };

  const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

  const signUp = async (email: string, password: string, name: string) => {
    const res = await fetch(`${API_BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? 'Sign up failed.' };
    await persist(data.user, data.token);
    return {};
  };

  const signIn = async (email: string, password: string) => {
    const res = await fetch(`${API_BASE_URL}/api/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? 'Sign in failed.' };
    await persist(data.user, data.token);
    return {};
  };

  const signOut = async () => {
    await persist(null, null);
  };

  const applyForAdmin = async (description: string) => {
    const res = await fetch(`${API_BASE_URL}/api/users/apply-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ description }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? 'Request failed.' };
    return {};
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, signUp, signIn, signOut, applyForAdmin, authHeaders }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
