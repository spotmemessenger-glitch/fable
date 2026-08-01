/**
 * The fields of a `User` that may travel to SOMEONE ELSE.
 *
 * `findByUsername`, `stories` and `groups` already hand-wrote this shape; four
 * other places said `include: { user: true }` instead and shipped the whole
 * row. A `User` carries `passwordHash` and `claimSecretHash` — and
 * `claimSecretHash` is an unsalted SHA-256 of a client-generated secret that is
 * the SOLE credential for `guestAuth`, so offline recovery of a weak one is
 * account takeover. It also carries `email`, `phone`, `city`, `age`, `sex` and
 * `ageVerifyRef`.
 *
 * Sending someone a chat request was enough to collect theirs. Sharing a
 * conversation, or blocking them, was too.
 *
 * A named constant rather than four copies, so the next `include` has an
 * obvious right answer to reach for.
 */
export const PUBLIC_USER = {
  id: true,
  username: true,
  name: true,
  avatarUrl: true,
  publicKey: true,
} as const;

/**
 * What YOU may see of your own row. Demographics belong here and nowhere else;
 * the two credential hashes belong in neither.
 */
export const SELF_USER = {
  ...PUBLIC_USER,
  email: true,
  phone: true,
  city: true,
  area: true,
  age: true,
  sex: true,
  ageVerified: true,
  role: true,
  createdAt: true,
} as const;
