export type Photo = { id: string; url: string; mime: string; size: number; sortOrder: number };
export type User = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  age: number | null;
  gender: string;
  preferences: string[];
  city: string;
  vibes: string[];
  intent: string;
  bio: string;
  onboardingComplete: boolean;
  verificationStatus: string;
  photos: Photo[];
};
export type PublicProfile = Pick<User, "id" | "name" | "age" | "city" | "vibes" | "intent" | "bio" | "onboardingComplete"> & {
  photos: Pick<Photo, "id" | "url">[];
};
export type PersonPreview = {
  id: string;
  name: string;
  age: number;
  city: string;
  vibes: string[];
  bio: string;
  photo_url: string;
};
export type Activity = {
  id: string;
  name: string;
  location: string;
  description: string;
  image_url: string;
  date_label: string;
  time_label: string;
  categories: string[];
  interestedCount: number;
  viewerInterested?: boolean;
  people?: { id: string; name: string; url: string }[];
};

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: "Please try again." }))) as { error?: string };
    throw new ApiError(body.error || "Please try again.", response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function uploadPhoto(file: File, replaceId?: string) {
  return api<{ user: User }>(replaceId ? `/api/me/photos/${replaceId}` : "/api/me/photos", {
    method: replaceId ? "PUT" : "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
}

export function queryValue(name: string) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

export function safeReturnTo(value: string) {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
