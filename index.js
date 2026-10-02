/**
 * Host half of the download dashboard.
 *
 * Serves the machine-readable download state that the companion `dl.ps1` writes
 * under the temporary directory, so the Client half can render a floating
 * monitor without a model turn and without depending on job ownership (a
 * download started by a sub-agent is invisible in the parent session's job
 * roster, but its state file is not).
 *
 * Read-only: this half never writes or deletes anything.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Where the downloader publishes one JSON file per download. */
const STATE_DIR = join(tmpdir(), 'dsh-downloads', 'state')

/** Entries older than this are ignored, so a stale file never haunts the panel. */
const STALE_MS = 24 * 60 * 60 * 1000

/** A non-`/api` prefix: the gateway's own routes require connection auth, this one does not. */
const ROUTE = '/dsh-downloads/state'

/**
 * The fields the panel actually consumes. A state file may carry more (the
 * downloader records the source URL, which can hold a signature or an embedded
 * credential); the route is a public surface and returns only this list.
 */
const EXPOSED_FIELDS = [
  'id',
  'name',
  'out',
  'totalBytes',
  'doneBytes',
  'speedBps',
  'etaSec',
  'status',
  'attempt',
  'error',
  'startedAt',
  'updatedAt',
]

/**
 * Narrow one state record to the exposed fields.
 * @param value - the parsed record.
 * @returns a fresh object carrying only the exposed fields.
 */
function projectEntry(value) {
  const projected = {}
  for (const field of EXPOSED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) projected[field] = value[field]
  }
  return projected
}

/**
 * The socket peer, when the runtime exposes one.
 * @param req - the incoming request.
 * @returns the peer address, or null when unavailable.
 */
function peerAddress(req) {
  try {
    const address = req && req.socket ? req.socket.remoteAddress : undefined
    return typeof address === 'string' && address !== '' ? address : null
  } catch {
    return null
  }
}

/**
 * Whether an address is this machine.
 * @param address - a socket peer address.
 * @returns whether it is loopback.
 */
function isLoopbackAddress(address) {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  )
}

/**
 * Whether a Host header names this machine.
 * @param host - the raw Host header.
 * @returns whether it is a loopback authority.
 */
function isLoopbackHost(host) {
  return (
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:') ||
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '[::1]' ||
    host.startsWith('[::1]:')
  )
}

/**
 * Decide whether this route may answer a request.
 *
 * The web server registry does not inherit the Harness connection's
 * authentication, so this route is its own boundary. No single header is one:
 * `Host` is client-controlled, and a deployment that binds the web server to
 * `0.0.0.0` for LAN access would otherwise answer anyone who sends
 * `Host: 127.0.0.1:<port>`. Three independent gates instead:
 *
 *  - the socket peer must be loopback (kernel-supplied, unforgeable);
 *  - a `Host` header, when the runtime sends one, must name this machine;
 *  - no cross-site browser markers, and an `Origin`, when present, must be
 *    same-origin — the same pair the Harness gateway checks.
 *
 * A missing `Host` is tolerated only while the peer address vouches for the
 * caller: the desktop shell's forwarding proxy deletes that header.
 * @param req - the incoming request.
 * @returns whether the request is local.
 */
function isLocalRequest(req) {
  const headers = (req && req.headers) || {}
  const peer = peerAddress(req)
  if (peer !== null && !isLoopbackAddress(peer)) return false
  if (String(headers['sec-fetch-site'] || '') === 'cross-site') return false
  const host = String(headers.host || '')
  if (headers.origin !== undefined) {
    if (host === '') return false
    try {
      if (new URL(String(headers.origin)).host !== host) return false
    } catch {
      return false
    }
  }
  if (host !== '') return isLoopbackHost(host)
  return peer !== null && isLoopbackAddress(peer)
}

/**
 * Read every fresh state file. An unreadable or half-written file is skipped:
 * a partially written JSON is a normal race, not a condition to report. A file
 * whose timestamp cannot be read counts as stale, so a truncated record can
 * never become a row that outlives every cleanup path.
 * @returns the parsed download entries, oldest start first.
 */
async function readDownloads() {
  let names
  try {
    const entries = await readdir(STATE_DIR, { withFileTypes: true })
    names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name)
  } catch {
    // No download has ever run on this machine.
    return []
  }
  const now = Date.now()
  const downloads = []
  for (const name of names) {
    try {
      const value = JSON.parse(await readFile(join(STATE_DIR, name), 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const updated = Date.parse(String(value.updatedAt ?? ''))
      if (!Number.isFinite(updated) || now - updated > STALE_MS) continue
      downloads.push(projectEntry(value))
    } catch {
      continue
    }
  }
  downloads.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
  return downloads
}

/**
 * Host half entry point.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const route = {
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(body))
        }
        if (!isLocalRequest(req)) {
          send(403, { error: 'local requests only' })
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405).end()
          return
        }
        try {
          send(200, { now: Date.now(), downloads: await readDownloads() })
        } catch (error) {
          send(500, { error: String((error && error.message) || error) })
        }
      },
    }
    scope.effect(() => scope.webServer.register(route), 'dsh-download-dashboard: state route')
  })
}
