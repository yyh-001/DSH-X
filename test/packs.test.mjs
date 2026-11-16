import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { crc32, readZip, writeZip } from '../src/zip.js'
import { environmentFromPack } from '../src/environment-pack.js'
// 整合包改成「导入为环境」后，整包装进 Profile 的默认 profile 名（defaultProfileFor）、页面摘要（packSummary）、
// 把 Profile 打成包（exportPack）、整包安装计划（planInstall）都撤了；导出走 /api/environments/export（见 packs-api）。
// 这里只留解析、只导配置的安装计划（planConfigInstall）与它的写入 / 备份 / 回滚，以及导出钉版读实装版本的 installedVersion
import {
  MANIFEST_FIELDS,
  PACK_TYPES,
  applyInstall,
  backupDirFor,
  forgetPack,
  installSpecs,
  installedVersion,
  isSensitiveFile,
  parsePackArchive,
  parsePackDir,
  parsePackSource,
  planConfigInstall,
  readPackState,
  rememberPack,
  rollbackFiles,
  safeRelPath,
  sameInstall,
  slugName,
  uninstallPack,
} from '../src/packs.js'

function tempDir(prefix = 'dsh-pack-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 造一个最小可用的整合包（形状对齐 PackForge 的 .dspack）。 */
function makePack({
  manifest = {},
  entries = [],
  marker = { format: 'dspack', version: 3 },
  packageJson = true,
} = {}) {
  const files = [
    ...(marker === null ? [] : [{ name: 'dspack.json', data: JSON.stringify(marker) }]),
    {
      name: 'manifest.json',
      data: JSON.stringify({
        manifestVersion: 5,
        type: 'profile',
        name: 'demo',
        version: '1.0.0',
        displayName: '示例整合包',
        profileName: 'demo',
        dshVersion: '0.1.7-rc.2',
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'],
        dependencies: { 'dsh-cost-meter': '1.7.37' },
        ...manifest,
      }),
    },
    ...(packageJson ? [{ name: 'package.json', data: '{"name":"dsh-profile-demo","private":true}\n' }] : []),
    ...entries,
  ]
  return writeZip(files)
}

// ---- ZIP ----

test('zip：写出来能读回去，路径、二进制、空文件都对', () => {
  const buffer = writeZip([
    { name: 'manifest.json', data: '{"a":1}' },
    { name: 'overrides/nested/deep.yml', data: 'x: 1\n' },
    { name: 'home/skills/中文 技能/SKILL.md', data: '# 技能\n' },
    { name: 'empty.txt', data: '' },
    { name: 'raw.bin', data: Buffer.from([0, 1, 2, 255, 254]) },
    { name: 'a\\b.txt', data: '反斜杠也归一' },
  ])
  const { entries } = readZip(buffer)
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]))
  assert.equal(byName.get('manifest.json').toString(), '{"a":1}')
  assert.equal(byName.get('overrides/nested/deep.yml').toString(), 'x: 1\n')
  assert.equal(byName.get('home/skills/中文 技能/SKILL.md').toString(), '# 技能\n')
  assert.equal(byName.get('empty.txt').length, 0)
  assert.deepEqual([...byName.get('raw.bin')], [0, 1, 2, 255, 254])
  assert.equal(byName.get('a/b.txt').toString(), '反斜杠也归一')
})

