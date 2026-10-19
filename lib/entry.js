/**
 * dsh-delete-archived host half (HTTP-route design).
 *
 * Registers two HTTP routes on the browser carrier and one model-facing tool:
 *   POST /plugin/dsh-delete-archived/delete   { sessionId } → { deleted, ... }
 *   GET  /plugin/dsh-delete-archived/list                    → { sessions: [...] }
 *   tool delete_archived_conversation(sessionId)
 *
 * `deleteArchived` permanently removes one ARCHIVED session: its JSONL storage
 * directory and its workspace registry entries (archive set, pin set, and every
 * workspace account). It refuses only a session that is not archived. Being
 * archived means stop-and-archive already stopped the agent and the host's
 * ArchivedSessionGate refuses further steps, so the log is no longer written;
 * whether the controller still holds the session is reported (`heldAtDelete`),
 * not used to refuse.
 *
 * Concurrency and failure behaviour:
 *   - one in-flight deletion per session id; a second request waits for the
 *     first and then observes its outcome (the disk removal is idempotent);
 *   - the persisted log is removed first and the registry entries after it, so
 *     an interrupted run leaves no silently resurrected log: re-running the same
 *     deletion finishes the registry cleanup;
 *   - registry failures are reported per field instead of aborting the response.
 *
 * Route safety: both routes only serve loopback Hosts (the desktop carrier
 * listens on 127.0.0.1), reject cross-site / mismatched-Origin callers, and the
 * write route accepts only POST with a bounded `application/json` body. No
 * plugin `Config` schema and no Typert Remote are used, so there is no cordis
 * config-schema contract and no gateway namespace to wire.
 */

import { homedir } from 'node:os'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'dsh-delete-archived'
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions', 'sessionQuery']

/** Largest accepted request body; the only body we accept is `{ sessionId }`. */
const MAX_BODY_BYTES = 8 * 1024
/** Session ids the host mints are `session-<uuid>`; anything else is rejected. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Hosts that count as the local carrier. Anything else is refused. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0:0:0:0:0:0:0:1'])

// ── path encoding (mirrors @deepseek-ai/dsh-session-persistence-jsonl/src/format.ts) ──

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

function sessionDir(root, cwd, id) {
  const project = (cwd === undefined || cwd === null || cwd === '')
    ? join(root, '_no-cwd')
    : join(root, projectKey(cwd))
  return join(project, encodeSegment(id))
}

function resolveRoot(config) {
  const configured = typeof config?.root === 'string' && config.root.length > 0 ? config.root : undefined
  if (configured !== undefined) return configured
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = env.length > 0 ? env : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ── pending-deletion journal ────────────────────────────────────────────────
// The log file is removed before the registry entries, so an interrupted run
// leaves "log gone, marker still archived". The journal is what makes a retry
// converge: while it exists the archived check is bypassed and the remaining
// cleanup steps are finished, and it is removed only once every step passed.

function journalPathFor(sessionsRoot, sessionId) {
  return join(dirname(sessionsRoot), 'delete-archived', 'pending', sessionId + '.json')
}

function readJournal(file, sessionId) {
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  // Only a journal this plugin wrote for the very same session may bypass the
  // archived gate; anything else is treated as absent (and therefore refused).
  if (value.sessionId !== sessionId) return undefined
  if (typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) return undefined
  return value
}

function writeJournal(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function clearJournal(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* best effort: a leftover journal only makes the next retry resume */
  }
}

function respondJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(Buffer.byteLength(body)))
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

// ────────────────────────────────────────────────────────────── request guard

/** Lower-cased hostname part of a Host header, keeping an IPv6 bracket form. */
function hostnameOf(hostHeader) {
  const host = String(hostHeader).toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(0, end + 1) : ''
  }
  const colon = host.lastIndexOf(':')
  return colon > 0 ? host.slice(0, colon) : host
}

/**
 * Accept only callers that can have come from the local carrier page:
 * a loopback Host (the desktop server binds 127.0.0.1), no cross-site fetch
 * metadata, and — when the browser sends an Origin — the very same origin.
 * @param req - the incoming request.
 * @returns whether the request may reach the handlers at all.
 */
