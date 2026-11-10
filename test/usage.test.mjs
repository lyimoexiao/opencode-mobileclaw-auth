import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import Plugin from '../index.mjs'
import { creditWindow, json, MANAGER, tokenPlanWindows } from '../lib/mobileclaw.mjs'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const auth = { type: 'oauth', access: 'fake', expires: Date.now() + 7200000, device: { aiProvider: 'p' }, accountId: 'test' }
const plugin = () => Plugin({ client: {} })

test('experience credit becomes a balance window, not a fake 0% usage', () => {
  assert.deepEqual(creditWindow({ remainTokens: 36000000, totalTokens: 0 }), [{
    name: '体验额度', balance: 36000000, unit: 'tokens', display: '36000000 tokens',
  }])
  assert.deepEqual(creditWindow({}), [])
  assert.deepEqual(creditWindow({ remainTokens: -1 }), [])
})

test('Token Plan uses used/total tokens and ignores unknown totals', () => {
  assert.deepEqual(tokenPlanWindows([{ chaGroupName: 'Coding', usedTokens: 10, totalTokens: 100 }]), [{
    name: 'Coding', amount: 10, limit: 100, unit: 'tokens', display: '10 / 100 tokens',
  }])
  assert.deepEqual(tokenPlanWindows([{ usedTokens: 10, totalTokens: 0 }]), [])
})

test('successful empty body is null, not a JSON parse error', async () => {
  globalThis.fetch = async () => new Response('', { status: 200 })
  assert.equal(await json(`${MANAGER}/subscriptions/coding-plans/p`), null)
})

test('usage survives optional endpoint failures and shows the available wallet', async () => {
  const p = await plugin()
  globalThis.fetch = async url => {
    if (url.endsWith('/subscriptions/coding-plans/p')) return new Response('', { status: 200 })
    if (url.endsWith('/subscriptions/token-plans-personal/p')) return Response.json([])
    if (url.endsWith('/credits/v2/exp-credit')) return Response.json({ remainTokens: 36000000, totalTokens: 0, expireTime: null })
    throw new Error('unexpected URL')
  }
  const usage = await p.auth.usage(async () => auth)
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0].balance, 36000000)
  assert.equal(usage.windows[0].used, undefined)
  assert.equal(usage.error, undefined)
})

test('usage never reports an empty result as success', async () => {
  const p = await plugin()
  globalThis.fetch = async () => Response.json([])
  const usage = await p.auth.usage(async () => auth)
  assert.deepEqual(usage.windows, [])
  assert.match(usage.error, /未返回/)
})
