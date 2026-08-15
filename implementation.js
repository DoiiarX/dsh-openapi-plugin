/**
 * one-api bridge plugin (persistent bundle, host composition row).
 *
 * Turns one-api style interface definitions (OpenAI function/tool format, or
 * OpenAPI 3.x specs) into searchable, invocable function registrations.
 *
 * Tools:
 *   oa_register   — accept a JSON string or URL, parse the one-api format, and
 *                   register every function found into the local registry.
 *   oa_search     — search registered functions by name/description keyword.
 *   oa_invoke     — call a registered function with arguments over HTTP
 *                   (loose mode: arguments are free JSON).
 *   oa_activate   — TEMPORARILY expose one registered function as a NATIVE
 *                   model tool with its strict JSON schema, so the model can
 *                   call it directly in the next step with schema validation.
 *   oa_deactivate — un-expose an activated native tool.
 *   oa_active     — list currently activated native tools.
 *
 * Network goes through ctx.get('proxyFetch') when the proxy plugin is present,
 * else native fetch.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** True when a value looks like a plain object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize a parsed JSON value so it survives the harness's strict lossless-JSON
 * gate on tool output. The harness rejects -0 (NaN/Infinity are already
 * impossible from JSON.parse), so normalize negative zero to 0; also guard
 * against Date objects and undefined fields that could sneak in from over-permissive
 * parsers. Mutating copies are returned so the original response is preserved.
 */
function sanitizeLossless(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) out.push(sanitizeLossless(item))
    return out
  }
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = sanitizeLossless(item)
    }
    return out
  }
  // Date, RegExp, Map, Set, etc. -> drop non-JSON wrappers via stringify
  if (value instanceof Date) return value.toISOString()
  return null
}

/**
 * Fetch text/JSON from a URL, preferring the proxyFetch service when present.
 */
async function fetchJson(url, opts = {}, ctx) {
  const timeoutMs = opts.timeoutMs || 30000
  const proxy = ctx.get('proxyFetch')
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
 * Parse a one-api interface source into a list of function shapes.
 * Supported forms:
 *   - OpenAI tools array: [{type:'function', function:{name,description,parameters}}]
 *   - OpenAI functions array: [{name,description,parameters}]
 *   - a single function/tool object
 *   - OpenAPI 3.x spec: {openapi:'3.x', paths:{...}} -> one entry per operation
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

  // OpenAPI 3.x spec
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
            const schema = isPlainObject(p.schema) ? p.schema : { type: 'string' }
            parameters.properties[p.name] = { ...schema, description: p.description }
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
                parameters.properties[key] = { ...(isPlainObject(value) ? value : { type: 'json' }), description: value?.description }
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
          meta: { kind: 'openapi', method, path },
        })
      }
    }
    return shapes
  }

  // Single function/tool object
  const single = extractFunctionShape(source)
  if (single && single.name) shapes.push(single)
  return shapes
}

/** Convert an OpenAI-style function shape into a normalized registration. */
function normalizeShape(shape, opts) {
  const parameters = isPlainObject(shape.parameters)
    ? shape.parameters
    : { type: 'object', additionalProperties: true, properties: {} }
  return {
    name: String(shape.name),
    description: shape.description ? String(shape.description) : shape.name,
    parameters,
    meta: shape.meta || { kind: 'openai' },
    baseUrl: opts.baseUrl || '',
    apiKey: opts.apiKey || '',
    model: opts.model || '',
  }
}

/** Build a strict parameter map for native-tool registration from a shape. */
function strictParameters(parameters) {
  const props = isPlainObject(parameters) && isPlainObject(parameters.properties)
    ? parameters.properties
    : {}
  const required = Array.isArray(parameters && parameters.required) ? parameters.required : []
  // Convert each property to the unified ParameterSchemaSpec shape:
  // { type, description, required? } for scalars; nested objects keep
  // additionalProperties explicit.
  const out = {}
  for (const [key, value] of Object.entries(props)) {
    const node = isPlainObject(value) ? value : { type: 'json' }
    const prop = {}
    if (typeof node.type === 'string') {
      prop.type = node.type
      if (node.type === 'object') {
        prop.additionalProperties = node.additionalProperties === false ? false : true
        if (isPlainObject(node.properties)) {
          prop.properties = strictParameters({ type: 'object', properties: node.properties, required: node.required })
        }
      } else if (node.type === 'array' && isPlainObject(node.items)) {
        prop.items = strictParameters({ type: 'object', properties: node.items.properties, required: node.items.required })
        if (!prop.items.type) {
          // items without properties: keep scalar type
          prop.items = { type: node.items.type || 'json' }
        }
      }
    } else if (typeof node.oneOf === 'object') {
      prop.type = 'json'
    } else {
      prop.type = 'json'
    }
    if (node.description !== undefined) prop.description = String(node.description)
    if (node.enum !== undefined && Array.isArray(node.enum)) prop.enum = node.enum
    if (node.const !== undefined) prop.const = node.const
    if (required.includes(key)) prop.required = true
    out[key] = prop
  }
  return out
}

