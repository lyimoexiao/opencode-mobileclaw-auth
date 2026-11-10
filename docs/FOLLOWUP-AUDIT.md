# 登录 400 后的协议复核与实现差距

本次复核针对 MobileClaw macOS 1.9.8，同一份 ASAR 与 engine 文件，哈希见 [PROTOCOL.md](PROTOCOL.md)。目标是核查协议差异，**不是宣称所有 400 已解决**。

## 1. UA：管理 API 与模型推理不是同一个网络栈

### 已观察的静态事实

- `electron/dist/main.cjs:202` 调用 `app.setName("MobileClaw")`。
- `dist/assets/index-C7INMgFG.js` 中 `xm(e,t)` 直接调用 `globalThis.fetch(e,t)`。管理 API 的 `WG.request()` 经这个函数发出请求。
- `electron/dist/preload.cjs` 未替换 fetch；已检索 main 中未发现 `setUserAgent`、`userAgentFallback` 或 `onBeforeSendHeaders` 改写 UA 的代码。检索未发现不代表运行时绝无其他影响。
- `Electron Framework` 的 Info.plist 标明 Electron **36.9.5**。
- 对该 framework 二进制进行字符串读取，发现 `Chrome/136.0.7103.177 Electron/36.9.5` 和 UA 构造模板。
- engine `422983–423000` 的 `createOpenAICompatible()` 使用 `withUserAgentSuffix(..., ai-sdk/openai-compatible/${VERSION5})`；其来源路径版本是 **1.0.32**。底层 provider-utils 还会追加自己的版本与运行环境标识。

### 结论与边界

管理 API 默认属于 **Electron/Chromium 浏览器 UA**，模型推理属于 **AI SDK UA**。不应把二者粗暴视为同一套 UA，也不应从遥测的 `Ecbot/...` 字符串推断真实 HTTP UA：遥测代码的 user_agent 数据字段不是设置请求头的证据。

此前插件没有为管理 API 设置 UA，会落到 Magpie/Bun 宿主默认 UA。这是一个已确认的兼容差异。

现为管理 API 添加基于该 macOS 构建重建的兼容配置：

```text
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) MobileClaw/1.9.8 Chrome/136.0.7103.177 Electron/36.9.5 Safari/537.36
```

**这不是从运行中的应用捕获的精确 UA**。产品 token 的拼接顺序等细节仍需真实网络观测核实。它不改变真实 TLS/HTTP 指纹，不伪造 Cookie、登录态或硬件标识，也不应被当作绕过访问控制的方法。模型推理仍保留 SDK 请求头，不强行覆盖为浏览器 UA。

## 2. 服务端空请求实测：MAC 确实必填

使用无手机号、无密码、无令牌的空 JSON `{}`，分别以普通 UA 和上述 Electron 兼容 UA 请求：

- POST `/desktop/manager/auth/captcha`
- POST `/desktop/manager/auth/password/login`

没有提供手机号，因此不会发送短信；没有向任何真实账号提交密码。

两种 UA 下都得到 HTTP 400 / `C400999`。返回的固定校验信息包括：

```text
操作系统不能为空
手机号不能为空
设备 Id 不能为空
客户端版本号不能为空
MAC 不能为空
主机名不能为空
密码不能为空（仅密码登录）
```

因此：

1. 早期实现 `mac: ''` 确实不满足服务端约束，已改为读取当前宿主的实际网络接口，过滤规则与应用一致。
2. 若机器只暴露回环接口、没有可用 MAC，仍可能 400；不应伪造别人的设备信息。
3. 当前 `os` 已由 `platform + release` 修正为官方 `getSystemInfo().os_version` 对应的 release-only 格式。
4. `C400999` 是广义业务/参数错误，**不能仅凭这个码认定 aiProvider 无效**。
5. 两种 UA 都执行了参数校验，因此本次探针没有证明服务端因非浏览器 UA 拒绝登录。真实有效请求仍须进一步比较。

另外，无凭据 GET `/desktop/manager/user-subjects` 在两种 UA 下都返回 401 / missing token。

## 3. 加密和请求格式复核

