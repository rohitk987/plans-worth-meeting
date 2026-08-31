import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const base = (process.env.WORKER_BASE_URL || "http://127.0.0.1:4191").replace(/\/$/, "");

class TestClient {
  cookie = "";

  async raw(route: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("Cookie", this.cookie);
    const response = await fetch(`${base}${route}`, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return response;
  }

  async request<T = any>(route: string, init: RequestInit = {}, expected = 200): Promise<T> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await this.raw(route, { ...init, headers });
    const body = response.status === 204 ? null : await response.json();
    assert.equal(response.status, expected, `${init.method || "GET"} ${route}: ${JSON.stringify(body)}`);
    return body as T;
  }
}

async function registerAndComplete(client: TestClient, email: string, phone: string, name: string, photo: Buffer) {
  await client.request("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password: "A-safe-password-42" }) }, 201);
  await client.request("/api/me", { method: "PATCH", body: JSON.stringify({
    name,
    age: 27,
    gender: name.endsWith("A") ? "Woman" : "Man",
    preferences: ["Everyone"],
    vibes: ["Food", "Outdoors"],
    intent: "A relationship",
    bio: "Here for a good plan and a real conversation.",
  }) });
  for (let index = 0; index < 2; index += 1) {
    await client.request("/api/me/photos", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: photo }, 201);
  }
  const otp = await client.request<{ devCode: string }>("/api/auth/otp/request", {
    method: "POST",
    body: JSON.stringify({ phone, purpose: "safety" }),
  });
  assert.equal(otp.devCode, "246810");
  await client.request("/api/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, purpose: "safety", code: otp.devCode }),
  });
  await client.request("/api/me/complete", { method: "POST" });
  const me = await client.request<{ user: { id: string; onboardingComplete: boolean; photos: { id: string; url: string }[] } }>("/api/me");
  assert.equal(me.user.onboardingComplete, true);
  assert.equal(me.user.photos.length, 2);
  return me.user;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string) {
  let received = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5_000;
  while (!received.includes(expected) && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 2_000)),
    ]);
    if (next.done) break;
    received += decoder.decode(next.value, { stream: true });
  }
  assert(received.includes(expected), `Expected ${expected}; received ${received}`);
  return received;
}

