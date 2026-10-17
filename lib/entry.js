/**
 * dsh-delete-archived host half (HTTP-route design).
 *
 * Registers two HTTP routes on the browser carrier and one model-facing tool:
 *   POST /plugin/dsh-delete-archived/delete   { sessionId } → { deleted, ... }
 *   GET  /plugin/dsh-delete-archived/list                    → { sessions: [...] }
 *   tool delete_archived_conversation(sessionId)
 *
 * `deleteArchived` permanently removes one ARCHIVED session: its JSONL
 * storage directory and its workspace registry entries (archive set, pin set,
 * and every workspace account). It refuses any session that is not archived or
 * still loaded in memory (a live session would rewrite its log on the next
 * flush and resurrect the data).
 *
 * No plugin `Config` schema and no Typert Remote are used, so there is no
 * cordis config-schema contract and no gateway namespace to wire: the Web
 * client calls the plain routes above. The sessions root resolves here
 * (config.root → $DSH_HOME → ~/.dsh/sessions).
 */

import { homedir } from 'node:os'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'dsh-delete-archived'
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions', 'sessionQuery']

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

function respondJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(Buffer.byteLength(body)))
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  return JSON.parse(text)
}

/** Host plugin body: register the routes and the agent tool. */
export function apply(ctx, config = {}) {
  const root = resolveRoot(config)

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
    const registry = ctx.workspaceRegistry

    const archived = Array.isArray(registry.archivedSessionIds)
      ? registry.archivedSessionIds
      : [...(registry.archivedSessionIds ?? [])]
    if (!archived.includes(sessionId)) {
      throw fail('session-delete/not-archived', `会话 ${sessionId} 未归档，拒绝删除（只允许删除已归档对话）`)
    }

    // An archived session's agent has already been stopped by stop-and-archive,
    // and the ArchivedSessionGate blocks it from running another step. The JSONL
    // backend opens the log only for the duration of one append and closes it
    // immediately, so deleting the directory is safe even while the (idle)
    // session object is still resident in memory; it will not rewrite the log.

    const snapshot = await ctx.sessionPersistence.stat(sessionId)
    if (snapshot !== undefined) {
      await rm(sessionDir(root, snapshot.header?.cwd, sessionId), { recursive: true, force: true })
    }

    // Notify the Web client's session list that this session is gone. The
    // client maintains its session rows from the `api-session/added` /
    // `api-session/removed` forwarded events (emitted by sessionController on
    // `session/created` / `session/disposed`); a directly-deleted persisted
    // session has no such event otherwise, so without this emit it lingers as
    // an ungrouped (stray) row in the unarchived area after unarchiving.
    try {
      ctx.emit('api-session/removed', sessionId)
    } catch (error) {
      ctx.logger?.warn?.('dsh-delete-archived: notify removed failed', error)
    }

    await registry.unarchiveSession(sessionId)
    await registry.unpinSession(sessionId)
    for (const workspace of registry.list()) {
      const ids = workspace.sessionIds
      if (Array.isArray(ids) && ids.includes(sessionId) && typeof workspace.detachSession === 'function') {
        await workspace.detachSession(sessionId)
      }
    }

    let persistenceRemoved = true
    try {
      persistenceRemoved = (await ctx.sessionPersistence.stat(sessionId)) === undefined
    } catch {
      persistenceRemoved = false
    }

    return { deleted: true, sessionId, persistenceRemoved }
  }

  // Delete route.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugin/dsh-delete-archived/delete',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        respondJson(res, 405, { code: 'method-not-allowed', message: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const result = await deleteArchived(body?.sessionId)
        respondJson(res, 200, result)
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'session-delete/failed'
        respondJson(res, 400, { code, message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-delete-archived: delete route')

  // List route.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugin/dsh-delete-archived/list',
    handler: async (_req, res) => {
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
        'Permanently delete an archived conversation by its sessionId. Only works for '
        + 'sessions that are already archived in the workspace registry and not loaded in '
        + 'memory; the deletion removes the persisted session log and the workspace '
        + 'registration and cannot be undone.',
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
