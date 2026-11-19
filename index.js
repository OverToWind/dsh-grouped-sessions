/**
 * Host half of dsh-grouped-sessions.
 *
 * Owns the persisted group store (`~/.dsh/dsh-grouped-sessions.json`) and serves
 * it to the Web Client half over a small loopback-only JSON route family, plus
 * one agent tool so a session can be organised without the GUI.
 *
 * Why a plain file and not the storage domain facility: the store is one small
 * document that must stay readable and hand-editable, and it must not depend
 * on which storage backends a profile happens to mount.
 *
 * A group record is `{ id, workspaceId, name, order, sessionIds }`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Route prefix owned by this plugin. */
const API = '/api/dsh-grouped-sessions'

/** Largest accepted request body. */
const MAX_BODY_BYTES = 1024 * 1024

/** Longest accepted group name. */
const MAX_NAME = 80

/** Absolute path of the store document. */
function storePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-grouped-sessions.json')
}

/** Coerce one stored record into a usable group, dropping anything unusable. */
function normalizeGroup(raw, index) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (workspaceId === '' || name === '') return undefined
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'group-' + randomUUID()
  const sessionIds = Array.isArray(raw.sessionIds)
    ? raw.sessionIds.filter(value => typeof value === 'string' && value !== '')
    : []
  const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index
  return { id, workspaceId, name, order, sessionIds: [...new Set(sessionIds)] }
}

/** Store file used before the package was renamed, kept for a one-time read. */
function legacyStorePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-session-groups.json')
}

/** Read the whole store, tolerating a missing or damaged file. */
async function readStore() {
  let text
  try {
    text = await readFile(storePath(), 'utf8')
  } catch {
    try {
      text = await readFile(legacyStorePath(), 'utf8')
    } catch {
      return []
    }
  }
  try {
    const parsed = JSON.parse(text)
    const rawGroups = Array.isArray(parsed.groups) ? parsed.groups : []
    const groups = []
    rawGroups.forEach((raw, index) => {
      const group = normalizeGroup(raw, index)
      if (group !== undefined) groups.push(group)
    })
    return groups
  } catch {
    return []
  }
}

/** Write the store atomically (temp file + rename). */
async function writeStore(groups) {
  const target = storePath()
  await mkdir(dirname(target), { recursive: true })
  const temp = target + '.' + process.pid + '.tmp'
  await writeFile(temp, JSON.stringify({ version: 1, groups }, null, 2) + '\n', 'utf8')
  await rename(temp, target)
}

/** Sorted view of every group. */
function sortedGroups(groups) {
  return [...groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** Remove one session from every group of one workspace. */
function detach(groups, workspaceId, sessionId) {
  for (const group of groups) {
    if (group.workspaceId !== workspaceId) continue
    group.sessionIds = group.sessionIds.filter(id => id !== sessionId)
  }
}

/**
 * Build a machine-readable mutation failure.
 * The Client half translates `code` into UI copy, so the message stays a
 * diagnostic for logs instead of raw English leaking into a localized page.
 * @param code - stable failure code.
 * @param message - English diagnostic.
 */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Resolve one group by id or fail the mutation. */
function requireGroup(groups, rawId) {
  const id = typeof rawId === 'string' ? rawId : ''
  const group = groups.find(item => item.id === id)
  if (group === undefined) throw fail('unknown-group', 'unknown group: ' + id)
  return group
}

/** Apply one mutation to the group list in memory. */
function applyMutation(groups, body) {
  const action = typeof body.action === 'string' ? body.action : ''
  if (action === 'create') {
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : ''
    if (workspaceId === '') throw fail('missing-workspace', 'workspaceId is required')
    if (name === '') throw fail('missing-name', 'name is required')
    const order = groups.reduce((max, group) => Math.max(max, group.order + 1), 0)
    groups.push({ id: 'group-' + randomUUID(), workspaceId, name, order, sessionIds: [] })
    return
  }
  if (action === 'rename') {
    const group = requireGroup(groups, body.groupId)
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : ''
    if (name === '') throw fail('missing-name', 'name is required')
    group.name = name
    return
  }
  if (action === 'delete') {
    const group = requireGroup(groups, body.groupId)
    groups.splice(groups.indexOf(group), 1)
    return
  }
  if (action === 'assign') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') throw fail('missing-session', 'sessionId is required')
    const groupId = typeof body.groupId === 'string' ? body.groupId : ''
    if (groupId === '') {
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
      if (workspaceId === '') throw fail('missing-workspace', 'workspaceId is required to ungroup a session')
      detach(groups, workspaceId, sessionId)
      return
    }
    const group = requireGroup(groups, groupId)
    detach(groups, group.workspaceId, sessionId)
    if (!group.sessionIds.includes(sessionId)) group.sessionIds.push(sessionId)
    return
  }
  if (action === 'move') {
    const group = requireGroup(groups, body.groupId)
    const direction = typeof body.direction === 'string' ? body.direction : ''
    if (direction !== 'up' && direction !== 'down') throw fail('invalid-direction', 'direction must be up or down')
    const siblings = groups
      .filter(item => item.workspaceId === group.workspaceId)
      .sort((left, right) => left.order - right.order)
    const from = siblings.indexOf(group)
    const to = direction === 'up' ? from - 1 : from + 1
    /* Already at the edge: nothing to swap, and not an error worth a banner. */
    if (from < 0 || to < 0 || to >= siblings.length) return
    siblings[from] = siblings[to]
    siblings[to] = group
    /* Renumber the siblings so a duplicate order can never stall a later swap. */
    siblings.forEach((item, index) => { item.order = index })
    return
  }
  if (action === 'reorder') {
    const ids = Array.isArray(body.groupIds)
      ? body.groupIds.filter(value => typeof value === 'string')
      : []
    ids.forEach((id, index) => {
      const group = groups.find(item => item.id === id)
      if (group !== undefined) group.order = index
    })
    return
  }
  throw fail('unknown-action', 'unknown action: ' + action)
}

/** True when the request comes from this machine. */
function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === ''
}