function isTrustedRequest(req) {
  const hostHeader = req.headers?.host
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  if (!LOOPBACK_HOSTS.has(hostnameOf(hostHeader))) return false

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.host.toLowerCase() !== hostHeader.toLowerCase()) return false
  }
  return true
}

/** Read a JSON body, refusing declared or actual sizes above the bound. */
async function readJsonBody(req) {
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw fail('session-delete/body-too-large', `请求正文超过 ${MAX_BODY_BYTES} 字节上限`)
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw fail('session-delete/body-too-large', `请求正文超过 ${MAX_BODY_BYTES} 字节上限`)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw fail('session-delete/bad-json', '请求正文不是合法 JSON')
  }
}

/** Host plugin body: register the routes and the agent tool. */
export function apply(ctx, config = {}) {
  const root = resolveRoot(config)
  const locks = new Map()

  /** Serialize work per session id; a queued caller runs after the current one. */
  function withSessionLock(sessionId, work) {
    const previous = locks.get(sessionId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.then(() => {}, () => {})
    locks.set(sessionId, settled)
    settled.then(() => {
      if (locks.get(sessionId) === settled) locks.delete(sessionId)
    })
    return run
  }

  /**
   * Whether the host currently holds this session in its controller. Being held
   * is NOT being writable: archiving stops the agent and the host's
   * ArchivedSessionGate refuses further steps, so this is recorded as evidence
   * and never used as a refusal.
   */
  function heldSession(sessionId) {
    const sessions = ctx.sessions
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
    return sessions.get(sessionId)
  }

  async function listArchived() {
    const registry = ctx.workspaceRegistry
    const archived = Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : []
    const rows = []
    for (const sessionId of archived) {
      let snapshot
      try {
        snapshot = await ctx.sessionPersistence.stat(sessionId)
      } catch {
        snapshot = undefined
      }
      if (snapshot === undefined) continue
      let title = null
      try {
        const read = await ctx.sessionQuery.readTitle(sessionId)
        title = typeof read?.title === 'string' && read.title.length > 0 ? read.title : null
      } catch {
        title = null
      }
      rows.push({
        sessionId,
        title,
        cwd: typeof snapshot.header?.cwd === 'string' ? snapshot.header.cwd : null,
        createdAt: typeof snapshot.header?.createdAt === 'number' ? snapshot.header.createdAt : null,
      })
    }
    rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return { sessions: rows }
  }

  async function deleteArchived(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw fail('gateway/bad-request', 'sessionDelete 需要一个非空的 sessionId')
    }
    if (!SESSION_ID_RE.test(sessionId)) {
      throw fail('gateway/bad-request', `sessionId 格式不合法：${sessionId}`)
    }

    return await withSessionLock(sessionId, async () => {
      const registry = ctx.workspaceRegistry

      const journalFile = journalPathFor(root, sessionId)
      const journal = readJournal(journalFile, sessionId)
      if (journal === undefined) {
        const archived = Array.isArray(registry.archivedSessionIds)
          ? registry.archivedSessionIds
          : [...(registry.archivedSessionIds ?? [])]
        if (!archived.includes(sessionId)) {
          throw fail('session-delete/not-archived', `会话 ${sessionId} 未归档，拒绝删除（只允许删除已归档对话）`)
        }
      }

      // Archived already means stop-and-archive stopped the agent and the host's
      // ArchivedSessionGate refuses further steps; the JSONL backend opens the
      // log only for the duration of one append. So "still held by the
      // controller" is not "still writable" — record it, never refuse on it.
      let heldAtDelete = false
      try {
        heldAtDelete = heldSession(sessionId) !== undefined
      } catch {
        heldAtDelete = false
      }

      // Journal first: if this run dies after the log is gone but before the
      // registry is clean, the next call resumes instead of being refused as
      // "not archived".
      if (journal === undefined) {
        writeJournal(journalFile, { sessionId, startedAt: new Date().toISOString() })
      }

      const snapshot = await ctx.sessionPersistence.stat(sessionId)
      if (snapshot !== undefined) {
        await rm(sessionDir(root, snapshot.header?.cwd, sessionId), { recursive: true, force: true })
      }

      // Notify the Web client's session list that this session is gone. The
      // client maintains its session rows from the `api-session/added` /
      // `api-session/removed` forwarded events; a directly-deleted persisted
      // session has no such event otherwise, so without this emit it lingers as
      // an ungrouped (stray) row in the unarchived area.
      try {
        ctx.emit('api-session/removed', sessionId)
      } catch (error) {
        ctx.logger?.warn?.('dsh-delete-archived: notify removed failed', error)
      }

      // Registry cleanup runs after the log is gone, so a failure here leaves a
      // stale marker rather than a resurrected log; rerunning the deletion is
      // idempotent and finishes the cleanup.
      const registryErrors = []
      try {
        await registry.unarchiveSession(sessionId)
      } catch (error) {
        registryErrors.push('unarchive: ' + (error instanceof Error ? error.message : String(error)))
      }
      try {
        await registry.unpinSession(sessionId)
      } catch (error) {
        registryErrors.push('unpin: ' + (error instanceof Error ? error.message : String(error)))
      }
      for (const workspace of registry.list()) {
        const ids = workspace.sessionIds
        if (Array.isArray(ids) && ids.includes(sessionId) && typeof workspace.detachSession === 'function') {
          try {
            await workspace.detachSession(sessionId)
          } catch (error) {
            registryErrors.push('detach: ' + (error instanceof Error ? error.message : String(error)))
          }
        }
      }

      let persistenceRemoved = true
      try {
        persistenceRemoved = (await ctx.sessionPersistence.stat(sessionId)) === undefined
      } catch {
        persistenceRemoved = false
      }

      // The journal is consumed only once every step actually passed; otherwise
      // it stays behind so the next call resumes the cleanup.
      if (persistenceRemoved && registryErrors.length === 0) clearJournal(journalFile)

      return {
        deleted: true,
        sessionId,
        persistenceRemoved,
        heldAtDelete,
        registryUpdated: registryErrors.length === 0,
        ...(registryErrors.length > 0 ? { registryErrors } : {}),
      }
    })
  }

  // Delete route: POST + application/json + bounded body, loopback callers only.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugin/dsh-delete-archived/delete',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        respondJson(res, 405, { code: 'method-not-allowed', message: 'POST only' })
        return
      }
      if (!isTrustedRequest(req)) {
        respondJson(res, 403, { code: 'session-delete/untrusted-caller', message: '仅接受本机同源调用' })
        return
      }
      const contentType = String(req.headers?.['content-type'] ?? '')
      if (!/^application\/json\b/i.test(contentType)) {
        res.setHeader('Accept-Post', 'application/json')
        respondJson(res, 415, { code: 'session-delete/unsupported-media-type', message: '只接受 application/json' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const result = await deleteArchived(body?.sessionId)
        respondJson(res, 200, result)
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'session-delete/failed'
        const status = code === 'session-delete/body-too-large' ? 413
          : code === 'gateway/bad-request' || code === 'session-delete/bad-json' ? 400
            : code === 'session-delete/live-session' || code === 'session-delete/not-archived' ? 409
              : 400
        respondJson(res, status, { code, message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-delete-archived: delete route')

  // List route: GET, loopback callers only.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugin/dsh-delete-archived/list',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        respondJson(res, 405, { code: 'method-not-allowed', message: 'GET only' })
        return
      }
      if (!isTrustedRequest(req)) {
        respondJson(res, 403, { code: 'session-delete/untrusted-caller', message: '仅接受本机同源调用' })
        return
      }
      try {
        respondJson(res, 200, await listArchived())
      } catch (error) {
        respondJson(res, 400, { code: 'session-delete/failed', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-delete-archived: list route')

  // Model-facing tool, deferred until the tools registry is available.
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'delete_archived_conversation',
      description:
        'Permanently delete an archived conversation by its sessionId. Refused unless the '
        + 'session is archived in the workspace registry; archiving already stopped its agent '
        + 'and the host gate refuses further steps, so its log is no longer written. The '
        + 'deletion removes the persisted session log and the workspace registration and '
        + 'cannot be undone.',
      parameters: {
        sessionId: {
          type: 'string',
          required: true,
          description: 'The archived session id (e.g. "session-xxxxxxxx-xxxx-...").',
        },
      },
      execute: (args) => deleteArchived(args.sessionId),
    }), 'dsh-delete-archived: tool')
  })
}
