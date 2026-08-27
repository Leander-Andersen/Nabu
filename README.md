# nabu

A Cloudflare Worker that polls the MangaDex API on a cron, finds new chapters in your
followed series, and emails you a digest about them via Microsoft Graph.

Named after the Mesopotamian god of writing and scribes.

---

## How it works

Every 15 minutes the cron fires and the Worker:

1. Gets a MangaDex access token — refresh grant if a refresh token is in KV, password
   grant otherwise (and if no login is configured, refresh-only; see step 1 of Setup).
2. Asks `/user/follows/manga/feed` for chapters created since the last successful run.
3. Drops entries with a non-null `externalUrl` (official publisher links, not readable
   on MangaDex).
4. Drops chapter IDs already in the KV dedupe set.
5. If anything is left, sends **one** digest (HTML + plain text) through SMTP2GO.
6. Marks those chapter IDs seen and advances `last_run` — **only after the send
   succeeds**, so a mail outage retries instead of silently swallowing chapters.

Zero new chapters means zero emails.

### Why the API and not the RSS feed

The follows page exposes RSS, but it honours the account-level chapter-language setting
— global, so changing it also changes what you see browsing the site — and it takes no
query parameters: no `since`, no pagination, the same overlapping window every fetch.
The REST API takes `translatedLanguage[]` and `createdAtSince` per request, so filtering
is independent of account config and each poll asks only for what is new.

---

## Setup

### 0. Prerequisites

- A Cloudflare account with Workers (the free plan covers this) and `wrangler` logged in
  (`npx wrangler login`).
- A MangaDex account that follows some series.
- An SMTP2GO account (the free tier covers this volume), or an M365 tenant if you
  would rather send through Graph.
- `jq` and `curl`, if you seed the refresh token by hand (step 1).

```sh
npm install
```

### 1. Register a MangaDex personal client

**Do this first.** Personal clients go through a staff approval queue before they start
working — you do not want to discover that at the end of the build.

1. Go to <https://mangadex.org/settings> → **API Clients** tab → create a client.
2. The client ID looks like `personal-client-<uuid>-<name>`.
3. Once approved, use the **Get Secret** button for the client secret.

#### There is no MangaDex API key

Worth stating plainly, because MangaDex's own docs invite the confusion — they describe a
personal client as working *"similarly to an API key."* It is not one. It is a
**clientId + clientSecret pair**, and it cannot authenticate by itself:

- There is **no `client_credentials` flow**. Personal clients support only the password
  grant and the refresh grant.
- Public clients (the browser-redirect flow) are *"not yet available."*
- `/user/follows/manga/feed` is **user-scoped** — it returns *your* follows, so the
  request has to be made as your account, not as an app.

It *is* personal, though: *"Only the account that owns a personal client can be used with
it."* It is bound to your account and useless with any other.

So the client pair identifies the app, and something has to identify the account. You get
to choose what that something is — see below.

#### Storing the credentials

They live in the Secrets Store item **`MangaDexAPI`**, bound as `MD_CREDENTIALS` in
[wrangler.toml](wrangler.toml), holding one JSON object:

```json
{
  "clientId": "personal-client-…",
  "clientSecret": "…"
}
```

`snake_case` keys (`client_id`, `client_secret`) are accepted too, and the JSON may be
pretty-printed or on one line.

Set the value from the Cloudflare dashboard, or from the CLI. `update` takes the secret's
**ID**, not its name, so list the store first:

```sh
npx wrangler secrets-store secret list 7d16eedbb01c493ebbc6cf86aa891f12 --remote

npx wrangler secrets-store secret update 7d16eedbb01c493ebbc6cf86aa891f12 \
  --secret-id <id-from-that-list> --scopes workers --remote
```

Omit `--value` as shown — wrangler then prompts for it, keeping the JSON out of your
shell history.

#### Running without your account password

With only `clientId`/`clientSecret` above, nabu never sees your password — it runs
**refresh-token-only**. That costs one manual step: the first refresh token has to be
minted by hand, since only the password grant can produce one.

Run this **locally, once**. It prompts for the four values, mints the token, and writes it
to KV:

```sh
./scripts/seed-refresh-token.sh
```

