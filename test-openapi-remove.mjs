import { applyOneApi } from './implementation.js'
const registered = {}
let nativeFoo = false  // 模拟原生 tool 是否仍注册
const tools = {
  register(tool) {
    registered[tool.name] = tool
    if (tool.name === 'foo') nativeFoo = true
    return () => { if (tool.name === 'foo') nativeFoo = false }
  },
}
const mockCtx = { tools, get: () => undefined }
const result = applyOneApi(mockCtx, {}, () => {})

await registered.oa_register.execute({ source: JSON.stringify([{ type:'function', function:{ name: 'foo', description: 'foo func', parameters: {} } }]), baseUrl: 'http://x' })
const act = await registered.oa_activate.execute({ name: 'foo' })
console.log('activate:', JSON.stringify(act), '| 原生tool注册:', nativeFoo)
const rm = await registered.oa_remove.execute({ name: 'foo' })
console.log('remove结果:', JSON.stringify(rm), '| 原生tool是否移除:', nativeFoo ? '仍注册(错)' : '已移除(对)')
const active = await registered.oa_active.execute({})
console.log('active:', JSON.stringify(active))
// 再移除不存在的
const rm2 = await registered.oa_remove.execute({ name: 'nonexistent' })
console.log('remove不存在:', JSON.stringify(rm2))
console.log(rm.removed && !nativeFoo && rm2.removed === false ? 'SMOKE2 OK' : 'SMOKE2 FAIL')
