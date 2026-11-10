import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { constants, generateKeyPairSync, privateDecrypt, publicEncrypt } from 'node:crypto'
import Plugin from '../index.mjs'
import { BASE, MANAGER, ORIGIN, credentials, device, encrypt, finishLogin, models, refresh, usageWindows } from '../lib/mobileclaw.mjs'

const originalFetch = globalThis.fetch
const ok = value => Response.json(value)
const auth = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 7200000, device: { deviceId: 'test-device', aiProvider: 'test-provider' } }
const plugin = () => Plugin({ client: { auth: { set: async () => {} } } })
afterEach(() => { globalThis.fetch = originalFetch })

test('only one plugin function exported; config respects user override', async () => {
  const exports = await import('../index.mjs')
  assert.deepEqual(Object.keys(exports), ['default'])
  const p = await plugin(); const cfg = {}; await p.config(cfg)
  assert.equal(cfg.provider.mobileclaw.api, BASE)
  const custom = { provider: { mobileclaw: { name: 'custom' } } }
  await p.config(custom); assert.equal(custom.provider.mobileclaw.name, 'custom')
})

test('RSA public key produces randomized 2048-bit PKCS#1 ciphertext', () => {
  assert.equal(Buffer.from(encrypt('example'), 'base64').length, 256)
  assert.notEqual(encrypt('example'), encrypt('example'))
})

test('device identity persists; token expiry and rotated refresh are mapped', () => {
  const d = device({ deviceId: 'stable', userId: 'u' })
  const result = credentials({ accessToken: 'new', refreshToken: 'rotated', expiresAt: '2030-01-01T00:00:00Z' }, d)
  assert.equal(result.device.deviceId, 'stable'); assert.equal(result.refresh, 'rotated')
  assert.equal(result.expires, Date.parse('2030-01-01T00:00:00Z'))
})

test('SMS flow encrypts phone and uses callback code, resolves account and subscription', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push([url, init])
    if (url.endsWith('/auth/captcha')) return ok({})
    if (url.endsWith('/auth/login') || url.endsWith('/auth/refresh')) return ok({ accessToken: 'new', refreshToken: 'r', expiresAt: '2030-01-01', userSubject: { userId: 'u', username: 'example-user' } })
    if (url.endsWith('/user-subjects')) return ok([{ userId: 'u' }])
    if (url.endsWith('/subscriptions/getAiProviders')) return ok([{ provider: 'p' }])
    throw new Error('unexpected URL')
  }
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({ phone: '13800000000' })
  assert.equal(flow.method, 'code')
  const result = await flow.callback('123456')
  assert.equal(result.type, 'success'); assert.equal(result.device.aiProvider, 'p')
  const body = JSON.parse(calls[0][1].body)
  assert.equal(body.phone, undefined); assert.equal(Buffer.from(body.phoneEnc, 'base64').length, 256)
  assert.equal(JSON.parse(calls[1][1].body).captcha, '123456')
  assert.ok(calls.every(([, init]) => init.redirect === 'error'))
})

test('multiple subjects require explicit userId instead of silently selecting one', async () => {
  globalThis.fetch = async () => ok([{ userId: 'a' }, { userId: 'b' }])
  await assert.rejects(finishLogin({ accessToken: 'a', refreshToken: 'r' }, device()), /userId/)
})

test('password flow never sends plaintext password', async () => {
  const p = await plugin(); let captured
  globalThis.fetch = async (_url, init) => { captured = init.body; return new Response('', { status: 400 }) }
  const flow = await p.auth.methods[1].authorize({ phone: '13800000000', password: 'not-a-real-password' })
  const failure = await flow.callback()
  assert.equal(failure.type, 'failed')
  assert.match(failure.error, /auth\/password\/login: HTTP 400/)
  assert.equal(captured.includes('not-a-real-password'), false)
  assert.equal(Buffer.from(JSON.parse(captured).passwordEnc, 'base64').length, 256)
})