Your password is read without echoing, sent straight to `auth.mangadex.org`, and dropped
from the environment as soon as the request returns — it never reaches Cloudflare, your
shell history, or disk. The token is handed to wrangler through a `chmod 600` temp file
rather than on the command line.

<details>
<summary>Equivalent by hand, if you'd rather not run a script</summary>

```sh
curl -sS -X POST \
  https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token \
  -H "User-Agent: nabu/1.0 (+https://github.com/Leander-Andersen/Nabu; security@isame12.no)" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "username=YOUR_MANGADEX_USERNAME" \
  --data-urlencode "password=YOUR_MANGADEX_PASSWORD" \
  --data-urlencode "client_id=personal-client-YOUR-CLIENT-ID" \
  --data-urlencode "client_secret=YOUR_CLIENT_SECRET" | jq -r .refresh_token

npx wrangler kv key put refresh_token "<the-token-from-above>" \
  --binding NABU_STATE --remote
```

Use `--data-urlencode`, not `-d` — a password containing `&`, `=` or spaces breaks `-d`.
Note this leaves your password in your shell history; `history -d` afterwards, or prefix
the command with a space if your shell is set to ignore those.

</details>

Every token request rotates that value and nabu writes the new one straight back, so it
stays fresh indefinitely. Refresh tokens last months, and nabu refreshes on every run.

**The trade-off:** if the refresh token is ever rejected — you change your MangaDex
password, revoke the client, or the Worker sits idle past the token's lifetime — nabu
cannot heal itself. It fails with a named error telling you to re-seed, and you re-run
the two commands above. That is the price of not storing the password.

**If you would rather it self-heal**, add your login to the same JSON object and skip the
seeding entirely:

```json
{
  "username": "…",
  "password": "…",
  "clientId": "personal-client-…",
  "clientSecret": "…"
}
```

Then the password grant runs once on the first run and only ever again if the refresh
token is rejected. Note that MangaDex flags a general caveat for this flow: it *"bypasses
multi-factor authentication."*

### 2. Set up sending

nabu ships two mail providers, chosen with the `MAIL_PROVIDER` var. The default is
`smtp2go`.

#### Why there is no SMTP host/port/username/password

Because a Worker cannot use them. Cloudflare blocks it at the platform level — *"Workers
cannot create outbound TCP connections on port 25 to send email to SMTP mail servers"* —
so there is no socket to open and nothing to configure a port on. nabu therefore uses
SMTP2GO's **HTTP API**, which is a single `fetch` and a single secret. The host, port and
TLS settings on SMTP2GO's *SMTP Users* page belong to a different transport and do not
apply here.

#### SMTP2GO (default)

1. **Verify a sender.** SMTP2GO dashboard → **Sending** → **Verified Senders**. Verify
   either the single from-address or the whole `isame12.no` domain (domain verification
   means adding CNAME records, and gets you DKIM, which mail providers like).
2. **Create an API key.** **Sending** → **API Keys** → **Add API Key**, with the
   **email/send** permission. It starts with `api-`.
3. Put the from-address in `SENDER_ADDRESS` in [wrangler.toml](wrangler.toml) — it has to
   be the verified one, or every send fails.

That is the whole setup: one credential, `SMTP2GO_API_KEY`.

#### Pick your region

SMTP2GO runs regional data centres and **issues API keys per region**. A key from the
wrong one comes back as `An API User matching the passed 'api_key' was not found` — which
reads like a bad key, not a wrong endpoint, and is the single most confusing failure here.

| Region | Base URL |
|---|---|
| Global (default) | `https://api.smtp2go.com/v3/` |
| US | `https://us-api.smtp2go.com/v3/` |
| EU | `https://eu-api.smtp2go.com/v3/` |
| AU | `https://au-api.smtp2go.com/v3/` |

"Global" is not a superset — it routes to whichever region is nearest the *caller*, and
for a Worker that is wherever Cloudflare happens to run the request. If your account is
regional (console at `app-eu.smtp2go.com`, say), pin the matching region or sends will
fail unpredictably.

Set it with the **SMTP2GO region** toggle in the dashboard, which stores it in KV.
`SMTP2GO_REGION` in [wrangler.toml](wrangler.toml) is the initial value; the toggle wins
once used.

#### Where the API key lives

