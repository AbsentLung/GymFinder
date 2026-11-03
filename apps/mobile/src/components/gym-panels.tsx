import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, TextInput, View, ScrollView } from 'react-native';

import { API_BASE_URL } from '@/config';
import { useAuth } from '@/auth-context';

// Shared between gym-map-screen.web.tsx (Leaflet) and gym-map-screen.tsx
// (a WebView wrapping the same Leaflet map, for native) - everything here
// is plain React Native primitives (View/Text/Pressable/TextInput/
// ScrollView) with no DOM/window dependency, so it was always safe to run
// on native; it just used to live inside the web-only file by accident of
// where the map screen was first built. Splitting it out means the chat/
// reviews/edit/add-gym features don't need a second, parallel
// implementation for native - one real bug fix here fixes both platforms.

// The tile-shape gym (API.md 2.2, GET /v1/tiles/{geohash4}) - what the map
// has for every pin on screen. Deliberately lightweight: description is
// truncated, there's no trial/openingHours/amenities text, and only the
// day-pass price is included (week/month only show up once a gym's full
// details are fetched - see GymDetails below). osm_id, week/month pass
// price, suggested-price and trial-day-count fields from the old demo's
// Gym type don't exist in the new API at all; dropped rather than kept
// as always-null placeholders.
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

// Add-gym and edit-request are both async now (202 + poll), not the old
// demo's synchronous "scrape and decide in this one HTTP call" - bot
// review genuinely searches the web, which isn't instant. Short,
// fixed-interval polling (no backoff) is fine here: these requests
// almost always resolve in single-digit seconds against a real LLM, and
// a form the user is actively watching isn't the same cost/patience
// tradeoff as a background "My requests" list poll would be.
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

// Live map-search filter, shared so both platforms match on the exact
// same fields - name, description, address, and categories, not just
// name, per explicit request. Plain case-insensitive substring, not a
// fuzzy/ranked search: this filters which markers are even on screen,
// so "obviously matches or doesn't" beats a relevance score here.
export function gymMatchesSearch(gym: Gym, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const haystack = [gym.name, gym.description, gym.address, ...gym.categories].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

// Mirrors GYM_CATEGORIES in apps/server/src/lib.ts exactly - a fixed,
// generic list rather than whatever free-text phrase a scrape happened
// to produce, per explicit request. A gym can have several at once, not
// just one.
export const GYM_CATEGORIES = [
  'Traditional', 'Group', 'Yoga', 'Bouldering', 'Swimming', 'Luxury', 'MMA', '24hr', 'Outdoor', 'Sports',
  'CrossFit', 'Hyrox', 'HIIT', 'Personal Trainer', 'Pilates',
];

// A gym with zero categories on file still needs to be representable as
// one of the category filter's own checkboxes - this stands in for
// `categories.length === 0` there, never a real category value.
export const UNKNOWN_CATEGORY = '__unknown__';

// Manual symbol/decimals table, not Intl.NumberFormat's style: 'currency'
// - that depends on the JS engine shipping full ICU currency data, and
// this app's web bundle runs on Hermes, which doesn't reliably support
// that for less-common codes.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', THB: '฿', IDR: 'Rp', VND: '₫', PHP: '₱', MYR: 'RM', SGD: 'S$',
  JPY: '¥', KRW: '₩', CNY: '¥', INR: '₹', EUR: '€', GBP: '£', AUD: 'A$',
  NZD: 'NZ$', KHR: '៛', LAK: '₭', MMK: 'K',
};

// Mirrors apps/server/src/lib.ts's ZERO_DECIMAL_CURRENCIES/
// amountMinorToMajor exactly (confirmed there against a real API.md
// example: 150000 IDR amountMinor -> 950 usdCents only works out to a
// realistic price if 150000 IS the whole-Rupiah amount, not IDR-cents).
// Not shared cross-package (no packages/shared plumbing exists for
// this yet) - duplicated rather than standing up that wiring for one
// small, already-proven-correct pure function.
const ZERO_DECIMAL_CURRENCIES = new Set(['IDR', 'JPY', 'KRW', 'VND', 'KHR', 'LAK', 'MMK']);
function amountMinorToMajor(amountMinor: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? amountMinor : amountMinor / 100;
}

