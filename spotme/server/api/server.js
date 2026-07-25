/**
 * Spot Me — the API, off Vercel.
 *
 * The four endpoints already exist as Vercel functions and are well tested, so
 * this does not reimplement them: it is an adapter that gives each handler the
 * `req`/`res` shape Vercel hands it, and routes to the same files. One
 * behaviour, one place to fix a bug, whichever host is serving.
 *
 * The username registry deliberately keeps talking to Vercel Blob. Its token
 * works from anywhere — it is an HTTP API, not a Vercel-only binding — and the
 * registry is a few kilobytes of username→id records. Moving it to a file on
 * this instance would trade a managed store for one that dies with the box.
 *
 * Sits behind nginx on 127.0.0.1:8080; nginx owns TLS and static files.
 */
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8080

/** Bigger than any real call; voice cloning posts a recording as base64. */
const MAX_BODY_BYTES = 25 * 1024 * 1024

const ROUTES = {
  '/api/username': './username.js',
  '/api/translate': './translate.js',
  '/api/turn': './turn.js',
  '/api/voice': './voice.js'
}

/** Loaded once and reused — importing per request would recompile every time. */
const handlers = new Map()
async function handlerFor (route) {
  if (!handlers.has(route)) {
    const mod = await import(new URL(ROUTES[route], `file://${join(HERE, '/')}`).href)
    handlers.set(route, mod.default)
  }
  return handlers.get(route)
}

/** Collect the body, refusing anything absurd rather than buffering it all. */
function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Vercel hands handlers a request with `query` and a parsed `body`, and a
 * response with chainable `status()` and `json()`. Node's own objects have
 * none of that, so the handlers would break in ways that only show at runtime.
 */
function adapt (req, res, url, rawBody) {
  req.query = Object.fromEntries(url.searchParams)
  if (rawBody) {
    // Handlers accept a string and parse it themselves, so a malformed body
    // becomes their 400 rather than a 500 from in here.
    try { req.body = JSON.parse(rawBody) } catch { req.body = rawBody }
  }

  res.status = (code) => { res.statusCode = code; return res }
  res.json = (value) => {
    if (!res.headersSent) res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(value))
    return res
  }
  return { req, res }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const route = ROUTES[url.pathname] ? url.pathname : null

  if (!route) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  try {
    const rawBody = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : ''
    adapt(req, res, url, rawBody)
    const handler = await handlerFor(route)
    await handler(req, res)
    // A handler that returned without answering would hang the connection
    // until nginx timed it out — 300s of a phone waiting on nothing.
    if (!res.writableEnded) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: 'no response' }))
    }
  } catch (error) {
    const code = error?.statusCode || 500
    console.error(`[api] ${req.method} ${url.pathname} -> ${code}:`, error?.message)
    if (!res.headersSent) {
      res.statusCode = code
      res.setHeader('content-type', 'application/json')
    }
    // Never relay the raw message: these handlers talk to paid vendors, and one
    // already leaked a provider name and pricing tier through an error string.
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: code === 413 ? 'payload too large' : 'server error' }))
    }
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[api] listening on 127.0.0.1:${PORT}`)
  console.log(`[api] routes: ${Object.keys(ROUTES).join(', ')}`)
})

// systemd restarts on failure; log the reason first so the journal says why.
process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection:', reason)
})
