/**
 * Deterministic test accounts, and cleanup that cannot miss one.
 *
 * WHY GUEST SIGNUP. `/api/auth/guest` takes a CLIENT-CHOSEN id, username and
 * secret. That makes an account a pure function of the run id and the role, so
 * a test never has to search for what it created, two runs cannot collide, and
 * a crashed run leaves rows that are identifiable rather than orphaned. The
 * alternative — OTP signup — needs a mail provider, which means a credential,
 * which is exactly what this suite must not have.
 *
 * IDs ARE HEX AND USERNAMES ARE SHORT because the API says so: id must match
 * /^[a-f0-9]{8,64}$/i and username /^[a-z0-9_]{3,16}$/. Both are enforced here
 * rather than discovered as a 400 in the middle of a test.
 */
import { createHash } from 'node:crypto'

/** One id per run. Passed through the environment so every worker and the
 *  cleanup step agree on it without a file. */
export const RUN_ID = process.env.E2E_RUN_ID ||
  createHash('sha256').update(String(process.pid) + String(Date.now())).digest('hex').slice(0, 8)

const hex16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** Everything a role needs, derived. Same inputs, same account, every time. */
export function account (role) {
  const seed = `spotme-e2e|${RUN_ID}|${role}`
  return {
    id: hex16(seed),
    // 16 chars max, and the run id is in it so a leftover row names its run.
    username: `e2e${RUN_ID.slice(0, 6)}${role.slice(0, 4)}`.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16),
    secret: `e2e-secret-${hex16(seed + '|secret')}`,
    name: `E2E ${role}`,
  }
}

/** Create it server-side and return the tokens. Throws loudly — a test that
 *  silently proceeds without an account fails later, somewhere unrelated. */
export async function signUp (request, api, role) {
  const who = account(role)
  const res = await request.post(`${api}/api/auth/guest`, {
    // Wave 1B (D6): account creation requires the 18+ declaration; the e2e
    // fixtures are adults, like every fixture in the backend suites.
    data: { id: who.id, username: who.username, secret: who.secret, name: who.name, birthYearMonth: '1990-01' },
  })
  if (!res.ok()) {
    throw new Error(`could not create the ${role} account: ${res.status()} ${await res.text()}`)
  }
  return { ...who, ...(await res.json()) }
}

/**
 * Put an account's session into a browser context before the app boots.
 *
 * `addInitScript` runs BEFORE any page script, which is the only correct moment:
 * the app reads its profile during startup, so seeding afterwards produces a
 * half-initialised app that is not what any user would see.
 */
export async function seedSession (context, who) {
  await context.addInitScript(([profile, tokens]) => {
    // The real keys, read from store.js and socket-transport.js rather than
    // guessed: a wrong key here produces an app that boots signed-out and a
    // test that fails somewhere far from the cause.
    localStorage.setItem('spotme:me', profile)
    localStorage.setItem('spotme.server.tokens', tokens)
  }, [
    JSON.stringify({ id: who.userId || who.id, name: who.name, username: who.username, lang: 'en' }),
    JSON.stringify({ accessToken: who.accessToken, refreshToken: who.refreshToken }),
  ])
}

/** Delete every account this run created. `DELETE /api/users/me` is the real
 *  path a user takes, so cleanup exercises it rather than reaching into the
 *  database behind the app's back. */
export async function cleanUp (request, api, sessions) {
  const failures = []
  for (const s of sessions) {
    try {
      const res = await request.delete(`${api}/api/users/me`, {
        headers: { Authorization: `Bearer ${s.accessToken}` },
      })
      if (!res.ok() && res.status() !== 404) failures.push(`${s.username}: ${res.status()}`)
    } catch (err) {
      failures.push(`${s.username}: ${err.message}`)
    }
  }
  return failures
}
