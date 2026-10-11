/**
 * Latency eval: is the app-grouped edition actually FASTER at finding the
 * operation you need?
 *
 * "Faster" is measured as: how many tool calls, and how many output bytes,
 * from the moment the model starts looking to the moment it knows enough to
 * make the call. Registration is excluded.
 *
 * Deliberately split by scenario, because the honest answer is scenario
 * dependent — knowing the name is a different job from not knowing it.
 *
 * The registry here is CLEAN (every parameter has a description), so this
 * measures pure efficiency, not "does it crash".
 *
 * Run: node eval-latency.mjs
 */
import { applyOneApi as applyNew } from './implementation.js'
import { applyOneApi as applyOld } from './implementation.old.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WAREHOUSE_OPS = ['whListSkus', 'getById', 'whAdjustStock', 'whListBins', 'whGetBin', 'whTransfer', 'whListSuppliers', 'whGetSupplier', 'whAudit', 'whExport']
const ORDER_OPS = ['listOrders', 'getById', 'createOrder', 'cancelOrder', 'refundOrder', 'shipOrder', 'trackOrder', 'listInvoices', 'getInvoice', 'payInvoice']

function buildSpec(title, description, summaryWord, tag, opNames) {
  const paths = {}
  opNames.forEach((opName, i) => {
    paths[`/${tag}/op${i}`] = {
      get: {
        operationId: opName,
        tags: [tag],
        summary: `${summaryWord} operation ${i}`,
        parameters: [{ name: 'id', in: 'query', description: `${summaryWord} identifier`, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    }
  })
  return { openapi: '3.0.0', info: { title, description }, paths }
}

const warehouseSpec = buildSpec('Warehouse Cloud Nine', 'Warehouse inventory service', 'Inventory', 'inventory', WAREHOUSE_OPS)
const ordersSpec = buildSpec('Orders', 'Order placement and lookup', 'Order', 'orders', ORDER_OPS)

function assertLossless(value, path = '$') {
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`non-finite at ${path}`)
  if (Array.isArray(value)) { value.forEach((v, i) => assertLossless(v, `${path}[${i}]`)); return }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertLossless(v, `${path}.${k}`)
  }
}

function boot(apply) {
  const registered = {}
  const tools = { register(t) { registered[t.name] = t; return () => {} } }
  apply({ tools, get: () => undefined }, { storagePath: join(mkdtempSync(join(tmpdir(), 'oa-lat-')), 'r.json') }, () => {})
  const stats = { calls: 0, bytes: 0, trace: [] }
  const T = {}
  for (const [name, tool] of Object.entries(registered)) {
    T[name] = {
      async execute(args) {
        stats.calls++
        let result
        try {
          result = await tool.execute(args)
          assertLossless(result)
        } catch (error) {
          stats.trace.push(`${name} → FAIL ${String(error.message).slice(0, 40)}`)
          return { __failed: true }
        }
        const size = JSON.stringify(result).length
        stats.bytes += size
        stats.trace.push(`${name} → ${size}B`)
        return result
      },
    }
  }
  return { T, stats }
}

async function prepare(apply) {
  const booted = boot(apply)
  await booted.T.oa_register.execute({ source: JSON.stringify(warehouseSpec), baseUrl: 'https://wh.example.com' })
  await booted.T.oa_register.execute({ source: JSON.stringify(ordersSpec), baseUrl: 'https://orders.example.com' })
  booted.stats.calls = 0
  booted.stats.bytes = 0
  booted.stats.trace = []
  return booted
}

/** How many parameter names can we name for `opName`, starting from scratch? */
function paramNames(entry) {
  if (entry && Array.isArray(entry.params)) return entry.params
  const props = entry && entry.parameters && entry.parameters.properties
  return props ? Object.keys(props) : []
}

// ------------------------------------------------------------- the scenarios

/** S1 — the model already knows the operation name; it needs its arguments. */
async function s1Old(T) {
  const r = await T.oa_search.execute({ query: 'listOrders' })
  const entry = r.entries && r.entries[0]
  return { ok: paramNames(entry).length > 0, answer: `参数 ${paramNames(entry).join(',') || '(未知)'}` }
}
async function s1New(T) {
  const r = await T.oa_search.execute({ query: 'listOrders' })
  const entry = r.entries && r.entries[0]
  if (!entry) return { ok: false, answer: '没找到' }
  let names = paramNames(entry)
  if (names.length === 0) {
    const d = await T.oa_describe.execute({ name: 'listOrders', app: entry.app })
    names = d.parameters && d.parameters.properties ? Object.keys(d.parameters.properties) : []
  }
  return { ok: names.length > 0, answer: `参数 ${names.join(',') || '(未知)'}` }
}

/** S2 — the model knows the SERVICE name but no operation name. */
async function s2Old(T) {
  const r = await T.oa_search.execute({ query: 'Warehouse Cloud Nine' })
  const names = (r.entries || []).map((e) => e.name)
  return { ok: names.length === 10, answer: names.length ? `命中 ${names.length} 条: ${names.slice(0, 3).join(',')}…` : '命中 0 条（服务名搜不到）' }
}
async function s2New(T) {
  const dir = await T.oa_apps.execute({})
  const hit = dir.apps.find((a) => /warehouse/i.test(a.app))
  if (!hit) return { ok: false, answer: '目录里没有' }
  const expand = await T.oa_apps.execute({ app: hit.app })
  const names = expand.ops.map((o) => o.name)
  return { ok: names.length === 10, answer: `${hit.app}: ${names.length} 个操作` }
}

/** S2b — same question as S2, but the service name is tried as a keyword. */
async function s2NewFast(T) {
  const r = await T.oa_search.execute({ query: 'Warehouse Cloud Nine' })
  const names = (r.entries || []).map((e) => e.name)
  return { ok: names.length === 10, answer: `一次关键词直接命中 ${names.length} 条` }
}

/** S3 — no clue at all: "what can I do?" */
async function s3Old(T) {
  const r = await T.oa_search.execute({ query: '' })
  return { ok: r.count > 0, answer: `${r.count} 条` }
}
async function s3New(T) {
  const r = await T.oa_apps.execute({})
  return { ok: r.count > 0, answer: `${r.count} 个包 / ${r.totalOps} 个操作` }
}

/** S4 — a fuzzy theme word ("invoice"), several plausible hits. */
async function s4Old(T) {
  const r = await T.oa_search.execute({ query: 'invoice' })
  const withParams = (r.entries || []).filter((e) => paramNames(e).length > 0)
  return { ok: withParams.length > 0, answer: `${r.count} 条命中，可直接调用 ${withParams.length} 条` }
}
async function s4New(T) {
  const r = await T.oa_search.execute({ query: 'invoice' })
  const entries = r.entries || []
  let ready = 0
  for (const e of entries) {
    if (paramNames(e).length > 0) { ready++; continue }
    const d = await T.oa_describe.execute({ name: e.name, app: e.app })
    if (d.parameters && d.parameters.properties) ready++
  }
  return { ok: ready > 0, answer: `${entries.length} 条命中，查完参数后可用 ${ready} 条` }
}

// ------------------------------------------------------------------ the runs

async function measure(label, apply, oldRunner, newRunner, useNew) {
  const { T, stats } = await prepare(apply)
  const result = useNew ? await newRunner(T) : await oldRunner(T)
  return { label, calls: stats.calls, bytes: stats.bytes, ...result, trace: stats.trace }
}

const scenarios = [
  { id: 'S1', name: '知道操作名，要拿参数', old: s1Old, new: s1New },
  { id: 'S2', name: '知道服务名，不知道操作名', old: s2Old, new: s2New },
  { id: 'S2b', name: '知道服务名（改用关键词捷径）', old: s2Old, new: s2NewFast },
  { id: 'S3', name: '毫无线索，只想看有什么', old: s3Old, new: s3New },
  { id: 'S4', name: '模糊主题词，多个候选', old: s4Old, new: s4New },
]

console.log('\n每个场景：从开始查找到「足够发起调用」为止（不含注册）\n')
console.log(`${'场景'.padEnd(30)} | ${'旧:次数'.padStart(8)} | ${'新:次数'.padStart(8)} | ${'旧:字节'.padStart(9)} | ${'新:字节'.padStart(9)} | 旧答对 新答对`)
console.log('-'.repeat(110))

const rows = []
for (const s of scenarios) {
  const oldRun = await measure('old', applyOld, s.old, s.new, false)
  const newRun = await measure('new', applyNew, s.old, s.new, true)
  rows.push({ s, oldRun, newRun })
  const name = `${s.id} ${s.name}`
  console.log(`${name.padEnd(30)} | ${String(oldRun.calls).padStart(8)} | ${String(newRun.calls).padStart(8)} | ${String(oldRun.bytes).padStart(9)} | ${String(newRun.bytes).padStart(9)} | ${oldRun.ok ? '是' : '否'}     ${newRun.ok ? '是' : '否'}`)
}

console.log('\n明细：')
for (const { s, oldRun, newRun } of rows) {
  console.log(`\n${s.id} ${s.name}`)
  console.log(`  旧: ${oldRun.answer}`)
  oldRun.trace.forEach((t) => console.log(`      ${t}`))
  console.log(`  新: ${newRun.answer}`)
  newRun.trace.forEach((t) => console.log(`      ${t}`))
}

const sameCalls = rows.filter((r) => r.oldRun.calls === r.newRun.calls).length
const newFewer = rows.filter((r) => r.newRun.calls < r.oldRun.calls).length
const newMore = rows.filter((r) => r.newRun.calls > r.oldRun.calls).length
const oldFail = rows.filter((r) => !r.oldRun.ok).length
const newFail = rows.filter((r) => !r.newRun.ok).length

console.log('\n================ 结论 ================')
console.log(`调用次数: 新版更少 ${newFewer} 个场景 / 持平 ${sameCalls} / 更多 ${newMore}`)
console.log(`能答出来: 旧版失败 ${oldFail} 个场景，新版失败 ${newFail} 个`)
