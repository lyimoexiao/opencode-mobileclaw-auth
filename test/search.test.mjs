import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import Plugin from '../index.mjs'
import { ORIGIN, searchWeb } from '../lib/mobileclaw.mjs'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const auth = { type: 'oauth', access: 'fake-search-token' }

test('search calls the official mwebsearch endpoint and normalizes pages', async () => {
  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    assert.equal(`${u.origin}${u.pathname}`, `${ORIGIN}/desktop/search/v2/mwebsearch`)
    assert.equal(u.searchParams.get('q'), 'OpenAI')
    assert.equal(u.searchParams.get('ref_prom'), 'aiso-sr')
    assert.equal(u.searchParams.get('count'), '3')
    assert.ok(/^[0-9a-f-]{36}$/.test(u.searchParams.get('sid')))
    assert.equal(init.headers.authorization, 'Bearer fake-search-token')
    assert.equal(init.headers['service-version'], '2.6.1')
    assert.equal(init.redirect, 'error')
    return Response.json({ errno: 0, items: [
      { title: '<b>One</b>', url: 'https://example.com/1', summary_ai: 'AI <i>summary</i>', summary: 'old', time: '2026-01-01' },
      { title: '', url: 'https://example.com/empty' },
    ] })
  }
  assert.deepEqual(await searchWeb('OpenAI', 3, auth), [{
    title: 'One', url: 'https://example.com/1', text: 'AI summary', age: '2026-01-01',
  }])
})

test('search surfaces HTTP and business errors so Magpie can rest the account', async () => {
  globalThis.fetch = async () => new Response('', { status: 429 })
  await assert.rejects(searchWeb('x', 1, auth), error => error.status === 429)
  globalThis.fetch = async () => Response.json({ errno: 1001 })
  await assert.rejects(searchWeb('x', 1, auth), /errno 1001/)
})

test('plugin registers an account-scoped search API tied to mobileclaw auth', async () => {
  const p = await Plugin({ client: {} })
  assert.equal(p.search.mobileclaw.auth, 'mobileclaw')
  globalThis.fetch = async () => Response.json({ errno: 0, items: [{ title: 'T', url: 'https://e.test' }] })
  const pages = await p.search.mobileclaw.execute({ query: 'q', count: 1 }, { getAuth: async () => auth })
  assert.deepEqual(pages, [{ title: 'T', url: 'https://e.test', text: '', age: '' }])
})