// Flipped from "most currencies get 2 decimals, a few exceptions get 0"
// to "most get 0, decimals only survive where a single unit is worth
// real money" - gym prices in THB/IDR/etc. are never actually quoted
// down to a fractional unit, decimals there read as fake precision, not
// accuracy. Driven off the price's own usdCents (no separate FX fetch
// needed anymore - the server already returns each price in its own
// real local currency, API.md 2.2/2.3), not a hardcoded currency list,
// so any currency qualifies the same way: 1 unit has to be worth at
// least 20 cents USD for a decimal of it to mean anything for a gym
// day-pass price.
const MIN_UNIT_VALUE_USD_FOR_DECIMALS = 0.2;

export function formatPrice(price: { amountMinor: number; currency: string; usdCents: number } | null | undefined): string | null {
  if (!price) return null;
  const amountMajor = amountMinorToMajor(price.amountMinor, price.currency);
  const symbol = CURRENCY_SYMBOLS[price.currency] ?? `${price.currency} `;
  const unitValueUsd = amountMajor > 0 ? price.usdCents / 100 / amountMajor : 0;
  const decimals = unitValueUsd >= MIN_UNIT_VALUE_USD_FOR_DECIMALS ? 2 : 0;
  return `${symbol}${amountMajor.toFixed(decimals)}`;
}

// Derived, not a stored field on the tile shape: a day-pass price
// implies drop-ins are accepted. This loses the ability to say
// "confirmed yes, price unknown" as distinct from "unknown either way"
// - a deliberate tradeoff, not an oversight. No price means "not
// known," never "no." acceptsDropIn is an explicit override, not the
// default - most gyms are NULL here, meaning "use the derived
// assumption below." `prices` (only present once a gym's full details
// are loaded - GymDetails, not the tile-level Gym) restores the old
// demo's week/month-pass-also-counts behavior when it's available;
// falls back to just dayPass on the map's tile-level pins.
export function acceptsDropIn(gym: { acceptsDropIn: boolean | null; dayPass: DayPass | null; prices?: PriceEntry[] }): boolean {
  if (gym.acceptsDropIn != null) return gym.acceptsDropIn;
  if (gym.dayPass != null) return true;
  return (gym.prices ?? []).length > 0;
}

// DayPass (the tile shape) and PriceEntry (the full-details shape)
// carry the same "verified or not" fact under different names -
// DayPass.verified is already a boolean the tiles route computed
// server-side, PriceEntry.verifiedBy is the raw "bot" | "admin" | null.
// One place to check, since the detail panel reads week/month pass
// from `prices` but day pass from either shape depending on whether
// full details have loaded yet.
export function isPriceVerified(price: DayPass | PriceEntry): boolean {
  return 'verified' in price ? price.verified : price.verifiedBy != null;
}

