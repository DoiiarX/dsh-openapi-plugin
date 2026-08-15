# dsh-openapi-plugin

> [English](README.md) | 中文

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

将 OpenAPI 风格接口桥接为可搜索、可调用的函数注册项的持久化 DeepSeek Harness 插件包。

## 提供的功能

- **`oa_register`** — 接受 JSON 字符串或 JSON 文档 URL，解析
  OpenAPI 格式，并注册找到的每一个函数。支持的格式：
  - OpenAI `tools` 数组（`{type:'function', function:{...}}`）
  - OpenAI `functions` 数组（`{name, description, parameters}`）
  - 单个函数/工具对象
  - OpenAPI 3.x 规范（`paths` → 每个操作生成一个注册项）
- **`oa_remove`** — 从注册表中移除一个已注册的函数。如果它
  当前已作为原生工具激活，则先停用，再移除。
- **`oa_search`** — 按名称/描述关键词搜索已注册的函数。
- **`oa_invoke`** — 通过 HTTP 调用已注册的函数并传参
  （宽松模式：参数为自由 JSON）。
  - openai 类型：`POST {baseUrl}/v1/chat/completions`，并通过 `tool_choice`
    强制指定该函数。
  - openapi 类型：使用该操作的方法/路径直接请求，路径
    参数被替换，查询/请求体由参数构建。
- **`oa_activate`** — 将一个已注册函数**临时**暴露为原生
  模型工具，并附带其严格 JSON schema。激活后模型可在下一步
  直接调用它，并带 schema 校验（严格模式）。
- **`oa_deactivate`** — 从模型工具列表中移除一个已激活的原生工具。
- **`oa_active`** — 列出当前已激活的原生工具。

## 设计说明

- 已注册的函数保留在注册表中，默认**不**暴露 —
  模型工具列表保持精简。激活是显式且临时的：
  `oa_activate` 用于暴露，`oa_deactivate` 用于移除。
- 注册表是每个进程内的内存态（用
  `oa_register` 注册的函数不会跨重启持久化；重启后需重新注册）。
- 当代理插件存在时，网络经由 `ctx.get('proxyFetch')`，
  否则使用原生 `fetch`。
- 调用需要注册一个 `baseUrl`（即提供该函数/端点的 HTTP 主机）。
