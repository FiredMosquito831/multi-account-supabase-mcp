// The identity check. It asks Supabase whose token this is, and it fails closed: a response that does not
// have the shape the check needs throws, and nothing is returned. No message holds the token. Each message
// is fixed, apart from an HTTP status number.

// Who a token belongs to. gotrueId is the Supabase user id.
export type Profile = { gotrueId: string; email: string; username: string };

// The part of fetch that the check uses. The tests pass a fake with this shape.
export type FetchLike = (
  url: string,
  init: { method: "GET"; headers: Record<string, string> },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

const SUPABASE_API_URL = "https://api.supabase.com";

// The default is the global fetch. No test calls it.
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

const UNEXPECTED = "Unexpected response from Supabase /v1/profile.";

// Checks the body before anything is returned. gotrue_id and primary_email are stored in the accounts
// registry, which refuses an empty value, so an empty one is refused here too.
const toProfile = (body: unknown): Profile => {
  if (typeof body !== "object" || body === null) {
    throw new Error(UNEXPECTED);
  }
  const fields = body as Record<string, unknown>;
  const gotrueId = fields.gotrue_id;
  const email = fields.primary_email;
  const username = fields.username;
  if (typeof gotrueId !== "string" || gotrueId.length === 0) {
    throw new Error(UNEXPECTED);
  }
  if (typeof email !== "string" || email.length === 0) {
    throw new Error(UNEXPECTED);
  }
  if (typeof username !== "string") {
    throw new Error(UNEXPECTED);
  }
  return { gotrueId, email, username };
};

// Asks Supabase for the profile of a token. A failure throws a fixed message. The only value a message takes
// from the response is the HTTP status number.
export const fetchProfile = async (
  token: string,
  fetchFn: FetchLike = defaultFetch,
  apiUrl = SUPABASE_API_URL,
): Promise<Profile> => {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(`${apiUrl}/v1/profile`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // The error is not kept. A fetch error can repeat a header value, and the header value here is the token.
    throw new Error("Could not reach Supabase while checking the token.");
  }
  if (response.status === 401) {
    throw new Error("Supabase rejected this token (HTTP 401).");
  }
  if (!response.ok) {
    throw new Error(`Supabase API returned HTTP ${response.status} while checking the token.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(UNEXPECTED);
  }
  return toProfile(body);
};
