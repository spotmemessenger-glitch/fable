#!/usr/bin/env bash
#
# Runs once ON the instance, as root, from provision.sh. Turns a bare Amazon
# Linux box into something that can serve Spot Me over https.
#
#   bootstrap.sh <hostname>
#
# Safe to re-run: every step checks before it acts.

set -euo pipefail
HOST="${1:?hostname required}"
APP_DIR=/srv/spotme
WEB_DIR="$APP_DIR/web"

echo "▸ Host: $HOST"

# ── packages ────────────────────────────────────────────────────────────────
dnf -q -y update
dnf -q -y install nginx git tar gzip
# Node from the distro repos rather than a third-party install script: fewer
# moving parts, and it is what the security updates will keep patched.
dnf -q -y install nodejs npm || dnf -q -y install nodejs20 npm

echo "▸ node $(node --version), nginx $(nginx -v 2>&1 | grep -o '[0-9.]*')"

mkdir -p "$WEB_DIR"
chown -R ec2-user:ec2-user "$APP_DIR"

# ── nginx ───────────────────────────────────────────────────────────────────
# The cache rules are the point of moving here. Vite fingerprints every asset
# (index-A1b2C3.js), so those are immutable and can be cached for a year — but
# index.html must NEVER be cached, or a phone keeps loading the old bundle and
# no amount of pull-to-refresh helps. That mismatch is the single most common
# cause of "the update did not arrive".
cat > /etc/nginx/conf.d/spotme.conf <<NGINX
server {
    listen 80;
    server_name $HOST;
    root $WEB_DIR;
    index index.html;

    # The entry document decides which bundle the phone loads. Cache it and the
    # phone is frozen on an old build; never cache it and every deploy lands.
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        expires -1;
    }
    # nginx has no mime entry for .webmanifest and falls back to
    # application/octet-stream, which some browsers refuse to parse — the app
    # then silently loses its icon and full-screen install.
    location = /manifest.webmanifest {
        types { } default_type application/manifest+json;
        add_header Cache-Control "no-cache" always;
        expires -1;
    }

    # Fingerprinted assets: the name changes when the content does, so these
    # can be held forever and never revalidated.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }

    # The API lives in the same origin, so no CORS preflight on every call.
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;          # voice cloning is slow
        client_max_body_size 25m;         # audio uploads
    }

    # A hash-router app: unknown paths must return index.html, not a 404.
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
NGINX

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ── https ───────────────────────────────────────────────────────────────────
# Not optional: getUserMedia, WebRTC and service workers are all refused on
# plain http, so without a certificate the app cannot use a camera, a
# microphone, or connect a call at all.
if [[ ! -d "/etc/letsencrypt/live/$HOST" ]]; then
  echo "▸ Requesting a certificate for $HOST"
  dnf -q -y install certbot python3-certbot-nginx
  # --register-unsafely-without-email: no address to hand over, and expiry
  # warnings are moot while the renewal timer below is running.
  certbot --nginx -d "$HOST" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect \
    || echo "⚠ certbot failed — the site is up on http, but cameras and calls will not work until this succeeds"
else
  echo "▸ Certificate already present"
fi
systemctl enable --now certbot-renew.timer 2>/dev/null || true

# ── api service ─────────────────────────────────────────────────────────────
# Started even though the code is not deployed yet, so the first deploy only
# has to drop files and restart. Restart=always covers the gap: it will fail,
# back off, and come up the moment there is something to run.
cat > /etc/systemd/system/spotme-api.service <<UNIT
[Unit]
Description=Spot Me API
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=8080
EnvironmentFile=-$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/api/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable spotme-api 2>/dev/null || true

# A holding page, so the address answers with something honest before the first
# deploy rather than an nginx welcome screen.
if [[ ! -f "$WEB_DIR/index.html" ]]; then
  cat > "$WEB_DIR/index.html" <<'HOLD'
<!doctype html><meta charset=utf-8><title>Spot Me</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#0f0f10">
<div style="text-align:center"><div style="font-size:20px;font-weight:700;color:#1b8a9d">Spot Me</div>
<p>Server is up. Nothing deployed here yet.</p></div>
HOLD
  chown ec2-user:ec2-user "$WEB_DIR/index.html"
fi

echo "▸ Bootstrap complete — https://$HOST"