test('zip：crc32 与标准实现对得上', () => {
  // 空串与 "123456789" 是 CRC-32 的两个标准测试向量
  assert.equal(crc32(Buffer.from('')), 0)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('zip：截断、非 ZIP、内容被改过都要报错', () => {
  const buffer = writeZip([{ name: 'a.txt', data: 'hello world hello world' }])
  assert.throws(() => readZip(buffer.subarray(0, 30)), /不是 ZIP|截断/)
  assert.throws(() => readZip(Buffer.from('这是一个普通的文本文件，不是压缩包，长度也够长够长够长')), /不是 ZIP/)
  // 内容被压过，字面量不在包里：直接改本地头后面第一个数据字节
  const tampered = Buffer.from(buffer)
  const dataStart = 30 + tampered.readUInt16LE(26) + tampered.readUInt16LE(28)
  tampered[dataStart] ^= 0xff
  assert.throws(() => readZip(tampered), /解压失败|校验失败|长度对不上/)
})

test('zip：64 位（ZIP64）与加密包明确拒绝，不猜', () => {
  const buffer = writeZip([{ name: 'a.txt', data: 'x' }])
  const zip64 = Buffer.from(buffer)
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16)
  assert.throws(() => readZip(zip64), /ZIP64/)
})

// ---- 路径安全 ----

test('路径安全：越界、绝对路径、Windows 设备名一律拒收', () => {
  assert.equal(safeRelPath('overrides/cordis.patch.yml'), 'overrides/cordis.patch.yml')
  assert.equal(safeRelPath('a\\b\\c.txt'), 'a/b/c.txt')
  assert.equal(safeRelPath('./a.txt'), 'a.txt')
  assert.equal(safeRelPath('../evil.txt'), '')
  assert.equal(safeRelPath('a/../../evil.txt'), '')
  assert.equal(safeRelPath('/etc/passwd'), '')
  assert.equal(safeRelPath('C:\\Windows\\system32\\x.dll'), '')
  assert.equal(safeRelPath('CON'), '')
  assert.equal(safeRelPath('dir/nul.txt'), '')
  assert.equal(safeRelPath('trailing./x'), '')
  assert.equal(safeRelPath('trailing /x'), '')
  assert.equal(safeRelPath(''), '')
})

// ---- 解析 ----

test('解析整合包：组成、补丁层、overrides、home 都分得清', () => {
  const pack = parsePackArchive(makePack({
    entries: [
      { name: 'overrides/cordis.patch.yml', data: '- id: x\n  disabled: true\n' },
      { name: 'overrides/config/extra.json', data: '{}' },
      { name: 'home/skills/my-skill/SKILL.md', data: '# hi' },
      { name: '.env', data: 'SECRET=1' },
      { name: 'overrides/.env.local', data: 'SECRET=1' },
      { name: 'overrides/.npmrc', data: 'registry=https://evil.example\n' },
      { name: 'home/settings.yaml', data: 'secret: yes' },
      { name: 'random/whatever.txt', data: 'x' },
    ],
  }))
  assert.equal(pack.ok, true)
  assert.equal(pack.fields.name, 'demo')
  assert.deepEqual(pack.fields.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'])
  assert.equal(pack.patch.source, 'overrides/cordis.patch.yml')
  assert.match(pack.patch.text, /disabled: true/)
  assert.deepEqual(pack.overrides.map((item) => item.path), ['config/extra.json'])
  assert.deepEqual(pack.home.map((item) => item.path), ['skills/my-skill/SKILL.md'])
  const skipped = pack.skipped.map((item) => item.path)
  assert.ok(skipped.includes('overrides/.env.local'), '.env 不落盘')
  assert.ok(skipped.includes('overrides/.npmrc'), '.npmrc 不落盘（会改 registry）')
  assert.ok(skipped.includes('home/settings.yaml'), '整机设置不落盘')
  assert.ok(skipped.includes('random/whatever.txt'), '不认识的内容只报告')
  assert.equal(pack.displayName, '示例整合包')
})

test('解析整合包：缺 manifest、清单版本过新、collection 形态都要拒', () => {
  assert.throws(() => parsePackArchive(writeZip([{ name: 'a.txt', data: 'x' }])), /没有 manifest\.json/)
  const tooNew = parsePackArchive(makePack({ manifest: { manifestVersion: 6 } }))
  assert.equal(tooNew.ok, false)
  assert.match(tooNew.errors.join(), /比这个启动器认识的.*更新/)
  const collection = parsePackArchive(makePack({ manifest: { type: 'collection' } }))
  assert.equal(collection.ok, false)
  assert.match(collection.errors.join(), /collection/)
})

test('解析整合包：路径越界整包拒收，未知字段只警告', () => {
  const evil = parsePackArchive(makePack({ entries: [{ name: '../../evil.txt', data: 'x' }] }))
  assert.equal(evil.ok, false)
  assert.match(evil.errors.join(), /路径不安全/)
  const private_ = parsePackArchive(makePack({ manifest: { 'x-eac': { installProfiles: ['full'] } } }))
  assert.equal(private_.ok, true, '私有扩展字段不挡安装')
  assert.match(private_.warnings.join(), /不处理的字段/)
})

test('解析整合包：没有 dspack.json 标记时退一步按 manifest 读，并说明', () => {
  const pack = parsePackArchive(makePack({ marker: null }))
  assert.equal(pack.ok, true)
  assert.match(pack.warnings.join(), /没有 dspack\.json 标记/)
})

test('解析目录形态：和归档走同一套判定', () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'overrides'), { recursive: true })
  writeFileSync(join(dir, 'dspack.json'), '{"format":"dspack","version":3}\n')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifestVersion: 5, type: 'profile', name: 'demo', version: '1.0.0',
    bundles: ['@deepseek-ai/dsh-base'], dependencies: {},
  }))
  writeFileSync(join(dir, 'overrides', 'cordis.patch.yml'), '- id: x\n')
  const pack = parsePackDir(dir)
  assert.equal(pack.ok, true)
  assert.equal(pack.patch.source, 'overrides/cordis.patch.yml')
})