export function TrialSection({ gym }: { gym: GymDetails }) {
  const [expanded, setExpanded] = useState(false);
  // null = never researched - hide the row entirely, same as the old
  // demo's trial_days == null case. Unlike that version, there's no
  // numeric day-count in the new schema (gyms.has_trial is a plain
  // boolean, not a day count) - a deliberate simplification, disclosed
  // rather than silently dropped.
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

// One review per signed-in user per gym now (API.md decision #9) - no
// more free-text "author" name; POST uses the signed-in user's own
// name, and PUT .../reviews/mine is the new "Edit" button this adds
// for the reviewer's own review.
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
                placeholderTextColor="#9AA3AB"
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

// Per-gym chat history, kept only for this JS session - module-level, not
// component state, specifically so it survives the panel closing and
// reopening (ChatSection remounts fresh each time via its `key` prop) but
// vanishes the moment the app itself closes, per explicit request: "keep
// it in memory until they close the app, no hard database storing."
const chatHistoryCache = new Map<number, ChatMessage[]>();
const CHAT_POLL_MS = 1000;
const CHAT_POLL_TIMEOUT_MS = 30000;

// Answers are grounded server-side in whatever's actually on file for
// this gym (description, pricing, reviews), plus live web research the
// server triggers when something's still missing - the model's told to
// say it doesn't know rather than guess at anything not covered
// otherwise. Async now (202 + poll GET /v1/chats/{chatId}), not the old
// demo's synchronous reply - and a fact the bot finds along the way no
// longer updates this gym's visible info immediately the way the old
// demo's onGymUpdated did: it becomes a gym_changes row and goes
// through the same bot-review/admin pipeline as every other source
// (FR-9), so it genuinely isn't live yet by the time an answer comes
// back. Expanded by default, unlike Trial/Reviews above - this is the
// thing most worth a traveler's immediate attention.
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
              placeholderTextColor="#9AA3AB"
              multiline
              onSubmitEditing={send}
              // onSubmitEditing above never actually fires on web - RN
              // Web's multiline TextInput renders a real <textarea>, where
              // Enter just inserts a newline like any textarea. Shift+Enter
              // still does that; plain Enter submits instead. Native
              // TextInput does fire onSubmitEditing normally, so this
              // listener is harmless there (web-only nativeEvent shape).
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

// Deliberately minimal: only the name is ever collected here. Address and
// description get filled in by the bot from Google's own listing once it
// confirms a match. Everything else - pricing, trial, drop-in - only
// arrives later through an edit request, not at creation.
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
      // Merge the new pin into live state the moment we know about it -
      // not deferred until the user clicks a specific "Done" button. The
      // panel also has its own "✕" close button; closing via that instead
      // of Done used to silently drop an already-created gym from view
      // until a full page refresh, since only Done used to carry this
      // merge. Decoupling it from any particular button closes that gap
      // regardless of how the panel gets dismissed.
      // No optimistic gym object here, unlike the old demo's version:
      // the server doesn't hand back a gym id for an add-gym request at
      // all (API.md 2.4 - the response is the request/changes shape, not
      // the resulting gym), so there's nothing to merge yet. The next
      // tile fetch picks it up once (and if) it's actually approved.
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
// three price kinds - the client-side rendering of the same whitelist.
// "name" and "status" aren't offered here even though the server
// supports editing them (name wasn't in the old demo's editable-field
// list either, and status - closing/removing a gym - was never an edit
// option in this UI; adding either would be new UI surface beyond
// "keep the UI exactly as is"). Trial DETAILS text also isn't offered -
// the server's own field whitelist only covers the hasTrial boolean,
// not the free-text details (which lives inside gyms.details, a jsonb
// catch-all the generic field-update path doesn't reach) - a known,
// disclosed gap, not silently dropped.
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
  // categories is the one field where the new value is a SET, not a
  // single pick like the old demo's category chip - the server replaces
  // the gym's whole categories array with whatever's submitted here
  // (not an add-one-tag merge), so this has to start pre-populated with
  // the gym's current categories or an edit would silently wipe the
  // rest.
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
// components above and directly by each platform's own MapScreen (for
// the rows it renders itself: rating/category/description/address/
// pricing/coordinates). cursor/boxShadow are harmless on native (React
// Native silently ignores style keys it doesn't recognize).
export const panelStyles = StyleSheet.create({
  panelScroll: { flex: 1 },
  panelScrollContent: { padding: 20, gap: 20 },
  panelRow: { gap: 8 },
  panelLabel: { fontSize: 11, fontWeight: '600', color: '#8A94A0', textTransform: 'uppercase', letterSpacing: 0.5 },
  panelValue: { fontSize: 14, color: '#1C2430', lineHeight: 20 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  sectionChevron: { fontSize: 12, color: '#8A94A0' },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewForm: {
    gap: 8,
    backgroundColor: '#F7F8F9',
    borderRadius: 10,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#DDE2E6',
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
  starFilled: { color: '#E0A500' },
  editLink: { color: '#146C5F', fontSize: 12, fontWeight: '700' },
  submitButton: {
    backgroundColor: '#146C5F',
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
  reviewAuthor: { fontSize: 13, fontWeight: '700', color: '#1C2430' },
  reviewStars: { fontSize: 12, color: '#E0A500' },
  chatBox: { gap: 8 },
  chatBubble: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%' },
  chatBubbleUser: { backgroundColor: '#146C5F', alignSelf: 'flex-end' },
  chatBubbleAssistant: { backgroundColor: '#F7F8F9', alignSelf: 'flex-start' },
  chatBubbleUserText: { color: 'white', fontSize: 13, lineHeight: 18 },
  chatBubbleAssistantText: { color: '#1C2430', fontSize: 13, lineHeight: 18 },
  chatInputRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  chatInput: { flex: 1 },
  chatInputLarge: { minHeight: 72, textAlignVertical: 'top' },
  chatSendButton: { paddingHorizontal: 16 },
  editFieldPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  editFieldChip: { borderWidth: 1, borderColor: '#DDE2E6', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  editFieldChipActive: { backgroundColor: '#146C5F', borderColor: '#146C5F' },
  editFieldChipText: { fontSize: 12, color: '#5B6470', fontWeight: '600' },
  editFieldChipTextActive: { color: 'white' },
});
