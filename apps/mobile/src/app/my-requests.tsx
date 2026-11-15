import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth-context';
import { API_BASE_URL } from '@/config';
import { type GymRequest } from '@/components/gym-panels';

// My requests: add-gym, update-gym and sweep requests, newest first.
// Chats aren't listed - they're never stored. Styled to match the
// existing profile/admin screens' dark utility-page look.
const STATUS_FILTERS: { value: '' | 'pending' | 'completed' | 'failed'; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

const KIND_LABELS: Record<GymRequest['kind'], string> = {
  add_gym: 'New gym',
  update_gym: 'Gym edit',
  sweep: 'Sweep',
};

function summarize(r: GymRequest): string {
  if (r.status === 'pending') {
    const awaitingAdmin = r.changes.some((c) => c.reviewStatus === 'awaiting_admin');
    return awaitingAdmin ? 'Waiting on an admin to review' : 'Still being checked';
  }
  if (r.status === 'failed') return r.failureReason === 'timed_out' ? 'Timed out' : 'Failed';
  if (r.kind === 'sweep') {
    const result = r.result as { gymsFound?: number; gymsNew?: number } | null;
    return `Found ${result?.gymsFound ?? 0} gym(s), ${result?.gymsNew ?? 0} new`;
  }
  const approved = r.changes.filter((c) => c.reviewStatus === 'approved').length;
  const rejected = r.changes.filter((c) => c.reviewStatus === 'rejected').length;
  if (rejected === 0) return 'Approved';
  if (approved === 0) return `Not approved${r.changes[0]?.reason ? ` — ${r.changes[0].reason}` : ''}`;
  return `${approved} approved, ${rejected} not approved`;
}

export default function MyRequestsScreen() {
  const router = useRouter();
  const { user, loading, authHeaders } = useAuth();
  const [statusFilter, setStatusFilter] = useState<'' | 'pending' | 'completed' | 'failed'>('');
  const [requests, setRequests] = useState<GymRequest[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (cursor?: string) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (cursor) params.set('cursor', cursor);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/me/requests?${params}`, {
        headers: await authHeaders(),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const data = await res.json();
      setRequests((prev) => (cursor ? [...(prev ?? []), ...data.items] : data.items));
      setNextCursor(data.nextCursor ? String(data.nextCursor) : null);
      setError(null);
    } catch (e) {
      console.error('Failed to load my requests', e);
      setError('Failed to load your requests.');
    }
  };

  useEffect(() => {
    if (user) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, statusFilter]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await load(nextCursor);
    setLoadingMore(false);
  };

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/requests/${id}/retry`, {
        method: 'POST',
        headers: await authHeaders(),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Retry failed: ${res.status}`);
      await load();
    } catch (e) {
      console.error('Failed to retry request', e);
      setError('Failed to retry that request.');
    } finally {
      setRetrying(null);
    }
  };

  if (loading) return <View style={styles.container} />;

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Sign in to view your requests.</Text>
        <Pressable style={styles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={styles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My requests</Text>
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
        <Pressable style={styles.refreshButton} onPress={() => load()}>
          <Text style={styles.refreshButtonText}>↻ Refresh</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {requests?.length === 0 && <Text style={styles.subtitle}>No requests match these filters.</Text>}
        {requests?.map((r) => (
          <View key={r.id} style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowType}>{KIND_LABELS[r.kind]}</Text>
              <Text style={[styles.rowStatus, r.status === 'failed' && styles.rowStatusFailed, r.status === 'completed' && styles.rowStatusCompleted]}>
                {r.status}
              </Text>
            </View>
            {r.gymName && <Text style={styles.rowGymName}>{r.gymName}</Text>}
            <Text style={styles.rowSummary}>{summarize(r)}</Text>
            <Text style={styles.rowMeta}>{new Date(r.createdAt).toLocaleString()}</Text>
            {r.status === 'failed' && (
              <Pressable style={styles.retryButton} disabled={retrying === r.id} onPress={() => retry(r.id)}>
                <Text style={styles.retryButtonText}>{retrying === r.id ? 'Retrying…' : 'Retry'}</Text>
              </Pressable>
            )}
          </View>
        ))}
        {nextCursor && (
          <Pressable style={styles.loadMoreButton} disabled={loadingMore} onPress={loadMore}>
            <Text style={styles.loadMoreButtonText}>{loadingMore ? 'Loading…' : 'Load more'}</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const ACCENT = '#CEFF45';
const BG = '#111315';
const TEXT = '#F4F4F2';
const TEXT_MUTED = '#A9ADB3';
const TEXT_DIM = '#777D84';
const ERROR = '#E9643A';
const BORDER = '#2C3034';
const FONT_SIZE_TINY = 11;
const FONT_SIZE_BODY = 13;
const FONT_WEIGHT_SEMIBOLD = '600';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, padding: 24, gap: 14, alignItems: 'center' },
  title: { fontFamily: 'Archivo, sans-serif', fontWeight: '900', fontSize: 26, color: TEXT, width: '100%', maxWidth: 640 },
  subtitle: { fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: FONT_SIZE_BODY, color: TEXT_MUTED },
  submitButton: { backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20 },
  submitButtonText: { color: BG, fontWeight: '700', fontSize: 14 },
  filterRow: { flexDirection: 'row', gap: 8, width: '100%', maxWidth: 640, flexWrap: 'wrap', alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: BORDER, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 },
  chipActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: TEXT_MUTED, fontSize: 12, fontWeight: FONT_WEIGHT_SEMIBOLD },
  chipTextActive: { color: BG },
  refreshButton: { marginLeft: 'auto', paddingHorizontal: 8, paddingVertical: 7 },
  refreshButtonText: { color: ACCENT, fontSize: 12, fontWeight: FONT_WEIGHT_SEMIBOLD },
  error: { color: ERROR, fontSize: FONT_SIZE_BODY },
  list: { width: '100%', maxWidth: 640, flex: 1 },
  listContent: { gap: 12, paddingBottom: 24 },
  row: { borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 14, gap: 6, backgroundColor: '#1B1E21' },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  rowType: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: FONT_SIZE_TINY,
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  rowStatus: { fontSize: FONT_SIZE_TINY, color: TEXT_DIM, fontWeight: FONT_WEIGHT_SEMIBOLD, textTransform: 'uppercase' },
  rowStatusFailed: { color: ERROR },
  rowStatusCompleted: { color: ACCENT },
  rowGymName: { color: TEXT, fontSize: 16, fontWeight: '700' },
  rowSummary: { color: TEXT, fontSize: 14, fontWeight: FONT_WEIGHT_SEMIBOLD },
  rowMeta: { color: '#6C7177', fontSize: FONT_SIZE_TINY },
  retryButton: { alignSelf: 'flex-start', marginTop: 6, borderWidth: 1, borderColor: ACCENT, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  retryButtonText: { color: ACCENT, fontWeight: '700', fontSize: FONT_SIZE_BODY },
  loadMoreButton: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 20 },
  loadMoreButtonText: { color: ACCENT, fontSize: FONT_SIZE_BODY, fontWeight: FONT_WEIGHT_SEMIBOLD },
});