test('来源识别：本地路径、链接、owner/repo、@版本', () => {
  const dir = tempDir()
  assert.equal(parsePackSource(dir).kind, 'dir')
  const file = join(dir, 'x.dspack')
  writeFileSync(file, 'x')
  assert.equal(parsePackSource(file).kind, 'file')
  assert.equal(parsePackSource('https://example.com/a.dspack').kind, 'url')
  const github = parsePackSource('https://github.com/owner/repo/releases/download/v1/a.dspack')
  assert.equal(github.kind, 'url', 'release 直链就是普通直链')
  assert.deepEqual(parsePackSource('owner/repo@v1.2.3'), { kind: 'github', repo: 'owner/repo', ref: 'v1.2.3', value: 'owner/repo@v1.2.3' })
  assert.equal(parsePackSource('https://github.com/owner/repo').repo, 'owner/repo')
  assert.throws(() => parsePackSource('随便一段话'), /认不出这个来源/)
})

test('slug：落在目录安全字符里', () => {
  assert.equal(slugName('Better DeepSeek Harness'), 'better-deepseek-harness')
  assert.equal(slugName('@scope/name'), 'scope-name')
  assert.equal(slugName(''), 'pack')
})

// ---- 依赖坐标 ----
// 环境只认「包名 → spec」一张表：旧整包安装要往 package.json 里写的那份别名表（installAliases）跟着撤了

test('依赖坐标：github:owner/repo + 版本 会翻成别名 + pnpm spec，不再另带别名表', () => {
  const dependencies = {
    'github:swaylq/dsh-wildmon': 'a2c7df00b27c2de9f2b0915d3bd5f1acc4d02c68',
    'dsh-cost-meter': '1.7.37',
    'github:owner/heads-up': 'latest',
  }
  const expected = {
    'dsh-wildmon': 'github:swaylq/dsh-wildmon#a2c7df00b27c2de9f2b0915d3bd5f1acc4d02c68',
    'dsh-cost-meter': '1.7.37',
    'heads-up': 'github:owner/heads-up',
  }
  const pack = parsePackArchive(makePack({ manifest: { bundles: ['@deepseek-ai/dsh-base', 'dsh-wildmon'], dependencies } }))
  assert.deepEqual(pack.installSpecs, expected)
  assert.ok(!('github:swaylq/dsh-wildmon' in pack.installSpecs), '坐标本身不当包名')
  assert.equal('installAliases' in pack, false, '解析结果里不再有别名表')
  // 直接调用：返回 { specs, warnings }，只有这两样
  assert.deepEqual(installSpecs(['@deepseek-ai/dsh-base', 'dsh-wildmon'], dependencies), { specs: expected, warnings: [] })
})

