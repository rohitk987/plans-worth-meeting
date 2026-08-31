import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlansApp } from "../server/app";

class TestClient {
  cookie = "";
  constructor(private base: string) {}

  async raw(route: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("Cookie", this.cookie);
    const response = await fetch(`${this.base}${route}`, { ...init, headers });
    const setCookies = response.headers.getSetCookie();
    if (setCookies[0]) this.cookie = setCookies[0].split(";")[0];
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
    name, age: 27, gender: name === "Smoke A" ? "Woman" : "Man", preferences: ["Everyone"],
    vibes: ["Food", "Outdoors"], intent: "A relationship", bio: "Here for a good plan and a real conversation.",
  }) });
  for (let index = 0; index < 2; index++) await client.request("/api/me/photos", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: photo }, 201);
  const otp = await client.request<{ devCode: string }>("/api/auth/otp/request", { method: "POST", body: JSON.stringify({ phone, purpose: "safety" }) });
  assert.equal(otp.devCode, "246810");
  await client.request("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, purpose: "safety", code: otp.devCode }) });
  await client.request("/api/me/complete", { method: "POST" });
  const me = await client.request<{ user: { id: string; onboardingComplete: boolean; photos: unknown[] } }>("/api/me");
  assert.equal(me.user.onboardingComplete, true);
  assert.equal(me.user.photos.length, 2);
  return me.user.id;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string) {
  let text = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + 3000;
  while (!text.includes(expected) && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for SSE ${expected}`)), 1000)),
    ]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  assert(text.includes(expected), `Expected SSE stream to include ${expected}, received ${text}`);
  return text;
}

async function run() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "plans-smoke-"));
  const plans = createPlansApp({ dataDir, devOtp: "246810", secureCookies: false, seedLogin: true });
  const server = createServer(plans.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const publicClient = new TestClient(base);
  const a = new TestClient(base);
  const b = new TestClient(base);
  const incomplete = new TestClient(base);
  try {
    const activities = await publicClient.request<{ activities: { id: string; interestedCount: number }[] }>("/api/activities");
    assert.deepEqual(activities.activities.map((item) => item.id), ["cafe-date", "momo-cubbon", "church-street"]);
    assert(activities.activities.every((item) => item.interestedCount > 0));
    await publicClient.request("/api/profiles/rohan", {}, 401);
    const initial = await publicClient.request<{ conversations?: unknown[] }>("/api/conversations", {}, 401);
    assert(initial);

    await incomplete.request("/api/auth/register", { method: "POST", body: JSON.stringify({ email: "incomplete@example.test", password: "A-safe-password-42" }) }, 201);
    await incomplete.request("/api/profiles/rohan", {}, 403);
    await incomplete.request("/api/activities/cafe-date/interest", { method: "POST" }, 403);
    await incomplete.request("/api/invitations", {}, 403);

    const photo = readFileSync(path.join(process.cwd(), "client", "public", "images", "aanya.jpg"));
    const aId = await registerAndComplete(a, "smoke-a@example.test", "+919111111111", "Smoke A", photo);
    const bId = await registerAndComplete(b, "smoke-b@example.test", "+919222222222", "Smoke B", photo);

    const publicProfile = await a.request<{ profile: Record<string, unknown> }>(`/api/profiles/${bId}`);
    for (const privateField of ["email", "phone", "gender", "preferences", "verificationStatus"]) assert(!(privateField in publicProfile.profile), `Public profile leaked ${privateField}`);

    await a.request("/api/me/photos", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "not-an-image" }, 415);
    await a.request("/api/me/photos", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: "not-really-a-jpeg" }, 415);
    const aBeforePhotoEdit = await a.request<{ user: { photos: { id: string }[] } }>("/api/me");
    await a.request(`/api/me/photos/${aBeforePhotoEdit.user.photos[0].id}`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: photo });
    await a.request(`/api/me/photos/${aBeforePhotoEdit.user.photos[1].id}`, { method: "DELETE" }, 400);
    await b.request("/api/activities/cafe-date/interest", { method: "POST" }, 204);
    const bPeople = await b.request<{ people: { id: string }[] }>("/api/activities/cafe-date/people");
    assert(!bPeople.people.some((person) => person.id === bId), "Viewer appeared in their own people list");
    const rejected = await a.request<{ invitation: { id: string } }>("/api/invitations", { method: "POST", body: JSON.stringify({ receiverId: bId, activityId: "cafe-date" }) }, 201);
    const rejectedResult = await b.request<{ status: string; matchId: null }>(`/api/invitations/${rejected.invitation.id}/respond`, { method: "POST", body: JSON.stringify({ action: "reject" }) });
    assert.equal(rejectedResult.status, "rejected");
    assert.equal(rejectedResult.matchId, null);
    assert.equal((await a.request<{ conversations: unknown[] }>("/api/conversations")).conversations.length, 0);

    await b.request("/api/activities/momo-cubbon/interest", { method: "POST" }, 204);
    const sse = await b.raw("/api/events");
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    await readUntil(reader, "event: ready");
    const invitation = await a.request<{ invitation: { id: string } }>("/api/invitations", { method: "POST", body: JSON.stringify({ receiverId: bId, activityId: "momo-cubbon" }) }, 201);
    await readUntil(reader, "event: invitation");
    const pending = await b.request<{ incoming: { id: string; status: string }[] }>("/api/invitations");
    assert(pending.incoming.some((item) => item.id === invitation.invitation.id && item.status === "pending"));
    const accepted = await b.request<{ status: string; matchId: string; conversationId: string }>(`/api/invitations/${invitation.invitation.id}/respond`, { method: "POST", body: JSON.stringify({ action: "accept" }) });
    assert.equal(accepted.status, "accepted");
    assert(accepted.matchId && accepted.conversationId);
    const fresh = await a.request<{ messages: unknown[] }>(`/api/conversations/${accepted.conversationId}`);
    assert.deepEqual(fresh.messages, []);

    await a.request(`/api/conversations/${accepted.conversationId}/messages`, { method: "POST", body: JSON.stringify({ content: "Want to meet by the park gate?", clientNonce: "smoke-a-1" }) }, 201);
    const liveMessage = await readUntil(reader, "event: message");
    assert(liveMessage.includes('"content":"Want to meet by the park gate?"'), "Live message payload did not include the new message");
    const afterA = await b.request<{ messages: { sender_id: string; content: string }[] }>(`/api/conversations/${accepted.conversationId}`);
    assert.equal(afterA.messages[0].sender_id, aId);
    assert.equal(afterA.messages[0].content, "Want to meet by the park gate?");
    await b.request(`/api/conversations/${accepted.conversationId}/messages`, { method: "POST", body: JSON.stringify({ content: "Yes, see you there.", clientNonce: "smoke-b-1" }) }, 201);
    const afterB = await a.request<{ messages: { sender_id: string }[] }>(`/api/conversations/${accepted.conversationId}`);
    assert.equal(afterB.messages.length, 2);
    assert.equal(afterB.messages[1].sender_id, bId);

    const date = await a.request<{ datePlan: { location: string; date_label: string } }>(`/api/matches/${accepted.matchId}/date`, { method: "POST" });
    assert.equal(date.datePlan.location, "Cubbon Park");
    assert.equal(date.datePlan.date_label, "Saturday");
    await readUntil(reader, "event: date-plan");
    const persisted = await b.request<{ datePlan: unknown }>(`/api/conversations/${accepted.conversationId}`);
    assert(persisted.datePlan);
    await reader.cancel();

    await a.request("/api/auth/logout", { method: "POST" }, 204);
    await a.request("/api/me").then((result: any) => assert.equal(result.user, null));
    const restored = await a.request<{ user: { id: string; onboardingComplete: boolean } }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "smoke-a@example.test", password: "A-safe-password-42" }) });
    assert.equal(restored.user.id, aId);
    assert.equal(restored.user.onboardingComplete, true);
    console.log("Smoke test passed: browse, privacy, auth gates, onboarding, uploads, OTP, invitations, match, live message events, chat, date, and session restore.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    plans.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function runProductionChecks() {
  const previousNodeEnv = process.env.NODE_ENV;
  const dataDir = mkdtempSync(path.join(tmpdir(), "plans-production-smoke-"));
  process.env.NODE_ENV = "production";
  const plans = createPlansApp({ dataDir, secureCookies: true });
  const server = createServer(plans.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const client = new TestClient(`http://127.0.0.1:${address.port}`);
  try {
    await client.request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "aanya@example.test", password: "Meet123!" }) }, 401);
    await client.request("/api/auth/otp/request", { method: "POST", body: JSON.stringify({ phone: "+919333333333", purpose: "login" }) }, 503);
    const proxyResponse = await client.raw("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `https://127.0.0.1:${address.port}`, "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ email: "proxy@example.test", password: "A-safe-password-42" }),
    });
    assert.equal(proxyResponse.status, 201, `Trusted HTTPS proxy origin was rejected: ${await proxyResponse.text()}`);
    const setCookie = proxyResponse.headers.get("set-cookie") || "";
    assert(setCookie.includes("HttpOnly") && setCookie.includes("Secure") && setCookie.includes("SameSite=Lax"), "Production session cookie is missing security attributes");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    plans.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

run().then(runProductionChecks).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
