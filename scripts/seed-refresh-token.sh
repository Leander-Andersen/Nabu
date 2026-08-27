#!/usr/bin/env bash
#
# Mints a MangaDex refresh token and writes it to KV, so the Worker never needs
# your account password.
#
# Your password is typed here, on your machine, and goes straight to
# auth.mangadex.org. It is read with `read -s` (never echoed), passed to curl
# via --data-urlencode (never in your shell history), and is not written to disk.
#
#   ./scripts/seed-refresh-token.sh
#
# Re-run this if nabu ever logs that the refresh token was rejected.

set -euo pipefail

USER_AGENT="nabu/1.0 (+https://github.com/Leander-Andersen/Nabu; security@isame12.no)"
TOKEN_ENDPOINT="https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token"
KV_BINDING="NABU_STATE"

for cmd in curl jq npx; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: '$cmd' is required but not installed." >&2; exit 1; }
done

echo "MangaDex credentials — from https://mangadex.org/settings -> API Clients"
echo "(click your client, e.g. CFWorkerGlobalSecret, for the ID and Get Secret)"
echo

read -r  -p "MangaDex username : " MD_USERNAME
read -rs -p "MangaDex password : " MD_PASSWORD; echo
read -r  -p "Client ID         : " MD_CLIENT_ID
read -rs -p "Client secret     : " MD_CLIENT_SECRET; echo
echo

[ -n "$MD_USERNAME" ] && [ -n "$MD_PASSWORD" ] && [ -n "$MD_CLIENT_ID" ] && [ -n "$MD_CLIENT_SECRET" ] \
  || { echo "error: all four values are required." >&2; exit 1; }

echo "Requesting a token from MangaDex..."
response=$(curl -sS -X POST "$TOKEN_ENDPOINT" \
  -H "User-Agent: $USER_AGENT" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "username=${MD_USERNAME}" \
  --data-urlencode "password=${MD_PASSWORD}" \
  --data-urlencode "client_id=${MD_CLIENT_ID}" \
  --data-urlencode "client_secret=${MD_CLIENT_SECRET}")

# Drop the password from the environment as soon as it is no longer needed.
unset MD_PASSWORD MD_CLIENT_SECRET

refresh_token=$(printf '%s' "$response" | jq -r '.refresh_token // empty')

if [ -z "$refresh_token" ]; then
  echo >&2
  echo "Failed to get a refresh token. MangaDex replied:" >&2
  printf '%s' "$response" | jq '.' >&2 2>/dev/null || printf '%s\n' "$response" >&2
  echo >&2
  echo "Common causes:" >&2
  echo "  - client still pending staff approval (the dot on the API Clients page)" >&2
  echo "  - wrong username/password, or the client belongs to another account" >&2
  echo "  - client secret regenerated since you last copied it" >&2
  exit 1
fi

# Hand the token to wrangler via a file so it never appears in argv or history.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s' "$refresh_token" > "$tmp"
chmod 600 "$tmp"

echo "Got a refresh token. Writing it to KV ($KV_BINDING/refresh_token)..."
npx wrangler kv key put refresh_token --path "$tmp" --binding "$KV_BINDING" --remote

echo
echo "Done. nabu can now authenticate without your password."
echo "Next: npx wrangler deploy   (the first run seeds silently and sends no mail)"
