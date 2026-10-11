/**
 * OpenAPI bridge plugin — app-grouped edition.
 *
 * Turns OpenAPI style interface definitions (OpenAI function/tool format, or
 * OpenAPI 3.x specs) into searchable, invocable registrations, organized as
 * 「apps」(packages): one registration run produces one app, and every operation
 * belongs to exactly one app. Tags are a loose cross-app net on top of that.
 *
 * Discovery path the model is meant to follow — cheap to expensive:
 *   oa_apps()             -> directory: which apps exist, how many ops, what for
 *   oa_apps(app)          -> operations in one app: names + one-line summaries
 *   oa_describe(app, op)  -> that operation's full parameter contract
 *   oa_invoke / oa_activate -> actually call it
 *
 * Tools:
 *   oa_register   — parse an OpenAPI source and register it as an app.
 *   oa_apps       — directory (no args) or expand one app (arg: app).
 *   oa_describe   — full contract of one operation.
 *   oa_search     — keyword/tag fallback search; query optional (= list all).
 *   oa_invoke     — call a registered operation (loose JSON args).
 *   oa_activate   — TEMPORARILY expose one operation as a NATIVE model tool.
 *   oa_deactivate — un-expose an activated native tool.
 *   oa_active     — list currently activated native tools.
 *   oa_remove     — remove one operation, or a whole app.
 *
 * The registry persists to $DSH_HOME/storages/openapi-registry.json (override
 * with the `storagePath` config) so registrations survive a Host restart.
 * API keys are deliberately NEVER written to disk; a restored app that had one
 * reports apiKeyLost: true instead of silently failing with a 401.
 *
 * Network goes through ctx.get('proxyFetch') when the proxy plugin is present,
 * else native fetch.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

const REGISTRY_VERSION = 2

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** True when a value looks like a plain object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize a value so it survives the harness's strict lossless-JSON gate:
 * undefined fields are dropped and -0 becomes 0. EVERY tool output goes
 * through this — a raw `description: undefined` from an OpenAPI parameter is
 * exactly what used to kill oa_search outright.
 */
function sanitizeLossless(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value
  if (Array.isArray(value)) return value.map((item) => sanitizeLossless(item))
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = sanitizeLossless(item)
    }
    return out
  }
  if (value instanceof Date) return value.toISOString()
  return null
}

/** Collapse whitespace and cap length — keeps directory output cheap. */
function truncate(text, max) {
  const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** Split a comma/space separated tag string into a clean unique list. */
function parseTags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
}

/** Fetch JSON from a URL, preferring the proxyFetch service when present. */
async function fetchJson(url, opts = {}, ctx) {
  const timeoutMs = opts.timeoutMs || 30000
  const proxy = ctx && typeof ctx.get === 'function' ? ctx.get('proxyFetch') : undefined
  let text
  if (proxy !== undefined) {
    const r = await proxy.fetch(url, { timeoutMs })
    text = r.text
  } else {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`)
      }
      text = await response.text()
    } finally {
      clearTimeout(timer)
    }
  }
  return JSON.parse(text)
}

/** Send a JSON HTTP request (any method) through native fetch. */
async function sendJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`)
    }
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: true, text }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Extract (name, description, parameters) from one function/tool entry. */
function extractFunctionShape(entry) {
  if (isPlainObject(entry)) {
    if (isPlainObject(entry.function)) {
      const fn = entry.function
      return { name: fn.name, description: fn.description, parameters: fn.parameters }
    }
    if (typeof entry.name === 'string') {
      return { name: entry.name, description: entry.description, parameters: entry.parameters }
    }
  }
  return null
}

/**
 * Attach a parameter schema without ever writing an `undefined` value: the
 * harness rejects such an object as "not lossless JSON", which previously made
 * oa_search unusable for any spec whose parameters lacked descriptions.
 */
function putProperty(properties, key, schema, description) {
  const node = isPlainObject(schema) ? { ...schema } : { type: 'string' }
  if (description !== undefined && description !== null) node.description = description
  properties[key] = node
}

/**
 * Parse an OpenAPI-ish source into function shapes.
 *   - OpenAI tools array: [{type:'function', function:{name,description,parameters}}]
 *   - OpenAI functions array: [{name,description,parameters}]
 *   - a single function/tool object
 *   - OpenAPI 3.x spec: {openapi:'3.x', paths:{...}} -> one entry per operation
 * OpenAPI `operation.tags` are preserved onto each shape (they used to be
 * dropped on the floor) so they can drive tag search.
 */
