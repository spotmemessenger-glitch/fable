-- Native push registration tokens (FCM / APNs).
--
-- Why this exists alongside PushSubscription: Capacitor's Android WebView
-- exposes no PushManager and no Notification API (verified on-device), so the
-- packaged app can NEVER receive Web Push. A browser PWA can receive only Web
-- Push. The two transports address completely different things — a browser
-- endpoint with a p256dh/auth keypair versus an opaque vendor token — so they
-- get separate tables rather than a column full of nulls.

CREATE TABLE "DeviceToken" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "platform"   TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- The token is the natural key: a reinstall mints a new one, and re-registering
-- the same device must update a row rather than add a duplicate that would fire
-- the same notification twice.
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");

ALTER TABLE "DeviceToken"
  ADD CONSTRAINT "DeviceToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
