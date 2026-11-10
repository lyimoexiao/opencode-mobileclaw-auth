import { constants, publicEncrypt, randomUUID } from 'node:crypto'
import { hostname, networkInterfaces, release } from 'node:os'

export const PROVIDER = 'mobileclaw'
export const ORIGIN = 'https://zhenze-huhehaote.cmecloud.cn'
export const BASE = `${ORIGIN}/desktop/v1`
export const MANAGER = `${ORIGIN}/desktop/manager`
export const SERVICE_VERSION = '2.6.1'
// UA profile reconstructed from inspected binaries. Electron 36.9.5,
// Chrome 136.0.7103.177, product MobileClaw/1.9.8. Electron builds the platform
// token itself; macOS is the inspected platform, others follow Electron's
// documented default template and remain uncaptured.
const APP_VERSION = '1.9.8'
const CHROME_VERSION = '136.0.7103.177'
const ELECTRON_VERSION = '36.9.5'
export const OPENAI_COMPATIBLE_UA_SUFFIX = 'ai-sdk/openai-compatible/1.0.32'
// Official engine sets `User-Agent: opencode/${Installation.VERSION}` and the
// shipped engine resolves Installation.VERSION to "local". SDK then appends
// its own suffix. Management calls use the Electron renderer instead.
export const OPENCODE_CHAT_UA = 'opencode/local'

export function electronUserAgent(platform = process.platform, arch = process.arch) {
  const token = platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : `X11; Linux ${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) MobileClaw/${APP_VERSION} Chrome/${CHROME_VERSION} Electron/${ELECTRON_VERSION} Safari/537.36`
}

export const MANAGEMENT_UA = electronUserAgent()