/** Read and parse a small JSON request body. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw fail('body-too-large', 'request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail('invalid-body', 'body must be a JSON object')
  return parsed
}

/**
 * Turn a thrown failure into the response body the Client half reads.
 * `error` is the stable code the page translates; `message` stays a diagnostic.
 * @param error - anything thrown while handling a mutation.
 */
function failure(error) {
  const code = error instanceof Error && typeof error.code === 'string' ? error.code : 'failed'
  return { error: code, message: error instanceof Error ? error.message : String(error) }
}

/** Write one JSON response. */
function writeJson(response, status, value) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(value))
}

/** Project the store onto the wire shape. */
function groupsPayload(groups) {
  return sortedGroups(groups).map(group => ({
    id: group.id,
    workspaceId: group.workspaceId,
    name: group.name,
    sessionIds: [...group.sessionIds],
  }))
}

/**
 * Services this plugin needs before `apply` runs. Declaring them is what keeps
 * the route family from silently disappearing when the plugin activates before
 * the web server (or the tool registry) is up.
 */
export const inject = ['webServer', 'tools']

/**
 * Mount the group store: its route family and its agent tool.
 * @param ctx - host context.
 */
export function apply(ctx) {
  /** Mutation queue: every read-modify-write waits for the previous one. */
  let mutations = Promise.resolve()

  /** Serialize one read-modify-write against the store file. */
  const mutate = async body => {
    const run = mutations.then(async () => {
      const groups = await readStore()
      applyMutation(groups, body)
      await writeStore(groups)
    })
    mutations = run.catch(() => {})
    await run
    return readStore()
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => {
      const disposers = [
        webServer.register({
          kind: 'exact',
          path: API + '/state',
          handler: async (request, response) => {
            if (!isLoopback(request)) return writeJson(response, 403, { error: 'forbidden: loopback-only' })
            if ((request.method ?? 'GET') !== 'GET') return writeJson(response, 405, { error: 'method not allowed' })
            writeJson(response, 200, { groups: groupsPayload(await readStore()) })
          },
        }),
        webServer.register({
          kind: 'exact',
          path: API + '/mutate',
          handler: async (request, response) => {
            if (!isLoopback(request)) return writeJson(response, 403, { error: 'forbidden: loopback-only' })
            if ((request.method ?? 'GET') !== 'POST') return writeJson(response, 405, { error: 'method not allowed' })
            let body
            try {
              body = await readJsonBody(request)
            } catch (error) {
              return writeJson(response, 400, failure(error))
            }
            try {
              writeJson(response, 200, { groups: groupsPayload(await mutate(body)) })
            } catch (error) {
              writeJson(response, 400, failure(error))
            }
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-grouped-sessions: routes')
  }

  const tools = ctx.get('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    ctx.effect(() => tools.register({
      name: 'session_groups',
      description: 'List, create, rename, reorder and delete session groups, and move a session into or out of a group. The same groups appear in the "Session groups" sidebar panel.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'rename', 'delete', 'assign', 'move'],
          required: true,
          description: 'list reads every group; create/rename/delete change one group; assign moves one session into a group (or out of every group when groupId is empty); move shifts one group one step up or down among its workspace groups.',
        },
        workspaceId: { type: 'string', description: 'Workspace the group belongs to. Required by create, and by assign when groupId is empty.' },
        groupId: { type: 'string', description: 'Target group id, from list.' },
        name: { type: 'string', description: 'Group name, for create and rename.' },
        sessionId: { type: 'string', description: 'Session to move, for assign.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Where to shift the group, for move.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['groups'],
          properties: {
            groups: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'workspaceId', 'name', 'sessionIds'],
                properties: {
                  id: { type: 'string' },
                  workspaceId: { type: 'string' },
                  name: { type: 'string' },
                  sessionIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.groups.length === 0
            ? 'no session groups yet'
            : value.groups.map(group => group.name + ' (' + group.sessionIds.length + ') — ' + group.id).join('\n'),
        }],
      },
      async execute(args) {
        const action = typeof args.action === 'string' ? args.action : 'list'
        const groups = action === 'list' ? await readStore() : await mutate(args)
        return { groups: groupsPayload(groups) }
      },
    }), 'dsh-grouped-sessions: tools')
  }
}
