import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import Plugin from '../index.mjs'
import { json, MANAGER, MANAGEMENT_UA, device } from '../lib/mobileclaw.mjs'
import { release } from 'node:os'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('import validates access without refreshing or changing subscription', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(url)
    assert.equal(init.headers.get('authorization'), 'Bearer fake-access')
    return Response.json([{ userId: 'u', username: 'test-user' }])
  }
  const p = await Plugin({ client: {} })
  const flow = await p.auth.methods[2].authorize({ access: 'fake-access', refresh: 'fake-refresh', deviceId: 'original', userId: 'u', aiProvider: 'selected' })
  assert.equal(flow.url, '')
  const result = await flow.callback()
  assert.deepEqual(calls, [`${MANAGER}/user-subjects`])
  assert.equal(result.type, 'success')
  assert.equal(result.refresh, 'fake-refresh')
  assert.equal(result.device.deviceId, 'original')
  assert.equal(result.device.aiProvider, 'selected')
})

test('error identifies endpoint and safe errorCode without leaking upstream content', async () => {
  globalThis.fetch = async () => Response.json({ errorCode: 'C400001', errorMessage: 'secret credential here' }, { status: 400 })
  await assert.rejects(json(`${MANAGER}/auth/refresh`, { body: {}, token: 'secret' }), error => {
    assert.match(error.message, /POST .*\/auth\/refresh: HTTP 400 \(C400001\)/)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})

test('OS field matches official client release-only format', () => {
  assert.equal(device().os, release())
})

test('management calls use Electron compatibility UA, not host defaults', async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.get('user-agent'), MANAGEMENT_UA)
    assert.equal(init.headers.get('accept'), '*/*')
    return Response.json([])
  }
  await json(`${MANAGER}/user-subjects`)
})

test('generic C400999 validation identifies missing fields without exposing server text', async () => {
  globalThis.fetch = async () => Response.json({
    errorCode: 'C400999', errorMessage: 'MAC 不能为空\n操作系统不能为空\nprivate-example-token',
  }, { status: 400 })
  await assert.rejects(json(`${MANAGER}/auth/captcha`, { body: {} }), error => {
    assert.match(error.message, /MAC 不能为空/)
    assert.match(error.message, /操作系统不能为空/)
    assert.equal(error.message.includes('private-example-token'), false)
    return true
  })
})