// Mirrors the official SDK's withUserAgentSuffix(): preserve the runtime base
// UA, then append exactly one official openai-compatible suffix. Do not inject
// an Electron base into model calls; the official engine does not do that.
export function withOfficialChatUserAgent(input) {
  const h = new Headers(input)
  h.set('user-agent', `${OPENCODE_CHAT_UA} ${OPENAI_COMPATIBLE_UA_SUFFIX}`)
  return h
}
// Public encryption key shipped by MobileClaw 1.9.8; NOT a credential.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuq7b8g1uhnRitWzqgx4P
suXsDpJqg17imlz7vToQIAziX9IcclWE0sGXiQzsCTKHr4zFASc6GIQsJgjph9n7
jBzChmBul2+KhIbXzxzOC/ohUZWXq7k1OC+Kj3jD8V6LXwi3WE0+lU5q8AJ3FDGX
X4L7ibvohuic/FfeDBgJ6BaGCr7AnzxCj7BjU/5di1ThhSZoxVR0C16Yerk5bwo5
odmHKiu5jgjaT67oJTjLFnb7MXiMKB+8lNT016bcmOcE7BGCxcUSQANcJUPftVdu
cdlk5qN4D0Z1rcxb+s69O+wcprFkl0iAtE+vv8sFX/B0iIzpB9Mak+kC+sbjuYuX
AwIDAQAB
-----END PUBLIC KEY-----`

export function encrypt(value) {
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString('base64')
}

export function device(inputs = {}) {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, mac: a.mac })))
  const selected = candidates.find(c => !/virtual|vmware|docker|veth|bridge/i.test(c.name) && c.mac !== '00:00:00:00:00:00') || candidates[0]
  return {
    deviceId: inputs.deviceId?.trim() || randomUUID(),
    hostname: hostname(), mac: selected?.mac || '', clientVersion: '1.9.8', os: release(),
    ...(inputs.userId?.trim() ? { userId: inputs.userId.trim() } : {}),
    ...(inputs.aiProvider?.trim() ? { aiProvider: inputs.aiProvider.trim() } : {}),
  }
}

export function headers(auth, extra, profile = 'management') {
  const h = profile === 'chat'
    ? withOfficialChatUserAgent(extra)
    : new Headers(extra)
  h.set('service-version', SERVICE_VERSION)
  if (profile !== 'chat') h.set('user-agent', MANAGEMENT_UA)
  if (auth?.access || auth?.key) h.set('authorization', `Bearer ${auth.access || auth.key}`)
  if (auth?.device?.aiProvider) h.set('ai-provider', auth.device.aiProvider)
  return h
}

export async function json(url, { token, body, signal, method, extraHeaders, refresh = false } = {}) {
  const h = headers(token ? { access: token } : undefined, extraHeaders)
  h.set('accept', '*/*')
  if (body !== undefined) h.set('content-type', 'application/json')
  const res = await fetch(url, {
    method: method || (body === undefined ? 'GET' : 'POST'), headers: h, redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal || AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    // Do not surface upstream bodies: they may contain secrets or personal information.
    let code
    let validation = ''
    try {
      const payload = await res.json()
      code = payload.errorCode
      // Only expose known, fixed validation phrases. The general errorMessage
      // may echo personal data; do not log or return it verbatim.
      const required = ['操作系统不能为空', '手机号不能为空', '设备 Id 不能为空', '客户端版本号不能为空', 'MAC 不能为空', '主机名不能为空', '密码不能为空', '验证码不能为空']
      const hints = typeof payload.errorMessage === 'string'
        ? required.filter(phrase => payload.errorMessage.includes(phrase)) : []
      if (hints.length) validation = ` [${hints.join('; ')}]`
      // FastAPI/Pydantic validation details: include only known field names and
      // fixed error types, never msg/input/ctx (which may echo credentials).
      if (Array.isArray(payload.detail)) {
        const fields = new Set(['body', 'query', 'header', 'deviceId', 'hostname', 'mac', 'clientVersion', 'os', 'phoneEnc', 'passwordEnc', 'captcha', 'userId', 'aiProvider'])
        const types = new Set(['missing', 'value_error.missing', 'string_type', 'type_error.str', 'string_too_short', 'string_pattern_mismatch', 'extra_forbidden'])
        const issues = payload.detail.slice(0, 8).flatMap(d => {
          const loc = Array.isArray(d.loc) ? d.loc.filter(x => fields.has(x)).join('.') : ''
          return loc && types.has(d.type) ? [`${loc}: ${d.type}`] : []
        })
        if (issues.length) validation += ` [${issues.join('; ')}]`
      }
    } catch {}
    const endpoint = new URL(url).pathname.replace(/\/coding-plans\/[^/]+$/, '/coding-plans/<provider>')
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? ` (${code})` : ''
    const err = Object.assign(new Error(`MobileClaw ${method || (body === undefined ? 'GET' : 'POST')} ${endpoint}: HTTP ${res.status}${safeCode}${validation}`), { status: res.status })
    if ((refresh && res.status === 401 && code === 'C401004') || code === 'C401005') err.signIn = 'expired'
    throw err
  }
  const text = await res.text()
  if (!text.trim()) return null
  return JSON.parse(text)
}

export function credentials(result, context, previous = {}) {
  if (!result?.accessToken) throw new Error('MobileClaw response missing accessToken')
  const subject = result.userSubject
  const d = { ...context }
  if (subject?.userId || result.userId) d.userId = subject?.userId || result.userId
  const expires = Date.parse(result.expiresAt)
  return {
    ...previous, type: 'oauth', access: result.accessToken,
    refresh: result.refreshToken || previous.refresh || '',
    expires: Number.isFinite(expires) ? expires : Date.now() + 7200000,
    device: d, accountId: subject?.username || result.userName || previous.accountId || d.userId || result.phoneMask || 'MobileClaw',
    ...(d.userId ? { uid: d.userId } : {}),
  }
}

export async function refresh(auth, signal) {
  if (!auth.refresh) return undefined
  const result = await json(`${MANAGER}/auth/refresh`, { token: auth.refresh, body: auth.device, signal, refresh: true })
  return credentials(result, auth.device, auth)
}

export async function finishLogin(result, context, signal) {
  let auth = credentials(result, context)
  const subjects = await json(`${MANAGER}/user-subjects`, { token: auth.access, signal })
  if (!Array.isArray(subjects)) throw new Error('Unexpected MobileClaw account list')
  if (!context.userId && subjects.length > 1) {
    throw new Error('此手机号绑定多个移动云账号；请重新登录并填写 userId。可在官方客户端确认账号 ID。')
  }
  if (!context.userId && subjects[0]) auth.device.userId = subjects[0].userId
  if (auth.device.userId) auth = await refresh(auth, signal) || auth
  const providers = await json(`${MANAGER}/subscriptions/getAiProviders`, { token: auth.access, signal })
  if (!Array.isArray(providers)) throw new Error('Unexpected MobileClaw subscription list')
  if (!auth.device.aiProvider && providers[0]?.provider) {
    auth.device.aiProvider = providers[0].provider
    auth = await refresh(auth, signal) || auth
  }
  return { ...auth, type: 'success' }
}

export const baseline = {
  'agent-os': { name: 'Agent OS', limit: { context: 180224, output: 32768 }, tool_call: true },
  'glm-4.6': { name: 'GLM 4.6', limit: { context: 256000, output: 8192 }, tool_call: true },
  'minimax-m2.1': { name: 'MiniMax M2.1', limit: { context: 102400, output: 32768 }, tool_call: true },
  'glm-4.6v': { name: 'GLM 4.6V', limit: { context: 128000, output: 8192 }, tool_call: true },
}

function modelTypes(row) {
  if (Array.isArray(row?.modelTypes)) return row.modelTypes
  if (typeof row?.modelTypes === 'string') return row.modelTypes.split(',').map(x => x.trim()).filter(Boolean)
  return []
}

export function modelLimit(row, existing = {}) {
  const contextRaw = Number(row?.contextLength)
  const outputRaw = Number(row?.maxOutputLength)
  // MobileClaw reports these in thousands; its engine multiplies by 1000.
  // Fallbacks match the official engine's FALLBACK_MODEL_DEFAULTS.
  const context = contextRaw > 0 ? contextRaw * 1000 : existing.limit?.context || 200000
  const output = outputRaw > 0 ? outputRaw * 1000 : existing.limit?.output || 32768
  return { context, output: Math.min(output, context) }
}

export function modelCapabilities(types) {
  const set = new Set(types)
  const input = { text: true }
  const output = { text: true }
  if (set.has('图片理解')) input.image = true
  if (set.has('视频理解')) input.video = true
  if (set.has('图片生成')) output.image = true
  if (set.has('视频生成')) output.video = true
  return {
    temperature: true, reasoning: false, toolcall: true,
    attachment: !!input.image, input, output,
  }
}

export async function models(provider, auth) {
  const rows = await json(`${ORIGIN}/desktop/gate/model/modelList`, { token: auth.access || auth.key })
  if (!Array.isArray(rows)) throw new Error('Unexpected MobileClaw model list')
  const subscriptions = await json(`${MANAGER}/subscriptions/getAiProviders`, { token: auth.access || auth.key })
  if (!Array.isArray(subscriptions)) throw new Error('Unexpected MobileClaw subscription list')
  const selected = subscriptions.find(p => p.provider === auth.device?.aiProvider)
  if (!selected && subscriptions.length) throw new Error('请重新登录并选择有效的 aiProvider，以免列出无权使用的模型')
  const packages = selected?.packageList
  const available = Array.isArray(packages) ? new Set(packages.filter(p => p.available === true).map(p => p.providerType)) : null
  const result = {}
  for (const row of rows) {
    const id = row.modelName
    if (typeof id !== 'string' || !id || id === '__proto__') continue
    const declaredPkg = Array.isArray(row.pkgTypes)
      ? row.pkgTypes.filter(p => typeof p === 'string')
      : typeof row.pkgTypes === 'string' ? row.pkgTypes.split(',').map(x => x.trim()).filter(Boolean) : []
    const pkgTypes = declaredPkg.filter(p => !available || available.has(p))
    if (available && !pkgTypes.length) continue
    const existing = provider.models?.[id] || {}
    const types = modelTypes(row)
    const rate = typeof row.rate === 'string' ? row.rate.trim() : row.rate
    const capabilities = modelCapabilities(types)
    result[id] = {
      ...existing, id, name: row.aliasName || id, tool_call: existing.tool_call ?? true,
      api: { id, url: BASE, npm: '@ai-sdk/openai-compatible' },
      limit: modelLimit(row, existing),
      capabilities,
      modalities: {
        input: Object.keys(capabilities.input).filter(k => capabilities.input[k]),
        output: Object.keys(capabilities.output).filter(k => capabilities.output[k]),
      },
      ...(rate && rate !== '0' ? { rate } : {}),
      // Official chat sends pkg-types, not context-limit; context lives in limit.
      headers: pkgTypes.length ? { 'pkg-types': pkgTypes.join(',') } : {},
    }
  }
  return result
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

// Official engine uses the same endpoint (src/tool/websearch.ts) with
// q/ref_prom/sid/count and optional fresh_day/date_range. Magpie's search hook
// only supplies query/count, so those two optional filters are not exposed.
export async function searchWeb(query, count, auth, signal) {
  const token = auth?.access || auth?.key
  if (!token) throw new Error('请先登录 MobileClaw')
  const n = Number.isFinite(Number(count)) ? Math.min(Math.max(Math.trunc(Number(count)), 1), 20) : 8
  const url = new URL(`${ORIGIN}/desktop/search/v2/mwebsearch`)
  url.searchParams.set('q', String(query ?? ''))
  url.searchParams.set('ref_prom', 'aiso-sr')
  url.searchParams.set('sid', randomUUID())
  url.searchParams.set('count', String(n))
  const timeout = AbortSignal.timeout(15000)
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, 'service-version': SERVICE_VERSION },
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    redirect: 'error',
  })
  if (!res.ok) throw Object.assign(new Error(`MobileClaw GET /desktop/search/v2/mwebsearch: HTTP ${res.status}`), { status: res.status })
  const data = await res.json()
  if (data?.errno !== 0) throw new Error(`MobileClaw search errno ${String(data?.errno)}`)
  return (Array.isArray(data.items) ? data.items : [])
    .filter(item => item && item.title && item.url)
    .slice(0, n)
    .map(item => ({
      title: stripHtml(item.title),
      url: String(item.url),
      text: stripHtml(item.summary_ai || item.summary || ''),
      age: stripHtml(item.time || item.page_time || ''),
    }))
}

export function usageWindows(plan) {
  return ['day', 'week', 'month'].flatMap(period => {
    const amount = plan?.[`${period}UsedCount`]
    const limit = plan?.[`${period}InitCount`]
    if (typeof amount !== 'number' || typeof limit !== 'number' || limit <= 0) return []
    return [{ name: period, amount, limit, unit: 'requests', resetsAt: plan[`${period}RefreshTime`], display: `${amount} / ${limit}` }]
  })
}

// Token Plan rows use usedTokens/totalTokens rather than request counts.
export function tokenPlanWindows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.flatMap(row => {
    const amount = Number(row?.usedTokens)
    const limit = Number(row?.totalTokens)
    if (!Number.isFinite(amount) || !Number.isFinite(limit) || limit <= 0) return []
    return [{
      name: row.chaGroupName || 'Token Plan', amount, limit, unit: 'tokens',
      ...(row.expireTime ? { resetsAt: row.expireTime } : {}),
      display: `${amount} / ${limit} tokens`,
    }]
  })
}

// /credits/v2/exp-credit is a wallet, not a used/limit window. Only known
// numbers are exposed; an absent or zero total is not treated as availability.
export function creditWindow(credit) {
  const balance = Number(credit?.remainTokens)
  if (!Number.isFinite(balance) || balance < 0) return []
  return [{
    name: '体验额度', balance, unit: 'tokens',
    display: `${balance} tokens`,
    ...(credit?.expireTime ? { runsOutAt: credit.expireTime } : {}),
  }]
}
