# MobileClaw 1.9.8 协议调查

## 范围与证据

用户给出的 `/Application/MobileClaw.app` 不存在；唯一明确匹配为 `/Applications/MobileClaw.app`。未修改、启动或注入目标应用，未读取用户配置和钥匙串。

- 版本：renderer 的 `rV.version = 1.9.8`。
- `Contents/Resources/app.asar` SHA-256：`3026e2f39c861b656cad851b09a7179ab6007db97bd5329b190656ae99ef42a7`。
- REA 静态分析 Evidence ID：`ev_be3a64b698d63cdee9e4c261383ad9ea33a9a37ebe0f88ac958e19e8a64cd2d5`。
- REA 读取了 158 个选定源码文件；其图覆盖不完整，部分展开关系受到资源预算限制。不能用静态结果证明运行时实际行为或完整覆盖所有登录入口。
- 普通文件工具补充读取 `Contents/Resources/binaries/engine-node.js`，SHA-256：`ff36eddea4ceb8a2440d73a85b95ee4c83187efa4fc7048f5ddd178e7da2d6d5`。以下 engine 行号来自该精确文件，**不是 REA 动态证据**。
- 未发布提取的源码、完整应用包和庞大的原始分析记录；仅公开协议说明及独立编写的实现。

## 静态观察

### 登录与身份

主要来源：ASAR 的 `dist/assets/index-C7INMgFG.js`（单行压缩文件，以函数名定位）。

基地址 `Xa = https://zhenze-huhehaote.cmecloud.cn/desktop/manager`，服务版本 `Vg = 2.6.1`。客户端版本和服务版本不同。

| 函数 | 方法与相对路径 | 已观察用途 |
| --- | --- | --- |
| `Nx` | POST `/auth/captcha` | 短信发送 |
| `aY` | POST `/auth/login` | 短信验证登录 |
| `nY` | POST `/auth/password/login` | 密码登录 |
| `rY` | POST `/auth/password/set` | 设置/重置密码，插件未实现 |
| `qG` | POST `/auth/qrcode` | 返回 `qrId`、`qrCodeBase64` |
| `eY` | POST `/auth/qrstate` | 轮询二维码，result 为 `-1` 过期、`1` 已扫码、`2` 已确认 |
| `tY` | POST `/auth/qrlogin` | 以 qrId 换取登录结果，插件未实现扫码 UI |
| `af` | POST `/auth/refresh` | 使用 **refresh token** 作为 Bearer，body 为设备及工作区信息 |
| `TK` | POST `/auth/logout` | 官方注销；插件仅删除宿主凭据，不声称吊销上游令牌 |
| `zx` | GET `/user-subjects` | 手机号绑定的移动云账号 |
| `sY` | GET `/member-subjects` | 企业列表，插件未实现 |

代码还保留 `/auth/sim/login` 识别和 SIM 认证 UI/错误处理；不能从这些片段证明当前桌面发行版可完成 SIM 登录，插件未实现。

`is()` 生成 `deviceId`、`hostname`、`mac`、`clientVersion`、`os`，可附加 `aiProvider`；`pd()` 为刷新加入 `userId`，企业工作区再加入 `resId`、`memId`、`resUserId`、`orgId`。

`Zs.encrypt()` 使用 node-forge 的 `RSAES-PKCS1-V1_5`，输入为 UTF-8，输出 Base64。`Ti` 是应用内置的 RSA 公钥。短信登录 body 为设备字段 + `phoneEnc` + `captcha`；密码登录为设备字段 + `phoneEnc` + `passwordEnc`。

返回数据读取 `accessToken`、`refreshToken`、ISO `expiresAt`、`userSubject`（或 `userId`、`userName`）。客户端缺少 expiresAt 时使用 2 小时兜底；插件沿用这个兜底。账号选择后刷新一次，再按所选订阅的 aiProvider 刷新。

### 模型网关

