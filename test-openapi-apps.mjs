/**
 * App-grouped edition test: directory / expansion / describe layering,
 * lossless-JSON regression (the bug that used to kill oa_search), cross-app
 * name collisions, tag & app filters, whole-app removal, and persistence.
 *
 * Run: node test-openapi-apps.mjs
 */
import { applyOneApi } from './implementation.js'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function section(title) {
  console.log(`\n== ${title}`)
}

/**
 * Mimic the harness's strict lossless-JSON gate on tool output: undefined,
 * NaN, Infinity and -0 are all rejected there. This is the exact check that
 * used to fail with `value is not lossless JSON`.
 */
function assertLossless(value, path = '$') {
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new Error(`NaN at ${path}`)
    if (!Number.isFinite(value)) throw new Error(`non-finite at ${path}`)
    if (Object.is(value, -0)) throw new Error(`-0 at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertLossless(item, `${path}[${i}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertLossless(item, `${path}.${key}`)
  }
}

/** Fresh mock ctx; calling applyOneApi again simulates a Host restart. */
function boot(storagePath) {
  const registered = {}
  const tools = { register(tool) { registered[tool.name] = tool; return () => {} } }
  const ctx = { tools, get: () => undefined }
  const result = applyOneApi(ctx, { storagePath }, () => {})
  return { registered, result }
}

const warehouse = {
  openapi: '3.0.0',
  info: { title: 'Warehouse Cloud Nine', description: 'Manages warehouse SKUs and stock levels.' },
  paths: {
    '/skus': {
      get: {
        operationId: 'whListSkus',
        tags: ['inventory'],
        summary: 'List SKUs in the warehouse',
        parameters: [{ name: 'page', in: 'query', description: 'page number', schema: { type: 'integer' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/skus/{id}': {
      get: {
        operationId: 'getById',
        tags: ['inventory'],
        summary: 'Fetch one SKU',
        // NOTE: no `description` on this parameter — the exact shape that used
        // to make oa_search throw "value is not lossless JSON".
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
}

const orders = {
  openapi: '3.0.0',
  info: { title: 'Orders', description: 'Order placement and lookup.' },
  paths: {
    '/orders/{id}': {
      get: {
        operationId: 'getById',
        tags: ['orders'],
        summary: 'Fetch one order',
        parameters: [{ name: 'id', in: 'path', required: true, description: 'order id', schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/orders': {
      get: {
        operationId: 'listOrders',
        tags: ['orders'],
        summary: 'List orders',
        parameters: [{ name: 'status', in: 'query', description: 'status filter', schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
}

const dir = mkdtempSync(join(tmpdir(), 'oa-apps-'))
const storagePath = join(dir, 'registry.json')

const first = boot(storagePath)
section('tool surface')
check('9 tools registered, none failed',
  first.result.registered.length === 9 && first.result.failed.length === 0,
  `registered=${first.result.registered} failed=${first.result.failed}`)
check('oa_apps exists', typeof first.registered.oa_apps?.execute === 'function')
check('oa_describe exists', typeof first.registered.oa_describe?.execute === 'function')

const T = first.registered

section('register two apps')
const regA = await T.oa_register.execute({ source: JSON.stringify(warehouse), baseUrl: 'https://wh.example.com', apiKey: 'sk-test-secret-value' })
check('app name derived from info.title', regA.app?.name === 'Warehouse Cloud Nine', JSON.stringify(regA.app))
check('app carries the document description', /Manages warehouse SKUs/.test(regA.app?.description || ''))
check('2 operations added', regA.added?.length === 2, JSON.stringify(regA.added))
assertLossless(regA)
check('register output is lossless', true)

const regB = await T.oa_register.execute({ source: JSON.stringify(orders), baseUrl: 'https://orders.example.com' })
check('second app name from its own title', regB.app?.name === 'Orders', JSON.stringify(regB.app))
check('totals reported', regB.totalApps === 2 && regB.totalOps === 4, `apps=${regB.totalApps} ops=${regB.totalOps}`)
check('explicit tags merge', (await T.oa_register.execute({ source: JSON.stringify(orders), baseUrl: 'https://orders.example.com', tags: 'billing, priority' })).ok === true)

section('layer 1 — directory (oa_apps with no args)')
const dirResult = await T.oa_apps.execute({})
assertLossless(dirResult)
check('lossless', true)
check('lists both apps', dirResult.count === 2, JSON.stringify(dirResult.apps?.map((a) => a.app)))
check('each app reports opCount + description',
  dirResult.apps.every((a) => typeof a.opCount === 'number' && a.description),
  JSON.stringify(dirResult.apps))
check('directory output has NO parameter details',
  !JSON.stringify(dirResult).includes('"properties"'))
check('directory stays cheap', JSON.stringify(dirResult).length < 1500, `${JSON.stringify(dirResult).length} bytes`)

section('layer 2 — expand one app (oa_apps with app)')
const expand = await T.oa_apps.execute({ app: 'Warehouse Cloud Nine' })
assertLossless(expand)
check('lossless', true)
check('lists its operations', expand.count === 2, JSON.stringify(expand.ops?.map((o) => o.name)))
check('name + summary + parameter NAMES — but never the schema',
  expand.ops.every((o) => o.name && o.description && o.parameters === undefined),
  JSON.stringify(expand.ops))
check('parameter names are listed so a call can be built without a second lookup',
  expand.ops.every((o) => Array.isArray(o.params) && o.params.length > 0),
  JSON.stringify(expand.ops))
check('carries tags through', expand.ops.every((o) => o.tags?.includes('inventory')))
check('unknown app gives candidates, not a throw',
  (await T.oa_apps.execute({ app: 'nope' })).availableApps?.length === 2)

section('layer 3 — full contract (oa_describe)')
const described = await T.oa_describe.execute({ name: 'whListSkus' })
assertLossless(described)
check('lossless', true)
check('has parameters after all', described.parameters?.properties?.page?.type === 'integer')
check('reports required list', Array.isArray(described.required) || described.required === undefined)
check('reports how to connect', described.baseUrl === 'https://wh.example.com')
check('reports auth state', described.auth === 'bearer-set', described.auth)
check('suggests the concrete call', described.call?.tool === 'oa_invoke' && described.call?.args?.app === 'Warehouse Cloud Nine')

section('REGRESSION — the undefined-description bug')
// `getById` in Warehouse Cloud Nine has a parameter with no description.
const searchAll = await T.oa_search.execute({})
assertLossless(searchAll)
check('list-all search returns losslessly (used to throw here)', true)
check('all 4 operations listed', searchAll.count === 4, String(searchAll.count))
const searchById = await T.oa_search.execute({ query: 'getById' })
assertLossless(searchById)
check('searching the offending operation works (used to throw here)', searchById.count === 2, String(searchById.count))
const describeOffender = await T.oa_describe.execute({ name: 'getById', app: 'Warehouse Cloud Nine' })
assertLossless(describeOffender)
check('describing it works too, with the param present but description-free',
  describeOffender.parameters?.properties?.id?.type === 'string' && describeOffender.parameters.properties.id.description === undefined)
// Raw entry must survive JSON round-trip (what the gate effectively does).
check('JSON round-trip is stable', JSON.stringify(JSON.parse(JSON.stringify(describeOffender))) === JSON.stringify(describeOffender))

section('search as fallback: filters and empty query')
check('empty query = list everything', (await T.oa_search.execute({ query: '' })).count === 4)
check('app filter', (await T.oa_search.execute({ app: 'Orders' })).count === 2)
check('tag filter', (await T.oa_search.execute({ tag: 'inventory' })).count === 2)
check('keyword matches app name too', (await T.oa_search.execute({ query: 'warehouse' })).count === 2)
check('search results carry no parameters', !JSON.stringify(await T.oa_search.execute({})).includes('"properties"'))

section('cross-app name collisions (use to silently overwrite)')
const ambiguous = await T.oa_describe.execute({ name: 'getById' }).then(() => null, (e) => e.message)
check('ambiguous name asks for an app and lists candidates',
  typeof ambiguous === 'string' && ambiguous.includes('Warehouse Cloud Nine') && ambiguous.includes('Orders'),
  String(ambiguous))
check('both same-named operations still exist',
  (await T.oa_search.execute({ query: 'getById' })).count === 2)
check('disambiguated describe works', (await T.oa_describe.execute({ name: 'getById', app: 'Orders' })).app === 'Orders')

section('persistence — survive a Host restart')
check('registry file written', existsSync(storagePath))
const onDisk = readFileSync(storagePath, 'utf8')
check('API key is NOT on disk', !onDisk.includes('sk-test-secret-value'))
check('disk records that a key existed', onDisk.includes('"hadApiKey": true'))

const second = boot(storagePath)
const restored = await second.registered.oa_apps.execute({})
check('both apps restored after restart', restored.count === 2, JSON.stringify(restored.apps?.map((a) => a.app)))
check('operations restored', restored.totalOps === 4, String(restored.totalOps))
const restoredList = await second.registered.oa_apps.execute({ app: 'Warehouse Cloud Nine' })
check('restored app keeps its operation list', restoredList.count === 2)
const restoredDescribe = await second.registered.oa_describe.execute({ name: 'whListSkus' })
check('restored params intact', restoredDescribe.parameters?.properties?.page?.type === 'integer')
check('key loss is reported honestly, not silently', restoredDescribe.auth === 'bearer-lost-after-restart', restoredDescribe.auth)
check('restored registry is lossless', (assertLossless(restored), true))

section('removal')
const rmOne = await second.registered.oa_remove.execute({ name: 'listOrders', app: 'Orders' })
check('single operation removed', rmOne.removed === true && rmOne.totalOps === 3, JSON.stringify(rmOne))
const rmApp = await second.registered.oa_remove.execute({ app: 'Orders' })
check('whole app removed in one call', rmApp.removed === true && rmApp.removedOps === 1, JSON.stringify(rmApp))
check('only the other app remains', (await second.registered.oa_apps.execute({})).count === 1)
const third = boot(storagePath)
check('removals persisted too', (await third.registered.oa_apps.execute({})).count === 1)

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
