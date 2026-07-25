#!/usr/bin/env bash
#
# Spot Me — build locally, ship to the instance.
#
#   ./deploy.sh
#
# Finds the instance by tag, so there is no address to keep in sync here. Sends
# the built site and the API, restarts the service, and checks it answered
# before claiming success.
#
# Secrets: the API needs vendor keys, which are NOT in this repo and must never
# be. Put them in spotme/web/.env.local (already gitignored) as KEY=value lines
# and this copies them to the instance as root-readable /srv/spotme/.env. If
# that file is absent the deploy still runs — the app serves, and the language
# and voice endpoints answer with errors until keys arrive.

set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
NAME="${NAME:-spotme-peer}"
KEY_FILE="${KEY_FILE:-$HOME/.spotme/$NAME.pem}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB_SRC="$HERE/../web"

# Git Bash rewrites unix-looking arguments into Windows paths before the CLI
# sees them; see the same note in provision.sh.
aws_() { MSYS_NO_PATHCONV=1 aws --region "$REGION" "$@"; }
say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$KEY_FILE" ]] || die "No key at $KEY_FILE. Run ./provision.sh first."

IP=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
[[ -n "$IP" && "$IP" != "None" ]] || die "No running instance tagged $NAME in $REGION."
HOST="${IP//./-}.sslip.io"
SSH=(ssh -o StrictHostKeyChecking=no -i "$KEY_FILE" "ec2-user@$IP")

say "Target $HOST"

# ── build ───────────────────────────────────────────────────────────────────
say "Building"
( cd "$WEB_SRC" && npm run build >/dev/null ) || die "Build failed — nothing was shipped."
[[ -f "$WEB_SRC/dist/index.html" ]] || die "No dist/index.html after build."

# ── ship ────────────────────────────────────────────────────────────────────
# tar over ssh rather than rsync or scp -r: rsync is absent on stock Windows,
# and scp -r makes a round trip per file, which is slow for a hashed asset dir.
say "Uploading site"
tar czf - -C "$WEB_SRC/dist" . | "${SSH[@]}" \
  "rm -rf /srv/spotme/web.new && mkdir -p /srv/spotme/web.new && tar xzf - -C /srv/spotme/web.new"

say "Uploading API"
# The handlers are the SAME files the Vercel functions use — one behaviour, one
# place to fix a bug. They need no npm install: node:crypto, fetch, Blob and
# FormData are all built in on Node 18+.
tar czf - -C "$WEB_SRC/api" . -C "$HERE/api" . | "${SSH[@]}" \
  "rm -rf /srv/spotme/api.new && mkdir -p /srv/spotme/api.new && tar xzf - -C /srv/spotme/api.new"

# .env.server first: the vendor keys live in Vercel, and
#   npx vercel env pull .env.server --environment production
# is how they get here. .env.local is the fallback for a machine that has them
# by hand. Both are gitignored by the .env* rule.
ENV_SRC=""
for candidate in "$WEB_SRC/.env.server" "$WEB_SRC/.env.local"; do
  [[ -f "$candidate" ]] && ENV_SRC="$candidate" && break
done

if [[ -n "$ENV_SRC" ]]; then
  say "Uploading secrets from $(basename "$ENV_SRC")"
  # Only what the API actually reads. A pulled Vercel file also carries thirty
  # build variables — VERCEL_GIT_*, TURBO_*, an OIDC token — that would be
  # noise at best and misleading at worst on a machine that is not Vercel.
  # VITE_* are compiled into the bundle and have no business here either.
  WANTED='^(AZURE_TRANSLATOR_(KEY|ENDPOINT)|GOOGLE_TRANSLATE_KEY|OPENAI_API_KEY|SARVAM_API_KEY|ELEVENLABS_API_KEY|CF_TURN_(KEY_ID|TOKEN)|BLOB_READ_WRITE_TOKEN)='
  count=$(grep -cE "$WANTED" "$ENV_SRC" || true)
  [[ "$count" -gt 0 ]] || die "No API keys found in $ENV_SRC — the language and voice endpoints would all fail."

  # `vercel env pull` does NOT export encrypted values: it writes the literal
  # string [SENSITIVE] in their place. Shipping those looks like a success and
  # fails at the vendor, which is the worst way to find out — /api/turn even
  # answers 200 because it falls back to plain STUN. Refuse them by name.
  masked=$(grep -E "$WANTED" "$ENV_SRC" | grep -c 'SENSITIVE' || true)
  if [[ "$masked" -gt 0 ]]; then
    echo
    grep -E "$WANTED" "$ENV_SRC" | grep 'SENSITIVE' | cut -d= -f1 | sed 's/^/    /'
    die "$masked of $count keys are [SENSITIVE] placeholders, not real values.
     Vercel will not export encrypted secrets. Copy the real values from the
     Vercel dashboard into $ENV_SRC (it is gitignored) and deploy again."
  fi
  grep -E "$WANTED" "$ENV_SRC"     | "${SSH[@]}" "cat > /tmp/.env && sudo mv /tmp/.env /srv/spotme/.env && sudo chown ec2-user:ec2-user /srv/spotme/.env && sudo chmod 600 /srv/spotme/.env"
  echo "  $count keys"
else
  echo "  no .env.server or .env.local — language and voice endpoints will error until keys are added"
fi

# ── swap ────────────────────────────────────────────────────────────────────
# Move the finished directories into place in one step, so a phone loading
# mid-deploy never sees a half-written site.
say "Switching over"
"${SSH[@]}" bash <<'REMOTE'
set -e
cd /srv/spotme
rm -rf web.old api.old
[ -d web ] && mv web web.old || true
[ -d api ] && mv api api.old || true
mv web.new web
mv api.new api
sudo systemctl restart spotme-api
rm -rf web.old api.old
REMOTE

# ── verify ──────────────────────────────────────────────────────────────────
say "Checking"
sleep 2
code=$("${SSH[@]}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/turn" || echo 000)
if [[ "$code" == "200" ]]; then
  echo "  api: OK"
else
  echo "  api: HTTP $code — logs:"
  "${SSH[@]}" "sudo journalctl -u spotme-api -n 15 --no-pager" || true
fi
site=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/" || echo 000)
echo "  site: HTTP $site"

printf '\n  \033[1;32mLive: https://%s\033[0m\n\n' "$HOST"