export function applyOneApi(ctx, config = {}, report = () => {}) {
  // In-memory registry: name -> normalized registration
  const registry = new Map()
  // Activated native tools: toolName -> disposer
  const active = new Map()
  // Mapping from native toolName back to the registration name.
  const activeSource = new Map()

  function registerMany(shapes, opts) {
    const added = []
    for (const shape of shapes) {
      if (!shape || !shape.name) continue
      const entry = normalizeShape(shape, opts)
      const prev = registry.get(entry.name)
      if (prev) {
        if (!entry.baseUrl && prev.baseUrl) entry.baseUrl = prev.baseUrl
        if (!entry.apiKey && prev.apiKey) entry.apiKey = prev.apiKey
        if (!entry.model && prev.model) entry.model = prev.model
      }
      registry.set(entry.name, entry)
      added.push(entry.name)
    }
    return added
  }

  /** Call an openai-kind function through /v1/chat/completions. */
  async function invokeOpenAi(entry, args) {
    if (!entry.baseUrl) {
      throw new Error(`函数 ${entry.name} 未配置 baseUrl；注册时请提供 baseUrl`)
    }
    const endpoint = `${entry.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    const headers = {}
    if (entry.apiKey) headers.authorization = `Bearer ${entry.apiKey}`
    const tool = {
      type: 'function',
      function: { name: entry.name, description: entry.description, parameters: entry.parameters },
    }
    const body = {
      model: entry.model || 'gpt-4o-mini',
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

  /** Call an openapi-kind function: substitute path params, build query/body. */
  async function invokeOpenApi(entry, args) {
    if (!entry.baseUrl) {
      throw new Error(`函数 ${entry.name} 未配置 baseUrl；注册时请提供 baseUrl`)
    }
    const meta = entry.meta || {}
    const method = (meta.method || 'get').toLowerCase()
    let path = meta.path || ''
    const query = new URLSearchParams()
    const headers = {}
    if (entry.apiKey) headers.authorization = `Bearer ${entry.apiKey}`
    const argEntries = isPlainObject(args) ? Object.entries(args) : []
    for (const [key, value] of argEntries) {
      if (path.includes(`{${key}}`)) {
        path = path.split(`{${key}}`).join(encodeURIComponent(String(value)))
      } else if (['get', 'head', 'delete'].includes(method)) {
        query.set(key, String(value))
      }
    }
    let url = `${entry.baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    const qs = query.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
    const body = ['post', 'put', 'patch'].includes(method)
      ? Object.fromEntries(argEntries.filter(([k]) => !path.includes(`{${k}}`)))
      : undefined
    const result = await sendJson(url, { method, headers, body, timeoutMs: 60000 })
    return { ok: true, kind: 'openapi', result: sanitizeLossless(result) }
  }

  /** Dispatch an invocation to the right backend based on the entry kind. */
  async function invokeEntry(entry, args) {
    const kind = (entry.meta && entry.meta.kind) || 'openai'
    if (kind === 'openapi') return invokeOpenApi(entry, args)
    return invokeOpenAi(entry, args)
  }

  function doActivate(name, toolName) {
    const entry = registry.get(name)
    if (!entry) throw new Error(`未注册的函数 "${name}"`)
    if (active.has(toolName)) return { ok: true, toolName, alreadyActive: true }
    const disposer = ctx.tools.register(defineTool({
      name: toolName,
      description: entry.description || toolName,
      parameters: strictParameters(entry.parameters),
      output: objectOutput,
      async execute(callArgs) {
        return invokeEntry(entry, callArgs)
      },
    }))
    active.set(toolName, disposer)
    activeSource.set(toolName, name)
    return { ok: true, toolName, source: name, activated: true }
  }

  function doDeactivate(toolName) {
    const disposer = active.get(toolName)
    if (disposer === undefined) return { ok: true, toolName, alreadyInactive: true }
    if (typeof disposer === 'function') disposer()
    active.delete(toolName)
    activeSource.delete(toolName)
    return { ok: true, toolName, deactivated: true }
  }

  /**
   * Remove a registered function from the registry entirely. If it is
   * currently active (exposed as a native tool), first deactivate it. Any
   * descendant native tool(s) pointing back to this registration are also torn
   * down.
   */
  function doRemove(name) {
    const entry = registry.get(name)
    if (entry === undefined) {
      return { ok: true, removed: false, warning: `未注册的函数 "${name}"，无需移除` }
    }
    // Tear down native tools exposed from this registration (name or source).
    const toTear = []
    for (const [toolName, source] of activeSource.entries()) {
      if (source === name || toolName === name) toTear.push(toolName)
    }
    for (const toolName of toTear) doDeactivate(toolName)
    registry.delete(name)
    return { ok: true, removed: true, name, deactivatedTools: toTear, remaining: registry.size }
  }

  const registered = []
  const failed = []

  try {
    ctx.tools.register(defineTool({
      name: 'oa_register',
      description: '把 one-api 格式的接口定义注册为可搜索/可调用的函数。source 可以是 JSON 字符串（OpenAI tools/functions 数组、单个函数，或 OpenAPI 3.x spec），也可以是指向 JSON 文档的 URL。可选 baseUrl（调用地址）、apiKey、model。',
      parameters: {
        source: { type: 'string', required: true, description: 'one-api 格式的 JSON 字符串或 JSON 文档 URL' },
        baseUrl: { type: 'string', description: '调用后端地址，如 http://127.0.0.1:3000（OpenAPI 路径的宿主）' },
        apiKey: { type: 'string', description: '可选的 Bearer API Key' },
        model: { type: 'string', description: 'openai 风格的默认模型名' },
      },
      output: objectOutput,
      async execute(args) {
        const source = args && args.source ? String(args.source) : ''
        if (!source) throw new Error('source 不能为空')
        const opts = {
          baseUrl: args && args.baseUrl ? String(args.baseUrl) : '',
          apiKey: args && args.apiKey ? String(args.apiKey) : '',
          model: args && args.model ? String(args.model) : '',
        }
        let parsed
        if (/^https?:\/\//i.test(source)) {
          parsed = await fetchJson(source, { timeoutMs: 60000 }, ctx)
        } else {
          try {
            parsed = JSON.parse(source)
          } catch (error) {
            throw new Error(`source 不是合法 JSON，也不是 URL：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const shapes = parseFunctions(parsed)
        if (shapes.length === 0) {
          return { ok: true, added: [], warning: '未从输入中解析出任何函数；请确认格式（OpenAI tools/functions 或 OpenAPI 3.x）' }
        }
        const added = registerMany(shapes, opts)
        return { ok: true, added, addedCount: added.length, total: registry.size }
      },
    }))
    registered.push('oa_register')
  } catch (error) {
    failed.push('oa_register')
    report('oa_register', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_remove',
      description: '从注册表中移除一个已注册的 one-api 函数。如果它当前已被 oa_activate 暴露为原生 tool，会先自动停用再移除。',
      parameters: {
        name: { type: 'string', required: true, description: '要移除的已注册函数名' },
      },
      output: objectOutput,
      async execute(args) {
        const name = String((args && args.name) || '')
        if (!name) throw new Error('name 不能为空')
        return doRemove(name)
      },
    }))
    registered.push('oa_remove')
  } catch (error) {
    failed.push('oa_remove')
    report('oa_remove', error)
  }

  try {
    ctx.tools.register(defineTool({
      name: 'oa_search',
      description: '按关键词搜索已注册的 one-api 函数（匹配名称与描述）。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词' },
      },
      output: objectOutput,
      async execute(args) {
        const query = String((args && args.query) || '').toLowerCase().trim()
        const entries = []
        for (const entry of registry.values()) {
          const haystack = `${entry.name} ${entry.description}`.toLowerCase()
          if (!query || haystack.includes(query)) {
            entries.push({
              name: entry.name,
              description: entry.description,
              parameters: entry.parameters,
              baseUrl: entry.baseUrl || null,
              kind: (entry.meta && entry.meta.kind) || 'openai',
              active: activeSource.has(entry.name),
            })
          }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name))
        return { ok: true, count: entries.length, entries }
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
      description: '传参调用一个已注册的 one-api 函数（通过 HTTP 请求后端，宽松模式：参数为自由 JSON）。openai 风格走 /v1/chat/completions + tool_choice；openapi 风格按 method/path 直接请求。',
      parameters: {
        name: { type: 'string', required: true, description: '已注册的函数名' },
        args: { type: 'json', description: '传给函数的参数对象，例如 {"city":"chengdu"}' },
      },
      output: objectOutput,
      async execute(args) {
        const name = String((args && args.name) || '')
        const entry = registry.get(name)
        if (!entry) {
          const names = [...registry.keys()].sort()
          throw new Error(`未注册的函数 "${name}"；已注册：${names.join(', ') || '(空)'}`)
        }
        const callArgs = args && args.args !== undefined ? args.args : {}
        return invokeEntry(entry, callArgs)
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
      description: '把已注册的 one-api 函数 TEMPORARILY 暴露为原生 model tool（严格 JSON schema，模型下一轮可直接以严格模式调用）。不用了请用 oa_deactivate 停用。',
      parameters: {
        name: { type: 'string', required: true, description: '已注册的函数名' },
        toolName: { type: 'string', description: '原生 tool 名；缺省用函数名' },
      },
      output: objectOutput,
      async execute(args) {
        const name = String((args && args.name) || '')
        const toolName = args && args.toolName ? String(args.toolName) : name
        return doActivate(name, toolName)
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
        const toolName = String((args && args.toolName) || '')
        return doDeactivate(toolName)
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
      description: '列出当前通过 oa_activate 暴露为原生 tool 的函数。',
      parameters: {},
      output: objectOutput,
      async execute() {
        const entries = [...activeSource.entries()].map(([toolName, source]) => ({ toolName, source }))
        return { ok: true, count: entries.length, entries }
      },
    }))
    registered.push('oa_active')
  } catch (error) {
    failed.push('oa_active')
    report('oa_active', error)
  }

  return { registered, failed }
}
