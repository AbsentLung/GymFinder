import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, TextInput, View, ScrollView } from 'react-native';

import { API_BASE_URL } from '@/config';
import { useAuth } from '@/auth-context';

// Shared by both platforms' map screens - plain RN primitives, no
// DOM/window dependency, so one fix here covers chat/reviews/edit/add-gym
// on native and web alike.

// The tile-shape gym (GET /v1/tiles/{geohash4}) - lightweight: truncated
// description, no trial/openingHours text, only the day-pass price
// (week/month show up once full details load - see GymDetails).
export interface DayPass {
  amountMinor: number;
  currency: string;
  usdCents: number;
  verified: boolean;
}

export interface Gym {
  id: number;
  name: string;
  lat: number;
  lng: number;
  rating: number | null;
  description: string | null;
  address: string | null;
  categories: string[];
  acceptsDropIn: boolean | null;
  hasTrial: boolean | null;
  dayPass: DayPass | null;
}

export interface PriceEntry {
  kind: 'day_pass' | 'week_pass' | 'month_pass';
  amountMinor: number;
  currency: string;
  usdCents: number;
  sourceKind: string;
  sourceUrl: string | null;
  verifiedBy: string | null;
  lastSeenAt: string;
}

// The full-details shape (API.md 2.3, GET /v1/gyms/{id}) - fetched once
// a specific gym's panel actually opens, not for every pin on the map.
export interface GymDetails extends Gym {
  // available is null, not coerced to false, when nothing's known yet -
  // "we don't know" and "confirmed no trial" are different facts (see
  // TrialSection below).
  trial: { available: boolean | null; details: string | null };
  openingHours: string | null;
  prices: PriceEntry[];
  reviewCount: number;
  status: string;
  updatedAt: string;
}

export interface NewGymLocation {
  lat: number;
  lng: number;
}

export interface GymRequest {
  id: string;
  kind: 'add_gym' | 'update_gym' | 'sweep';
  status: 'pending' | 'completed' | 'failed';
  createdAt: string;
  deadline: string;
  result: Record<string, unknown> | null;
  failureReason: string | null;
  changes: { id: string; reviewStatus: 'pending_bot' | 'awaiting_admin' | 'approved' | 'rejected'; reason: string | null }[];
}

// Add-gym/edit-request are async now (202 + poll) since bot review
// actually searches the web. Fixed-interval, no backoff - fine while the
// user's actively watching this form.
const REQUEST_POLL_MS = 2000;
const REQUEST_POLL_TIMEOUT_MS = 60000;