- engine `532205–532290`：本地模式缺少自定义 baseURL 时，使用 `https://zhenze-huhehaote.cmecloud.cn/desktop/v1`；从 DesktopConfig 读取 access token，添加 `Authorization: Bearer …`、`service-version` 和按情况添加 `ai-provider`。
- engine `531199–531206`：`ecloud` / `ecloud-desktop` 属于内置代理标识，其他被代理的 provider ID 作为 ai-provider。
- engine `537968–538066`：基线供应商使用 `@ai-sdk/openai-compatible`，包含 `agent-os`、`glm-4.6`、`minimax-m2.1`、`glm-4.6v` 等。
- 由 SDK 的 Chat Completions 路径和基地址得出最终 POST URL：`https://zhenze-huhehaote.cmecloud.cn/desktop/v1/chat/completions`。
- renderer `CY.listModels()`：GET `https://zhenze-huhehaote.cmecloud.cn/desktop/gate/model/modelList`，可选 modelType。正常内置模型加载未给 modelType，插件同样不添加猜测值。
- renderer 模型 store `P`、`D`：按订阅可用 packageList.providerType 筛选 model.pkgTypes；`pkg-types` 进入聊天请求，`context-limit` 用于引擎模型配置，不是聊天请求头。
- engine `resolveContext()` 把 `contextLength` 乘 1000；`FALLBACK_MODEL_DEFAULTS` 是 context 200000、output 32768。

### 订阅与用量

renderer `fo`：

- GET `/subscriptions/getAiProviders`：当前客户端使用的订阅列表；旧版另有 `/subscriptions/ai-providers`。
- GET `/subscriptions/coding-plan`，或 `/subscriptions/coding-plans/{aiProvider}`：日/周/月窗口。
- GET `/credits/v2/exp-credit`：体验额度钱包，插件以余额窗口显示。
- GET `/ent/current-usage`：企业用量，当前插件未实现。

观察到 Coding Plan 字段 `dayUsedCount`、`dayInitCount`、`dayRefreshTime`，以及 week/month 对应字段、`planName`、`expireTime`、`autoRenew`。

### 错误语义

- `C401004` + refresh HTTP 401：客户端认为 refresh token 终态失效。
- `C401005`：企业账号禁用。
- `C400999`：广义业务/参数错误。客户端部分代码将其用于 aiProvider 回退，但后续匿名探针证明缺少 MAC、OS、手机号等也会返回此码，不能仅凭它认定供应商无效。详见 [后续复核](FOLLOWUP-AUDIT.md)。
- 某些上游 401 正文为配额耗尽，不应误判账号登录失效。插件通过 `X-Magpie-Sign-In: kept` 保留账号。

## 插件设计选择（不是已观察的官方行为）

1. 只支持个人工作区，扫码、SIM、密码设置和企业工作区暂不接入。
2. 新建登录生成独立 UUID deviceId，hostname/os 来自当前宿主，MAC 读取真实网卡。早期空 MAC 已被匿名探针证实不满足服务端必填约束，因此已修正。不冒用其他设备或伪造硬件 MAC。
3. 多个 user-subjects 时要求明确填写 userId；未实现动态账号选择对话框。
4. 未指定 aiProvider 时选择官方订阅接口的第一项，登录说明中明确告知。
5. 请求固定到官方域名和 Chat Completions 路径；拒绝重定向。
6. 未知模型输出上限使用保守 8192；不宣称未知模型支持图像、视频、推理或免费调用。
7. 未知额度不填 0；API 返回异常时抛错，由 Magpie 按文档保留原模型列表。
8. 不解密或自动导入官方客户端凭据；不发布其捆绑代码。

## 已执行验证

- Node 单元测试：初始 12 项通过，后续增加导入、UA 和错误校验覆盖。测试仅使用虚构凭据与模拟 fetch。
- Magpie `0.1.3489`，隔离 HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME 加载本地插件成功。JSON 列出 `mobileclaw`、三种登录方式、四个基线模型、`usage: true`、`renews: true`，没有登录账号或加载错误。
- 2026-11-10，对模型列表 GET 和模型网关 POST 发出**不带凭据**的有限请求。两者均返回 HTTP 401 和 `{"errorCode":"UNAUTHORIZED","errorMessage":"missing token","state":"Error"}`。只证明这些路径当前接受连接并要求认证，**不证明真实推理协议、模型权限或账号流程成功**。

## 未完成的真实联调

仍需用户主动以自己的账号测试：短信发送与验证、密码登录、账号绑定、所选订阅、真实模型 JSON 形状、推理/工具调用流、令牌轮换、额度窗口单位和到期时间。

没有已认证的网络抓包或成功模型回复，因此不能宣称本插件已可用于生产。发现上游实际字段与静态假设不同，应先补充脱敏证据和回归测试，再调整实现。
