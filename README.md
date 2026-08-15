# dsh-oneapi-plugin

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

Persistent DeepSeek Harness bundle bridging one-api style interfaces into
searchable, invocable function registrations.

## What it provides

- **`oa_register`** — accept a JSON string or a JSON document URL, parse the
  one-api format, and register every function found. Supported formats:
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