test('依赖坐标：协议型键原样交给 pnpm 并说明', () => {
  const pack = parsePackArchive(makePack({
    manifest: {
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: { 'https://example.com/x.tgz': '1.0.0' },
    },
  }))
  assert.deepEqual(pack.installSpecs, { 'https://example.com/x.tgz': '1.0.0' })
  assert.match(pack.warnings.join(), /协议型坐标/)
  const direct = installSpecs([], { 'https://example.com/x.tgz': '1.0.0' })
  assert.deepEqual(direct.specs, { 'https://example.com/x.tgz': '1.0.0' })
  assert.equal(direct.warnings.length, 1, '警告跟着返回值走，调用方并进包的警告里')
  assert.match(direct.warnings[0], /协议型坐标/)
})

// ---- 解析时的提示 ----

test('解析：锁文件只提示一句「导入时忽略」；缺 package.json 快照、缺补丁层都不再报', () => {
  // 实例只锁直接依赖：插件清单在清单的 dependencies 里，包里有没有 package.json 快照、补丁层都无所谓
  const bare = parsePackArchive(makePack({ packageJson: false }))
  assert.equal(bare.ok, true)
  assert.deepEqual(bare.warnings, [], '没快照、没补丁层的干净包一条警告都不该有')
  const locked = parsePackArchive(makePack({ entries: [{ name: 'pnpm-lock.yaml', data: 'lockfileVersion: 9.0\n' }] }))
  assert.deepEqual(locked.warnings, ['包里有 pnpm-lock.yaml，导入时忽略它（实例只锁直接依赖）'])
})

test('解析：环境文件在清单上加的 offline / environment 字段认得，不当「不处理的字段」', () => {
  assert.deepEqual({ ...MANIFEST_FIELDS }, { OFFLINE: 'offline', ENVIRONMENT: 'environment' })
  assert.deepEqual({ ...PACK_TYPES }, { PROFILE: 'profile', WHOLE_HOME: 'dshhome', COLLECTION: 'collection' })
  assert.ok(Object.isFrozen(MANIFEST_FIELDS) && Object.isFrozen(PACK_TYPES), '常量表不许被调用方改掉')
  const pack = parsePackArchive(makePack({
    manifest: {
      [MANIFEST_FIELDS.OFFLINE]: { 'dsh-cost-meter': { file: 'offline/dsh-cost-meter-1.7.37.tgz', sha256: '0'.repeat(64) } },
      [MANIFEST_FIELDS.ENVIRONMENT]: { dshVersion: '0.1.7-rc.2' },
    },
  }))
  assert.equal(pack.ok, true)
  assert.doesNotMatch(pack.warnings.join('\n'), /不处理的字段/)
  // 私有字段照旧只警告，而且只点它自己的名字
  const mixed = parsePackArchive(makePack({ manifest: { offline: {}, 'x-eac': {} } }))
  assert.match(mixed.warnings.join('\n'), /不处理的字段：x-eac（忽略）/)
})

test('敏感文件：凭据、密钥、改 registry 的 .npmrc、整机设置都算，普通文件不算', () => {
  for (const rel of ['.env', 'overrides/.env.local', '.npmrc', 'home/.netrc', 'settings.yaml', 'credentials.json', 'certs/x.pem', 'a/b.key', '.ssh/id_rsa', 'id_ed25519.pub']) {
    assert.equal(isSensitiveFile(rel), true, `${rel} 不该离开本机`)
  }
  for (const rel of ['skills/a/SKILL.md', 'config/extra.json', 'environment.json', 'offline/dsh-x-memory-0.1.4.tgz', 'README.md', '']) {
    assert.equal(isSensitiveFile(rel), false, `${rel || '(空)'} 是普通文件`)
  }
  assert.equal(isSensitiveFile(undefined), false, '空值不抛')
})

// ---- 只导配置的安装计划 ----
// 插件清单归环境、启动前由启动器写；配置导入只写补丁层、overrides 和用户级文件，
// 要是这里也动 package.json，撤销时会把环境后来写进去的清单还原成旧的

