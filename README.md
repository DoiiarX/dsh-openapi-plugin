# dsh-openapi-plugin

> English | [中文](README.zh.md)

> Part of the [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) collection; see that repository for the full index.

A persistent DeepSeek Harness plugin that bridges OpenAPI style interface
definitions into searchable, invocable registrations organized as **apps**
(packages).

## The model

One registration run produces **one app** — a single source's whole interface
surface. The app owns "how to connect" (base URL, auth) and "what this is"
(one-line summary). Every operation belongs to **exactly one** app; that
membership is the hard ownership edge.

Tags are a **loose net** on top: an operation may carry several, and one tag can
span many apps. Tags exist so the model can recover something it forgot the app
name of — they never carry ownership.

Operation names only need to be unique **within an app**, so two services that
both export `getById` no longer silently overwrite each other.

## Discovery path (cheap to expensive)

The intended route — not keyword guessing:

1. `oa_apps()` — **directory**: which apps exist, how many operations each has,
   what they are for, where they live.
2. `oa_apps(app)` — **expand one app**: operation names plus a one-line summary,
   **deliberately without parameters**.
3. `oa_describe(name, app?)` — **one operation's full contract**: parameters,
   required fields, auth state, and a ready-to-use call.
4. `oa_invoke` / `oa_activate` — actually call it.

`oa_search` returns only the app, the operation name and a one-line summary —
never parameter schemas. Details are fetched on demand with `oa_describe`.

## Tools

**Discovery**

- **`oa_apps`** — no args = directory; with `app` = that app's operation list
  (no parameter detail).
- **`oa_describe`** — full contract of one operation (parameters, required,
  baseUrl, auth state).
- **`oa_search`** — keyword/tag fallback. `query` may be omitted (= list
  everything); supports `app` and `tag` filters.

**Calling**

- **`oa_invoke`** — call over HTTP (loose mode: free JSON arguments).
  openai kind: `POST {baseUrl}/v1/chat/completions` with `tool_choice`;
  openapi kind: direct request using the operation's method/path with path
  params substituted and query/body built from arguments.
- **`oa_activate`** — TEMPORARILY expose one operation as a NATIVE model tool
  with its strict JSON schema.
- **`oa_deactivate`** — remove an activated native tool.
- **`oa_active`** — list currently activated native tools.

**Management**

- **`oa_register`** — parse an OpenAPI source and register it as an app.
  Supported: OpenAPI 3.x specs, OpenAI `tools` arrays, OpenAI `functions`
  arrays, and single function objects; `source` is a JSON string or a JSON
  document URL. The app name defaults to the document's `info.title`, then to
  the `baseUrl` host, and can be overridden with `app`. OpenAPI
  `operation.tags` are absorbed automatically.
- **`oa_remove`** — with `name`, remove one operation; with only `app`, remove
  the whole app. Activated native tools are torn down first. Removing something
  absent stays idempotent (a warning, not a throw).

## Design notes

- Registered operations are NOT exposed to the model by default — the tool list
  stays small, and activation is explicit and temporary.
- The registry **persists** to `$DSH_HOME/storages/openapi-registry.json`
  (override with the `storagePath` config), so it survives a Host restart.
- **API keys are never written to disk** — only the fact that one was supplied.
  After a restart such an app reports `apiKeyLost` /
  `auth: "bearer-lost-after-restart"` instead of silently failing with a 401.
- Every tool output is passed through lossless sanitization (drops `undefined`,
  normalizes `-0`). OpenAPI parameters without a `description` are common, and
  they used to make the whole `oa_search` call get rejected by the harness gate
  with `value is not lossless JSON`.
- Network goes through `ctx.get('proxyFetch')` when the proxy plugin is
  present, else native `fetch`.
- openapi-kind operations need a `baseUrl`; openai-kind ones need `model`
  (defaults to `gpt-4o-mini`).

## Tests

```bash
node test-openapi.mjs          # smoke: tool surface + register/search/describe/activate/remove
node test-openapi-remove.mjs   # teardown on remove + idempotent removal
node test-openapi-apps.mjs     # directory/expand/describe, lossless regression, cross-app
                               # name collisions, filters, persistence, whole-app removal

# before/after discovery eval (measures whether the model gets better at using it)
git show HEAD:implementation.js > implementation.old.mjs
node eval-discovery.mjs
```

All three tests write to a private temp registry file and never touch the real
`$DSH_HOME/storages/openapi-registry.json`.

## Installation

Copy the instruction block below to your DSH agent and it will install itself:

```text
Please install the openapi plugin (@doiiarx/dsh-openapi-plugin):

1. Prerequisite: deepseek-harness sources are on this machine (this plugin links
   against the dsh-tools package at <deepseek-harness>/packages/core/tools).
2. Clone:
   git clone https://github.com/DoiiarX/dsh-openapi-plugin
   cd dsh-openapi-plugin
3. Install deps: pnpm install
   (If the dsh-tools link path in package.json does not match your machine,
   fix it to your deepseek-harness path before installing.)
4. Mount into the web profile: edit $HOME/.dsh/profiles/web/package.json, add
   "@doiiarx/dsh-openapi-plugin": "link:<absolute path to this plugin>" to
   dependencies, and add "@doiiarx/dsh-openapi-plugin" to dsh.profile.bundles.
5. Run pnpm install in the profile directory.
6. Restart the web process and verify oa_register / oa_apps / oa_describe /
   oa_search appear in the tool list.
```

This plugin has no settings page and needs no WEB_SETTINGS_NAMESPACES entry.
