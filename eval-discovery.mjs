/**
 * Discovery eval: does the app-grouped edition actually make the model better
 * at USING the registry?
 *
 * Same registrations, same tasks, run twice — once against the pre-change
 * implementation (git show HEAD:implementation.js > implementation.old.mjs),
 * once against the current one.
 *
 * Measured per task:
 *   calls        — tool calls the discovery took
 *   bytes        — tool output the model actually had to read (discovery only,
 *                  registration excluded)
 *   gateErrors   — calls whose output the harness's strict lossless-JSON gate
 *                  would REJECT (the real `value is not lossless JSON` failure)
 *   correct      — did the task's question get a correct, complete answer
 *
 * Tasks are phrased the way a model actually asks them: it does NOT know what
 * has been registered, because that knowledge does not survive a restart.
 *
 * Run: node eval-discovery.mjs
 */
import { applyOneApi as applyNew } from './implementation.js'
import { applyOneApi as applyOld } from './implementation.old.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --------------------------------------------------------------- test corpus

const WAREHOUSE_OPS = [
  'whListSkus', 'getById', 'whAdjustStock', 'whListBins', 'whGetBin',
  'whTransfer', 'whListSuppliers', 'whGetSupplier', 'whAudit', 'whExport',
]
const ORDER_OPS = [
  'listOrders', 'getById', 'createOrder', 'cancelOrder', 'refundOrder',
  'shipOrder', 'trackOrder', 'listInvoices', 'getInvoice', 'payInvoice',
]

/** One parameter deliberately carries no description (i === 3). */
function buildSpec(title, description, summaryWord, tag, opNames) {
  const paths = {}
  opNames.forEach((opName, i) => {
    const param = { name: 'id', in: 'query', schema: { type: 'string' } }
    if (i !== 3) param.description = `${summaryWord} identifier`
    paths[`/${tag}/op${i}`] = {
      get: {
        operationId: opName,
        tags: [tag],
        summary: `${summaryWord} operation ${i}`,
        parameters: [param],
        responses: { 200: { description: 'ok' } },
      },
    }
  })
  return { openapi: '3.0.0', info: { title, description }, paths }
}

const warehouseSpec = buildSpec('Warehouse Cloud Nine', 'Warehouse inventory service', 'Inventory', 'inventory', WAREHOUSE_OPS)
const ordersSpec = buildSpec('Orders', 'Order placement and lookup', 'Order', 'orders', ORDER_OPS)

// ----------------------------------------------------------- harness emulation