function initedProfile(home, profile, packageJson = '{"name":"dsh-profile-x","private":true}\n') {
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), packageJson)
  return dir
}

test('配置导入计划：只写补丁层、overrides、home 文件，不碰 package.json / pnpm-workspace.yaml / cordis.yml', () => {
  const home = tempDir()
  initedProfile(home, 'web')
  const pack = parsePackArchive(makePack({
    entries: [
      { name: 'overrides/cordis.patch.yml', data: '- id: dsh-cost-meter\n  disabled: false\n' },
      { name: 'overrides/config/extra.json', data: '{}' },
      { name: 'home/skills/a/SKILL.md', data: '# a' },
      { name: 'pnpm-workspace.yaml', data: 'packages:\n  - .\n' },
      { name: 'profiles/web/cordis.yml', data: 'plugins: {}\n' },
    ],
  }))
  const plan = planConfigInstall(pack, { home, profile: 'web' })
  assert.equal(plan.ok, true)
  assert.equal(plan.configOnly, true)
  assert.equal(plan.profile, 'web')
  assert.deepEqual(plan.writes.map((write) => write.rel), [
    'profiles/web/cordis.patch.yml',
    'profiles/web/config/extra.json',
    'skills/a/SKILL.md',
  ])
  assert.equal(plan.writes.find((write) => write.kind === 'patch').overwrite, true, '补丁层整份替换')
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'cordis.yml']) {
    assert.ok(!plan.writes.some((write) => write.rel.endsWith(`/${name}`) || write.rel === name), `${name} 归环境，配置导入不写`)
  }
  assert.deepEqual(Object.keys(plan).sort(), ['configOnly', 'errors', 'ok', 'profile', 'warnings', 'writes'])
})

test('配置导入计划：配置（dsh profile）还没初始化（没有 package.json）就不往它目录里写', () => {
  const home = tempDir()
  const pack = parsePackArchive(makePack({ entries: [{ name: 'overrides/cordis.patch.yml', data: '- id: x\n' }] }))
  const missing = planConfigInstall(pack, { home, profile: 'fresh' })
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join(), /配置「fresh」还没初始化：先用它启动一次/)
  // 目录在、只有一份补丁层也不算：dsh 不认没有 package.json 的 profile
  mkdirSync(join(home, 'profiles', 'half'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'half', 'cordis.patch.yml'), '[]\n')
  assert.equal(planConfigInstall(pack, { home, profile: 'half' }).ok, false)
  // 只有用户级文件的包不往 profile 目录里写，Profile 在不在都行
  const homeOnly = parsePackArchive(makePack({ entries: [{ name: 'home/AGENTS.md', data: '全局指令' }] }))
  const plan = planConfigInstall(homeOnly, { home, profile: 'fresh' })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.writes.map((write) => write.rel), ['AGENTS.md'])
})

test('配置导入计划：home 文件进白名单，敏感文件和会话不进', () => {
  const home = tempDir()
  const pack = parsePackArchive(makePack({
    entries: [
      { name: 'home/skills/a/SKILL.md', data: '# a' },
      { name: 'home/AGENTS.md', data: '全局指令' },
      { name: 'home/sessions/2026/x.jsonl', data: 'x' },
      { name: 'home/settings.yaml', data: 'x' },
    ],
  }))
  const rels = planConfigInstall(pack, { home, profile: 'demo' }).writes.map((write) => write.rel)
  assert.deepEqual(rels.sort(), ['AGENTS.md', 'skills/a/SKILL.md'])
})

