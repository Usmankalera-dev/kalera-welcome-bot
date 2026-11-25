# Kalera Welcome Bot

A GitHub App webhook server that welcomes first-time contributors. When someone
opens their **first** issue or pull request in a repository where the app is
installed, the bot posts a short welcome comment and adds a `first-time` label
(creating the label if it does not exist yet).

It skips bot accounts (`login` ending in `[bot]`) and the repository owner
opening their own issue/PR.

Built for **Muhammad Usman** (GitHub: `Usmankalera-dev`). Working name:
**Kalera Welcome Bot**.

## How it works

```
GitHub webhook (issues.opened / pull_request.opened)
        │  HMAC SHA-256 signature verified (WEBHOOK_SECRET, timingSafeEqual)
        ▼
  bot or repo owner? ──yes──▶ 200, skipped
        │ no
        ▼
  App JWT (APP_ID + PRIVATE_KEY, RS256)
        │  exchanged for an installation access token
        ▼
  List the author's issues/PRs in the repo (real-time list API)
        │  > 1 item? ──yes──▶ 200, not first-time
        │ no
        ▼
  Ensure `first-time` label exists → add it → post welcome comment → 200
```

A correctly signed webhook **always gets a 200**, even if processing fails
(the error is logged). GitHub retries non-2xx deliveries, so a 500 on a
doomed event would only cause retry spam. A bad or missing signature gets
**401**.

## Environment variables

| Variable | Required | What it is |
|---|---|---|
| `APP_ID` | yes | The GitHub App's numeric ID (shown on the app's settings page). |
| `PRIVATE_KEY` | yes | The RSA private key generated for the GitHub App. Paste the whole PEM. Literal `\n` characters are converted to real newlines by the code, so either form works. |
| `WEBHOOK_SECRET` | yes | The webhook secret set on the GitHub App. Must match exactly. |
| `GITHUB_API_BASE` | no | Defaults to `https://api.github.com`. Only used by the local test to point at a mock API. Leave unset in production. |

No secret is hardcoded anywhere. Copy `.env.example` to `.env` for local
testing only — `.env` is gitignored.

## Dependency choice: `jsonwebtoken` + plain `fetch`

The only dependency is `jsonwebtoken`, used to sign the App JWT. Everything
else is Node's built-in `fetch` and `crypto`.

`@octokit/app` would do the same job (JWT + installation-token exchange) but
it pulls in a dependency tree and hides the auth flow behind an abstraction.
For a single-purpose webhook, explicit code is easier to audit: the JWT
payload, the token exchange, and every API call are all visible in
`api/webhook.js`. If the bot grows (more endpoints, retries, token caching),
switching to `@octokit/app` would be the right move.

## Files

| File | Purpose |
|---|---|
| `api/webhook.js` | The webhook handler — Vercel deploys it as a serverless function at `/api/webhook`. |
| `package.json` | Node 18+, one dependency (`jsonwebtoken`), `npm test` / `npm run check`. |
| `.env.example` | Placeholder env vars (no real values). |
| `.gitignore` | `node_modules/`, `.env`, `.vercel`. |
| `test/local-test.js` | Local test: mock GitHub API + the real handler, fake signed payloads. |

No `vercel.json` is needed — Vercel auto-detects `api/*.js` as functions.

## Local test

```bash
npm install
npm test        # runs test/local-test.js
npm run check   # node --check on both JS files
```

The test generates a throwaway RSA keypair, starts a mock GitHub API and the
real handler on localhost, and checks 9 scenarios: bad/missing signature
→ 401; ping → 200; bot author and repo owner → 200 with no GitHub calls;
first-time issue author → token exchange, first-time check, label created,
label added, welcome comment posted (comment text mentions repo + author);
label already existing → no duplicate creation; repeat PR author → checked
but no comment/label; unsupported event → 200, ignored.

## Deploy (Vercel) — to be done by the parent

1. Push this folder to a GitHub repo (e.g. `Usmankalera-dev/kalera-welcome-bot`).
2. Import the repo in Vercel (or `vercel` CLI) — no build step needed.
3. In Vercel project Settings → Environment Variables, set `APP_ID`,
   `PRIVATE_KEY`, `WEBHOOK_SECRET` (values from the GitHub App, below).
4. Deploy. The webhook URL is `https://<your-deployment>.vercel.app/api/webhook`.

## Register the GitHub App — to be done by the parent

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - Name: `Kalera Welcome Bot` (must be unique on GitHub).
   - Homepage URL: the repo URL.
   - Webhook URL: `https://<your-deployment>.vercel.app/api/webhook`.
   - Webhook secret: generate a long random string — this is `WEBHOOK_SECRET`.
   - Permissions: **Issues — Read & write** (comments + labels), **Pull requests — Read & write** (to receive `pull_request` events).
   - Subscribe to events: **Issues**, **Pull request**.
   - Where can this GitHub App be installed? **Only on this account** is fine.
2. After creating the app, note the **App ID** (`APP_ID`) and generate a
   **private key** (download the `.pem` — GitHub shows it only once; that is
   `PRIVATE_KEY`).
3. Put `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` in Vercel env vars (above)
   and redeploy if needed.
4. Install the app on the repositories you want it on (app settings →
   Install App → choose repos). The bot only acts where it is installed.

## Notes

- **First-time check:** the list-issues API (`GET /repos/:owner/:repo/issues?creator=:login&state=all&per_page=2`)
  is used instead of the search API, because search-index lag could briefly
  make a repeat contributor look like a first-timer. The list includes the
  triggering issue/PR itself, so `<= 1` item means first-time.
- **Installation tokens** are exchanged fresh on every webhook. They last
  1 hour; caching would save one API call per event, but for a welcome bot
  the volume is low and fresh tokens are simpler and safer.
- The welcome comment mentions the repo's full name (`owner/repo`) and says a
  maintainer will look soon. At most one emoji.
- The handler reads the raw request body itself (`bodyParser: false` in the
  exported `config`) — Vercel's default JSON parsing would break signature
  verification.
