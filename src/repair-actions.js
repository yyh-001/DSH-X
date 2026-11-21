import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { archivePackage, compatibleUpgrade, clientVersionEvidence, ordinaryPath, packageFingerprint, probePackageSources, restorePackage } from './diagnostic-repair.js'
import { checkedRepairPlan, profileFingerprint } from './repair-plan.js'
import { withProfileLock } from './recovery.js'
import { appendRowBlock } from './plugins.js'
import { buildRepairPresentation } from './repair-evidence.js'
import { installedPackageState, packageStateChanges } from './repair-dependencies.js'

const OPTIONAL_ROWS = ['desktop-product-telemetry', 'product-analytics']

function bytesDigest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readPatch(path) {
  ordinaryPath(path, true)
  if (!existsSync(path)) {
    return null
  }
  const bytes = readFileSync(path)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (!Buffer.from(text).equals(bytes)) {
    throw new Error('配置不是可无损处理的 UTF-8，禁止自动修改。')
  }
  return text
}

function disabledPatch(text, rows = OPTIONAL_ROWS) {
  let result = text ?? ''
  if (!Array.isArray(rows) || !rows.length || rows.length > 32 || rows.some(row => typeof row !== 'string' || !/^[\w.-]{1,128}$/.test(row))) {
    throw new Error('禁用目标行无效。')
  }
  for (const row of rows) {
    const next = appendRowBlock(result, row, true)
    if (!next.ok) {
      throw new Error(next.reason)
    }
    result = next.text
  }
  return result
}

const PREVIEW_LIMIT = 32
const HISTORY_LIMIT = 200
const ID_PATTERN = /^[a-f0-9]{32}$/
const PACKAGE_PATTERN = /^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 父目录已通过 ordinaryPath 校验时，只需检查目标叶子本身不是符号链接，避免重复走 10 层 realpathSync。 */
function ordinaryLeaf(path, allowMissing = false) {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      throw new Error('拒绝在符号链接或挂载重定向路径上读写修复记录。')
    }
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return
    throw error
  }
}