async function run() {
  const anonymous = new TestClient();
  const incomplete = new TestClient();
  const a = new TestClient();
  const b = new TestClient();
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const digits = String(Date.now() % 100_000_000).padStart(8, "0");
  const phoneA = `+9198${digits}`;
  const phoneB = `+9197${digits}`;
  const photo = readFileSync(path.join(process.cwd(), "client", "public", "images", "aanya.jpg"));

  const health = await anonymous.request<{ ok: boolean }>("/api/health");
  assert.equal(health.ok, true);
  const activities = await anonymous.request<{ activities: { id: string; interestedCount: number }[] }>("/api/activities");
  assert.deepEqual(activities.activities.map((activity) => activity.id), ["cafe-date", "momo-cubbon", "church-street"]);
  assert(activities.activities.every((activity) => activity.interestedCount > 0));
  await anonymous.request("/api/profiles/rohan", {}, 401);
  await anonymous.request("/api/conversations", {}, 401);

  await incomplete.request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: `worker-incomplete-${suffix}@example.test`, password: "A-safe-password-42" }),
  }, 201);
  await incomplete.request("/api/profiles/rohan", {}, 403);
  await incomplete.request("/api/activities/cafe-date/interest", { method: "POST" }, 403);
  await incomplete.request("/api/invitations", {}, 403);

  const aUser = await registerAndComplete(a, `worker-a-${suffix}@example.test`, phoneA, "Worker A", photo);
  const bUser = await registerAndComplete(b, `worker-b-${suffix}@example.test`, phoneB, "Worker B", photo);

  const publicProfile = await a.request<{ profile: Record<string, unknown> }>(`/api/profiles/${bUser.id}`);
  for (const field of ["email", "phone", "gender", "preferences", "verificationStatus"]) {
    assert(!(field in publicProfile.profile), `Public profile leaked ${field}`);
  }
  await a.request("/api/me/photos", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: "not-a-jpeg" }, 415);
  const replacement = await a.request<{ user: { photos: { id: string; url: string }[] } }>(`/api/me/photos/${aUser.photos[0].id}`, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: photo,
  });
  const uploaded = await a.raw(replacement.user.photos[0].url);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers.get("content-type"), "image/jpeg");
  assert((await uploaded.arrayBuffer()).byteLength > 0);
  await a.request(`/api/me/photos/${replacement.user.photos[1].id}`, { method: "DELETE" }, 400);

  const hostile = await a.raw("/api/activities/cafe-date/interest", { method: "POST", headers: { Origin: "https://attacker.example" } });
  assert.equal(hostile.status, 403);
  await b.request("/api/activities/cafe-date/interest", { method: "POST" }, 204);
  await b.request("/api/activities/momo-cubbon/interest", { method: "POST" }, 204);
  const people = await b.request<{ people: { id: string }[] }>("/api/activities/cafe-date/people");
  assert(!people.people.some((person) => person.id === bUser.id));

  const rejected = await a.request<{ invitation: { id: string } }>("/api/invitations", {
    method: "POST",
    body: JSON.stringify({ receiverId: bUser.id, activityId: "cafe-date" }),
  }, 201);
  const rejectedResult = await b.request<{ status: string; matchId: null }>(`/api/invitations/${rejected.invitation.id}/respond`, {
    method: "POST",
    body: JSON.stringify({ action: "reject" }),
  });
  assert.equal(rejectedResult.status, "rejected");
  assert.equal(rejectedResult.matchId, null);
  assert.equal((await a.request<{ conversations: unknown[] }>("/api/conversations")).conversations.length, 0);

  const eventResponse = await b.raw("/api/events");
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body!.getReader();
  await readUntil(reader, "event: ready");
  const invitation = await a.request<{ invitation: { id: string } }>("/api/invitations", {
    method: "POST",
    body: JSON.stringify({ receiverId: bUser.id, activityId: "momo-cubbon" }),
  }, 201);
  await readUntil(reader, "event: invitation");
  const accepted = await b.request<{ status: string; matchId: string; conversationId: string }>(`/api/invitations/${invitation.invitation.id}/respond`, {
    method: "POST",
    body: JSON.stringify({ action: "accept" }),
  });
  assert.equal(accepted.status, "accepted");
  const fresh = await a.request<{ messages: unknown[] }>(`/api/conversations/${accepted.conversationId}`);
  assert.deepEqual(fresh.messages, []);
  await a.request(`/api/conversations/${accepted.conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "Want to meet by the park gate?", clientNonce: `worker-${suffix}` }),
  }, 201);
  const messageEvent = await readUntil(reader, "Want to meet by the park gate?");
  assert(messageEvent.includes("event: message"));
  const persisted = await b.request<{ messages: { sender_id: string; content: string }[] }>(`/api/conversations/${accepted.conversationId}`);
  assert.equal(persisted.messages[0].sender_id, aUser.id);
  assert.equal(persisted.messages[0].content, "Want to meet by the park gate?");
  const date = await a.request<{ datePlan: { location: string; date_label: string; time_label: string } }>(`/api/matches/${accepted.matchId}/date`, { method: "POST" });
  assert.deepEqual([date.datePlan.location, date.datePlan.date_label, date.datePlan.time_label], ["Cubbon Park", "Saturday", "5:00 PM"]);
  await readUntil(reader, "event: date-plan");
  await reader.cancel();

  await a.request("/api/auth/logout", { method: "POST" }, 204);
  assert.equal((await a.request<{ user: null }>("/api/me")).user, null);
  const restored = await a.request<{ user: { id: string; onboardingComplete: boolean } }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: `worker-a-${suffix}@example.test`, password: "A-safe-password-42" }),
  });
  assert.equal(restored.user.id, aUser.id);
  assert.equal(restored.user.onboardingComplete, true);

  console.log("Worker smoke test passed: D1, durable photo storage, auth, privacy, onboarding, invitations, rejection, match, SSE chat, date, and session restore.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