It is held in the account-level **Secrets Store**, not as a per-Worker
`wrangler secret`, and reaches the Worker through a binding already configured in
[wrangler.toml](wrangler.toml):

```toml
[[secrets_store_secrets]]
binding     = "SMTP2GO_API_KEY"   # the name the code reads
store_id    = "7d16eedbb01c493ebbc6cf86aa891f12"
secret_name = "smtp2goApiKey"     # the name inside the store
```

Two consequences worth knowing:

- A Secrets Store binding is **an object, not a string** — `await env.X.get()`. nabu
  reads every secret through `readSecret()` in [src/secrets.ts](src/secrets.ts), which
  accepts either that or a plain string, so the same code works with
  `wrangler secret put` and with `.dev.vars`.
- **Do not also run `wrangler secret put SMTP2GO_API_KEY`.** Two bindings of the same
  name collide and the deploy is rejected.

The secret needs the `workers` scope to be bindable. To check what the store holds:

```sh
npx wrangler secrets-store secret list 7d16eedbb01c493ebbc6cf86aa891f12 --remote
```

> A send that SMTP2GO rejects for an unverified sender comes back **HTTP 200** with
> `data.failed: 1`, not an error status. nabu inspects the body and treats that as a
> failure, so a misconfigured sender surfaces in the logs and holds `last_run` back
> instead of quietly dropping chapters.

#### Microsoft Graph (alternative)