// 整机快照（dshhome）一个包里有好几份 profile，各有各的插件清单；环境只有一份插件清单，接不住。
// 以前按 profile 逐个装进去，现在「整包装进 Profile」撤了，导入只认能变成一个环境的包，这种要明确拒掉。
test('dshhome 形态：解析得出来，但导入成环境时明确拒绝', () => {
  const pack = parsePackArchive(makeZip({
    'dspack.json': JSON.stringify({ format: 'dspack', version: 3 }),
    'manifest.json': JSON.stringify({
      manifestVersion: 5,
      type: 'dshhome',
      name: 'whole-home',
      version: '1.0.0',
      defaultProfile: 'work',
      profiles: {
        work: { bundles: ['@deepseek-ai/dsh-base', 'dsh-cost-meter'], dependencies: { 'dsh-cost-meter': '1.7.37' } },
      },
    }),
    'home/AGENTS.md': '全局指令',
  }))
  assert.equal(pack.ok, true, '格式本身是合法的整合包')
  const env = environmentFromPack(pack)
  assert.equal(env.ok, false, '不能当成一个环境导入')
  assert.match(env.errors.join(), /dshhome/, '报错要点名是哪种形态，用户才知道为什么不行')
})

function makeZip(map) {
  return writeZip(Object.entries(map).map(([name, data]) => ({ name, data })))
}

// ---- 执行与回滚 ----

test('配置导入：写文件、记备份，记录标成只导配置、没新建 profile；中途失败回滚回原样', async () => {
  const home = tempDir()
  const dataDir = tempDir()
  const manifest = '{\n  "name": "dsh-profile-demo",\n  "private": true\n}\n'
  const profileDir = initedProfile(home, 'demo', manifest)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const pack = parsePackArchive(makePack({
    entries: [
      { name: 'overrides/cordis.patch.yml', data: '- id: dsh-cost-meter\n' },
      { name: 'home/AGENTS.md', data: '指令' },
    ],
  }))
  const plan = planConfigInstall(pack, { home, profile: 'demo' })
  const logs = []
  const result = await applyInstall(plan, { home, dataDir, pack, source: '文件：x.dspack', log: (line) => logs.push(line) })
  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '- id: dsh-cost-meter\n')
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '指令')
  assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), manifest, 'package.json 原样，一个字节都不动')
  assert.ok(existsSync(join(result.backupDir, 'files', 'profiles/demo/cordis.patch.yml')), '被覆盖的补丁层有备份')
  assert.ok(!existsSync(join(result.backupDir, 'files', 'profiles/demo/package.json')), '没写的文件不备份')
  const { record } = result
  assert.equal(record.configOnly, true)
  assert.equal(record.createdProfile, false, '配置导入从不新建 profile')
  assert.equal(record.profile, 'demo')
  assert.equal(record.name, 'demo')
  assert.equal(record.source, '文件：x.dspack')
  assert.deepEqual(record.files.map(({ rel, existed }) => [rel, existed]), [
    ['profiles/demo/cordis.patch.yml', true],
    ['AGENTS.md', false],
  ])

  // 第二份写入找不到内容：前面已经写下去的要还原，后面的一个都不留
  const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  const broken = {
    profile: 'demo',
    configOnly: true,
    writes: [
      { rel: 'profiles/demo/cordis.patch.yml', kind: 'patch', data: 'second\n' },
      { rel: 'profiles/demo/config/x.json', kind: 'override', source: 'overrides/missing.json' },
    ],
  }
  await assert.rejects(applyInstall(broken, { home, dataDir, pack, log: () => {} }), /没有内容（已回滚）/)
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), before)
  assert.ok(!existsSync(join(profileDir, 'config', 'x.json')))
})

test('执行计划：不再装依赖；不是只导配置的计划，记录里也没有 configOnly', async () => {
  const home = tempDir()
  const dataDir = tempDir()
  const pack = parsePackArchive(makePack())
  const calls = []
  const plan = { ok: true, profile: 'demo', writes: [{ rel: 'AGENTS.md', kind: 'home', data: '指令' }] }
  // runInstall 已经不是 applyInstall 的参数：传了也不会被调用（插件由环境在启动前写进 profile、再装）
  const { record } = await applyInstall(plan, { home, dataDir, pack, runInstall: async (profile) => calls.push(profile) })
  assert.deepEqual(calls, [])
  assert.equal(record.createdProfile, false)
  assert.equal('configOnly' in record, false)
})