- 已按字节比较插件公钥与 renderer `Ti` 的 Base64 负载，完全一致。
- 原客户端 node-forge 使用 `RSAES-PKCS1-V1_5`，插件 Node crypto 使用 `RSA_PKCS1_PADDING`，不是 OAEP。
- PKCS#1 v1.5 带随机填充，不能通过比较两次密文相等来验证。
- 手机号字段是 `phoneEnc`，密码字段是 `passwordEnc`；短信验证码字段是 `captcha`。
- 登录版本号 `clientVersion = 1.9.8` 与请求头 `service-version = 2.6.1` 是不同维度，不能互换。
- 官方 renderer 支持本地 serviceVersion 覆盖。此次只核对了本地配置的版本、serviceVersion 和工作区元数据，未输出任何凭据；当前没有 serviceVersion 覆盖，版本 1.9.8，个人工作区。
- 主客户端的默认管理请求头是 `service-version`；有 JSON body 时添加 Content-Type。没有静态证据表明密码/验证码请求还需要额外签名。
- Chromium 可能自动附加 Origin、Sec-Fetch 等浏览器头，但未捕获真实请求前不添加猜测的 Origin/Referer/Cookie。

## 4. 已修复的流程差异

| 差异 | 处理 |
| --- | --- |
| mac 为空、os 格式不一致 | 使用实际网卡 MAC、release-only OS |
| 所有登录方式误填浏览器首页 | `url: ''`，不再主动要求打开浏览器 |
| 手动导入执行完整账号绑定与刷新 | 导入只校验 access token，不立即旋转 refresh token |
| 错误只显示状态码 | 返回具体接口、HTTP 状态、受限错误码 |
| 上游 errorMessage 可能含隐私 | 仅提取已确认的固定必填校验短语，不直接展示全文 |
| 登录 callback 抛错被宿主简化 | 显式 `{type:'failed', error}` 返回可显示的安全错误 |
| 管理 API 使用宿主默认 UA | 添加有来源说明的 Electron 兼容 UA |

## 5. 仍未实现或不完整的功能

### 登录与生命周期

- **扫码登录**：二维码生成、状态轮询、换取 token 的接口已找到；尚未实现安全二维码展示和取消/过期 UI。
- **SIM 登录**：存在 UI 及部分路径/错误处理；尚未证明当前桌面发行版可用，未实现。
- **设置/重置密码**：`/auth/password/set` 已找到，未实现。
- **多主体交互选择**：官方在登录后列出 `/user-subjects`；插件目前多账号需用户预填 userId，不具备动态选择 UI。
- **企业工作区**：官方 `/member-subjects` 后追加 resId、memId、resUserId、orgId 再刷新。插件未实现；不能仅填一个企业 userId 冒充完成绑定。
- **上游退出登录/吊销**：宿主 logout 删除本地凭据，不调用官方 `/auth/logout`。
- **C400999 的细分恢复**：官方客户端某些代码对其作 aiProvider 回退，但服务端已证明它也表示其他参数错误；插件不应对所有 C400999 自动删除 aiProvider 重试。
- **令牌导入过期时间**：当前沿用官方缺少 expiresAt 时的两小时兜底，不能把它理解为导入 access token 的真实剩余有效期。401 时续期或重新导入仍可能必要。

### 模型列表与支持参数

已对齐的字段：

| 官方字段/行为 | 插件映射 |
| --- | --- |
| `modelName` | `id`、`api.id`、默认 `name` |
| `aliasName` | 非空时作为显示名；本次实测账号全部为 `null` |
| `contextLength` | `limit.context = contextLength * 1000`（官方 `resolveContext` 同样乘 1000） |
| `maxOutputLength` | `limit.output = maxOutputLength * 1000`，不超过上下文 |
| 缺失 context/output | 官方 engine 兜底 200000 / 32768 |
| `modelTypes` | 文本→输入/输出 text；图片理解→input.image + attachment + modalities.input 含 image；视频理解→input.video；图片生成→output.image；视频生成→output.video |
| `pkgTypes` | 与订阅 `packageList.available` 交集，作为 chat 的 `pkg-types` |
| `rate` | 原样作为 Magpie `rate`；空串或 `0` 不写 |
| `aiProvider` | chat 的 `ai-provider` 头 |