Set `MAIL_PROVIDER = "graph"` and see [Appendix: Microsoft Graph](#appendix-microsoft-graph).

### 3. Create the KV namespace

```sh
npx wrangler kv namespace create NABU_STATE
```

Copy the returned ID into `id` under `[[kv_namespaces]]` in [wrangler.toml](wrangler.toml).

### 4. Fill in the config

All of these are already filled in in [wrangler.toml](wrangler.toml); change them there if needed:

| Var | Meaning |
|---|---|
| `MAIL_PROVIDER` | `smtp2go` (default) or `graph` |
| `SENDER_ADDRESS` | from-address, `service@isame12.no` — must be a **verified sender** on SMTP2GO |
| `SENDER_NAME` | optional display name on the From line |
| `RECIPIENT_ADDRESS` | where the digest goes, `leander@isame12.no` (comma-separated for several) |
| `LANGUAGES` | comma-separated MangaDex language codes, e.g. `en` |

Nothing in [wrangler.toml](wrangler.toml) is a credential — the KV namespace ID and the
Secrets Store `store_id`/`secret_name` are identifiers that do nothing without account
authentication, which is why they belong in a committed file. The only file that must
never be committed is `.dev.vars`, and it is gitignored.

### 5. Set the secrets

Both credentials already come from the Secrets Store (`MangaDexAPI` and `smtp2goApiKey`),
so on the default configuration **there are no `wrangler secret put` commands to run**.
Setting Worker secrets named `MD_CREDENTIALS` or `SMTP2GO_API_KEY` would collide with the
store bindings and the deploy would be rejected.

If you ever want a value as a Worker secret instead, drop its `[[secrets_store_secrets]]`
block from [wrangler.toml](wrangler.toml) first, then:

```sh
npx wrangler secret put MD_CREDENTIALS   # the same JSON object, on one line
```

On `MAIL_PROVIDER = "graph"` add `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` and
`GRAPH_CLIENT_SECRET` (Worker secrets or Secrets Store bindings — both work). Either way
nabu resolves the set it needs *before* it polls, so a missing or deleted secret fails on
the first run with a named error rather than a 401 later.

Optional, and off by default — enables the manual "run now" endpoint (see
[Operating](#operating)):

```sh
openssl rand -hex 32 | npx wrangler secret put TRIGGER_SECRET
```

For local runs, copy [.dev.vars.example](.dev.vars.example) to `.dev.vars` and fill it in.
That file is gitignored; production never reads it.

### 6. Deploy and do the first, seeded run

```sh
npx wrangler deploy
```

**The first run emails nothing on purpose.** With no `last_run` in KV, nabu looks back 24
hours, writes every chapter it finds into the dedupe set, stamps `last_run`, and sends no
mail — otherwise your first email would be a day's worth of releases. The run after that
is the first real digest.

Trigger the seeding run and watch it, rather than waiting for the cron:

```sh
npx wrangler tail --format pretty
# in another shell, if TRIGGER_SECRET is set:
curl -H "Authorization: Bearer $TRIGGER_SECRET" https://nabu.<your-subdomain>.workers.dev
```

You want a line like:

```json
{"event":"seeded","since":"2026-08-26T18:00:00.000Z","chapters":12}
{"event":"run_complete","trigger":"manual","provider":"smtp2go","seeded":true,"provider":"smtp2go","found":12,"readable":12,"new":12,"mailed":false,"durationMs":804}
```

To test that mail actually sends without waiting for a release, delete the dedupe entry
for one recent chapter and let the next run pick it up again:

```sh
npx wrangler kv key list --binding NABU_STATE --remote | head
npx wrangler kv key delete "seen:<chapter-id>" --binding NABU_STATE --remote
```

---

## Local development

```sh
npm run dev          # wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"
```

Production Secrets Store values are unreachable from local dev by design, so seed a local
copy of the key once (omitting `--remote` targets the local store):

```sh
npx wrangler secrets-store secret create 7d16eedbb01c493ebbc6cf86aa891f12 \
  --name smtp2goApiKey --scopes workers
```

`wrangler dev` reads `.dev.vars` and uses a local KV store under `.wrangler/`, so local
runs cannot touch production state. They *do* hit the real MangaDex API and really send
mail through SMTP2GO — point `RECIPIENT_ADDRESS` somewhere harmless while experimenting.

```sh
npm run typecheck    # tsc --noEmit
```

---

## Operating

**Logs.** One JSON object per line. `npx wrangler tail` and grep:

| Event | Meaning |
|---|---|
| `run_complete` | `provider`, `found` (from the feed), `readable` (after the externalUrl filter), `new` (after dedupe), `mailed` |
| `seeded` | first run — dedupe set primed, nothing emailed |
| `md_refresh_failed` | refresh token rejected; falls back to the password grant, or fails with a re-seed instruction if no login is configured |
| `md_feed_truncated` | more than 500 chapters in one window; pagination hit its cap |
| `run_failed` | the run threw; `last_run` was not advanced |

**Manual run.** From the dashboard's *Run now* button, or by hand:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://nabu.<your-subdomain>.workers.dev/api/run
```

**State in KV.**

| Key | Purpose |
|---|---|
| `refresh_token` | rotated on every token request |
| `last_run` | ISO timestamp; the next poll asks from here minus 60s of overlap |
| `seen:{chapterId}` | dedupe guard, 7-day TTL |
| `run_log` | last 50 runs, shown in the dashboard |
| `series_index` | per-series last-chapter record |
| `recipients` | recipient list, once edited in the dashboard |
| `smtp2go_region` | SMTP2GO region, once set in the dashboard |

Deleting `last_run` makes the next run a seeding run again (24h back, no mail). Deleting
`refresh_token` forces a fresh password grant. Neither is destructive.

**Missed a digest?** A failed send leaves `last_run` and the dedupe set untouched,
so the next cron re-sends the same chapters. Nothing is lost until the send succeeds.

---

## Admin dashboard

Visit the Worker's URL. It serves a single page — no build step, no external assets —
showing:

- **Status and last run**, plus the provider, sender and languages in use.
- **Run now**, with the run's full JSON summary rendered underneath: what it found, what
  was new, whether mail went out, and every chapter in the digest as a link.
- **Recipients**, add and remove, as many as you like. Changes take effect on the next
  run — no redeploy. Each row has a **Test** button, and **Send test to all** does the
  lot; results appear per address (hover a failure for the provider's own words).
- **Series**, sorted by most recent chapter, each linking to it. *Sync followed series*
  pulls your full follows list from MangaDex so quiet series appear too, rather than only
  the ones that have published since you deployed.
- **SMTP2GO region** — global / US / EU / AU, stored server-side in KV.
- **Credentials** — whether each secret is present and *shaped* like what its provider
  expects. No secret value is ever read back or displayed; Secrets Store does not permit
  it, and this reports only length and plausibility. It exists because "the provider
  rejected my key" otherwise gives you nothing to go on — this tells missing from
  truncated from wrong-kind-of-credential.
- **Runs** — the last 50, successes and failures, each with its error or its chapter list.

The history is nabu's own, kept in KV. That avoids needing a Cloudflare API token to read
Workers Logs, and it survives independently of log retention. `wrangler tail` still shows
the live structured logs.

### Access

The page is gated on `ADMIN_TOKEN` — the value in the Secrets Store item `AdminToken`.

- **With it unset the Worker serves 404 to every HTTP request** and only the cron can
  drive it. That is the safe default if you would rather not expose a dashboard at all.
- Signing in exchanges the token for an HMAC-signed session cookie
  (`HttpOnly`, `Secure`, `SameSite=Strict`, 12 hours). The cookie carries nothing but an
  expiry and cannot be forged without the secret.
- The same token works as `Authorization: Bearer …` for the JSON API.
- The password comparison is length-independent, so a wrong guess leaks no timing signal.

That is honest single-password auth, which is proportionate for a personal tool on an
unguessable `workers.dev` URL. **If you want it properly locked down, put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in
front of the Worker** — you then get SSO, device posture and an audit log, and the
password becomes a second factor rather than the only one.

### API

Every route takes `Authorization: Bearer $ADMIN_TOKEN`.

| Route | Does |
|---|---|
| `GET /api/state` | runs, series, recipients, config in one payload |
| `POST /api/run` | run now; returns the same summary the page shows |
| `PUT /api/recipients` | `{"recipients":["a@b.co","c@d.co"]}` — validated, trimmed, deduped |
| `GET /api/diagnostics` | shape of each configured secret — length and plausibility, never the value |
| `PUT /api/smtp2go-region` | `{"region":"eu"}` — global, us, eu or au |
| `POST /api/test-email` | `{"recipients":["a@b.co"]}`, or omit to test every configured address |
| `POST /api/series/refresh` | pull the follows list from MangaDex |

### Testing delivery

The test email is sent **once per address**, not once with everybody in the `to` field.
That costs a few extra API calls and buys the thing that matters: when one address fails,
you learn *which*, instead of an aggregate `1 failed` that could be any of them. The
others still go out. It reports the provider's verbatim error, so an unverified sender
says so in as many words.

It touches nothing else — no `last_run`, no dedupe entries, no run history. Safe to press
whenever.

### A note on recipients

Once you edit the list in the dashboard it lives in KV, and `RECIPIENT_ADDRESS` in
[wrangler.toml](wrangler.toml) becomes just the initial seed — a redeploy will not
overwrite your edits. The page says which of the two is in effect.

## Configuration reference

| Name | Type | Purpose |
|---|---|---|
| `MD_CREDENTIALS` | **Secrets Store** | MangaDex personal client as JSON. Bound from store `7d16eedb…` / `MangaDexAPI`. `clientId` + `clientSecret` required; `username` + `password` optional |
| `MD_CLIENT_ID` | secret | fallback if `MD_CREDENTIALS` is unset |
| `MD_CLIENT_SECRET` | secret | fallback if `MD_CREDENTIALS` is unset |
| `MD_USERNAME` | secret | *optional* fallback — only for self-bootstrapping |
| `MD_PASSWORD` | secret | *optional* fallback — only for self-bootstrapping |
| `SMTP2GO_API_KEY` | **Secrets Store** | SMTP2GO API key (`api-…`), `email/send` permission. Bound from store `7d16eedb…` / `smtp2goApiKey` — required when `MAIL_PROVIDER=smtp2go` |
| `GRAPH_TENANT_ID` | secret | M365 tenant — required when `MAIL_PROVIDER=graph` |
| `GRAPH_CLIENT_ID` | secret | app registration — `graph` only |
| `GRAPH_CLIENT_SECRET` | secret | app registration — `graph` only |
| `ADMIN_TOKEN` | **Secrets Store** | dashboard password + API bearer token. Bound from store `7d16eedb…` / `AdminToken`. Unset ⇒ no HTTP surface at all |
| `TRIGGER_SECRET` | secret | older name for `ADMIN_TOKEN`, still honoured |
| `MAIL_PROVIDER` | var | `smtp2go` (default) or `graph` |
| `SMTP2GO_REGION` | var | initial region: `global`/`us`/`eu`/`au`; the dashboard's KV value wins |
| `SENDER_ADDRESS` | var | from-address; must be a verified sender on SMTP2GO |
| `SENDER_NAME` | var | *optional* display name on the From line |
| `RECIPIENT_ADDRESS` | var | initial recipient(s); the dashboard's KV list wins once set |
| `LANGUAGES` | var | default `en` |
| `NABU_STATE` | KV | `refresh_token`, `last_run`, `seen:{chapterId}` |

Every secret above may be supplied either as a Worker secret / `.dev.vars` string or as a
Secrets Store binding; [src/secrets.ts](src/secrets.ts) accepts both.

Tunables live in [src/constants.ts](src/constants.ts): page size, pagination cap, the
overlap window, the seeding window, and the User-Agent. The cron expression is in
[wrangler.toml](wrangler.toml).

---

## Notes for future me

- **`createdAtSince` format is strict**: `YYYY-MM-DDTHH:MM:SS`, UTC, no milliseconds and
  no trailing `Z`. Anything else is a 400.
- **`includes[]=manga`** is what makes the series title available for the email. Without
  it a chapter carries only relationship IDs and you would need one extra request each.
- **Set the User-Agent on every outbound request**, the `auth.mangadex.org` calls
  included. Workers do not populate it automatically on outbound `fetch()`, and unlike
  browser fetch it is not a forbidden header. Spoofing a browser UA violates MangaDex's
  terms and is enforced. If this Worker ever develops a bug and starts hammering them,
  that header is the difference between an email asking you to fix it and a silent ban.
- **SMTP2GO has two transports.** SMTP (`mail.smtp2go.com`, ports 2525/587/465, an SMTP
  *user* + password) and an HTTP API (an *API key*). Only the second works from a Worker,
  since Cloudflare blocks outbound port 25. Same account, same quota, same dashboard
  logs — the difference is which credential you create.
- **Dedupe on chapter IDs, not `publishAt`** — timestamps get adjusted when uploads are
  edited.
- **`contentRating[]` is not set**, so MangaDex's default applies: suggestive is
  included, pornographic is not. Add the parameter in `src/mangadex.ts` to change that.
- The global API rate limit is 5 req/s — irrelevant at this cron interval unless
  pagination misbehaves, which is why it is capped.

---

## Appendix: Microsoft Graph

Only needed if you set `MAIL_PROVIDER = "graph"`. SMTP2GO is the default and needs none
of this.

In the Entra admin center (<https://entra.microsoft.com>) → **App registrations** → **New
registration** (single tenant, no redirect URI):

1. Note the **Application (client) ID** and **Directory (tenant) ID**.
2. **Certificates & secrets** → **New client secret** → note the *value*.
3. **API permissions** → **Add a permission** → **Microsoft Graph** → **Application
   permissions** → `Mail.Send` → **Grant admin consent**.

`Mail.Send` as an application permission means send-as-anyone, tenant-wide. Narrow it to
the one mailbox before deploying:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline -UserPrincipalName admin@yourdomain.example

# A mail-enabled security group holding just the sending mailbox.
New-DistributionGroup -Name "nabu-senders" -Type Security `
  -PrimarySmtpAddress nabu-senders@yourdomain.example `
  -Members nabu@yourdomain.example

New-ApplicationAccessPolicy -AppId <GRAPH_CLIENT_ID> `
  -PolicyScopeGroupId nabu-senders@yourdomain.example `
  -AccessRight RestrictAccess `
  -Description "nabu may only send as nabu@yourdomain.example"

# Should say Granted for the sender and Denied for anyone else.
Test-ApplicationAccessPolicy -Identity nabu@yourdomain.example -AppId <GRAPH_CLIENT_ID>
Test-ApplicationAccessPolicy -Identity someone.else@yourdomain.example -AppId <GRAPH_CLIENT_ID>
```

Policy changes can take up to an hour to propagate. On tenants using the newer
RBAC-for-applications model, the equivalent is a scoped role assignment instead:

```powershell
New-ManagementRoleAssignment -Name "nabu-mail-send" -App <GRAPH_CLIENT_ID> `
  -Role "Application Mail.Send" -CustomResourceScope nabu@yourdomain.example
```

## License

Apache-2.0. See [LICENSE](LICENSE).