test('安装记录：备份目录带时间戳；同一次安装只留一条，整包安装和只导配置各算各的', () => {
  const dataDir = tempDir()
  const stamp = backupDirFor(dataDir, 'demo', new Date('2026-09-26T10:00:00Z'))
  assert.match(stamp.replace(/\\/g, '/'), /packs\/backups\/20260926100000-demo$/)
  rememberPack(dataDir, { name: 'demo', version: '1.0.0', profile: 'demo', files: [] })
  rememberPack(dataDir, { name: 'demo', version: '1.1.0', profile: 'demo', files: [] })
  assert.equal(readPackState(dataDir).packs.length, 1, '同一个包同一 profile 只留一条')
  assert.equal(readPackState(dataDir).packs[0].version, '1.1.0')
  // 同一个包先整包装过、后来又只导配置：两条记录，各自撤销
  rememberPack(dataDir, { name: 'demo', version: '2.0.0', profile: 'demo', configOnly: true, files: [] })
  rememberPack(dataDir, { name: 'demo', version: '2.0.1', profile: 'demo', configOnly: true, files: [] })
  rememberPack(dataDir, { name: 'demo', version: '1.0.0', profile: 'other', files: [] })
  assert.deepEqual(readPackState(dataDir).packs.map((item) => [item.profile, item.version, item.configOnly === true]), [
    ['demo', '1.1.0', false],
    ['demo', '2.0.1', true],
    ['other', '1.0.0', false],
  ])
  // forgetPack 收的是记录本身，按同一套规则只摘掉对上的那条
  forgetPack(dataDir, { name: 'demo', profile: 'demo', configOnly: true })
  assert.deepEqual(readPackState(dataDir).packs.map((item) => [item.profile, item.version]), [['demo', '1.1.0'], ['other', '1.0.0']])
  forgetPack(dataDir, readPackState(dataDir).packs[0])
  assert.deepEqual(readPackState(dataDir).packs.map((item) => [item.profile, item.version]), [['other', '1.0.0']])
})

test('同一次安装：名字、Profile、是否只导配置三样都对上才算', () => {
  const legacy = { name: 'demo', profile: 'web' }
  const config = { name: 'demo', profile: 'web', configOnly: true }
  assert.equal(sameInstall(legacy, { name: 'demo', profile: 'web' }), true)
  assert.equal(sameInstall(legacy, { name: 'demo', profile: 'web', configOnly: false }), true)
  assert.equal(sameInstall(legacy, { name: 'demo', profile: 'web', configOnly: true }), false)
  assert.equal(sameInstall(config, { name: 'demo', profile: 'web' }), false, '不带 configOnly 指的是整包安装')
  assert.equal(sameInstall(config, { name: 'demo', profile: 'web', configOnly: true }), true)
  assert.equal(sameInstall(legacy, { name: 'demo', profile: 'other' }), false)
  assert.equal(sameInstall(legacy, { name: 'other', profile: 'web' }), false)
})

test('撤销配置导入：包新建的文件删掉、覆盖的文件还原，package.json 不受牵连', async () => {
  const home = tempDir()
  const dataDir = tempDir()
  const profileDir = initedProfile(home, 'demo')
  const manifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const pack = parsePackArchive(makePack({
    entries: [
      { name: 'overrides/cordis.patch.yml', data: '- id: x\n' },
      { name: 'overrides/config/new.json', data: '{"a":1}' },
    ],
  }))
  const { record } = await applyInstall(planConfigInstall(pack, { home, profile: 'demo' }), { home, dataDir, pack, log: () => {} })
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '- id: x\n')
  assert.ok(existsSync(join(profileDir, 'config', 'new.json')), '新写的文件在')
  // 导入之后环境往 package.json 里写了插件清单：撤销配置不能把它还原回去
  writeFileSync(join(profileDir, 'package.json'), `${manifest.trim()}\n`.replace('"private":true', '"private":true,"dependencies":{"dsh-x":"1.0.0"}'))
  const afterEnvironment = readFileSync(join(profileDir, 'package.json'), 'utf8')
  uninstallPack(record, { home, log: () => {} })
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '[]\n', '覆盖的补丁层还原')
  assert.ok(!existsSync(join(profileDir, 'config', 'new.json')), '包新建的文件被删掉')
  assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), afterEnvironment)
})

