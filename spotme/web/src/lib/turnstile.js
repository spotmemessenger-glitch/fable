/**
 * Cloudflare Turnstile on the signup surface — client half (ADR-032).
 *
 * PRESENCE GATE: everything here keys off the build-time env name
 * TURNSTILE_SITE_KEY (injected by vite as __TURNSTILE_SITE_KEY__). Without it
 * — the repo's permanent state until the owner creates a Turnstile site and
 * sets keys — every export is a cheap no-op: no script tag, no widget, no
 * token, no header. The backend gate is bypassed in exactly the same
 * key-absent way, so neither side changes behavior until BOTH keys exist.
 *
 * INVISIBLE MODE + THE A11Y FALLBACK. The widget renders with
 * `appearance: 'interaction-only'`: nothing is shown while Cloudflare clears
 * the browser silently, which is the overwhelmingly common path. When
 * Turnstile decides it needs interaction, the widget becomes visible INSIDE
 * the signup form (the container mountTurnstile() was given) as Cloudflare's
 * standard checkbox — which ships its own keyboard focus handling, ARIA
 * labelling, and localisation. Users who fail or block the challenge are not
 * silently stuck: token acquisition times out to null, the request goes out
 * without the header, and the server answers a clean 403 the form surfaces —
 * the documented fallback is "retry, or contact support", never an
 * audio-CAPTCHA maze.
 *
 * Tokens are SINGLE-USE server-side, so turnstileToken() runs a fresh
 * execution per call (guest signup's 409-retry needs its own token).
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const TOKEN_TIMEOUT_MS = 12_000

/** The header name the backend gate reads (Cloudflare's own field name). */
export const TURNSTILE_HEADER = 'cf-turnstile-response'

export function turnstileSiteKey () {
  // typeof-guard: the define only exists in vite builds, not in node tests.
  // eslint-disable-next-line no-undef
  return (typeof __TURNSTILE_SITE_KEY__ === 'string' && __TURNSTILE_SITE_KEY__) || ''
}

/** True only with a site key AND a DOM — node/test contexts stay inert. */
export function turnstileEnabled () {
  return Boolean(turnstileSiteKey()) && typeof document !== 'undefined'
}

/** Attach the token header when (and only when) a token exists. */
export function withTurnstileHeader (headers, token) {
  if (token) headers[TURNSTILE_HEADER] = token
  return headers
}

let scriptPromise = null
function loadTurnstileScript () {
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    if (globalThis.turnstile) return resolve(globalThis.turnstile)
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.onload = () => resolve(globalThis.turnstile)
    s.onerror = () => { scriptPromise = null; reject(new Error('turnstile script failed to load')) }
    document.head.appendChild(s)
  })
  return scriptPromise
}

let widgetId = null
let pendingResolve = null

/**
 * Mount the widget into the signup form. Invisible until Cloudflare needs
 * interaction; a plain empty div (and nothing else) when disabled. Safe to
 * call more than once — the widget mounts once.
 */
export async function mountTurnstile (container) {
  if (!turnstileEnabled() || !container || widgetId !== null) return null
  try {
    const ts = await loadTurnstileScript()
    widgetId = ts.render(container, {
      sitekey: turnstileSiteKey(),
      appearance: 'interaction-only', // invisible unless a challenge is required
      execution: 'execute', // tokens are minted on demand by turnstileToken()
      callback: (token) => { pendingResolve?.(token); pendingResolve = null },
      'error-callback': () => { pendingResolve?.(null); pendingResolve = null },
      'timeout-callback': () => { pendingResolve?.(null); pendingResolve = null }
    })
    return widgetId
  } catch {
    return null // script blocked/unreachable — token stays null, server fails open on ITS outage, 403s on verdicts
  }
}

/**
 * Mint one fresh token (single-use). Resolves null when disabled, when the
 * widget could not mount, or after TOKEN_TIMEOUT_MS — callers send the
 * request either way and let the server answer.
 */
export async function turnstileToken () {
  if (!turnstileEnabled()) return null
  try {
    const ts = await loadTurnstileScript()
    if (widgetId === null) {
      // No form-mounted widget (e.g. token needed after onboarding was torn
      // down) — mount into an offscreen host so execute still works.
      const fallback = document.createElement('div')
      fallback.setAttribute('data-turnstile-host', 'offscreen')
      document.body.appendChild(fallback)
      await mountTurnstile(fallback)
      if (widgetId === null) return null
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { pendingResolve = null; resolve(null) }, TOKEN_TIMEOUT_MS)
      pendingResolve = (token) => { clearTimeout(timer); resolve(token) }
      try {
        ts.reset(widgetId) // a used/expired token cannot be re-served
        ts.execute(widgetId)
      } catch {
        clearTimeout(timer)
        pendingResolve = null
        resolve(null)
      }
    })
  } catch {
    return null
  }
}