function parseFunctions(source) {
  const shapes = []
  if (Array.isArray(source)) {
    for (const entry of source) {
      const shape = extractFunctionShape(entry)
      if (shape && shape.name) shapes.push(shape)
    }
    return shapes
  }
  if (!isPlainObject(source)) return shapes

  if (typeof source.openapi === 'string' && isPlainObject(source.paths)) {
    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
    for (const [path, item] of Object.entries(source.paths)) {
      if (!isPlainObject(item)) continue
      for (const method of methods) {
        const op = item[method]
        if (!isPlainObject(op)) continue
        const name = op.operationId
          || `${method}${path.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')}`
        const parameters = { type: 'object', additionalProperties: true, properties: {} }
        const required = []
        const collect = (paramList) => {
          if (!Array.isArray(paramList)) return
          for (const p of paramList) {
            if (!isPlainObject(p) || !p.name) continue
            putProperty(parameters.properties, p.name, p.schema, p.description)
            if (p.required) required.push(p.name)
          }
        }
        collect(op.parameters)
        if (isPlainObject(op.requestBody) && isPlainObject(op.requestBody.content)) {
          const jsonContent = op.requestBody.content['application/json']
          if (isPlainObject(jsonContent) && isPlainObject(jsonContent.schema)) {
            const schema = jsonContent.schema
            if (isPlainObject(schema.properties)) {
              for (const [key, value] of Object.entries(schema.properties)) {
                putProperty(parameters.properties, key, value, isPlainObject(value) ? value.description : undefined)
              }
              if (Array.isArray(schema.required)) required.push(...schema.required)
            }
          }
        }
        if (required.length > 0) parameters.required = [...new Set(required)]
        shapes.push({
          name,
          description: op.summary || op.description || `${method.toUpperCase()} ${path}`,
          parameters,
          tags: Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string') : [],
          meta: { kind: 'openapi', method, path },
        })
      }
    }
    return shapes
  }

  const single = extractFunctionShape(source)
  if (single && single.name) shapes.push(single)
  return shapes
}

/** Pull app-level metadata out of an OpenAPI document. */
function readDocumentMeta(source) {
  const meta = { title: '', description: '', tags: [] }
  if (!isPlainObject(source)) return meta
  if (isPlainObject(source.info)) {
    if (typeof source.info.title === 'string') meta.title = source.info.title.trim()
    if (typeof source.info.description === 'string') meta.description = truncate(source.info.description, 240)
  }
  if (Array.isArray(source.tags)) {
    for (const t of source.tags) {
      if (isPlainObject(t) && typeof t.name === 'string') meta.tags.push(t.name)
      else if (typeof t === 'string') meta.tags.push(t)
    }
  }
  return meta
}

