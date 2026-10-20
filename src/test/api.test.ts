import { test } from "node:test";
import assert from "node:assert/strict";
import { type FetchLike, fetchProfile } from "../supabase/api.js";

// A placeholder, not a token. Every test sends it, and no thrown message may contain it.
const TOKEN = "tok-1";

// The one message for a response whose body does not have the shape the check needs.
const UNEXPECTED = "Unexpected response from Supabase /v1/profile.";

const VALID_BODY = { gotrue_id: "u1", primary_email: "a@example.com", username: "x" };

// A fake FetchLike. It records each request it is given, and it answers with the status and body it is given.
// Every test passes a fake, so the default fetch (the global one) is never called and nothing reaches the network.
const fakeFetch = (status: number, body: unknown = VALID_BODY) => {
  const sent: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    sent.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { fetchFn, sent };
};

// Runs a check that should fail, and returns the error it threw. A check that resolves fails the test.
const rejectionOf = async (check: Promise<unknown>): Promise<Error> => {
  try {
    await check;
  } catch (error) {
    return error as Error;
  }
  throw new Error("The check resolved, but it should have thrown.");
};

test("a 200 response with the three fields gives the profile", async () => {
  const { fetchFn } = fakeFetch(200);
  assert.deepEqual(await fetchProfile(TOKEN, fetchFn), {
    gotrueId: "u1",
    email: "a@example.com",
    username: "x",
  });
});

test("the request is a GET to the profile URL, with the token as a bearer header", async () => {
  const { fetchFn, sent } = fakeFetch(200);
  await fetchProfile(TOKEN, fetchFn);
  assert.deepEqual(sent, [
    {
      url: "https://api.supabase.com/v1/profile",
      init: { method: "GET", headers: { Authorization: "Bearer tok-1" } },
    },
  ]);
});

test("a given apiUrl replaces the default base URL", async () => {
  const { fetchFn, sent } = fakeFetch(200);
  await fetchProfile(TOKEN, fetchFn, "https://api.example.test");
  assert.equal(sent[0].url, "https://api.example.test/v1/profile");
});

test("a 401 throws the rejected-token message, and the message does not hold the token", async () => {
  const { fetchFn } = fakeFetch(401);
  const error = await rejectionOf(fetchProfile(TOKEN, fetchFn));
  assert.equal(error.message, "Supabase rejected this token (HTTP 401).");
  assert.ok(!error.message.includes(TOKEN));
});

test("a 503 throws the HTTP-status message, and the message does not hold the token", async () => {
  const { fetchFn } = fakeFetch(503);
  const error = await rejectionOf(fetchProfile(TOKEN, fetchFn));
  assert.equal(error.message, "Supabase API returned HTTP 503 while checking the token.");
  assert.ok(!error.message.includes(TOKEN));
});

// Bodies the check must refuse. Each one lacks a field, has it with the wrong kind of value, or has it empty.
const UNEXPECTED_BODIES: [string, unknown][] = [
  ["no gotrue_id", { primary_email: "a@example.com", username: "x" }],
  ["a gotrue_id that is not a string", { gotrue_id: 7, primary_email: "a@example.com", username: "x" }],
  ["an empty gotrue_id", { gotrue_id: "", primary_email: "a@example.com", username: "x" }],
  ["no primary_email", { gotrue_id: "u1", username: "x" }],
  ["a primary_email that is not a string", { gotrue_id: "u1", primary_email: null, username: "x" }],
  ["an empty primary_email", { gotrue_id: "u1", primary_email: "", username: "x" }],
  ["no username", { gotrue_id: "u1", primary_email: "a@example.com" }],
  ["a username that is not a string", { gotrue_id: "u1", primary_email: "a@example.com", username: 3 }],
  ["the JSON value null", null],
  ["a JSON array", []],
];

for (const [label, body] of UNEXPECTED_BODIES) {
  test(`a 200 response with ${label} throws the unexpected-response message`, async () => {
    const { fetchFn } = fakeFetch(200, body);
    const error = await rejectionOf(fetchProfile(TOKEN, fetchFn));
    assert.equal(error.message, UNEXPECTED);
    assert.ok(!error.message.includes(TOKEN));
  });
}

test("a 200 response whose body is not JSON throws the unexpected-response message", async () => {
  const fetchFn: FetchLike = async () => ({
    status: 200,
    ok: true,
    json: async () => {
      throw new SyntaxError("Unexpected token '<'");
    },
  });
  const error = await rejectionOf(fetchProfile(TOKEN, fetchFn));
  assert.equal(error.message, UNEXPECTED);
  assert.ok(!error.message.includes(TOKEN));
});

test("a fetch that fails throws the network message, and keeps neither the token nor the cause", async () => {
  // A fetch error can repeat a header value, and here the header value is the token.
  const fetchFn: FetchLike = async () => {
    throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
  };
  const error = await rejectionOf(fetchProfile(TOKEN, fetchFn));
  assert.equal(error.message, "Could not reach Supabase while checking the token.");
  assert.ok(!error.message.includes(TOKEN));
  assert.equal(error.cause, undefined);
});