test('refresh uses refresh token, original device and terminal invalidation only', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${MANAGER}/auth/refresh`)
    assert.equal(init.headers.get('authorization'), 'Bearer test-refresh')
    assert.equal(JSON.parse(init.body).deviceId, 'test-device')
    return ok({ accessToken: 'updated' })
  }
  assert.equal((await refresh(auth)).refresh, 'test-refresh')
  globalThis.fetch = async () => ok({})
  await assert.rejects(refresh(auth), /missing accessToken/)
  globalThis.fetch = async () => Response.json({ errorCode: 'C401004' }, { status: 401 })
  await assert.rejects(refresh(auth), e => e.signIn === 'expired')
  globalThis.fetch = async () => new Response('', { status: 503 })
  await assert.rejects(refresh(auth), e => e.signIn === undefined)
})

test('model discovery intersects account package availability and retains request headers', async () => {
  globalThis.fetch = async url => url.includes('modelList') ? ok([
    { modelName: 'allowed', contextLength: 200, maxOutputLength: 8, modelTypes: ['文本模型', '图片理解'], rate: '1:1000Token', pkgTypes: ['CODING', 'OTHER'] },
    { modelName: 'denied', pkgTypes: ['OTHER'] },
  ]) : ok([{ provider: 'test-provider', packageList: [{ providerType: 'CODING', available: true }, { providerType: 'OTHER', available: false }] }])
  const list = await models({ models: {} }, auth)
  assert.deepEqual(Object.keys(list), ['allowed'])
  assert.equal(list.allowed.headers['pkg-types'], 'CODING')
  assert.equal(list.allowed.headers['context-limit'], undefined)
  assert.equal(list.allowed.api.url, BASE)
  assert.deepEqual(list.allowed.limit, { context: 200000, output: 8000 })
  assert.equal(list.allowed.capabilities.input.image, true)
  assert.equal(list.allowed.capabilities.attachment, true)
  assert.equal(list.allowed.capabilities.temperature, true)
  assert.equal(list.allowed.capabilities.reasoning, false)
  assert.deepEqual(list.allowed.modalities.input, ['text', 'image'])
  assert.equal(list.allowed.rate, '1:1000Token')
})

test('malformed model discovery throws, so host retains previous model list', async () => {
  globalThis.fetch = async () => ok({ unexpected: [] })
  await assert.rejects(models({ models: {} }, auth), /Unexpected/)
})

test('unknown usage is not represented as zero', () => {
  assert.deepEqual(usageWindows({}), [])
  assert.deepEqual(usageWindows({ dayUsedCount: 0 }), [])
  assert.equal(usageWindows({ dayUsedCount: 0, dayInitCount: 10 })[0].amount, 0)
})

test('gateway forwards cancellation, correct auth and unchanged SSE stream', async () => {
  const p = await plugin(); const loader = await p.auth.loader(async () => auth)
  const controller = new AbortController()
  const stream = 'data: {"choices":[]}\n\ndata: [DONE]\n\n'
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${BASE}/chat/completions`)
    assert.equal(init.signal, controller.signal)
    assert.equal(init.headers.get('authorization'), 'Bearer test-access')
    assert.equal(init.headers.get('ai-provider'), 'test-provider')
    assert.equal(init.headers.get('service-version'), '2.6.1')
    assert.equal(init.redirect, 'error')
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }
  const response = await loader.fetch(`${BASE}/chat/completions`, { method: 'POST', body: '{}', signal: controller.signal })
  assert.equal(await response.text(), stream)
  await assert.rejects(loader.fetch('https://example.com/chat/completions'), /仅允许/)
  await assert.rejects(loader.fetch(`${ORIGIN}/other`), /仅允许/)
})

test('quota 401 keeps sign-in; genuine 401 refreshes once and saves account', async () => {
  let saved; let calls = 0
  const p = await Plugin({ client: { auth: { set: async value => { saved = value.body } } } })
  const loader = await p.auth.loader(async () => auth)
  globalThis.fetch = async () => new Response('配额已用完', { status: 401 })
  assert.equal((await loader.fetch(`${BASE}/chat/completions`)).headers.get('X-Magpie-Sign-In'), 'kept')
  globalThis.fetch = async url => {
    if (url.endsWith('/auth/refresh')) return ok({ accessToken: 'renewed', refreshToken: 'rotated' })
    calls++; return calls === 1 ? new Response('invalid token', { status: 401 }) : ok({ choices: [] })
  }
  assert.equal((await loader.fetch(`${BASE}/chat/completions`, { method: 'POST', body: '{}' })).status, 200)
  assert.equal(calls, 2); assert.equal(saved.access, 'renewed')
})

test('loader restores model pkg-types that Magpie did not forward', async () => {
  const p = await plugin()
  const loader = await p.auth.loader(async () => ({ ...auth, device: { ...auth.device, aiProvider: 'p' } }))
  let chatHeaders
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/gate/model/modelList')) return ok([
      { modelName: 'glm-test', pkgTypes: ['FREE', 'PAID'], contextLength: 1024 },
    ])
    if (String(url).includes('/subscriptions/getAiProviders')) return ok([
      { provider: 'p', packageList: [{ providerType: 'FREE', available: true }, { providerType: 'PAID', available: false }] },
    ])
    chatHeaders = init.headers
    return ok({ choices: [] })
  }
  assert.equal((await loader.fetch(`${BASE}/chat/completions`, { method: 'POST', body: '{"model":"glm-test"}' })).status, 200)
  assert.equal(chatHeaders.get('pkg-types'), 'FREE')
  assert.equal(chatHeaders.get('context-limit'), null)
  assert.equal(chatHeaders.get('ai-provider'), 'p')
  assert.equal(chatHeaders.get('user-agent'), 'opencode/local ai-sdk/openai-compatible/1.0.32')
})


test('multimodal image content passes through the chat request unchanged', async () => {
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  const imageBody = {
    model: 'vision-test',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    }],
    stream: false,
  }
  let sent
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/gate/model/modelList')) return ok([
      { modelName: 'vision-test', modelTypes: ['文本模型', '图片理解'], pkgTypes: ['FREE'], contextLength: 128, maxOutputLength: 8 },
    ])
    if (String(url).includes('/subscriptions/getAiProviders')) return ok([
      { provider: 'test-provider', packageList: [{ providerType: 'FREE', available: true }] },
    ])
    sent = JSON.parse(init.body)
    return ok({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
  }
  const response = await loader.fetch(`${BASE}/chat/completions`, { method: 'POST', body: JSON.stringify(imageBody) })
  assert.equal(response.status, 200)
  assert.deepEqual(sent, imageBody)
})
