import {
  BASE, MANAGER, ORIGIN, PROVIDER, baseline, credentials, device, encrypt,
  creditWindow, finishLogin, headers, json, models, refresh, tokenPlanWindows, usageWindows,
} from './lib/mobileclaw.mjs'

const phonePrompt = { type: 'text', key: 'phone', message: '手机号（+86）', validate: v => /^1[3-9]\d{9}$/.test(v) ? undefined : '请输入有效的中国大陆手机号' }
const advancedPrompts = [
  { type: 'text', key: 'userId', message: '移动云 userId（单账号留空；多账号必填）' },
  { type: 'text', key: 'aiProvider', message: 'aiProvider（留空自动选第一个订阅）' },
]

export default async function MobileClawPlugin({ client }) {
  // Account-scoped single flight; never mix refresh tokens from different accounts.
  const pending = new Map()
  async function renew(auth, signal) {
    if (!auth.refresh) return auth
    const key = auth.refresh
    if (pending.has(key)) return pending.get(key)
    const promise = (async () => {
      const next = await refresh(auth, signal)
      if (!next) return auth
      await client.auth.set({ path: { id: PROVIDER }, body: next })
      return next
    })()
    pending.set(key, promise)
    try { return await promise } finally { pending.delete(key) }
  }
  async function current(getAuth, signal) {
    const auth = await getAuth()
    if (auth?.type !== 'api' && auth?.type !== 'oauth') throw new Error('请先登录 MobileClaw')
    return auth.refresh && auth.expires && auth.expires < Date.now() + 60000 ? renew(auth, signal) : auth
  }
  // Magpie does not forward model.headers from provider.models() into chat.
  // Official MobileClaw requires pkg-types on the completed request, so derive
  // it from the account's own model list once per loader/account.
  async function modelHeaderMap(auth) {
    const list = await models({ models: baseline }, auth)
    return new Map(Object.entries(list).map(([id, model]) => [id, model.headers || {}]))
  }

  const hooks = {
    config: async cfg => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'MobileClaw', npm: '@ai-sdk/openai-compatible', api: BASE, models: structuredClone(baseline),
      }
    },
    auth: {
      provider: PROVIDER,
      refreshLead: 5 * 60000,
      refresh: auth => refresh(auth),
      methods: [
        {
          type: 'oauth', label: '手机号 + 短信验证码', prompts: [phonePrompt, ...advancedPrompts],
          async authorize(inputs, { signal } = {}) {
            const context = device(inputs)
            const phoneEnc = encrypt(inputs.phone)
            await json(`${MANAGER}/auth/captcha`, { body: { ...context, phoneEnc }, signal })
            return {
              url: '', method: 'code', instructions: '短信已发送。请输入短信验证码。',
              async callback(code, options = {}) {
                if (!/^\d{4,8}$/.test(code?.trim() || '')) return { type: 'failed', error: '无效的短信验证码' }
                const activeSignal = options.signal || signal
                const result = await json(`${MANAGER}/auth/login`, { body: { ...context, phoneEnc, captcha: code.trim() }, signal: activeSignal })
                return finishLogin(result, context, activeSignal)
              },
            }
          },
        },
        {
          type: 'oauth', label: '手机号 + MobileClaw 密码',
          prompts: [phonePrompt, { type: 'password', key: 'password', message: 'MobileClaw 密码（不是移动云控制台密码）' }, ...advancedPrompts],
          async authorize(inputs, { signal } = {}) {
            const context = device(inputs)
            const body = { ...context, phoneEnc: encrypt(inputs.phone), passwordEnc: encrypt(inputs.password) }
            return {
              url: '', method: 'auto', instructions: '正在通过官方 API 登录 MobileClaw。',
              async callback(_code, options = {}) {
                const activeSignal = options.signal || signal
                const result = await json(`${MANAGER}/auth/password/login`, { body, signal: activeSignal })
                return finishLogin(result, context, activeSignal)
              },
            }
          },
        },
        {
          type: 'oauth', label: '手动导入令牌（高级）',
          prompts: [
            { type: 'password', key: 'access', message: 'Access token（明文，不含 Bearer 前缀）' },
            { type: 'password', key: 'refresh', message: 'Refresh token（可留空，仅使用 access token）' },
            { type: 'text', key: 'deviceId', message: '原登录 deviceId（有 refresh token 时必填）' },
            ...advancedPrompts,
          ],
          async authorize(inputs) {
            if (!inputs.access?.trim()) throw new Error('Access token 不能为空')
            if (inputs.refresh?.trim() && !inputs.deviceId?.trim()) throw new Error('续期需要原登录 deviceId')
            const context = device(inputs)
            return {
              url: '', method: 'auto', instructions: '正在验证令牌。插件不会读取官方客户端的配置或钥匙串。',
              async callback(_code, { signal } = {}) {
                const imported = credentials({ accessToken: inputs.access.trim(), refreshToken: inputs.refresh?.trim() }, context)
                // An imported token is already bound. Validate it without rebinding or rotating it.
                let subjects
                try {
                  subjects = await json(`${MANAGER}/user-subjects`, { token: imported.access, signal })
                } catch (error) {
                  return { type: 'failed', error: error.message }
                }
                if (!Array.isArray(subjects)) return { type: 'failed', error: 'Unexpected MobileClaw account list' }
                const subject = subjects.find(s => s.userId === context.userId) || (subjects.length === 1 ? subjects[0] : undefined)
                if (subject && !context.userId) imported.device.userId = subject.userId
                imported.accountId = subject?.username || context.userId || 'MobileClaw (imported)'
                return { ...imported, type: 'success' }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const signedIn = await getAuth()
        if (!signedIn) return {}
        let headersByModel
        const headersFor = async auth => {
          headersByModel ??= modelHeaderMap(auth).catch(() => new Map())
          return headersByModel
        }
        return {
          baseURL: BASE,
          async fetch(input, init = {}) {
            const url = new URL(input instanceof Request ? input.url : String(input))
            // Never leak account tokens to an arbitrary provider/model override or redirect.
            if (url.origin !== ORIGIN || url.pathname !== '/desktop/v1/chat/completions') throw new Error('MobileClaw 仅允许官方 Chat Completions 网关')
            const auth = await current(getAuth, init.signal)
            const request = input instanceof Request ? input : null
            let model
            try { model = JSON.parse(typeof init.body === 'string' ? init.body : '{}').model } catch {}
            const modelHeaders = (await headersFor(auth).catch(() => new Map())).get(model) || {}
            const base = new Headers(modelHeaders)
            new Headers(init.headers || request?.headers).forEach((v, k) => base.set(k, v))
            const send = a => fetch(input, {
              ...init, headers: headers(a, base, 'chat'), redirect: 'error',
            })
            let res = await send(auth)
            if (res.status === 401) {
              const message = await res.clone().text()
              if (/配额已用完|model_not_found|model.*not available|模型不支持/i.test(message) && !/invalid.*token|token.*invalid|登录失效/i.test(message)) {
                const h = new Headers(res.headers); h.set('X-Magpie-Sign-In', 'kept')
                return new Response(res.body, { status: res.status, headers: h })
              }
              // SDK supplies replayable JSON in init.body; do not retry one-shot Request bodies.
              if (auth.refresh && (!request || init.body !== undefined)) {
                await res.body?.cancel()
                res = await send(await renew(auth, init.signal))
              }
            }
            return res
          },
        }
      },
      async usage(getAuth) {
        const auth = await current(getAuth)
        const token = auth.access || auth.key
        const provider = auth.device?.aiProvider
        const endpoint = provider
          ? `/subscriptions/coding-plans/${encodeURIComponent(provider)}`
          : '/subscriptions/coding-plan'
        const optional = async path => {
          try { return await json(`${MANAGER}${path}`, { token }) } catch { return null }
        }
        const [codingResult, tokenResult, credit] = await Promise.all([
          optional(endpoint),
          provider ? optional(`/subscriptions/token-plans-personal/${encodeURIComponent(provider)}`) : null,
          optional('/credits/v2/exp-credit'),
        ])
        const plan = Array.isArray(codingResult) ? codingResult[0] : codingResult
        const tokenPlans = tokenPlanWindows(tokenResult)
        const credits = creditWindow(credit)
        const windows = [...usageWindows(plan), ...tokenPlans, ...credits]
        if (!windows.length) return { error: 'MobileClaw 未返回可用的额度窗口', windows: [] }
        const until = plan?.expireTime || (Array.isArray(tokenResult) ? tokenResult[0]?.expireTime : undefined) || credit?.expireTime
        return {
          plan: plan?.planName || (Array.isArray(tokenResult) ? tokenResult[0]?.chaGroupName : undefined),
          until,
          renew: plan?.autoRenew === undefined ? undefined : plan.autoRenew ? 'auto' : 'off',
          user: auth.accountId,
          windows,
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        return models(provider, auth)
      },
    },
  }
  // Return explicit login failures so Magpie's UI can show the endpoint instead
  // of reducing a thrown RPC exception to a generic 400.
  const failure = error => ({
    type: 'failed',
    error: /^MobileClaw (GET|POST) \/desktop\//.test(error?.message || '')
      ? error.message : 'MobileClaw 登录未完成。请确认输入参数，或通过终端重试以定位失败阶段。',
  })
  for (const method of hooks.auth.methods) {
    const authorize = method.authorize
    method.authorize = async (...args) => {
      try {
        const flow = await authorize(...args)
        if (flow?.callback) {
          const callback = flow.callback
          flow.callback = async (...params) => {
            try { return await callback(...params) } catch (error) { return failure(error) }
          }
        }
        return flow
      } catch (error) { return failure(error) }
    }
  }
  return hooks
}