没有对齐或不做的部分：

- `free` 不从 `pkgTypes` 推断；官方没有在该列表里直接给“免费”语义。
- `reasoning`、工具调用能力没有独立字段；沿用官方兜底的 `tool_call: true`，不额外宣称推理能力。
- `aliasName` 在官方普通模型选择路径中没有被使用；插件仅在非空时作为名称。
- 自动模式 Token Plan 的“只允许 `auto`”规则、企业模型、AICC 图像/视频任务没有实现。
- 官方 chat 不发 `context-limit`，插件也不发；上下文只用于模型 `limit.context`。

图片理解的能力标记已对齐到 Magpie 的 `capabilities.input.image`、`attachment` 和 `modalities.input`；loader 对 `image_url` 内容原样透传，并有单元测试确认请求体不被改写。当前账号只有 `FREE` 文本模型，`minimax/minimax-m3` 这类多模态模型需要 Token Plan，未做真实图片请求验证。视频理解只标能力，Magpie/OpenAI Chat 的视频消息支持未验证。

Magpie 不会把 `provider.models` 返回的模型 `headers` 带到聊天请求。插件因此在第一次聊天前按账号拉一次模型列表，生成模型 ID→`pkg-types` 映射。这个坑曾导致真实账号的 `provider test` 返回 500；补上后 `glm-5.3` 实测 200。

### 额度与模型

当前额度已实现 Coding Plan 日/周/月窗口、个人 Token Plan 和应用体验额度余额；**仍不是完整的 MobileClaw 全部额度**。其余已发现接口：

| 官方接口（相对 /desktop/manager） | 用途 | 当前状态 |
| --- | --- | --- |
| `/subscriptions/token-plans-personal/{provider}` | 个人 Token Plan | 已实现 used/total tokens 映射；空数组不显示 |
| `/subscriptions/coding-plan-tokens/{provider}` | Coding Plan token 套餐 | 未实现 |
| `/credits/v2/exp-credit` | 体验额度 | 已实现余额窗口；不伪造 used/limit |
| `/subscriptions/finance-benefit` | 金融权益 | 未实现 |
| `/subscriptions/free-usages/{provider}` | 免费用量统计 | 未实现 |
| `/ent/current-usage` | 企业个人用量 | 未实现 |

- 官方 token 套餐存在 `usedTokens`、`totalTokens`、`effectTime`、`expireTime` 等字段；不可混作 Coding Plan 请求次数。
- 2026-11-10 用当前插件账号实测：Coding Plan 与 Token Plan 均返回空数组，体验额度返回 `remainTokens: 36000000`、`totalTokens: 0`、`expireTime: null`。Magpie 的 `quota` 已显示“体验额度 36,000,000 tokens left”。空 `totalTokens` 不能当作 0 额度或 100% 已用。
- 同一账号的模型列表有 16 条，按 `FREE` 套餐过滤后剩 3 条：`glm-5.3`、`glm-5.3-flash`、`deepseek-v4.1-flash`。`magpie provider test mobileclaw` 对 `glm-5.3` 返回 `✓ chat`。
- renderer 对某个特定自动模式 Token Plan 有模型 `auto` 专属限制；插件尚未完全复制这项业务规则，可能列出实际不可用模型。
- 自定义模型含 RSA 包装 AES key、AES-GCM 解密 apiKey 的独立流程；插件不读取这些密钥，也不支持自定义厂商模型同步。
- 未实现内部员工模型、AICC 图像/视频任务、Moma 深链导入、企业模型列表。
- 未实现新活动的签到及赠送权益领取；发现赠送类型字符串不等于证明有可直接调用的领取 API。
- 动态模型的推理、图像、多模态和真实输出上限尚未逐一验证；仍采取保守能力声明。

## 6. 当前登录状态

