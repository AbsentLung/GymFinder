import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth-context';
import { API_BASE_URL } from '@/config';

interface Submission {
  id: string;
  gym_id: number | null;
  gym_name: string | null;
  submitted_by_name: string;
  submitted_by_user_id: string | null;
  submission_type: 'new_gym' | 'edit' | 'admin_request';
  description: string | null;
  payload: Record<string, any>;
  status_id: number;
  status_label: string;
  created_at: string;
}

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'new_gym', label: 'Gym creation' },
  { value: 'edit', label: 'Gym edit' },
  { value: 'admin_request', label: 'Admin request' },
];

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '2', label: 'Pending' },
  { value: '3', label: 'Approved' },
  { value: '4', label: 'Denied' },
  { value: '', label: 'All statuses' },
];

function summarize(s: Submission): string {
  if (s.submission_type === 'new_gym') return `New gym: "${s.payload.name}"`;
  if (s.submission_type === 'edit') return `Edit "${s.gym_name ?? `gym #${s.gym_id}`}" — ${s.payload.field}: ${s.payload.previousValue ?? '(none)'} → ${s.payload.newValue}`;
  return 'Admin application';
}

export default function AdminScreen() {
  const router = useRouter();
  const { user, loading, authHeaders } = useAuth();
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('2');
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const params = new URLSearchParams();
    if (typeFilter) params.set('type', typeFilter);
    if (statusFilter) params.set('status', statusFilter);
    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/submissions?${params}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to load submissions.');
        return;
      }
      setSubmissions(data);
      setError(null);
    } catch {
      setError('Failed to load submissions.');
    }
  };

  useEffect(() => {
    if (user?.isAdmin) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.isAdmin, typeFilter, statusFilter]);

  const decide = async (id: string, decision: 'approve' | 'deny') => {
    setActingOn(id);
    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/submissions/${id}/${decision}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? `Failed to ${decision}.`);
      } else {
        await load();
      }
    } finally {
      setActingOn(null);
    }
  };

  if (loading) return <View style={styles.container} />;

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Sign in as an admin to view requests.</Text>
        <Pressable style={styles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={styles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  if (!user.isAdmin) {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Admins only. Apply from your profile page.</Text>
        <Pressable style={styles.submitButton} onPress={() => router.push('/profile')}>
          <Text style={styles.submitButtonText}>Go to profile</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Requests</Text>
      <View style={styles.filterRow}>
        {TYPE_FILTERS.map((f) => (
          <Pressable
            key={f.value}
            style={[styles.chip, typeFilter === f.value && styles.chipActive]}
            onPress={() => setTypeFilter(f.value)}
          >
            <Text style={[styles.chipText, typeFilter === f.value && styles.chipTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <Pressable
            key={f.value}
            style={[styles.chip, statusFilter === f.value && styles.chipActive]}
            onPress={() => setStatusFilter(f.value)}
          >
            <Text style={[styles.chipText, statusFilter === f.value && styles.chipTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {submissions?.length === 0 && <Text style={styles.subtitle}>No requests match these filters.</Text>}
        {submissions?.map((s) => (
          <View key={s.id} style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowType}>{TYPE_FILTERS.find((t) => t.value === s.submission_type)?.label}</Text>
              <Text style={styles.rowStatus}>{s.status_label}</Text>
            </View>
            <Text style={styles.rowSummary}>{summarize(s)}</Text>
            {s.description && <Text style={styles.rowDescription}>“{s.description}”</Text>}
            <Text style={styles.rowMeta}>
              by {s.submitted_by_name} · {new Date(s.created_at).toLocaleString()}
            </Text>
            {s.status_id === 2 && (
              <View style={styles.actions}>
                <Pressable
                  style={[styles.actionButton, styles.approveButton]}
                  disabled={actingOn === s.id}
                  onPress={() => decide(s.id, 'approve')}
                >
                  <Text style={styles.approveButtonText}>Approve</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionButton, styles.denyButton]}
                  disabled={actingOn === s.id}
                  onPress={() => decide(s.id, 'deny')}
                >
                  <Text style={styles.denyButtonText}>Deny</Text>
                </Pressable>
              </View>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const ACCENT = '#CEFF45';
const BG = '#111315';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, padding: 24, gap: 14, alignItems: 'center' },
  title: { fontFamily: 'Archivo, sans-serif', fontWeight: '900', fontSize: 26, color: '#F4F4F2', width: '100%', maxWidth: 640 },
  subtitle: { fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: 13, color: '#A9ADB3' },
  submitButton: { backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20 },
  submitButtonText: { color: '#111315', fontWeight: '700', fontSize: 14 },
  filterRow: { flexDirection: 'row', gap: 8, width: '100%', maxWidth: 640, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#2C3034', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 },
  chipActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: '#A9ADB3', fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#111315' },
  error: { color: '#E9643A', fontSize: 13 },
  list: { width: '100%', maxWidth: 640, flex: 1 },
  listContent: { gap: 12, paddingBottom: 24 },
  row: { borderWidth: 1, borderColor: '#2C3034', borderRadius: 12, padding: 14, gap: 6, backgroundColor: '#1B1E21' },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  rowType: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: 11,
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  rowStatus: { fontSize: 11, color: '#777D84', fontWeight: '600' },
  rowSummary: { color: '#F4F4F2', fontSize: 14, fontWeight: '600' },
  rowDescription: { color: '#A9ADB3', fontSize: 13, fontStyle: 'italic' },
  rowMeta: { color: '#6C7177', fontSize: 11 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  actionButton: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  approveButton: { backgroundColor: ACCENT },
  approveButtonText: { color: '#111315', fontWeight: '700', fontSize: 13 },
  denyButton: { borderWidth: 1, borderColor: '#E9643A' },
  denyButtonText: { color: '#E9643A', fontWeight: '700', fontSize: 13 },
});
