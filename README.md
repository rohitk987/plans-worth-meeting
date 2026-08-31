# Plans

Plans is a Bangalore dating app where people choose an activity first, see who is down, and invite one person to join them.

## Run locally

Requirements: Node.js 24 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

The local development OTP is clearly shown in the interface and defaults to `246810`. No SMS is sent. Production deliberately refuses OTP requests until a real SMS provider is connected.

Seeded accounts for local development testing:

- `aanya@example.test` / `Meet123!`
- `rohan@example.test` / `Meet123!`

Those seed-profile passwords are automatically disabled when the production server starts, so the sample people cannot be impersonated in a deployed build.

`pnpm dev` runs the persistent Node/SQLite development server. `pnpm dev:sites` runs the Cloudflare-compatible version locally with D1 and R2 bindings; both expose the same product API and screens.

Chats and messages are never seeded. Accepting an invitation creates an empty conversation.

## Verify

```sh
pnpm check
pnpm test:smoke
pnpm build
```

The default production build targets Sites with a Cloudflare Worker, D1 for structured records, and R2 for uploaded photos. A standalone Node build remains available through `pnpm build:node` and `pnpm start:node`.

The smoke test uses isolated temporary databases and covers public browsing, private-profile isolation, account-state authorization, account creation, onboarding, uploads, OTP verification, invitations, rejection, matching, live message delivery, chat persistence, date confirmation, logout/login restoration, secure production cookies, reverse-proxy origins, honest production OTP failure, and disabled production seed credentials.

## Data

SQLite data and uploaded profile photos live under `data/` by default. Set `PLANS_DATA_DIR` to use a different persistent directory. Runtime data is intentionally ignored by version control.

Activity and seed-profile photo sources are listed at `/photo-credits.html` in the app.
