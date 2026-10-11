/**
 * Smoke test: load the OpenAPI implementation with a mock ctx, then exercise
 * the registry helpers by calling the registered tool executes directly.
 *
 * Uses a private temp registry file so a test run never touches the real
 * $DSH_HOME/storages/openapi-registry.json.
 */
import { applyOneApi } from './implementation.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const storagePath = join(mkdtempSync(join(tmpdir(), 'oa-smoke-')), 'registry.json')

const registered = {}
const tools = {
  register(tool) {
    registered[tool.name] = tool
    return () => {}
  },
}
const mockCtx = {
  tools,
  get(name) {
    if (name === 'tools') return tools
    return undefined
  },
}

const result = applyOneApi(mockCtx, { storagePath }, (scope, err) => {
  console.error(`[report] ${scope}: ${err.message}`)
})
console.log('registered:', result.registered)
console.log('failed:', result.failed)
if (result.registered.length !== 9 || result.failed.length !== 0) {
  console.error('SMOKE FAIL')
  process.exit(1)
}

// Exercise oa_register with an OpenAI tools array.
const registerTool = registered.oa_register
const regResult = await registerTool.execute({
  source: JSON.stringify([{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }]),
  baseUrl: 'http://127.0.0.1:3000',
})
console.log('register result:', JSON.stringify(regResult))
if (!regResult.app || !regResult.app.name) {
  console.error('SMOKE FAIL: register did not report the app it landed in')
  process.exit(1)
}

// The app shows up in the directory.
const directory = await registered.oa_apps.execute({})
console.log('apps:', directory.count, directory.apps.map((a) => a.app).join(','))
if (directory.count !== 1 || directory.totalOps !== 1) {
  console.error('SMOKE FAIL: directory did not reflect the registration')
  process.exit(1)
}

// Search for it.
const searchTool = registered.oa_search
const searchResult = await searchTool.execute({ query: 'weather' })
console.log('search count:', searchResult.count, 'names:', searchResult.entries.map((e) => e.name).join(','))

// Describe it.
const described = await registered.oa_describe.execute({ name: 'get_weather' })
console.log('describe params:', JSON.stringify(described.parameters))
if (described.parameters.properties.city.type !== 'string') {
  console.error('SMOKE FAIL: describe lost the parameter schema')
  process.exit(1)
}

// Activate it as a native tool.
const activateTool = registered.oa_activate
const actResult = await activateTool.execute({ name: 'get_weather' })
console.log('activate result:', JSON.stringify(actResult))
if (!registered.get_weather) {
  console.error('ACTIVATE FAIL: get_weather native tool not registered')
  process.exit(1)
}

// List active.
const activeTool = registered.oa_active
const activeResult = await activeTool.execute({})
console.log('active:', JSON.stringify(activeResult))

// Deactivate.
const deactivateTool = registered.oa_deactivate
const deactResult = await deactivateTool.execute({ toolName: 'get_weather' })
console.log('deactivate:', JSON.stringify(deactResult))

// Remove the function.
const removeTool = registered.oa_remove
const removeResult = await removeTool.execute({ name: 'get_weather' })
console.log('remove result:', JSON.stringify(removeResult))

// Confirm search no longer finds it.
const search2 = await registered.oa_search.execute({ query: 'weather' })
console.log('search after remove count:', search2.count)
if (search2.count !== 0) {
  console.error('SMOKE FAIL: removed operation still searchable')
  process.exit(1)
}

console.log('SMOKE OK')