当前插件账号已实测登录成功，模型列表、额度、搜索接口和 `glm-5.3` 聊天均可返回。短信/密码登录的独立全流程仍需自测；早期 400 已补 MAC、OS、UA、deviceId 等参数，但不声称所有账号和所有登录方式都已通过。

## 7. 当前应如何定位剩余 400

真实失败仍需至少一条**不含凭据**的信息：

1. 失败发生在发送短信、提交验证码、密码登录还是登录后的查询。
2. 新版显示的具体 endpoint、HTTP 状态和错误码。
3. 若有固定必填校验提示，记录字段名。
4. 如响应来自 HTML/WAF/代理而非官方 JSON，不应继续调整 RSA 或业务参数，应先排查路由及代理。

目前未捕获真实已认证请求，也没有成功登录/推理证据。因此不能宣称补 UA 已修复登录；必须用同一账号主动操作后的反馈继续验证。凭据导出工具保持在仓库外，不提交 GitHub。


## 遥测

遥测位于 renderer，不在 engine 中；engine 未检出 `gwyydc` 或 `/track` 调用。

### 已观察的配置

- 地址：`https://gwyydc.cmecloud.cn:31119`，上报路径 `/track`。
- `siteId = 1`，`hostname = com.cmss.mobileclaw-desktop`，`page_title = MobileClaw-desktop`，`appVersion = 1.9.8`。
- 每 5 分钟刷新；队列达到 10 条触发；本地 `ecbot_track_pending` 最多保存 200 条；最多重试 3 次；`debug=false`，`apiKey` 未配置。
- POST `application/json`，`keepalive: true`，超时 10 秒。
- 页面切换通过路由 `afterEach` 产生 pageview。

### 字段与事件

公共字段：`site_id`、`hostname`、`page_title`、`user_agent`、`language`、`screenWidth`、`screenHeight`。

- pageview：`type=pageview`、`pathname`、`page_title`、过滤后的 `querystring`（仅允许 `tab`、`scope`、`category`、`source`、`plan`、`channel`、`view` 等键）、`referrer`、以及以 `CIDC-U-` 开头的 `user_id`。
- custom_event：`event_name`、`properties`。properties 序列化后超过 2048 字符会截断，单个字符串超过 200 字符会截断。
- 已定位的 custom_event 包括：`app_error`、`chat_send_result`、`chat_model_select`、`chat_suggestion_click`、`chat_topbar_action`、`logout_click`、`companion_create`、`companion_edit`、`expert_use`、`schedule_create`、`skill_use`、`skill_share`、`skill_install`/`skill_update`、`setting_section_click`、`sidebar_item_click`、`message_channel_add`、`message_channel_enter`、`account_version_switch`、`subscribe_click`、`skills_tab_filter` 等。
- 隐私边界：没有发现把完整对话提示词作为固定字段上报；但 `chat_suggestion_click` 会发送被点击建议的 `text`，`app_error` 会发送错误信息/堆栈序列化结果，专家和技能事件包含 id/name。因此不能把官方遥测简单描述为完全匿名。

### 本插件的处理

插件不复制或伪造上述遥测，不发送 pageview/custom_event，也不冒充官方客户端以规避封号。这是有意的安全和合规边界，不是待实现功能。插件只发送完成登录、模型发现、额度读取和模型推理所需的最小请求；UA 兼容仅用于协议互操作，不用于伪造官方使用记录。


## 搜索

插件按 Magpie 的 `search` 钩子接入官方接口：

```text
GET https://zhenze-huhehaote.cmecloud.cn/desktop/search/v2/mwebsearch
```

参数为 `q`、`ref_prom=aiso-sr`、`sid`、`count`，使用当前账号令牌和 `service-version`。返回 `items` 后取 `title`、`url`、`summary_ai` 或 `summary`、`time`，转成 Magpie 的页面结构。2026-11-10 实测返回 HTTP 200、`errno: 0`、1 条结果。

官方 engine 的搜索工具还有 DuckDuckGo 和 Exa 兜底；插件只接主接口，失败时交给 Magpie 的搜索重试/其他搜索源。`fresh_day`、`date_range` 和独立 `web_search` 工具参数没有暴露给 Magpie 搜索钩子。
