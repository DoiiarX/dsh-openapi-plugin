# dsh-openapi-plugin

> [English](README.md) | [中文](README.zh.md)

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

Persistent DeepSeek Harness bundle bridging OpenAPI style interfaces into
searchable, invocable function registrations.

## What it provides

- **`oa_register`** — accept a JSON string or a JSON document URL, parse the
  OpenAPI format, and register every function found. Supported formats:
  - OpenAI `tools` array (`{type:'function', function:{...}}`)
  - OpenAI `functions` array (`{name, description, parameters}`)
  - a single function/tool object
  - OpenAPI 3.x spec (`paths` → one registration per operation)
- **`oa_remove`** — remove a registered function from the registry. If it is
  currently activated as a native tool, it is deactivated first, then removed.
- **`oa_search`** — search registered functions by name/description keyword.
- **`oa_invoke`** — call a registered function with arguments over HTTP
  (loose mode: arguments are free JSON).
  - openai kind: `POST {baseUrl}/v1/chat/completions` with `tool_choice`
    forcing that function.
  - openapi kind: direct request using the operation's method/path with path
    params substituted and query/body built from arguments.
- **`oa_activate`** — TEMPORARILY expose one registered function as a NATIVE
  model tool with its strict JSON schema. After activation the model can call
  it directly in the next step, with schema validation (strict mode).
- **`oa_deactivate`** — remove an activated native tool from the model tool
  list.
- **`oa_active`** — list currently activated native tools.

## Design notes

- Registered functions stay in the registry and are NOT exposed by default —
  the model tool list stays small. Activation is explicit and temporary:
  `oa_activate` to expose, `oa_deactivate` to remove.
- The registry is in-memory per process (functions registered with
  `oa_register` are not persisted across restarts; re-register after restart).
- Network goes through `ctx.get('proxyFetch')` when the proxy plugin is
  present, otherwise native `fetch`.
- Registration requires a `baseUrl` for invocations (the HTTP host that serves
  the function/endpoint).

## Installation

复制下面的指令块给你的 DSH agent，它会自动完成安装：

```text
请安装 openapi 插件（@local/dsh-openapi-plugin）：

1. 前置：本机已有 deepseek-harness 源码（本插件 link 依赖其中的 dsh-tools 包，
   位于 <deepseek-harness>/packages/core/tools）。
2. 克隆仓库：
   git clone https://github.com/DoiiarX/dsh-openapi-plugin
   cd dsh-openapi-plugin
3. 安装依赖：pnpm install
   （如果 package.json 里 dsh-tools 的 link 路径与你机器不符，改成你的
   deepseek-harness 实际路径后再装。）
4. 挂进 web profile：编辑 $HOME/.dsh/profiles/web/package.json，
   在 dependencies 加 "@local/dsh-openapi-plugin": "link:<本插件目录绝对路径>"，
   在 dsh.profile.bundles 加 "@local/dsh-openapi-plugin"。
5. 在 profile 目录执行 pnpm install。
6. 重启 web 进程，验证工具列表出现 oa_register / oa_search / oa_invoke 等工具。
```

本插件无设置页，不需要改 WEB_SETTINGS_NAMESPACES 白名单。
