import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('packaged icon is a valid PNG and fits Magpie data-URI limit', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const icon = pkg.magpie.icon
  assert.match(icon, /^data:image\/png;base64,/)
  assert.ok(icon.length < 1_000_000)
  const body = Buffer.from(icon.slice('data:image/png;base64,'.length), 'base64')
  assert.deepEqual([...body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(readFileSync(join(root, 'assets/mobileclaw-icon.png')).length > 0)
  assert.ok(readFileSync(join(root, 'assets/mobileclaw-icon-256.png')).equals(body))
})