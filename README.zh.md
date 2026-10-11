# dsh-openapi-plugin

> [English](README.md) | 中文

> 本插件属于 [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) 合集，完整的自研插件索引见该仓库。

把 OpenAPI 风格的接口定义桥接成**可发现、可调用**的注册项，并按「包」（app）组织起来的 DeepSeek Harness 插件。

## 核心模型

一次注册产出**一个包**（app）——它代表一个来源的一整套接口，承载「怎么连」（地址、鉴权）和「这是什么」（整包简介）。每个操作**必须且只能**属于一个包；包是硬归属。

标签（tag）是包之上的**松散一张网**：一个操作可以带多个标签，一个标签下可以横跨多个包。它只用于「我忘了包名时捞回来」，不承担归属。

操作名只需要**包内唯一**——两个服务都叫 `getById` 也不再互相覆盖。

## 发现路径（按代价从低到高）

模型应该这样走，而不是一上来就猜关键词：

1. `oa_apps()` — **总目录**：有哪些包、各含几个操作、干什么用、调用地址。
2. `oa_apps(app)` — **展开一个包**：操作名 + 一句简介，**故意不含参数**。
3. `oa_describe(name, app?)` — **单个操作的完整契约**：参数、必填、鉴权状态、调用示例。
4. `oa_invoke` / `oa_activate` — 真正调用。

搜索结果（`oa_search`）只返回包名、操作名与一句简介，不夹带参数 schema；参数按需用 `oa_describe` 取。

## 提供的工具

**发现**

- **`oa_apps`** — 不传参数 = 总目录；传 `app` = 展开该包的操作清单（不带参数细节）。
- **`oa_describe`** — 一个操作的完整契约（参数、必填、baseUrl、鉴权状态）。
- **`oa_search`** — 关键词/标签兜底检索。`query` 可省略（省略即列出全部）；支持 `app`、`tag` 过滤。

**调用**

- **`oa_invoke`** — 通过 HTTP 调用（宽松模式：参数为自由 JSON）。openai 风格走 `POST {baseUrl}/v1/chat/completions` + `tool_choice`；openapi 风格按该操作的方法/路径直接请求，路径参数被替换，查询/请求体由参数构建。
- **`oa_activate`** — 把某个操作**临时**暴露为原生模型工具（严格 JSON schema，下一步可直接调用）。
- **`oa_deactivate`** — 移除一个已激活的原生工具。
- **`oa_active`** — 列出当前已激活的原生工具。

**管理**

- **`oa_register`** — 解析 OpenAPI 源并注册为一个包。支持：OpenAPI 3.x 规范、OpenAI `tools` 数组、OpenAI `functions` 数组、单个函数对象；`source` 既可以是 JSON 字符串，也可以是指向 JSON 文档的 URL。包名默认取文档的 `info.title`，其次取 `baseUrl` 的主机名，可用 `app` 参数覆盖。OpenAPI 的 `operation.tags` 会被自动吸收为标签。
- **`oa_remove`** — 给 `name` 移除单个操作；只给 `app` 移除整个包。已激活的原生工具会先被停用。对不存在的目标保持幂等（返回提示而非报错）。

## 设计说明

- 注册项默认**不**暴露给模型：工具列表保持精简，激活是显式且临时的。
- 注册表**持久化**到 `$DSH_HOME/storages/openapi-registry.json`（可用 `storagePath` 配置覆盖），跨 Host 重启保留。
- **API Key 永不落盘**：只记录「曾经提供过钥匙」这一事实。重启后该包会报告 `apiKeyLost` / `auth: "bearer-lost-after-restart"`，而不是静默地以 401 失败。
- 所有工具输出都经过 lossless 清洗（丢弃 `undefined`、把 `-0` 归零）。OpenAPI 参数缺少 `description` 是常见情况，此前会让 `oa_search` 整个调用被 harness 门禁拒绝（`value is not lossless JSON`）。
- 当代理插件存在时，网络经由 `ctx.get('proxyFetch')`，否则使用原生 `fetch`。
- openapi 风格的操作需要注册一个 `baseUrl`；openai 风格还需要 `model`（缺省 `gpt-4o-mini`）。

## 测试

```bash
node test-openapi.mjs          # 冒烟：工具面 + 注册/搜索/描述/激活/移除
node test-openapi-remove.mjs   # 激活后移除的清理行为 + 幂等移除
node test-openapi-apps.mjs     # 分目录/展开/描述、lossless 回归、跨包同名、过滤、持久化、整包移除

# 前后对照实验（衡量「模型是否更会用」）
git show HEAD:implementation.js > implementation.old.mjs
node eval-discovery.mjs
```

三个测试都使用临时目录里的私有注册表文件，**不会**触碰真实的 `$DSH_HOME/storages/openapi-registry.json`。

## 安装

复制下面的指令块给你的 DSH agent，它会自动完成安装：

```text
请安装 openapi 插件（@doiiarx/dsh-openapi-plugin）：

1. 前置：本机已有 deepseek-harness 源码（本插件 link 依赖其中的 dsh-tools 包，
   位于 <deepseek-harness>/packages/core/tools）。
2. 克隆仓库：
   git clone https://github.com/DoiiarX/dsh-openapi-plugin
   cd dsh-openapi-plugin
3. 安装依赖：pnpm install
   （如果 package.json 里 dsh-tools 的 link 路径与你机器不符，改成你的
   deepseek-harness 实际路径后再装。）
4. 挂进 web profile：编辑 $HOME/.dsh/profiles/web/package.json，
   在 dependencies 加 "@doiiarx/dsh-openapi-plugin": "link:<本插件目录绝对路径>"，
   在 dsh.profile.bundles 加 "@doiiarx/dsh-openapi-plugin"。
5. 在 profile 目录执行 pnpm install。
6. 重启 web 进程，验证工具列表出现 oa_register / oa_apps / oa_describe / oa_search 等工具。
```

本插件无设置页，不需要改 WEB_SETTINGS_NAMESPACES 白名单。