export async function pollRequest(
  requestId: string,
  authHeaders: () => Promise<Record<string, string>>
): Promise<GymRequest> {
  const startedAt = Date.now();
  while (true) {
    const res = await fetch(`${API_BASE_URL}/v1/requests/${requestId}`, {
      headers: await authHeaders(),
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    const request: GymRequest = await res.json();
    if (request.status !== 'pending' || Date.now() - startedAt > REQUEST_POLL_TIMEOUT_MS) return request;
    await new Promise((resolve) => setTimeout(resolve, REQUEST_POLL_MS));
  }
}

// Shared search filter - matches name, description, address, categories.
// Plain substring match, not fuzzy/ranked: this just decides which
// markers show on screen.
export function gymMatchesSearch(gym: Gym, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const haystack = [gym.name, gym.description, gym.address, ...gym.categories].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

// Mirrors GYM_CATEGORIES in apps/server/src/lib.ts. A gym can have several.
export const GYM_CATEGORIES = [
  'Traditional', 'Group', 'Yoga', 'Bouldering', 'Swimming', 'Luxury', 'MMA', '24hr', 'Outdoor', 'Sports',
  'CrossFit', 'Hyrox', 'HIIT', 'Personal Trainer', 'Pilates',
];

// Stands in for `categories.length === 0` in the category filter UI -
// never a real category value.
export const UNKNOWN_CATEGORY = '__unknown__';

// Manual symbol/decimals table - Intl.NumberFormat's currency style needs
// full ICU data this app's Hermes bundle doesn't reliably ship.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', THB: '฿', IDR: 'Rp', VND: '₫', PHP: '₱', MYR: 'RM', SGD: 'S$',
  JPY: '¥', KRW: '₩', CNY: '¥', INR: '₹', EUR: '€', GBP: '£', AUD: 'A$',
  NZD: 'NZ$', KHR: '៛', LAK: '₭', MMK: 'K',
};

// Mirrors apps/server/src/lib.ts's ZERO_DECIMAL_CURRENCIES/
// amountMinorToMajor - duplicated, no shared package wired up yet.
const ZERO_DECIMAL_CURRENCIES = new Set(['IDR', 'JPY', 'KRW', 'VND', 'KHR', 'LAK', 'MMK']);
function amountMinorToMajor(amountMinor: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? amountMinor : amountMinor / 100;
}

// Decimals only shown where a single unit is worth real money - driven
// off the price's own usdCents, not a hardcoded currency list.
const MIN_UNIT_VALUE_USD_FOR_DECIMALS = 0.2;

export function formatPrice(price: { amountMinor: number; currency: string; usdCents: number } | null | undefined): string | null {
  if (!price) return null;
  const amountMajor = amountMinorToMajor(price.amountMinor, price.currency);
  const symbol = CURRENCY_SYMBOLS[price.currency] ?? `${price.currency} `;
  const unitValueUsd = amountMajor > 0 ? price.usdCents / 100 / amountMajor : 0;
  const decimals = unitValueUsd >= MIN_UNIT_VALUE_USD_FOR_DECIMALS ? 2 : 0;
  return `${symbol}${amountMajor.toFixed(decimals)}`;
}

// Derived: a day-pass (or any loaded) price implies drop-ins are
// accepted. acceptsDropIn is an explicit override; most gyms are NULL,
// meaning "use this derived guess." No price means "not known," never
// "no."
export function acceptsDropIn(gym: { acceptsDropIn: boolean | null; dayPass: DayPass | null; prices?: PriceEntry[] }): boolean {
  if (gym.acceptsDropIn != null) return gym.acceptsDropIn;
  if (gym.dayPass != null) return true;
  return (gym.prices ?? []).length > 0;
}

// DayPass.verified (precomputed boolean) and PriceEntry.verifiedBy
// (raw "bot" | "admin" | null) carry the same fact under different
// names - one place to check either shape.
export function isPriceVerified(price: DayPass | PriceEntry): boolean {
  return 'verified' in price ? price.verified : price.verifiedBy != null;
}

export function TrialSection({ gym }: { gym: GymDetails }) {
  const [expanded, setExpanded] = useState(false);
  // null = never researched - hide the row entirely.
  if (gym.trial.available == null) return null;
  return (
    <View style={panelStyles.panelRow}>
      <Pressable style={panelStyles.sectionHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={panelStyles.panelLabel}>Trial</Text>
        <View style={panelStyles.sectionHeaderRight}>
          <Text style={panelStyles.panelValue}>{gym.trial.available ? 'Available' : 'No trial'}</Text>
          <Text style={panelStyles.sectionChevron}>{expanded ? '▾' : '▸'}</Text>
        </View>
      </Pressable>
      {expanded && gym.trial.available && <Text style={panelStyles.panelValue}>{gym.trial.details || 'No details provided'}</Text>}
    </View>
  );
}

interface Review {
  id: string;
  userName: string | null;
  rating: number;
  body: string | null;
  createdAt: string;
  isMine: boolean;
}

const RATINGS = [1, 2, 3, 4, 5];

// One review per signed-in user per gym (API.md decision #9) - POST
// uses the signed-in user's name; PUT .../reviews/mine is the Edit button.
export function ReviewsSection({ gym }: { gym: Gym }) {
  const { user, authHeaders } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);

  const loadReviews = () => {
    fetch(`${API_BASE_URL}/v1/gyms/${gym.id}/reviews`, { cache: 'no-store', credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setReviews(data.items))
      .catch((e) => console.error('Failed to load reviews', e));
  };

  useEffect(loadReviews, [gym.id]);

  const myReview = reviews.find((r) => r.isMine);

  const submit = async () => {
    if (rating === 0 || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/gyms/${gym.id}/reviews${myReview ? '/mine' : ''}`, {
        method: myReview ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ rating, body: body.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`Post review failed: ${res.status}`);
      setRating(0);
      setBody('');
      setEditing(false);
      loadReviews();
    } catch (e) {
      console.error('Failed to submit review', e);
    } finally {
      setSubmitting(false);
    }
  };

  const startEditing = () => {
    if (!myReview) return;
    setRating(myReview.rating);
    setBody(myReview.body ?? '');
    setEditing(true);
  };

  return (
    <View style={panelStyles.panelRow}>
      <Pressable style={panelStyles.sectionHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={panelStyles.panelLabel}>Reviews ({reviews.length})</Text>
        <Text style={panelStyles.sectionChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded && (
        <>
          {!user && <Text style={panelStyles.panelValue}>Sign in to leave a review.</Text>}

          {user && myReview && !editing && (
            <View style={panelStyles.reviewForm}>
              <View style={panelStyles.reviewCardHeader}>
                <Text style={panelStyles.reviewStars}>{'★'.repeat(myReview.rating)}</Text>
                <Pressable onPress={startEditing}>
                  <Text style={panelStyles.editLink}>Edit</Text>
                </Pressable>
              </View>
              {myReview.body && <Text style={panelStyles.panelValue}>{myReview.body}</Text>}
            </View>
          )}

          {user && (!myReview || editing) && (
            <View style={panelStyles.reviewForm}>
              <View style={panelStyles.ratingPicker}>
                {RATINGS.map((n) => (
                  <Pressable key={n} style={panelStyles.starHit} onPress={() => setRating(n)}>
                    <Text style={[panelStyles.star, n <= rating && panelStyles.starFilled]}>★</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={[panelStyles.input, panelStyles.textarea]}
                placeholder="How was it?"
                placeholderTextColor={PLACEHOLDER_COLOR}
                value={body}
                onChangeText={setBody}
                multiline
              />
              <Pressable style={[panelStyles.submitButton, (submitting || rating === 0) && panelStyles.submitButtonDisabled]} onPress={submit}>
                <Text style={panelStyles.submitButtonText}>{submitting ? 'Posting…' : myReview ? 'Save changes' : 'Post review'}</Text>
              </Pressable>
            </View>
          )}

          {reviews.length === 0 ? (
            <Text style={panelStyles.panelValue}>No reviews yet — be the first.</Text>
          ) : (
            reviews
              .filter((r) => !r.isMine)
              .map((review) => (
                <View key={review.id} style={panelStyles.reviewCard}>
                  <View style={panelStyles.reviewCardHeader}>
                    <Text style={panelStyles.reviewAuthor}>{review.userName ?? 'Anonymous'}</Text>
                    <Text style={panelStyles.reviewStars}>{'★'.repeat(review.rating)}</Text>
                  </View>
                  {review.body && <Text style={panelStyles.panelValue}>{review.body}</Text>}
                </View>
              ))
          )}
        </>
      )}
    </View>
  );
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

// Per-gym chat history, module-level (not component state) so it
// survives the panel closing/reopening but vanishes when the app closes
// - no database storage, per explicit request.
const chatHistoryCache = new Map<number, ChatMessage[]>();
const CHAT_POLL_MS = 1000;
const CHAT_POLL_TIMEOUT_MS = 30000;

// Async (202 + poll GET /v1/chats/{chatId}). A fact the bot finds along
// the way doesn't update this gym live - it becomes a gym_changes row
// through the normal bot-review/admin pipeline (FR-9). Expanded by
// default, unlike Trial/Reviews above.
export function ChatSection({ gym }: { gym: Pick<Gym, 'id'> }) {
  const [expanded, setExpanded] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatHistoryCache.get(gym.id) ?? []);
  useEffect(() => {
    chatHistoryCache.set(gym.id, messages);
  }, [gym.id, messages]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!input.trim() || sending) return;
    const question = input.trim();
    const userMessage: ChatMessage = { role: 'user', text: question };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/gyms/${gym.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: messages.slice(-6) }),
      });
      if (!res.ok) throw new Error(`Chat request failed: ${res.status}`);
      const { chatId } = await res.json();

      const startedAt = Date.now();
      let answerText = "Sorry, I couldn't answer that just now — try again?";
      while (Date.now() - startedAt < CHAT_POLL_TIMEOUT_MS) {
        const pollRes = await fetch(`${API_BASE_URL}/v1/chats/${chatId}`);
        const data = await pollRes.json();
        if (data.status === 'answered') {
          answerText = data.answer;
          break;
        }
        if (data.status === 'failed' || data.status === 'expired') break;
        await new Promise((resolve) => setTimeout(resolve, CHAT_POLL_MS));
      }
      setMessages([...nextMessages, { role: 'assistant', text: answerText }]);
    } catch (e) {
      console.error('Chat failed', e);
      setMessages([...nextMessages, { role: 'assistant', text: "Sorry, I couldn't answer that just now — try again?" }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={panelStyles.panelRow}>
      <Pressable style={panelStyles.sectionHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={panelStyles.panelLabel}>Ask me questions about this gym</Text>
        <Text style={panelStyles.sectionChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded && (
        <View style={panelStyles.chatBox}>
          {messages.map((m, i) => (
            <View key={i} style={[panelStyles.chatBubble, m.role === 'user' ? panelStyles.chatBubbleUser : panelStyles.chatBubbleAssistant]}>
              <Text style={m.role === 'user' ? panelStyles.chatBubbleUserText : panelStyles.chatBubbleAssistantText}>{m.text}</Text>
            </View>
          ))}
          {sending && <Text style={panelStyles.panelValue}>Thinking…</Text>}
          <View style={panelStyles.chatInputRow}>
            <TextInput
              style={[panelStyles.input, panelStyles.chatInput, panelStyles.chatInputLarge]}
              value={input}
              onChangeText={setInput}
              placeholder="Ask about pricing, trials, hours, or anything else that isn't display here. Our bot will do the research for you."
              placeholderTextColor={PLACEHOLDER_COLOR}
              multiline
              onSubmitEditing={send}
              // onSubmitEditing doesn't fire on web's <textarea>; plain
              // Enter submits here instead, Shift+Enter still newlines.
              onKeyPress={(e) => {
                const { key, shiftKey } = e.nativeEvent as unknown as { key?: string; shiftKey?: boolean };
                if (key === 'Enter' && !shiftKey) {
                  (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                  send();
                }
              }}
            />
            <Pressable
              style={[panelStyles.submitButton, panelStyles.chatSendButton, (sending || !input.trim()) && panelStyles.submitButtonDisabled]}
              onPress={send}
            >
              <Text style={panelStyles.submitButtonText}>Send</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

// Deliberately minimal: only name is collected here. Address/description
// get filled in by the bot from Google's listing; everything else
// arrives later through an edit request.
export function SubmitGymForm({
  location,
  onSubmitted,
  onClose,
}: {
  location: NewGymLocation;
  onSubmitted: (newGym: Gym | null) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { user, authHeaders } = useAuth();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ approved: boolean; reason: string | null } | null>(null);

  if (!user) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelValue}>Sign in to add a gym.</Text>
        <Pressable style={panelStyles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={panelStyles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  const submit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/gyms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ name, lat: location.lat, lng: location.lng, categories: [] }),
      });
      if (!res.ok) throw new Error(`Submit gym failed: ${res.status}`);
      const created: GymRequest = await res.json();
      const final = await pollRequest(created.id, authHeaders);
      const change = final.changes[0];
      setResult({ approved: change?.reviewStatus === 'approved', reason: change?.reason ?? null });
      // No optimistic gym object - the server doesn't return a gym id
      // for add-gym (API.md 2.4). Next tile fetch picks it up if approved.
      onSubmitted(null);
    } catch (e) {
      console.error('Failed to submit gym', e);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Submitted</Text>
        {result.approved ? (
          <Text style={panelStyles.panelValue}>
            Your gym is <Text style={{ fontWeight: '700' }}>live now</Text> — it checked out automatically.
          </Text>
        ) : (
          <Text style={panelStyles.panelValue}>
            This gym is now <Text style={{ fontWeight: '700' }}>awaiting admin review</Text>
            {result.reason ? ` (${result.reason})` : ''}. That can take a few days.
          </Text>
        )}
        <Pressable style={panelStyles.submitButton} onPress={onClose}>
          <Text style={panelStyles.submitButtonText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={panelStyles.panelScroll} contentContainerStyle={panelStyles.panelScrollContent}>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Location</Text>
        <Text style={panelStyles.panelValue}>
          {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
        </Text>
      </View>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Gym name</Text>
        <TextInput style={panelStyles.input} value={name} onChangeText={setName} />
      </View>
      <Pressable style={[panelStyles.submitButton, (submitting || !name.trim()) && panelStyles.submitButtonDisabled]} onPress={submit}>
        <Text style={panelStyles.submitButtonText}>{submitting ? 'Submitting…' : 'Submit gym'}</Text>
      </Pressable>
    </ScrollView>
  );
}

// Mirrors apps/server/src/jobs/bot-review.ts's NON_PRICE_FIELDS plus the
// three price kinds. "name"/"status" aren't offered (no new UI surface);
// trial DETAILS text isn't either - only the hasTrial boolean is in the
// server's field whitelist.
export const EDITABLE_FIELDS: { key: string; label: string; kind: 'price' | 'text' | 'category' | 'boolean' }[] = [
  { key: 'day_pass', label: 'Day pass price (USD)', kind: 'price' },
  { key: 'week_pass', label: 'Week pass price (USD)', kind: 'price' },
  { key: 'month_pass', label: 'Month pass price (USD)', kind: 'price' },
  { key: 'description', label: 'Description', kind: 'text' },
  { key: 'address', label: 'Address', kind: 'text' },
  { key: 'categories', label: 'Categories', kind: 'category' },
  { key: 'acceptsDropIn', label: 'Accepts drop-ins', kind: 'boolean' },
  { key: 'hasTrial', label: 'Offers a trial', kind: 'boolean' },
];

export function SuggestEditForm({
  gym,
  onDone,
  onCancel,
}: {
  gym: GymDetails;
  onDone: (updatedGym: Gym | null) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const { user, authHeaders } = useAuth();
  const [fieldKey, setFieldKey] = useState(EDITABLE_FIELDS[0].key);
  const [value, setValue] = useState('');
  // categories submits a whole replacement SET, not an add-one-tag merge
  // - pre-populate with current categories or an edit would wipe the rest.
  const [selectedCategories, setSelectedCategories] = useState<string[]>(gym.categories);
  const [boolValue, setBoolValue] = useState(true);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ approved: boolean; reason: string | null } | null>(null);

  if (!user) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelValue}>Sign in to suggest an edit.</Text>
        <Pressable style={panelStyles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={panelStyles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  const field = EDITABLE_FIELDS.find((f) => f.key === fieldKey)!;
  const isPriceField = field.kind === 'price';

  const canSubmit =
    !submitting &&
    description.trim().length > 0 &&
    (field.kind === 'category' || field.kind === 'boolean' || value.trim().length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    let newValue: unknown;
    if (isPriceField) {
      const amountMinor = Math.round(parseFloat(value) * 100);
      if (!Number.isFinite(amountMinor)) return;
      newValue = { amountMinor, currency: 'USD', sourceKind: 'user' };
    } else if (field.kind === 'category') {
      newValue = selectedCategories;
    } else if (field.kind === 'boolean') {
      newValue = boolValue;
    } else {
      newValue = value;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/gyms/${gym.id}/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ field: field.key, newValue, description }),
      });
      if (!res.ok) throw new Error(`Edit request failed: ${res.status}`);
      const created: GymRequest = await res.json();
      const final = await pollRequest(created.id, authHeaders);
      const change = final.changes[0];
      const approved = change?.reviewStatus === 'approved';
      setResult({ approved, reason: change?.reason ?? null });
      onDone(null); // the next tile/details fetch picks up the real change, same as SubmitGymForm.
    } catch (e) {
      console.error('Failed to submit edit request', e);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Submitted</Text>
        {result.approved ? (
          <Text style={panelStyles.panelValue}>
            Confirmed — <Text style={{ fontWeight: '700' }}>{field.label}</Text> updated right away.
          </Text>
        ) : (
          <Text style={panelStyles.panelValue}>
            This edit is now <Text style={{ fontWeight: '700' }}>awaiting admin review</Text>
            {result.reason ? ` (${result.reason})` : ''}.
          </Text>
        )}
        <Pressable style={panelStyles.submitButton} onPress={onCancel}>
          <Text style={panelStyles.submitButtonText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={panelStyles.panelScroll} contentContainerStyle={panelStyles.panelScrollContent}>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Field</Text>
        <View style={panelStyles.editFieldPicker}>
          {EDITABLE_FIELDS.map((f) => (
            <Pressable
              key={f.key}
              style={[panelStyles.editFieldChip, fieldKey === f.key && panelStyles.editFieldChipActive]}
              onPress={() => {
                setFieldKey(f.key);
                setValue('');
              }}
            >
              <Text style={[panelStyles.editFieldChipText, fieldKey === f.key && panelStyles.editFieldChipTextActive]}>{f.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>New value</Text>
        {field.kind === 'category' ? (
          <View style={panelStyles.editFieldPicker}>
            {GYM_CATEGORIES.map((cat) => {
              const active = selectedCategories.includes(cat);
              return (
                <Pressable
                  key={cat}
                  style={[panelStyles.editFieldChip, active && panelStyles.editFieldChipActive]}
                  onPress={() =>
                    setSelectedCategories((prev) => (active ? prev.filter((c) => c !== cat) : [...prev, cat]))
                  }
                >
                  <Text style={[panelStyles.editFieldChipText, active && panelStyles.editFieldChipTextActive]}>{cat}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : field.kind === 'boolean' ? (
          <View style={panelStyles.editFieldPicker}>
            {[
              { label: 'Yes', val: true },
              { label: 'No', val: false },
            ].map((opt) => (
              <Pressable
                key={opt.label}
                style={[panelStyles.editFieldChip, boolValue === opt.val && panelStyles.editFieldChipActive]}
                onPress={() => setBoolValue(opt.val)}
              >
                <Text style={[panelStyles.editFieldChipText, boolValue === opt.val && panelStyles.editFieldChipTextActive]}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <TextInput
            style={panelStyles.input}
            value={value}
            onChangeText={setValue}
            keyboardType={field.kind === 'text' ? 'default' : 'numeric'}
            placeholder={field.kind === 'price' ? 'e.g. 12.00' : undefined}
          />
        )}
      </View>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Description</Text>
        <TextInput
          style={[panelStyles.input, panelStyles.textarea]}
          value={description}
          onChangeText={setDescription}
          placeholder="How do you know this?"
          multiline
          numberOfLines={3}
        />
      </View>
      <Pressable style={[panelStyles.submitButton, !canSubmit && panelStyles.submitButtonDisabled]} onPress={submit}>
        <Text style={panelStyles.submitButtonText}>{submitting ? 'Submitting…' : 'Submit edit'}</Text>
      </Pressable>
    </ScrollView>
  );
}

// Shared visual language for the detail panel - used both by the
// components above and directly by each platform's MapScreen. cursor is
// harmless on native (RN ignores unrecognized style keys).
const ACCENT = '#146C5F';
const TEXT = '#1C2430';
const TEXT_MUTED = '#8A94A0';
const TEXT_DIM = '#5B6470';
const BORDER = '#DDE2E6';
const GOLD = '#E0A500';
const BG_MUTED = '#F7F8F9';
export const PLACEHOLDER_COLOR = '#9AA3AB';

export const panelStyles = StyleSheet.create({
  panelScroll: { flex: 1 },
  panelScrollContent: { padding: 20, gap: 20 },
  panelRow: { gap: 8 },
  panelLabel: { fontSize: 11, fontWeight: '600', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 0.5 },
  panelValue: { fontSize: 14, color: TEXT, lineHeight: 20 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  sectionChevron: { fontSize: 12, color: TEXT_MUTED },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewForm: {
    gap: 8,
    backgroundColor: BG_MUTED,
    borderRadius: 10,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: 'white',
  },
  textarea: { minHeight: 60, textAlignVertical: 'top' },
  ratingPicker: { flexDirection: 'row', gap: 2 },
  // @ts-expect-error - web-only cursor hint, fine for the demo
  starHit: { cursor: 'pointer', padding: 2 },
  star: { fontSize: 18, color: '#D7DBDF' },
  starFilled: { color: GOLD },
  editLink: { color: ACCENT, fontSize: 12, fontWeight: '700' },
  submitButton: {
    backgroundColor: ACCENT,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitButtonText: { color: 'white', fontWeight: '600', fontSize: 13 },
  reviewCard: {
    gap: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EFEFEF',
  },
  reviewCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewAuthor: { fontSize: 13, fontWeight: '700', color: TEXT },
  reviewStars: { fontSize: 12, color: GOLD },
  chatBox: { gap: 8 },
  chatBubble: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%' },
  chatBubbleUser: { backgroundColor: ACCENT, alignSelf: 'flex-end' },
  chatBubbleAssistant: { backgroundColor: BG_MUTED, alignSelf: 'flex-start' },
  chatBubbleUserText: { color: 'white', fontSize: 13, lineHeight: 18 },
  chatBubbleAssistantText: { color: TEXT, fontSize: 13, lineHeight: 18 },
  chatInputRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  chatInput: { flex: 1 },
  chatInputLarge: { minHeight: 72, textAlignVertical: 'top' },
  chatSendButton: { paddingHorizontal: 16 },
  editFieldPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  editFieldChip: { borderWidth: 1, borderColor: BORDER, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  editFieldChipActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  editFieldChipText: { fontSize: 12, color: TEXT_DIM, fontWeight: '600' },
  editFieldChipTextActive: { color: 'white' },
});