function assertLossless(value, path = '$') {
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite at ${path}`)
    if (Object.is(value, -0)) throw new Error(`-0 at ${path}`)
    return
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertLossless(v, `${path}[${i}]`)); return }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertLossless(v, `${path}.${k}`)
  }
}

function boot(apply, storagePath) {
  const registered = {}
  const tools = { register(t) { registered[t.name] = t; return () => {} } }
  apply({ tools, get: () => undefined }, { storagePath }, () => {})
  const stats = { calls: 0, bytes: 0, gateErrors: 0, errors: 0, trace: [] }
  const T = {}
  for (const [name, tool] of Object.entries(registered)) {
    T[name] = {
      name,
      async execute(args) {
        stats.calls++
        let result
        try {
          result = await tool.execute(args)
        } catch (error) {
          stats.errors++
          stats.trace.push(`${name} → 报错: ${truncateMsg(error.message)}`)
          return { __failed: true, message: error.message }
        }
        try {
          assertLossless(result)
        } catch (error) {
          stats.gateErrors++
          stats.trace.push(`${name} → 门禁拒绝: ${truncateMsg(error.message)}`)
          return { __failed: true, message: `value is not lossless JSON (${error.message})` }
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

function truncateMsg(text) {
  const s = String(text).replace(/\s+/g, ' ')
  return s.length > 74 ? `${s.slice(0, 73)}…` : s
}

function freshStore(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'registry.json')
}

function mark(stats) {
  return { calls: stats.calls, bytes: stats.bytes, gateErrors: stats.gateErrors }
}

function since(stats, base) {
  return { calls: stats.calls - base.calls, bytes: stats.bytes - base.bytes, gateErrors: stats.gateErrors - base.gateErrors }
}

// ----------------------------------------------------------------- the tasks

/**
 * T1 — "Is there anything here about a warehouse? What is it called and how
 * many operations does it offer?" Answering needs the SERVICE, not one hit.
 */
async function taskWarehouseOld(T) {
  let hitCount = 0
  const tried = []
  for (const guess of ['warehouse', '仓库', 'stock']) {
    const r = await T.oa_search.execute({ query: guess })
    tried.push(`${guess}:${r.__failed ? 'error' : r.count}`)
    if (!r.__failed) hitCount += r.count
  }
  // Even when a keyword lands, the old shape cannot name the service or count
  // its operations — there is no service boundary to report.
  return {
    correct: false,
    answer: `关键词尝试 [${tried.join(' ')}]，共命中 ${hitCount} 条零散操作；说不出服务名，也数不出它一共有几个操作`,
  }
}

async function taskWarehouseNew(T) {
  const dir = await T.oa_apps.execute({})
  if (dir.__failed) return { correct: false, answer: '目录调用失败' }
  const hit = dir.apps.find((a) => /warehouse/i.test(a.app) || /warehouse/i.test(a.description || ''))
  if (!hit) return { correct: false, answer: '目录里没有仓库服务' }
  const expand = await T.oa_apps.execute({ app: hit.app })
  if (expand.__failed) return { correct: false, answer: '展开失败' }
  return { correct: hit.opCount === 10 && expand.count === 10, answer: `找到「${hit.app}」，共 ${expand.count} 个操作` }
}

/** T2 — "What can I actually do right now?" Needs a full inventory. */
async function taskInventoryOld(T) {
  const r = await T.oa_search.execute({ query: '' }) // only route the old shape offers
  if (r.__failed) return { correct: false, answer: '列举失败（产出被门禁拒绝）' }
  return { correct: r.count === 19, answer: `列出 ${r.count} 条零散操作，无服务归属` }
}

async function taskInventoryNew(T) {
  const r = await T.oa_apps.execute({})
  if (r.__failed) return { correct: false, answer: '目录调用失败' }
  return { correct: r.count === 2 && r.totalOps === 20, answer: `${r.count} 个包 / 共 ${r.totalOps} 个操作` }
}

/** T3 — "Get me the parameters for the operation that lists orders." */
async function taskParamsOld(T) {
  const r = await T.oa_search.execute({ query: 'order' })
  if (r.__failed) return { correct: false, answer: '搜索失败（产出被门禁拒绝）' }
  const target = r.entries.find((e) => e.name === 'listOrders')
  const hasParams = Boolean(target && target.parameters && target.parameters.properties)
  return { correct: hasParams, answer: target ? `拿到 ${target.name} 的参数（随搜索一并返回）` : '没找到 listOrders' }
}

async function taskParamsNew(T) {
  const r = await T.oa_search.execute({ query: 'order' })
  if (r.__failed) return { correct: false, answer: '搜索失败' }
  const target = r.entries.find((e) => e.name === 'listOrders')
  if (!target) return { correct: false, answer: '没找到 listOrders' }
  const d = await T.oa_describe.execute({ name: 'listOrders', app: target.app })
  if (d.__failed) return { correct: false, answer: '描述调用失败' }
  return { correct: Boolean(d.parameters?.properties), answer: `按需取到 ${d.app}/${d.name} 的参数` }
}

// ------------------------------------------------------ micro: search payload

/**
 * One operation, looked up by its own name — the fairest like-for-like size
 * comparison: how much does the model read for ONE search hit?
 */
async function singleHitSize(apply) {
  const { T } = boot(apply, freshStore('oa-eval-micro-'))
  await T.oa_register.execute({ source: JSON.stringify(ordersSpec), baseUrl: 'https://orders.example.com' })
  const r = await T.oa_search.execute({ query: 'listOrders' })
  if (r.__failed) return { status: 'gate-rejected' }
  const entry = r.entries.find((e) => e.name === 'listOrders')
  if (!entry) return { status: 'not-found' }
  return { status: 'ok', bytes: JSON.stringify(entry).length, hasParameters: Boolean(entry.parameters) }
}

// -------------------------------------------------------------- the two runs

const registerOld = (T, spec, baseUrl) => T.oa_register.execute({ source: JSON.stringify(spec), baseUrl })

const oldBoot = boot(applyOld, freshStore('oa-eval-old-'))
const oldRegA = await registerOld(oldBoot.T, warehouseSpec, 'https://wh.example.com')
const oldRegB = await registerOld(oldBoot.T, ordersSpec, 'https://orders.example.com')
const oldBase = mark(oldBoot.stats)
const oldT1 = await taskWarehouseOld(oldBoot.T)
const oldT2 = await taskInventoryOld(oldBoot.T)
const oldT3 = await taskParamsOld(oldBoot.T)
const oldDiscover = since(oldBoot.stats, oldBase)

const newBoot = boot(applyNew, freshStore('oa-eval-new-'))
const newRegA = await newBoot.T.oa_register.execute({ source: JSON.stringify(warehouseSpec), baseUrl: 'https://wh.example.com' })
const newRegB = await newBoot.T.oa_register.execute({ source: JSON.stringify(ordersSpec), baseUrl: 'https://orders.example.com' })
const newBase = mark(newBoot.stats)
const newT1 = await taskWarehouseNew(newBoot.T)
const newT2 = await taskInventoryNew(newBoot.T)
const newT3 = await taskParamsNew(newBoot.T)
const newDiscover = since(newBoot.stats, newBase)

const microOld = await singleHitSize(applyOld)
const microNew = await singleHitSize(applyNew)

// ----------------------------------------------------------------- reporting

function line(label, oldVal, newVal) {
  console.log(`${label.padEnd(24)} | ${String(oldVal).padStart(14)} | ${String(newVal).padStart(14)}`)
}

console.log('\n================ 注册结果 ================')
console.log('两个服务各有 10 个操作，合计 20 个；两者都导出一个同名操作 getById。')
line('注册后操作总数', oldRegB.totalOps !== undefined ? oldRegB.totalOps : oldRegB.total, newRegB.totalOps)
line('服务（包）数量', '无此概念', newRegB.totalApps)

console.log('\n================ 任务正确性 ================')
const mk = (t) => (t.correct ? '对' : '错')
line('T1 认出仓库服务及其规模', mk(oldT1), mk(newT1))
console.log(`  旧: ${oldT1.answer}`)
console.log(`  新: ${newT1.answer}`)
line('T2 列出现有全部能力', mk(oldT2), mk(newT2))
console.log(`  旧: ${oldT2.answer}`)
console.log(`  新: ${newT2.answer}`)
line('T3 取到目标操作的参数', mk(oldT3), mk(newT3))
console.log(`  旧: ${oldT3.answer}`)
console.log(`  新: ${newT3.answer}`)

console.log('\n================ 发现阶段代价（不含注册） ================')
line('工具调用次数', oldDiscover.calls, newDiscover.calls)
line('读到的输出字节', oldDiscover.bytes, newDiscover.bytes)
line('门禁拒绝次数', oldDiscover.gateErrors, newDiscover.gateErrors)
line('任务正确数 (满分 3)', [oldT1, oldT2, oldT3].filter((t) => t.correct).length,
  [newT1, newT2, newT3].filter((t) => t.correct).length)

console.log('\n================ 单次搜索命中一条操作的载荷 ================')
line('条目字节数', microOld.status === 'ok' ? microOld.bytes : microOld.status,
  microNew.status === 'ok' ? microNew.bytes : microNew.status)
line('是否夹带参数 schema', microOld.status === 'ok' ? (microOld.hasParameters ? '是' : '否') : '-',
  microNew.status === 'ok' ? (microNew.hasParameters ? '是' : '否') : '-')

console.log('\n================ 调用轨迹 ================')
console.log('--- 旧版 ---')
oldBoot.stats.trace.forEach((t) => console.log(`  ${t}`))
console.log('--- 新版 ---')
newBoot.stats.trace.forEach((t) => console.log(`  ${t}`))

const oldScore = [oldT1, oldT2, oldT3].filter((t) => t.correct).length
const newScore = [newT1, newT2, newT3].filter((t) => t.correct).length
const improved = newScore > oldScore && newDiscover.gateErrors === 0 && newRegB.totalOps === 20
console.log(`\n${improved ? 'IMPROVED' : 'NO IMPROVEMENT'} — 正确 ${oldScore}→${newScore}/3，注册丢失 ${20 - (oldRegB.totalOps ?? oldRegB.total)}→${20 - newRegB.totalOps} 个，门禁拒绝 ${oldDiscover.gateErrors}→${newDiscover.gateErrors}`)
process.exit(improved ? 0 : 1)