/** Host of a base URL, used as a fallback app name. */
function hostOf(baseUrl) {
  if (!baseUrl) return ''
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

/** Build a strict parameter map for native-tool registration from a shape. */
function strictParameters(parameters, depth = 0) {
  const props = isPlainObject(parameters) && isPlainObject(parameters.properties) ? parameters.properties : {}
  const required = Array.isArray(parameters && parameters.required) ? parameters.required : []
  const out = {}
  for (const [key, value] of Object.entries(props)) {
    const node = isPlainObject(value) ? value : { type: 'json' }
    const prop = {}
    if (typeof node.type === 'string') {
      prop.type = node.type
      if (node.type === 'object' && depth < 6) {
        prop.additionalProperties = node.additionalProperties === false ? false : true
        if (isPlainObject(node.properties)) {
          prop.properties = strictParameters({ type: 'object', properties: node.properties, required: node.required }, depth + 1)
        }
      } else if (node.type === 'array' && isPlainObject(node.items) && depth < 6) {
        prop.items = isPlainObject(node.items.properties)
          ? strictParameters({ type: 'object', properties: node.items.properties, required: node.items.required }, depth + 1)
          : { type: node.items.type || 'json' }
        if (!prop.items.type) prop.items = { type: 'json' }
      }
    } else {
      prop.type = 'json'
    }
    if (node.description !== undefined) prop.description = String(node.description)
    if (Array.isArray(node.enum)) prop.enum = node.enum
    if (node.const !== undefined) prop.const = node.const
    if (required.includes(key)) prop.required = true
    out[key] = prop
  }
  return out
}

export function applyOneApi(ctx, config = {}, report = () => {}) {
  const apps = new Map() // appName -> app record
  const active = new Map() // toolName -> disposer
  const activeSource = new Map() // toolName -> { app, name }

  // ---------------------------------------------------------------- storage

  function storagePath() {
    if (config && config.storagePath) return String(config.storagePath)
    const home = process.env.DSH_HOME ? String(process.env.DSH_HOME) : join(homedir(), '.dsh')
    return join(home, 'storages', 'openapi-registry.json')
  }

  function serializeApp(app) {
    return {
      name: app.name,
      title: app.title,
      description: app.description,
      baseUrl: app.baseUrl,
      model: app.model,
      tags: app.tags,
      source: app.source,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      // NEVER persist the key itself — only the fact that one was supplied.
      hadApiKey: Boolean(app.apiKey),
      ops: [...app.ops.values()].map((op) => ({
        name: op.name,
        description: op.description,
        parameters: op.parameters,
        tags: op.tags,
        meta: op.meta,
      })),
    }
  }

  let storageWarning = ''

  async function saveRegistry() {
    if (config && config.persist === false) return
    const file = storagePath()
    try {
      const payload = {
        version: REGISTRY_VERSION,
        savedAt: new Date().toISOString(),
        apps: [...apps.values()].map(serializeApp),
      }
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmp, file)
      storageWarning = ''
    } catch (error) {
      storageWarning = `注册表未能写入磁盘（${file}）：${error instanceof Error ? error.message : String(error)}`
      report('storage', error)
    }
  }

  function restoreRegistry() {
    if (config && config.persist === false) return
    const file = storagePath()
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return // no file yet — first run
    }
    try {
      const payload = JSON.parse(raw)
      if (!isPlainObject(payload) || !Array.isArray(payload.apps)) return
      for (const a of payload.apps) {
        if (!isPlainObject(a) || typeof a.name !== 'string' || !a.name) continue
        const app = {
          name: a.name,
          title: typeof a.title === 'string' && a.title ? a.title : a.name,
          description: typeof a.description === 'string' ? a.description : '',
          baseUrl: typeof a.baseUrl === 'string' ? a.baseUrl : '',
          apiKey: '',
          apiKeyLost: Boolean(a.hadApiKey),
          model: typeof a.model === 'string' ? a.model : '',
          tags: Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === 'string') : [],
          source: typeof a.source === 'string' ? a.source : '',
          createdAt: typeof a.createdAt === 'string' ? a.createdAt : '',
          updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
          ops: new Map(),
        }
        const ops = Array.isArray(a.ops) ? a.ops : []
        for (const op of ops) {
          if (!isPlainObject(op) || typeof op.name !== 'string' || !op.name) continue
          app.ops.set(op.name, {
            name: op.name,
            app: a.name,
            description: typeof op.description === 'string' ? op.description : op.name,
            parameters: isPlainObject(op.parameters) ? op.parameters : { type: 'object', additionalProperties: true, properties: {} },
            tags: Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string') : [],
            meta: isPlainObject(op.meta) ? op.meta : { kind: 'openai' },
          })
        }
        apps.set(app.name, app)
      }
    } catch (error) {
      report('storage', error)
    }
  }

  // -------------------------------------------------------------- registry

  function totalOps() {
    let n = 0
    for (const app of apps.values()) n += app.ops.size
    return n
  }

  function appNames() {
    return [...apps.keys()].sort()
  }

  function ensureApp(name, opts, meta) {
    const now = new Date().toISOString()
    let app = apps.get(name)
    if (!app) {
      app = {
        name,
        title: meta.title || name,
        description: meta.description || '',
        baseUrl: opts.baseUrl || '',
        apiKey: opts.apiKey || '',
        apiKeyLost: false,
        model: opts.model || '',
        tags: [],
        source: opts.sourceLabel || '',
        createdAt: now,
        updatedAt: now,
        ops: new Map(),
      }
      apps.set(name, app)
    }
    if (meta.title) app.title = meta.title
    if (meta.description) app.description = meta.description
    if (opts.baseUrl) app.baseUrl = opts.baseUrl
    if (opts.apiKey) {
      app.apiKey = opts.apiKey
      app.apiKeyLost = false
    }
    if (opts.model) app.model = opts.model
    if (opts.sourceLabel) app.source = opts.sourceLabel
    for (const tag of [...meta.tags, ...(opts.tags || [])]) {
      if (!app.tags.includes(tag)) app.tags.push(tag)
    }
    app.updatedAt = now
    return app
  }

  function registerMany(shapes, opts, meta) {
    const appName = (opts.app || '').trim() || meta.title || hostOf(opts.baseUrl) || 'default'
    const app = ensureApp(appName, opts, meta)
    const added = []
    const updated = []
    for (const shape of shapes) {
      if (!shape || !shape.name) continue
      const entry = {
        name: String(shape.name),
        app: appName,
        description: shape.description ? String(shape.description) : String(shape.name),
        parameters: isPlainObject(shape.parameters) ? shape.parameters : { type: 'object', additionalProperties: true, properties: {} },
        tags: Array.isArray(shape.tags) ? [...new Set(shape.tags)] : [],
        meta: shape.meta || { kind: 'openai' },
      }
      const existed = app.ops.has(entry.name)
      app.ops.set(entry.name, entry)
      for (const tag of entry.tags) {
        if (!app.tags.includes(tag)) app.tags.push(tag)
      }
      ;(existed ? updated : added).push(entry.name)
    }
    app.updatedAt = new Date().toISOString()
    return { app, added, updated }
  }

  /** Every (app, entry) pair carrying this operation name. */
  function findOps(name) {
    const hits = []
    for (const app of apps.values()) {
      const entry = app.ops.get(name)
      if (entry) hits.push({ app, entry })
    }
    return hits
  }

  /** Resolve one operation, requiring `app` only when the name is ambiguous. */
  function resolveOp(name, appName) {
    const opName = String(name || '').trim()
    if (!opName) throw new Error('操作名不能为空')
    if (appName) {
      const app = apps.get(String(appName))
      if (!app) {
        throw new Error(`没有名为 "${appName}" 的包；现有包：${appNames().join(', ') || '(空)'}`)
      }
      const entry = app.ops.get(opName)
      if (!entry) {
        throw new Error(`包 "${appName}" 里没有操作 "${opName}"；该包有：${[...app.ops.keys()].sort().join(', ') || '(空)'}`)
      }
      return { app, entry }
    }
    const hits = findOps(opName)
    if (hits.length === 0) {
      throw new Error(`未注册的操作 "${opName}"；先调用 oa_apps 看看有哪些包`)
    }
    if (hits.length > 1) {
      throw new Error(`"${opName}" 在多个包里都存在，请用 app 参数指定：${hits.map((h) => h.app.name).join(', ')}`)
    }
    return hits[0]
  }

  /**
   * Parameter NAMES only. Cheap (a few bytes each) and enough to build a
   * loose-mode oa_invoke call — the expensive part is the JSON schema, which
   * stays behind oa_describe.
   */
  function paramNamesOf(entry) {
    const props = entry && entry.parameters && entry.parameters.properties
    return isPlainObject(props) ? Object.keys(props) : []
  }

  /** Required parameter names, when the schema declares any. */
  function requiredNamesOf(entry) {
    const req = entry && entry.parameters && entry.parameters.required
    return Array.isArray(req) ? req : []
  }

  function summarizeApp(app) {
    return {
      app: app.name,
      title: app.title,
      description: app.description || undefined,
      opCount: app.ops.size,
      baseUrl: app.baseUrl || null,
      tags: app.tags,
      apiKeyLost: app.apiKeyLost || undefined,
    }
  }

  // ------------------------------------------------------------- invocation

  async function invokeOpenAi(app, entry, args) {
    if (!app.baseUrl) {
      throw new Error(`包 ${app.name} 未配置 baseUrl；注册时请提供 baseUrl`)
    }
    const endpoint = `${app.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    const headers = {}
    if (app.apiKey) headers.authorization = `Bearer ${app.apiKey}`
    const tool = {
      type: 'function',
      function: { name: entry.name, description: entry.description, parameters: entry.parameters },
    }
    const body = {
      model: app.model || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `请调用函数 ${entry.name}，参数如下：${JSON.stringify(args)}。直接返回该函数的调用结果。`,
      }],
      tools: [tool],
      tool_choice: { type: 'function', function: { name: entry.name } },
    }
    const result = await sendJson(endpoint, { method: 'POST', headers, body, timeoutMs: 60000 })
    const choice = result.choices && result.choices[0]
    const message = choice && choice.message
    const calls = message && message.tool_calls
    if (Array.isArray(calls) && calls.length > 0 && calls[0].function) {
      try {
        return { ok: true, kind: 'openai', arguments: JSON.parse(calls[0].function.arguments), raw: result }
      } catch {
        return { ok: true, kind: 'openai', argumentsText: calls[0].function.arguments, raw: result }
      }
    }
    return { ok: true, kind: 'openai', raw: result }
  }

  async function invokeOpenApi(app, entry, args) {
    if (!app.baseUrl) {
      throw new Error(`包 ${app.name} 未配置 baseUrl；注册时请提供 baseUrl`)
    }
    const meta = entry.meta || {}
    const method = (meta.method || 'get').toLowerCase()
    let path = meta.path || ''
    const query = new URLSearchParams()
    const headers = {}
    if (app.apiKey) headers.authorization = `Bearer ${app.apiKey}`
    const argEntries = isPlainObject(args) ? Object.entries(args) : []
    for (const [key, value] of argEntries) {
      if (path.includes(`{${key}}`)) {
        path = path.split(`{${key}}`).join(encodeURIComponent(String(value)))
      } else if (['get', 'head', 'delete'].includes(method)) {
        query.set(key, String(value))
      }
    }
    let url = `${app.baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    const qs = query.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
    const body = ['post', 'put', 'patch'].includes(method)
      ? Object.fromEntries(argEntries.filter(([k]) => !path.includes(`{${k}}`)))
      : undefined
    const result = await sendJson(url, { method, headers, body, timeoutMs: 60000 })
    return { ok: true, kind: 'openapi', app: app.name, operation: entry.name, result: sanitizeLossless(result) }
  }

  async function invokeEntry(app, entry, args) {
    const kind = (entry.meta && entry.meta.kind) || 'openai'
    if (kind === 'openapi') return invokeOpenApi(app, entry, args)
    return invokeOpenAi(app, entry, args)
  }

  // ------------------------------------------------------ activation / undo

  function doActivate(name, toolName, appName) {
    const { app, entry } = resolveOp(name, appName)
    const finalToolName = toolName || entry.name
    if (active.has(finalToolName)) return { ok: true, toolName: finalToolName, alreadyActive: true }
    const disposer = ctx.tools.register(defineTool({
      name: finalToolName,
      description: entry.description || finalToolName,
      parameters: strictParameters(entry.parameters),
      output: objectOutput,
      async execute(callArgs) {
        return invokeEntry(app, entry, callArgs)
      },
    }))
    active.set(finalToolName, disposer)
    activeSource.set(finalToolName, { app: app.name, name: entry.name })
    return { ok: true, toolName: finalToolName, app: app.name, source: entry.name, activated: true }
  }

  function doDeactivate(toolName) {
    const disposer = active.get(toolName)
    if (disposer === undefined) return { ok: true, toolName, alreadyInactive: true }
    if (typeof disposer === 'function') disposer()
    active.delete(toolName)
    activeSource.delete(toolName)
    return { ok: true, toolName, deactivated: true }
  }

  /** Tear down any native tool exposed from this (app, op) pair. */
  function teardownFor(appName, opName) {
    const toTear = []
    for (const [toolName, ref] of activeSource.entries()) {
      if (ref.app !== appName) continue
      if (opName === undefined || ref.name === opName) toTear.push(toolName)
    }
    for (const toolName of toTear) doDeactivate(toolName)
    return toTear
  }

  function doRemove(name, appName) {
    // Whole-app removal: no operation name, just the app.
    if ((!name || !String(name).trim()) && appName) {
      const app = apps.get(String(appName))
      if (!app) return { ok: true, removed: false, warning: `没有名为 "${appName}" 的包，无需移除` }
      const torn = teardownFor(app.name, undefined)
      const opCount = app.ops.size
      apps.delete(app.name)
      return { ok: true, removed: true, app: app.name, removedOps: opCount, deactivatedTools: torn, totalApps: apps.size, totalOps: totalOps() }
    }
    let resolved
    try {
      resolved = resolveOp(name, appName)
    } catch (error) {
      // Removing something absent stays idempotent, but says what to check.
      return {
        ok: true,
        removed: false,
        warning: error instanceof Error ? error.message : String(error),
        totalApps: apps.size,
        totalOps: totalOps(),
      }
    }
    const { app, entry } = resolved
    const torn = teardownFor(app.name, entry.name)
    app.ops.delete(entry.name)
    const appEmptied = app.ops.size === 0
    if (appEmptied) apps.delete(app.name)
    return {
      ok: true,
      removed: true,
      app: app.name,
      name: entry.name,
      appEmptied: appEmptied || undefined,
      deactivatedTools: torn,
      totalApps: apps.size,
      totalOps: totalOps(),
    }
  }

  // ------------------------------------------------------------ tool wiring

  restoreRegistry()

  const registered = []
  const failed = []

  try {
    ctx.tools.register(defineTool({
      name: 'oa_register',
      description: '把 OpenAPI 格式的接口定义注册为一个「包」(app)。source 可以是 JSON 字符串（OpenAPI 3.x spec / OpenAI tools 数组 / 单个函数），也可以是指向 JSON 文档的 URL。包名默认取文档自己的 info.title（其次取 baseUrl 的主机名），可以用 app 参数覆盖。注册后请先调用 oa_apps 看目录。',
      parameters: {
        source: { type: 'string', required: true, description: 'OpenAPI 格式的 JSON 字符串或 JSON 文档 URL' },
        baseUrl: { type: 'string', description: '调用后端地址，如 http://127.0.0.1:3000（OpenAPI 路径的宿主）' },
        app: { type: 'string', description: '包名；缺省用文档 info.title，再退回 baseUrl 主机名' },
        tags: { type: 'string', description: '给整包附加的标签，逗号分隔（可选）' },
        apiKey: { type: 'string', description: '可选的 Bearer API Key（不会写入磁盘）' },
        model: { type: 'string', description: 'openai 风格的默认模型名' },
      },
      output: objectOutput,
      async execute(args) {
        const rawSource = args && args.source ? String(args.source) : ''
        if (!rawSource) throw new Error('source 不能为空')
        const isUrl = /^https?:\/\//i.test(rawSource)
        const opts = {
          baseUrl: args && args.baseUrl ? String(args.baseUrl) : '',
          app: args && args.app ? String(args.app) : '',
          tags: parseTags(args && args.tags),
          apiKey: args && args.apiKey ? String(args.apiKey) : '',
          model: args && args.model ? String(args.model) : '',
          sourceLabel: isUrl ? rawSource : '(inline JSON)',
        }
        let parsed
        if (isUrl) {
          parsed = await fetchJson(rawSource, { timeoutMs: 60000 }, ctx)
        } else {
          try {
            parsed = JSON.parse(rawSource)
          } catch (error) {
            throw new Error(`source 不是合法 JSON，也不是 URL：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const shapes = parseFunctions(parsed)
        if (shapes.length === 0) {
          return sanitizeLossless({
            ok: true,
            added: [],
            warning: '未从输入中解析出任何函数；请确认格式（OpenAPI 3.x / OpenAI tools / 单个函数对象）',
          })
        }
        const meta = readDocumentMeta(parsed)
        const { app, added, updated } = registerMany(shapes, opts, meta)
        await saveRegistry()
        return sanitizeLossless({
          ok: true,
          app: { name: app.name, title: app.title, description: app.description || undefined, opCount: app.ops.size, baseUrl: app.baseUrl || null },
          added,
          updated: updated.length ? updated : undefined,
          totalApps: apps.size,
          totalOps: totalOps(),
          storageWarning: storageWarning || undefined,
          hint: `已注册进包「${app.name}」。下一步：oa_apps() 看总目录，oa_apps("${app.name}") 看该包的操作，oa_describe 看单个操作的参数。`,
        })
      },
    }))
    registered.push('oa_register')
  } catch (error) {
    failed.push('oa_register')
    report('oa_register', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_apps',
      description: '查看已注册的 API「包」。不传参数 = 总目录：有哪些包、各含几个操作、干什么用、调用地址。传 app = 展开该包，列出里面的操作名与一句简介（不含参数细节，省上下文）。发现自己能调用什么，从这里开始。',
      parameters: {
        app: { type: 'string', description: '要展开的包名；省略则列出所有包' },
      },
      output: objectOutput,
      async execute(args) {
        const appName = args && args.app ? String(args.app) : ''
        if (!appName) {
          const list = [...apps.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(summarizeApp)
          return sanitizeLossless({
            ok: true,
            count: list.length,
            totalOps: totalOps(),
            apps: list,
            hint: list.length === 0
              ? '还没有注册任何包。用 oa_register 注册一个 OpenAPI 文档或 URL。'
              : '用 oa_apps(app="<包名>") 展开某个包，再用 oa_describe 看某个操作的参数。',
          })
        }
        const app = apps.get(appName)
        if (!app) {
          return sanitizeLossless({
            ok: false,
            error: `没有名为 "${appName}" 的包`,
            availableApps: appNames(),
            hint: '调用 oa_apps() 看全部包。',
          })
        }
        const ops = [...app.ops.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((op) => {
            const params = paramNamesOf(op)
            const required = requiredNamesOf(op)
            return {
              name: op.name,
              description: truncate(op.description, 160),
              ...(params.length ? { params } : {}),
              ...(required.length ? { required } : {}),
              ...(op.tags.length ? { tags: op.tags } : {}),
            }
          })
        return sanitizeLossless({
          ok: true,
          app: summarizeApp(app),
          count: ops.length,
          ops,
          hint: `用 oa_describe(app="${app.name}", name="<操作名>") 看参数，用 oa_invoke 直接调用。`,
        })
      },
    }))
    registered.push('oa_apps')
  } catch (error) {
    failed.push('oa_apps')
    report('oa_apps', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_describe',
      description: '查看一个已注册操作的完整契约：参数、哪些必填、返回值说明，以及所属包的调用地址与鉴权要求。在决定调用之前用它取细节——oa_apps 只给名字和简介，故意不带参数。',
      parameters: {
        name: { type: 'string', required: true, description: '操作名（来自 oa_apps 的展开结果）' },
        app: { type: 'string', description: '包名；仅当同名操作存在于多个包时才需要' },
      },
      output: objectOutput,
      async execute(args) {
        const { app, entry } = resolveOp(args && args.name, args && args.app)
        const params = isPlainObject(entry.parameters) ? entry.parameters : {}
        return sanitizeLossless({
          ok: true,
          app: app.name,
          name: entry.name,
          description: entry.description,
          tags: entry.tags.length ? entry.tags : undefined,
          kind: (entry.meta && entry.meta.kind) || 'openai',
          method: entry.meta && entry.meta.method ? String(entry.meta.method).toUpperCase() : undefined,
          path: entry.meta && entry.meta.path ? entry.meta.path : undefined,
          baseUrl: app.baseUrl || null,
          auth: app.apiKey ? 'bearer-set' : (app.apiKeyLost ? 'bearer-lost-after-restart' : 'none'),
          parameters: params,
          required: Array.isArray(params.required) ? params.required : undefined,
          call: { tool: 'oa_invoke', args: { name: entry.name, app: app.name } },
        })
      },
    }))
    registered.push('oa_describe')
  } catch (error) {
    failed.push('oa_describe')
    report('oa_describe', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_search',
      description: '按关键词搜索已注册的操作（匹配操作名、所属包名与描述），并可用 app / tag 过滤。query 可省略——省略即列出全部操作。这是「我不记得包名」时的兜底检索；正常发现路径应先走 oa_apps。结果只含包名、操作名与一句简介，不含参数细节。',
      parameters: {
        query: { type: 'string', description: '搜索关键词；省略或留空 = 列出全部操作' },
        app: { type: 'string', description: '只在这个包里搜' },
        tag: { type: 'string', description: '只返回带该标签的操作' },
      },
      output: objectOutput,
      async execute(args) {
        const query = String((args && args.query) || '').toLowerCase().trim()
        const appFilter = args && args.app ? String(args.app) : ''
        const tagFilter = args && args.tag ? String(args.tag).toLowerCase().trim() : ''
        const entries = []
        for (const app of apps.values()) {
          if (appFilter && app.name !== appFilter) continue
          for (const entry of app.ops.values()) {
            const haystack = `${entry.name} ${app.name} ${app.title} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase()
            if (query && !haystack.includes(query)) continue
            if (tagFilter && !entry.tags.some((t) => t.toLowerCase() === tagFilter)) continue
            const params = paramNamesOf(entry)
            const required = requiredNamesOf(entry)
            entries.push({
              app: app.name,
              name: entry.name,
              description: truncate(entry.description, 160),
              ...(params.length ? { params } : {}),
              ...(required.length ? { required } : {}),
              ...(entry.tags.length ? { tags: entry.tags } : {}),
              active: activeSource.has(entry.name) || undefined,
            })
          }
        }
        entries.sort((a, b) => (a.app + a.name).localeCompare(b.app + b.name))
        return sanitizeLossless({
          ok: true,
          count: entries.length,
          entries,
          hint: '用 oa_describe 看某个操作的参数；用 oa_apps() 看包包级别的总览。',
        })
      },
    }))
    registered.push('oa_search')
  } catch (error) {
    failed.push('oa_search')
    report('oa_search', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_invoke',
      description: '传参调用一个已注册的操作（通过 HTTP 请求后端，宽松模式：参数为自由 JSON）。openai 风格走 /v1/chat/completions + tool_choice；openapi 风格按 method/path 直接请求。参数细节用 oa_describe 查。',
      parameters: {
        name: { type: 'string', required: true, description: '已注册的操作名' },
        args: { type: 'json', description: '传给操作的参数对象，例如 {"city":"chengdu"}' },
        app: { type: 'string', description: '包名；仅当同名操作存在于多个包时才需要' },
      },
      output: objectOutput,
      async execute(toolArgs) {
        const { app, entry } = resolveOp(toolArgs && toolArgs.name, toolArgs && toolArgs.app)
        const callArgs = toolArgs && toolArgs.args !== undefined ? toolArgs.args : {}
        return invokeEntry(app, entry, callArgs)
      },
    }))
    registered.push('oa_invoke')
  } catch (error) {
    failed.push('oa_invoke')
    report('oa_invoke', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_activate',
      description: '把已注册的操作 TEMPORARILY 暴露为原生 model tool（严格 JSON schema，模型下一轮可直接以严格模式调用）。不用了请用 oa_deactivate 停用。',
      parameters: {
        name: { type: 'string', required: true, description: '已注册的操作名' },
        toolName: { type: 'string', description: '原生 tool 名；缺省用操作名' },
        app: { type: 'string', description: '包名；仅当同名操作存在于多个包时才需要' },
      },
      output: objectOutput,
      async execute(args) {
        return doActivate(args && args.name, args && args.toolName ? String(args.toolName) : '', args && args.app ? String(args.app) : '')
      },
    }))
    registered.push('oa_activate')
  } catch (error) {
    failed.push('oa_activate')
    report('oa_activate', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_deactivate',
      description: '停用之前通过 oa_activate 暴露的原生 tool，将其从模型工具列表中移除。',
      parameters: {
        toolName: { type: 'string', required: true, description: '要停用的原生 tool 名' },
      },
      output: objectOutput,
      async execute(args) {
        return doDeactivate(String((args && args.toolName) || ''))
      },
    }))
    registered.push('oa_deactivate')
  } catch (error) {
    failed.push('oa_deactivate')
    report('oa_deactivate', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_active',
      description: '列出当前通过 oa_activate 暴露为原生 tool 的操作。',
      parameters: {},
      output: objectOutput,
      async execute() {
        const entries = [...activeSource.entries()].map(([toolName, ref]) => ({ toolName, app: ref.app, name: ref.name }))
        return sanitizeLossless({ ok: true, count: entries.length, entries })
      },
    }))
    registered.push('oa_active')
  } catch (error) {
    failed.push('oa_active')
    report('oa_active', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_remove',
      description: '从注册表中移除内容。给 name = 移除单个操作；只给 app（不给 name）= 移除整个包。如果是已激活的原生 tool，会先自动停用。',
      parameters: {
        name: { type: 'string', description: '要移除的操作名；省略则配合 app 移除整个包' },
        app: { type: 'string', description: '包名。仅给 app 不给 name 时，整包移除' },
      },
      output: objectOutput,
      async execute(args) {
        const name = args && args.name ? String(args.name) : ''
        const appName = args && args.app ? String(args.app) : ''
        if (!name && !appName) throw new Error('至少要给 name（移除单个操作）或 app（移除整个包）')
        const result = doRemove(name, appName)
        await saveRegistry()
        return sanitizeLossless(result)
      },
    }))
    registered.push('oa_remove')
  } catch (error) {
    failed.push('oa_remove')
    report('oa_remove', error)
  }

  return { registered, failed }
}
