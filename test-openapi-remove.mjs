import { applyOneApi } from './implementation.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const storagePath = join(mkdtempSync(join(tmpdir(), 'oa-remove-')), 'registry.json')

const registered = {}
let nativeFoo = false // 模拟原生 tool 是否仍注册
const tools = {
  register(tool) {
    registered[tool.name] = tool
    if (tool.name === 'foo') nativeFoo = true
    return () => { if (tool.name === 'foo') nativeFoo = false }
  },
}
const mockCtx = { tools, get: () => undefined }
const result = applyOneApi(mockCtx, { storagePath }, () => {})
if (result.registered.length !== 9 || result.failed.length !== 0) {
  console.error('SMOKE2 FAIL: tool registration', result.registered, result.failed)
  process.exit(1)
}

await registered.oa_register.execute({ source: JSON.stringify([{ type: 'function', function: { name: 'foo', description: 'foo func', parameters: {} } }]), baseUrl: 'http://x' })
const act = await registered.oa_activate.execute({ name: 'foo' })
console.log('activate:', JSON.stringify(act), '| 原生tool注册:', nativeFoo)
const rm = await registered.oa_remove.execute({ name: 'foo' })
console.log('remove结果:', JSON.stringify(rm), '| 原生tool是否移除:', nativeFoo ? '仍注册(错)' : '已移除(对)')
const active = await registered.oa_active.execute({})
console.log('active:', JSON.stringify(active))
// 再移除不存在的：保持幂等，但要给出可操作的提示
const rm2 = await registered.oa_remove.execute({ name: 'nonexistent' })
console.log('remove不存在:', JSON.stringify(rm2))
const ok = rm.removed === true && !nativeFoo && rm2.removed === false && typeof rm2.warning === 'string'
console.log(ok ? 'SMOKE2 OK' : 'SMOKE2 FAIL')
process.exit(ok ? 0 : 1)