test('回滚：备份缺失时报出来而不是假装成功', () => {
  const home = tempDir()
  const logs = []
  const ok = rollbackFiles({
    backupDir: join(home, '没有这个目录'),
    files: [{ rel: 'profiles/x/package.json', existed: true }],
  }, home, (line) => logs.push(line))
  assert.equal(ok, false)
  assert.match(logs.join(), /还原 .* 失败/)
  assert.throws(() => uninstallPack({ backupDir: join(home, 'missing'), files: [{ rel: 'profiles/x/package.json', existed: true }] }, { home }), /未能还原/)
})

test('连续导入同一个包的配置：独立备份，撤销仍回到首次导入前', async () => {
  const home = tempDir()
  const dataDir = tempDir()
  const profileDir = initedProfile(home, 'demo', '{"name":"original","private":true}\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), 'original\n')
  const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
  const pack = parsePackArchive(makePack({ entries: [{ name: 'overrides/cordis.patch.yml', data: 'first\n' }] }))
  const now = new Date('2026-10-01T01:00:00Z')
  const first = await applyInstall(planConfigInstall(pack, { home, profile: 'demo' }), { home, dataDir, pack, now })
  const next = parsePackArchive(makePack({
    manifest: { version: '2.0.0' },
    entries: [
      { name: 'overrides/cordis.patch.yml', data: 'second\n' },
      { name: 'overrides/config/x.json', data: '{}' },
    ],
  }))
  const second = await applyInstall(planConfigInstall(next, { home, profile: 'demo' }), { home, dataDir, pack: next, now, previousRecord: first.record })
  assert.notEqual(first.backupDir, second.backupDir, '同一秒内的备份不能覆盖')
  assert.equal(second.record.configOnly, true)
  assert.equal(second.record.createdProfile, false)
  uninstallPack(second.record, { home })
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), 'original\n')
  assert.equal(existsSync(join(profileDir, 'config', 'x.json')), false)
  assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before)
})

// ---- 导出钉版读的实装版本 ----
// 整个 Profile 打成包的导出撤了（环境导出只带 DSH 精确版本和插件清单，见 packs-api）；
// 「范围 / tag 按 node_modules 实测版本钉死」由导出那层做，这里只管把实装版本读出来，读不到给空串

test('实装版本：按 node_modules 里的 package.json 读，带 scope 的包也找得到', () => {
  const profileDir = join(tempDir(), 'profiles', 'mine')
  mkdirSync(join(profileDir, 'node_modules', 'dsh-cost-meter'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'dsh-cost-meter', 'package.json'), '{"name":"dsh-cost-meter","version":"1.7.37"}')
  mkdirSync(join(profileDir, 'node_modules', '@acme', 'dsh-bar'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', '@acme', 'dsh-bar', 'package.json'), '{"name":"@acme/dsh-bar","version":" 2.3.1 "}')
  assert.equal(installedVersion(profileDir, 'dsh-cost-meter'), '1.7.37')
  assert.equal(installedVersion(profileDir, '@acme/dsh-bar'), '2.3.1', '前后空白去掉')
})

test('实装版本：没装成、读不到、没写版本都给空串，不编一个版本出来', () => {
  const profileDir = join(tempDir(), 'profiles', 'mine')
  mkdirSync(join(profileDir, 'node_modules', 'broken'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'broken', 'package.json'), '{ not json')
  mkdirSync(join(profileDir, 'node_modules', 'no-version'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'no-version', 'package.json'), '{"name":"no-version"}')
  assert.equal(installedVersion(profileDir, 'not-installed'), '')
  assert.equal(installedVersion(profileDir, 'broken'), '')
  assert.equal(installedVersion(profileDir, 'no-version'), '')
  assert.equal(installedVersion(join(tempDir(), 'no-such-profile'), 'dsh-cost-meter'), '', 'Profile 目录都不在也不抛')
})