function readOptional(path, { trustedParent = false } = {}) {
  if (trustedParent) ordinaryLeaf(path, true)
  else ordinaryPath(path, true)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** ready 只是地址就绪；仍存活、证据完整且所有已观测插件问题清空才标解除。 */
export function verificationSummary(ready, alive, report) {
  const remaining = report ? {
    failed: report.failed.length, rejected: report.rejected.length,
    required: report.blockingChains.length, waiting: report.waiting.length,
    skipped: report.skipped.entries.length,
  } : null
  const observedName = row => row.id || row.package || null
  const remainingItems = report ? {
    failed: report.failed.map(observedName).filter(Boolean),
    rejected: report.rejected.map(observedName).filter(Boolean),
    required: report.blockingChains.map(row => row.id && row.service ? `${row.id} → ${row.service}` : observedName(row)).filter(Boolean),
    waiting: report.waiting.map(observedName).filter(Boolean),
    skipped: report.skipped.entries.map(observedName).filter(Boolean),
  } : null
  const complete = Boolean(report && !report.truncated)
  return { ready, alive, complete, remaining, remainingItems, status: ready && alive && complete && Object.values(remaining).every(count => count === 0) ? 'resolved' : 'unresolved' }
}

/** 预览、执行与持久回退归同一控制器所有；HTTP 只传服务器生成的标识，不收路径或动作描述。 */
export class DiagnosticRepairs {
  constructor(options) {
    this.options = options
    this.previews = new Map()
    this.busy = new Set()
  }

  root() {
    return join(this.options.dataDir(), 'diagnostic-repairs')
  }

  scope(target) {
    return digest([target.home, target.profile, target.version, target.harnessEntry])
  }

  adaptationPath(target) {
    return join(this.root(), 'adapters', `${this.scope(target)}.json`)
  }

  save(record) {
    if (record.storageRoot !== this.root()) {
      throw new Error('修复记录目录已变化，禁止写入另一位置。')
    }
    const directory = join(record.storageRoot, 'history')
    ordinaryPath(directory, true)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const destination = join(directory, `${record.id}.json`)
    ordinaryLeaf(destination, true)
    const temporary = join(directory, `${record.id}.pending`)
    ordinaryLeaf(temporary, true)
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
    renameSync(temporary, destination)
  }

  /** 按安全标识读取原始记录，回退不受展示条数限制。 */
  readRecord(id, { trustedParent = false } = {}) {
    if (!ID_PATTERN.test(id || '')) {
      return null
    }
    try {
      const record = JSON.parse(readOptional(join(this.root(), 'history', `${id}.json`), { trustedParent }))
      return record?.id === id ? record : null
    } catch {
      return null
    }
  }

  /** 遍历可读取记录，仅供控制器校验与排序，不按文件名裁剪。 */
  *records() {
    const directory = join(this.root(), 'history')
    let names
    try {
      ordinaryPath(directory)
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) {
        continue
      }
      const record = this.readRecord(name.slice(0, -5), { trustedParent: true })
      if (record) {
        yield record
      }
    }
  }

  history() {
    return [...this.records()].sort((left, right) => (Number.isFinite(right.at) ? right.at : 0) - (Number.isFinite(left.at) ? left.at : 0)).slice(0, HISTORY_LIMIT)
  }

  current(binding) {
    const checked = checkedRepairPlan(binding, this.options.lookup, 'zh', true)
    if (checked.status !== 200) {
      throw new Error('诊断或配置已过期，请重新预览。')
    }
    return this.options.lookup(binding.attemptId)
  }

  probe(target, names) {
    return probePackageSources(target, names)
  }

  versionEvidence(target) {
    return clientVersionEvidence(target.harnessEntry)
  }

  acceptedPatch(target) {
    const source = join(target.home, 'profiles', target.profile, 'cordis.patch.yml')
    const current = readPatch(source)
    for (const record of this.records()) {
      if (record.action?.kind !== 'disable-optional' || !record.target || record.status === 'rolled_back' || this.scope(record.target) !== this.scope(target)) {
        continue
      }
      const backup = join(target.home, 'profiles', target.profile, '.dsh-x-repairs', record.id, 'patch-before.yml')
      if (record.action.source !== source || record.action.backup !== backup || current === null || bytesDigest(current) !== record.patchAppliedDigest) {
        continue
      }
      const original = readPatch(backup)
      if (original !== null && bytesDigest(original) === record.patchBeforeDigest && disabledPatch(original, record.action.rows || OPTIONAL_ROWS) === current) {
        return record.patchAppliedDigest
      }
    }
    return null
  }

  async inspect(target, diagnosis) {
    const evidence = this.versionEvidence(target)
    const rejected = diagnosis.rejected.flatMap(row => {
      const match = /^(@deepseek-ai\/[a-z0-9][a-z0-9._-]*)@([^\s]+)$/.exec(row.package)
      return match ? [{ ...row, name: match[1], version: match[2] }] : []
    })
    const names = [...new Set(rejected.map(row => row.name))]
    const acceptedPatchDigest = this.acceptedPatch(target)
    const probe = await this.probe({ ...target, anchor: evidence.anchor, acceptedPatchDigest, runtimeEvidence: diagnosis.runtimeEvidence }, names)
    if (probe.runtimeVersion !== evidence.version || evidence.version !== target.version) {
      throw new Error('运行时版本来源不一致，禁止修复。')
    }
    const profile = join(target.home, 'profiles', target.profile)
    const packages = probe.rows.map(row => {
      const source = join(profile, 'node_modules', row.name)
      let reason = ''
      let sourceDigest = null
      let replacementDigest = null
      const replacementRelative = row.replacement ? relative(dirname(dirname(dirname(evidence.anchor))), row.replacement.dir) : '..'
      if (!probe.rootConfirmed) {
        reason = '存在自定义补丁或 include，未证实此故障的解析基点。'
      } else if (row.declaredLocally) {
        reason = 'profile 清单声明了此包，正常安装可能装回旧版，需要人工核对声明。'
      } else if (!rejected.some(item => item.name === row.name && item.version === row.selected?.version) || !row.incompatible || row.selected?.dir !== source || !row.replacement?.compatible || row.fallback !== row.replacement.dir || isAbsolute(replacementRelative) || replacementRelative.split(sep).includes('..')) {
        reason = '未证实 profile 本地遮蔽和兼容替代，禁止自动处理。'
      } else if (!compatibleUpgrade(row.selected.version, row.replacement.version)) {
        reason = '兼容替代版本较低或版本无法可靠比较；禁止自动降级。'
      } else {
        try {
          sourceDigest = packageFingerprint(source)
          replacementDigest = packageFingerprint(row.replacement.dir)
        } catch {
          reason = '包或父目录为链接、内容过大或正在变化，无法安全归档。'
        }
      }
      const sourceConfirmed = Boolean((probe.rootConfirmed || row.configurationConfirmed) && row.selected?.name === row.name && rejected.some(item => item.name === row.name && item.version === row.selected.version && (probe.rootConfirmed || row.configurationRowIds?.includes(item.id))))
      return { ...row, source, sourceConfirmed, sourceDigest, replacementDigest, disabledReason: reason, evidence: rejected.filter(item => item.name === row.name) }
    })
    const files = [evidence.anchor, evidence.clientFile]
    const packageState = packages.map(row => [row.name, row.selected, row.replacement, row.fallback, row.incompatible, row.declaredLocally, row.sourceDigest, row.replacementDigest, row.disabledReason])
    const adaptation = readOptional(this.adaptationPath(target))
    const patchAvailable = readPatch(join(profile, 'cordis.patch.yml')) !== null
    const introducers = (probe.introducers || []).map(candidate => {
      const row = packages.find(item => item.name === candidate.component)
      let disabledReason = candidate.disabledReason
      if (!disabledReason && (!row?.sourceConfirmed || row.selected?.dir !== row.source || !row.incompatible || !row.replacement?.compatible || row.fallback !== row.replacement.dir || !compatibleUpgrade(row.selected.version, row.replacement.version) || !row.evidence.length)) {
        disabledReason = '当前拒绝日志、实际来源和兼容替代未形成一致证据。'
      }
      if (!disabledReason && diagnosis.truncated) {
        disabledReason = '本次诊断证据不完整。'
      }
      return { ...candidate, disabledReason }
    })
    return {
      evidence, packages, adaptation, introducers, dependencyReason: probe.dependencyReason,
      telemetrySource: probe.telemetrySource,
      configurationEvidence: probe.configurationEvidence || [],
      disableCandidates: (probe.disableCandidates || []).map(row => ({ ...row, disabledReason: !patchAvailable ? '配置文件不存在，不能自动禁用。' : diagnosis.truncated ? '诊断证据不完整，不能禁用。' : row.disabledReason })),
      disableAllowed: Boolean(probe.optionalProof?.allowed && probe.telemetryConfirmed && !acceptedPatchDigest && patchAvailable),
      disableReason: !patchAvailable ? '配置文件不存在，不能自动禁用。' : probe.optionalProof?.reason || '当前版本的可选依赖组尚未核实，不能禁用。',
      optionalProof: probe.optionalProof,
      optionalDependencies: probe.optionalDependencies || [],
      fingerprint: digest([this.root(), profileFingerprint(target.home, target.profile), evidence.digest, packageState, adaptation, files, probe.bundleDigests, probe.optionalProof, probe.rootDigest, acceptedPatchDigest, probe.disableCandidates, probe.compositionFiles, probe.dependencyDigest, introducers, probe.skippedBundleEvidence]),
    }
  }

  async preview(binding) {
    const current = this.current(binding)
    const target = { home: binding.home, profile: binding.profile, version: binding.version, harnessEntry: binding.harnessEntry }
    let inspected
    try {
      inspected = await this.inspect(target, current.diagnosis)
    } catch (error) {
      inspected = { packages: [], adaptation: null, fingerprint: null, evidence: {}, inspectionReason: `来源核实失败：${String(error.message || error)}` }
    }
    this.current(binding)
    const id = randomBytes(16).toString('hex')
    const backupRoot = join(target.home, 'profiles', target.profile, '.dsh-x-repairs', id)
    const actions = inspected.packages.map(row => ({
      id: row.name,
      kind: 'package',
      component: row.name,
      responsibility: row.disabledReason ? '实际责任位置未确认' : 'profile 本地安装层遮蔽运行时包',
      cause: row.disabledReason ? '日志报告不兼容，但未满足自动修复的来源证明。' : '此包声明的 Harness 版本不兼容。',
      source: row.disabledReason ? row.selected?.dir || '未知' : row.source,
      replacement: row.replacement?.dir || '',
      currentVersion: row.selected?.version || '',
      targetVersion: row.replacement?.version || '',
      backup: join(backupRoot, 'packages', row.name),
      recommendation: '仅将此旧包移到备份目录，让官方解析器使用已验证的兼容包。',
      rollback: '停止目标实例后，将本次备份原物移回；目标已出现新内容则拒绝覆盖。',
      disabledReason: row.disabledReason,
      evidence: row.evidence,
    }))
    const offeredIntroducers = new Set()
    for (const candidate of inspected.introducers || []) {
      if (offeredIntroducers.has(candidate.owner.dir)) {
        continue
      }
      offeredIntroducers.add(candidate.owner.dir)
      const related = inspected.introducers.filter(item => item.owner.dir === candidate.owner.dir)
      const row = inspected.packages.find(item => item.name === candidate.component)
      actions.push({
        id: `uninstall:${candidate.owner.name}:${candidate.component}`,
        kind: 'uninstall-introducer',
        component: candidate.component,
        owner: candidate.owner,
        owners: candidate.owners,
        rows: candidate.entries,
        affected: candidate.affected,
        predicted: candidate.predicted,
        affectedComponents: related.map(item => item.component),
        source: join(target.home, 'profiles', target.profile, 'package.json'),
        backup: join(backupRoot, 'installation'),
        currentVersion: row.selected?.version || '',
        targetVersion: row.replacement?.version || '',
        disabledReason: related.find(item => item.disabledReason)?.disabledReason || '',
        evidence: related.flatMap(item => inspected.packages.find(packageRow => packageRow.name === item.component)?.evidence || []),
        recommendation: `通过官方包管理器卸载 ${candidate.owner.name}；重算安装依赖，可能联网下载锁定包。禁用不等于卸载；失败也可能已部分修改文件。`,
        rollback: '此卸载不支持一键回退；恢复需另行确认重新安装，原版本可能重新引入冲突。',
      })
    }
    for (const candidate of inspected.disableCandidates || []) {
      const failure = current.diagnosis.failed.find(row => row.id === candidate.id && row.package === candidate.component)
      if (!failure) {
        continue
      }
      actions.push({
        id: `disable-row:${candidate.id}`, kind: 'disable-optional', proof: candidate.proof || 'runtime-schema-leaf', component: candidate.component,
        source: join(target.home, 'profiles', target.profile, 'cordis.patch.yml'),
        replacement: '', currentVersion: candidate.version, targetVersion: candidate.version,
        backup: join(backupRoot, 'patch-before.yml'), rows: [candidate.id],
        disabledReason: candidate.disabledReason,
        evidence: [failure],
        recommendation: '只禁用这个已报错、apply 尚未开始的非启动必需条目；模块顶层可能已执行，禁用不会撤销其副作用。其他等待组件保持原样，重新启动复验。',
        rollback: '恢复原配置备份，不改错误配置值。',
      })
    }
    if (current.diagnosis.advice.some(item => item.code === 'telemetry_configuration')) {
      actions.push({
        id: 'disable-analytics', kind: 'disable-optional', component: '@deepseek-ai/dsh-host-product-telemetry-otel',
        responsibility: inspected.disableAllowed ? '当前版本已核实的可选组件组' : '未确认',
        cause: '运行情况上报组件失败；产品使用情况收集依赖它。',
        source: join(target.home, 'profiles', target.profile, 'cordis.patch.yml'),
        replacement: '不改变 Harness 或任何插件版本。', currentVersion: target.version, targetVersion: target.version,
        backup: join(backupRoot, 'patch-before.yml'),
        recommendation: '禁用运行情况上报；产品使用情况收集还依赖本插件，将强制一起禁用。这会关闭两项收集/上报功能，仅绕过故障，并未修好插件。',
        rollback: '恢复本次备份的配置原物；配置被再次修改时拒绝覆盖。',
        disabledReason: inspected.disableAllowed ? '' : inspected.disableReason || inspected.inspectionReason,
        rows: OPTIONAL_ROWS,
        evidence: current.diagnosis.failed.filter(item => item.package === '@deepseek-ai/dsh-host-product-telemetry-otel'),
      })
    }
    const covered = new Set(actions.flatMap(action => action.evidence.map(item => `${item.id}\0${item.package}`)))
    for (const row of [...current.diagnosis.failed, ...current.diagnosis.rejected, ...(current.diagnosis.skipped?.entries || [])]) {
      if (covered.has(`${row.id}\0${row.package}`)) {
        continue
      }
      actions.push({
        id: `unsupported-${actions.length}`, kind: 'unsupported', component: row.package || row.packageName || row.id || '被跳过的组件',
        responsibility: '未确认', cause: row.reason || '日志报告插件错误。', source: '未知', replacement: '',
        currentVersion: '', targetVersion: '', backup: '', recommendation: '保留证据，人工核对该组件来源与兼容版本。',
        rollback: '未执行修改。', disabledReason: inspected.fingerprint ? current.diagnosis.runtimeEvidence ? '当前故障未满足已核实的安全动作条件。' : '缺少本次运行时首次配置校验失败及非必需叶子的证据；需重新启动采集。' : inspected.inspectionReason, evidence: [row],
      })
    }
    const presentation = buildRepairPresentation(actions, current.diagnosis, inspected, target)
    const preview = { id, binding, target, backupRoot, actions, fingerprint: inspected.fingerprint, diagnosis: current.diagnosis, inspected }
    if (this.previews.size >= PREVIEW_LIMIT) {
      this.previews.delete(this.previews.keys().next().value)
    }
    this.previews.set(id, preview)
    return { id, target, actions: presentation.actions, problems: presentation.problems, waitingServices: presentation.waitingServices, runtimeState: current.diagnosis.runtimeEvidence ? { phase: current.diagnosis.runtimeEvidence.phase, requiredInactive: current.diagnosis.runtimeEvidence.requiredInactive, requiredDependencyChains: current.diagnosis.runtimeEvidence.requiredDependencyChains } : null, blockingChains: current.diagnosis.blockingChains, waiting: current.diagnosis.waiting, impact: '将停止并重新启动此目标实例；运行中的任务会中断。仅执行确认的操作；卸载会由官方包管理器重算依赖，实际变动以执行记录为准。' }
  }

  async execute(id, actionId) {
    const preview = this.previews.get(id)
    const action = preview?.actions.find(item => item.id === actionId)
    if (!preview || !action || action.disabledReason || !['package', 'disable-optional', 'uninstall-introducer'].includes(action.kind)) {
      throw new Error('修复预览不存在、过期或该动作不可执行。')
    }
    const key = this.scope(preview.target)
    if (this.busy.has(key)) {
      throw new Error('此目标已有修复操作。')
    }
    this.busy.add(key)
    // 每次确认只消费一次；失败后也必须重新预览，不能覆盖已留存的回退记录。
    this.previews.delete(id)
    const record = { id, at: Date.now(), storageRoot: this.root(), target: preview.target, action, status: 'prepared', outcome: null, actualChanges: [], before: preview.inspected.adaptation }
    try {
      this.current(preview.binding)
      this.options.assertAvailable(preview.target)
      const inspected = await this.inspect(preview.target, preview.diagnosis)
      if (inspected.fingerprint !== preview.fingerprint) {
        throw new Error('修复目标内容已变化，请重新预览。')
      }
      this.current(preview.binding)
      await this.options.exclusive(preview.target, async () => {
        await this.options.stop(preview.target)
        await withProfileLock(join(preview.target.home, 'profiles', preview.target.profile), async () => {
          const mutate = async () => {
            const fresh = await this.inspect(preview.target, preview.diagnosis)
            if (fresh.fingerprint !== preview.fingerprint) {
              throw new Error('停止后文件状态变化，未执行修复，请重新诊断。')
            }
            ordinaryPath(preview.backupRoot, true)
            mkdirSync(preview.backupRoot, { recursive: true, mode: 0o700 })
            this.save(record)
            if (action.kind === 'uninstall-introducer') {
              const candidate = fresh.introducers?.find(item => item.component === action.component && item.owner.dir === action.owner.dir && item.owner.name === action.owner.name)
              if (!candidate || fresh.introducers.some(item => item.owner.dir === action.owner.dir && item.disabledReason)) {
                throw new Error('引入者或依赖证据已变化，禁止卸载。')
              }
              const profile = join(preview.target.home, 'profiles', preview.target.profile)
              const before = installedPackageState(profile)
              ordinaryPath(action.backup, true)
              mkdirSync(action.backup, { recursive: true, mode: 0o700 })
              for (const filename of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
                const text = readOptional(join(profile, filename))
                if (text !== null) {
                  writeFileSync(join(action.backup, filename), text, { flag: 'wx', mode: 0o600 })
                }
              }
              record.rollbackSupported = false
              record.status = 'uninstalling'
              this.save(record)
              try {
                await this.options.uninstall(preview.target, action.owner.name)
                record.status = 'applied'
              } catch (error) {
                record.error = String(error.message || error)
                record.status = 'uninstall_failed'
              }
              try {
                const after = installedPackageState(profile)
                record.actualChanges.push(...packageStateChanges(before, after))
                record.installationEvidenceComplete = true
                record.installationEvidenceScope = '仅核对配置/锁文件和包清单库存，不代表全目录文件级差异。'
              } catch (error) {
                record.installationEvidenceComplete = false
                record.installationEvidenceError = String(error.message || error)
              }
              try {
                const after = await this.probe({ ...preview.target, anchor: fresh.evidence.anchor }, [action.component])
                const selected = after.rows.find(item => item.name === action.component)
                record.actualChanges.push({ operation: 'resolved_package', component: action.component, path: selected?.selected?.dir || null, after: { version: selected?.selected?.version || null, incompatible: selected?.incompatible ?? null } })
              } catch (error) {
                record.resolutionError = String(error.message || error)
              }
              this.save(record)
            } else if (action.kind === 'package') {
              const row = fresh.packages.find(item => item.name === action.id)
              record.packageDigest = row.sourceDigest
              this.save(record)
              archivePackage(row.source, action.backup, row.sourceDigest)
              record.actualChanges.push({ operation: 'archive_package', path: row.source, backup: action.backup, before: { version: row.selected.version, digest: row.sourceDigest }, after: { movedToBackup: true }, scope: preview.target })
              record.status = 'applied'
              this.save(record)
              const after = await this.probe({ ...preview.target, anchor: fresh.evidence.anchor, acceptedPatchDigest: this.acceptedPatch(preview.target) }, [row.name])
              if (after.rows[0]?.selected?.dir !== row.replacement.dir || after.rows[0]?.incompatible) {
                throw new Error('移出后实际解析结果与预览不同，备份保留，可回退。')
              }
              record.actualChanges.push({ operation: 'resolved_package', path: after.rows[0].selected.dir, after: { version: after.rows[0].selected.version }, scope: preview.target })
            } else if (action.kind === 'disable-optional') {
              const single = ['runtime-schema-leaf', 'runtime-import-leaf'].includes(action.proof)
              const candidate = single ? fresh.disableCandidates?.find(row => action.rows?.length === 1 && row.id === action.rows[0] && row.component === action.component && (row.proof || 'runtime-schema-leaf') === action.proof) : null
              if (single ? !candidate || candidate.disabledReason : !fresh.disableAllowed) {
                throw new Error('可选性或依赖来源已变化，禁止禁用。')
              }
              const original = readPatch(action.source)
              if (original === null) {
                throw new Error('原配置不存在，需重新核对后才能禁用。')
              }
              const targetRows = action.rows || OPTIONAL_ROWS
              const patched = disabledPatch(original, targetRows)
              record.patchBeforeDigest = bytesDigest(original)
              record.patchAppliedDigest = bytesDigest(patched)
              this.save(record)
              ordinaryPath(action.backup, true)
              if (existsSync(action.backup)) {
                throw new Error('备份目标已存在。')
              }
              const prepared = join(preview.backupRoot, 'patch-prepared.yml')
              ordinaryPath(prepared, true)
              writeFileSync(prepared, patched, { flag: 'wx', mode: 0o600 })
              renameSync(action.source, action.backup)
              record.actualChanges.push({ operation: 'backup_patch', path: action.source, backup: action.backup, before: { digest: record.patchBeforeDigest }, after: { movedToBackup: true }, scope: preview.target })
              this.save(record)
              renameSync(prepared, action.source)
              record.actualChanges.push({ operation: 'disable_rows', path: action.source, before: { digest: record.patchBeforeDigest }, after: { digest: record.patchAppliedDigest }, rows: [...targetRows], scope: preview.target })
            }
            if (record.status !== 'uninstall_failed') {
              record.status = 'applied'
            }
            this.save(record)
          }
          if (action.kind === 'uninstall-introducer') {
            await this.options.installationExclusive(preview.target, mutate)
          } else {
            await mutate()
          }
        })
        record.verificationStatus = 'pending'
        this.save(record)
        record.outcome = await this.options.verify(preview.target)
        record.verificationStatus = 'complete'
        if (action.kind === 'disable-optional') {
          record.outcome.bypassed = true
        }
        if (record.outcome.status !== 'resolved') {
          const beforeCount = preview.diagnosis.failed.length + preview.diagnosis.rejected.length + preview.diagnosis.blockingChains.length + preview.diagnosis.waiting.length + preview.diagnosis.skipped.entries.length
          const afterCount = record.outcome.remaining ? Object.values(record.outcome.remaining).reduce((total, count) => total + count, 0) : beforeCount
          record.outcome.status = afterCount < beforeCount ? 'partial' : 'unresolved'
        }
      })
      this.save(record)
      this.previews.delete(id)
      return record
    } catch (error) {
      if (record.status === 'applied' || existsSync(join(this.root(), 'history', `${id}.json`))) {
        if (record.verificationStatus === 'pending') {
          // 复验失败不能覆盖官方卸载的原始包名、原因和部分执行事实。
          record.verificationStatus = 'failed'
          record.verificationError = String(error.message || error)
          if (record.status === 'applied') {
            record.status = 'applied_verification_failed'
          }
        } else {
          record.error = String(error.message || error)
          record.status = record.status === 'applied' ? 'applied_verification_failed' : 'interrupted'
        }
        this.save(record)
        error = Object.assign(new Error(String(error.message || error)), { cause: error, repairRecord: record })
      }
      throw error
    } finally {
      this.busy.delete(key)
    }
  }

  /** 持久记录可跨管理器重启找回；回退同样先停目标并在 profile 锁内拒绝覆盖。 */
  async rollback(id) {
    if (!ID_PATTERN.test(id || '')) {
      throw new Error('无效修复记录。')
    }
    const record = this.readRecord(id)
    if (record?.action?.kind === 'uninstall-introducer') {
      throw new Error('官方卸载不支持一键回退；重新安装必须另行确认。')
    }
    if (!record || record.status === 'rolled_back') {
      throw new Error('修复记录不存在或已回退。')
    }
    if (record.storageRoot !== this.root()) {
      throw new Error('回退记录目录已变化。')
    }
    const runtimeEvidence = this.versionEvidence(record.target)
    if (runtimeEvidence.version !== record.target.version) {
      throw new Error('运行时或客户端元数据已变化，回退前需要重新核对。')
    }
    const key = this.scope(record.target)
    if (this.busy.has(key)) {
      throw new Error('此目标已有修复操作。')
    }
    const profile = join(record.target.home, 'profiles', record.target.profile)
    const backupRoot = join(profile, '.dsh-x-repairs', id)
    const action = record.action
    if (action.kind === 'package') {
      if (!PACKAGE_PATTERN.test(action.id) || action.source !== join(profile, 'node_modules', action.id) || action.backup !== join(backupRoot, 'packages', action.id)) {
        throw new Error('修复记录路径不一致，禁止回退。')
      }
    } else if (action.kind === 'disable-optional') {
      if (action.source !== join(profile, 'cordis.patch.yml') || action.backup !== join(backupRoot, 'patch-before.yml')) {
        throw new Error('修复记录路径不一致，禁止回退。')
      }
    } else if (action.kind !== 'client-version' || action.source !== this.adaptationPath(record.target) || action.backup !== join(backupRoot, 'adapter-before.json')) {
      throw new Error('修复记录路径不一致，禁止回退。')
    }
    const priorRollbackIntent = Number.isFinite(record.rollbackStartedAt) && record.rollbackStartedAt > 0
    let currentAttemptRecorded = false
    this.busy.add(key)
    try {
      this.options.assertAvailable(record.target)
      await this.options.exclusive(record.target, async () => {
        await this.options.stop(record.target)
        await withProfileLock(profile, async () => {
          record.outcome = null
          record.verificationStatus = 'pending'
          delete record.verificationError
          this.save(record)
          currentAttemptRecorded = true
          if (action.kind === 'package' && !priorRollbackIntent) {
            ordinaryPath(action.source, true)
            ordinaryPath(action.backup)
            if (existsSync(action.source) || !record.packageDigest || packageFingerprint(action.backup) !== record.packageDigest) {
              throw new Error('回退原始条件不满足，未记录可续恢复意图。')
            }
          }
          record.rollbackStartedAt = record.rollbackStartedAt || Date.now()
          this.save(record)
          let contentAlreadyRestored = false
          if (action.kind === 'package') {
            ordinaryPath(action.backup, true)
            if (priorRollbackIntent && !existsSync(action.backup) && record.packageDigest && packageFingerprint(action.source) === record.packageDigest) {
              contentAlreadyRestored = true
            } else {
              restorePackage(action.source, action.backup, record.packageDigest)
            }
          } else if (action.kind === 'disable-optional') {
            const current = readPatch(action.source)
            const original = readPatch(action.backup)
            const retired = join(backupRoot, 'patch-withdrawn.yml')
            const withdrawn = readPatch(retired)
            if (original === null && current !== null && bytesDigest(current) === record.patchBeforeDigest && withdrawn !== null && bytesDigest(withdrawn) === record.patchAppliedDigest) {
              // 原物已恢复但持久状态尚未写入时，重试只完成记账。
            } else {
              if (original === null || bytesDigest(original) !== record.patchBeforeDigest || (current !== null && bytesDigest(current) !== record.patchAppliedDigest) || (withdrawn !== null && bytesDigest(withdrawn) !== record.patchAppliedDigest)) {
                throw new Error('配置或回退备份已变化，拒绝覆盖。')
              }
              if (current !== null) {
                if (withdrawn !== null) {
                  throw new Error('回退目标已存在。')
                }
                renameSync(action.source, retired)
              }
              // 两次原子 rename 中间中断时，仅在目标仍缺失且原备份摘要一致时续回退。
              ordinaryPath(action.source, true)
              if (existsSync(action.source)) {
                throw new Error('配置目标已出现新内容，拒绝覆盖。')
              }
              renameSync(action.backup, action.source)
            }
          } else {
            if (!record.adapter || readOptional(action.source) !== record.adapter) {
              throw new Error('启动适配已变化，拒绝覆盖。')
            }
            const before = JSON.parse(readOptional(action.backup))
            if (before.previous !== record.before) {
              throw new Error('回退备份内容已变化。')
            }
            const retired = join(backupRoot, 'adapter-withdrawn.json')
            ordinaryPath(retired, true)
            if (existsSync(retired)) {
              throw new Error('回退目标已存在。')
            }
            renameSync(action.source, retired)
            if (record.before !== null) {
              writeFileSync(action.source, record.before, { flag: 'wx', mode: 0o600 })
            }
          }
          record.rollbackChanges = [{ operation: contentAlreadyRestored ? 'confirm_restored_backup' : 'restore_backup', path: action.source, backup: action.backup, after: action.kind === 'package' ? { version: action.currentVersion } : action.kind === 'disable-optional' ? { digest: record.patchBeforeDigest } : { adapterPresent: record.before !== null }, scope: record.target }]
          record.status = 'rolled_back'
          record.rollbackAt = Date.now()
          record.outcome = null
          record.verificationStatus = 'pending'
          this.save(record)
        })
        record.outcome = await this.options.verify(record.target)
        record.verificationStatus = 'complete'
      })
      this.save(record)
      return record
    } catch (error) {
      if (currentAttemptRecorded && record.verificationStatus === 'pending') {
        record.verificationStatus = 'failed'
        record.verificationError = String(error.message || error)
        this.save(record)
        error = Object.assign(new Error(String(error.message || error)), { cause: error, repairRecord: record })
      }
      throw error
    } finally {
      this.busy.delete(key)
    }
  }

}
