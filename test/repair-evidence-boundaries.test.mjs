import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRepairPresentation } from '../src/repair-evidence.js'
import { DiagnosticRepairs } from '../src/repair-actions.js'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const component = '@example/fault'
const report = { failed: [{ id: 'fault', package: component, reason: 'ValidationError: $.path expected string but got 42' }], waiting: [], blockingChains: [{ id: 'unrelated', service: 'service' }] }
const edge = { from: { id: 'product-analytics', component: '@deepseek-ai/dsh-client-product-analytics' }, to: { id: 'desktop-product-telemetry', component: '@deepseek-ai/dsh-host-product-telemetry-otel' }, service: 'productTelemetry' }

test('generic single-row fault cannot inherit another reviewed group or global blocking chain', () => {
  const result = buildRepairPresentation([{ kind: 'disable-optional', proof: 'runtime-schema-leaf', component, rows: ['fault'] }], report, { optionalProof: { allowed: true }, optionalDependencies: [edge] }, {})
  assert.deepEqual(result.problems[0].dependencies, [])
  assert.equal(result.problems[0].capability, null)
  assert.equal(result.problems[0].blocking, undefined)
})

test('verified resolution remains factual when the action is forbidden', () => {
  const result = buildRepairPresentation([{ kind: 'package', component, disabledReason: 'downgrade' }], report, { packages: [{ name: component, sourceConfirmed: true, disabledReason: 'downgrade', selected: { dir: '/actual', version: '2' } }] }, {})
  assert.equal(result.problems[0].confirmations.find(item => item.kind === 'resolved_package')?.path, '/actual')
  assert.equal(result.problems[0].unknowns.some(item => item.code === 'source_unconfirmed'), false)
})

test('history sorts before truncating and direct record lookup ignores the display cap', (t) => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'd12-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repairs = new DiagnosticRepairs({ dataDir: () => root })
  const directory = join(repairs.root(), 'history')
  mkdirSync(directory, { recursive: true })
  for (let index = 0; index < 201; index += 1) {
    const id = index.toString(16).padStart(32, '0')
    writeFileSync(join(directory, id + '.json'), JSON.stringify({ id, at: 201 - index }))
  }
  assert.equal(repairs.history()[0].id, '0'.repeat(32))
  assert.equal(repairs.history().length, 200)
  assert.equal(repairs.readRecord((200).toString(16).padStart(32, '0')).at, 1)
  assert.equal(repairs.readRecord('../bad'), null)
})

test('package rollback resumes recording only with prior persisted intent and matching original bytes', async (t) => {
  const { packageFingerprint } = await import('../src/diagnostic-repair.js')
  for (const priorIntent of [false, true]) {
    const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'd12-rollback-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const target = { home: root, profile: 'desktop', version: '2', harnessEntry: '/runtime' }
    const id = 'a'.repeat(32)
    const name = '@deepseek-ai/example'
    const source = join(root, 'profiles/desktop/node_modules', name)
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version: '1' }))
    const backup = join(root, 'profiles/desktop/.dsh-x-repairs', id, 'packages', name)
    const repairs = new DiagnosticRepairs({
      dataDir: () => join(root, 'data'),
      assertAvailable() {
      },
      async exclusive(target, operation) {
        return operation()
      },
      async stop() {
      },
      async verify() {
        const pending = repairs.readRecord(id)
        assert.equal(pending.outcome, null)
        assert.equal(pending.verificationStatus, 'pending')
        return { status: 'unresolved' }
      },
    })
    repairs.versionEvidence = () => ({ version: '2' })
    repairs.save({ id, at: 1, storageRoot: repairs.root(), target, status: 'applied', outcome: { status: 'resolved' }, rollbackStartedAt: priorIntent ? 1 : undefined, packageDigest: packageFingerprint(source), action: { id: name, kind: 'package', source, backup, currentVersion: '1' } })
    if (priorIntent) {
      const result = await repairs.rollback(id)
      assert.equal(result.rollbackChanges[0].operation, 'confirm_restored_backup')
      assert.equal(result.verificationStatus, 'complete')
    } else {
      await assert.rejects(repairs.rollback(id))
      await assert.rejects(repairs.rollback(id))
      assert.equal(repairs.readRecord(id).outcome, null)
      assert.equal(repairs.readRecord(id).verificationStatus, 'failed')
    }
  }
})

test('accepted patch trust is independent of the displayed history cap', async (t) => {
  const { createHash } = await import('node:crypto')
  const { appendRowBlock } = await import('../src/plugins.js')
  const hash = text => createHash('sha256').update(text).digest('hex')
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'd12-patch-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = { home: root, profile: 'desktop', version: '2', harnessEntry: '/runtime' }
  const repairs = new DiagnosticRepairs({ dataDir: () => join(root, 'data') })
  const id = '0'.repeat(32)
  const source = join(root, 'profiles/desktop/cordis.patch.yml')
  const backup = join(root, 'profiles/desktop/.dsh-x-repairs', id, 'patch-before.yml')
  const original = '[]\n'
  const applied = appendRowBlock(original, 'fault', true).text
  mkdirSync(join(root, 'profiles/desktop/.dsh-x-repairs', id), { recursive: true })
  writeFileSync(source, applied)
  writeFileSync(backup, original)
  repairs.save({ id, at: 1, storageRoot: repairs.root(), target, status: 'applied', patchBeforeDigest: hash(original), patchAppliedDigest: hash(applied), action: { kind: 'disable-optional', source, backup, rows: ['fault'] } })
  for (let index = 1; index <= 201; index += 1) {
    repairs.save({ id: index.toString(16).padStart(32, '0'), at: index + 1, storageRoot: repairs.root(), action: { kind: 'other' } })
  }
  assert.equal(repairs.history().some(record => record.id === id), false)
  assert.equal(repairs.acceptedPatch(target), hash(applied))
})

test('only the exact reviewed action group receives its dependency and capability', () => {
  const component = edge.to.component
  const inspected = { optionalProof: { allowed: true, fingerprint: 'verified' }, optionalDependencies: [edge] }
  const action = { kind: 'disable-optional', component, rows: [edge.to.id, edge.from.id] }
  const result = buildRepairPresentation([action], { failed: [], waiting: [] }, inspected, {})
  assert.deepEqual(result.problems[0].dependencies, [edge])
  assert.equal(result.problems[0].capability.fingerprint, 'verified')
  action.rows = [edge.to.id]
  const mismatch = buildRepairPresentation([action], { failed: [], waiting: [] }, inspected, {})
  assert.deepEqual(mismatch.problems[0].dependencies, [])
})
