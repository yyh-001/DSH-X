import assert from 'node:assert/strict'
import test from 'node:test'
import { macSigningIdentity } from '../scripts/mac-signing.mjs'

test('macOS 正式构建必须有固定且明确的代码签名身份', () => {
  assert.throws(() => macSigningIdentity({ DSH_MAC_REQUIRE_SIGNED: '1' }), /缺少固定签名证书/)
  assert.throws(() => macSigningIdentity({ DSH_MAC_SIGNING_IDENTITY: 'Developer ID Application: someone' }), /40 位/)
  assert.equal(macSigningIdentity({ DSH_MAC_SIGNING_IDENTITY: 'a'.repeat(40), DSH_MAC_REQUIRE_SIGNED: '1' }), 'A'.repeat(40))
  assert.equal(macSigningIdentity({}), '-')
})
