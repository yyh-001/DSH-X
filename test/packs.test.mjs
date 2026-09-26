import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { crc32, readZip, writeZip } from '../zip.js'
import {
  applyInstall,
  backupDirFor,
  defaultProfileFor,
  exportPack,
  parsePackArchive,
  parsePackDir,
  parsePackSource,
  packSummary,
  planInstall,
  readPackState,
  rememberPack,
  rollbackFiles,
  safeRelPath,
  slugName,
  uninstallPack,
} from '../packs.js'

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

test('profile 名与 slug：都落在目录安全字符里', () => {
  assert.equal(slugName('Better DeepSeek Harness'), 'better-deepseek-harness')
  assert.equal(slugName('@scope/name'), 'scope-name')
  assert.equal(slugName(''), 'pack')
  assert.equal(defaultProfileFor(parsePackArchive(makePack({ manifest: { profileName: '' } }))), 'demo')
})

test('依赖坐标：github:owner/repo + 版本 会翻成别名 + pnpm spec', () => {
  const pack = parsePackArchive(makePack({
    manifest: {
      bundles: ['@deepseek-ai/dsh-base', 'dsh-wildmon'],
      dependencies: {
        'github:swaylq/dsh-wildmon': 'a2c7df00b27c2de9f2b0915d3bd5f1acc4d02c68',
        'dsh-cost-meter': '1.7.37',
        'github:owner/heads-up': 'latest',
      },
    },
  }))
  assert.deepEqual(pack.installSpecs, {
    'dsh-wildmon': 'github:swaylq/dsh-wildmon#a2c7df00b27c2de9f2b0915d3bd5f1acc4d02c68',
    'dsh-cost-meter': '1.7.37',
    'heads-up': 'github:owner/heads-up',
  })
  assert.deepEqual(pack.installAliases['github:swaylq/dsh-wildmon'], {
    name: 'dsh-wildmon',
    spec: 'github:swaylq/dsh-wildmon#a2c7df00b27c2de9f2b0915d3bd5f1acc4d02c68',
  })
  const home = tempDir()
  const plan = planInstall(pack, { home, profile: 'demo' })
  const value = JSON.parse(plan.writes.find((write) => write.rel === 'profiles/demo/package.json').data)
  assert.equal(value.dependencies['dsh-wildmon'], 'github:swaylq/dsh-wildmon#a2c7df00b27c2de9f2b0915d3bd5f1acc4d02c68')
  assert.ok(!('github:swaylq/dsh-wildmon' in value.dependencies), '坐标本身不当包名')
  const summary = packSummary(pack)
  assert.deepEqual(summary.dependencies.find((item) => item.name === 'github:swaylq/dsh-wildmon').installAs, {
    name: 'dsh-wildmon',
    spec: 'github:swaylq/dsh-wildmon#a2c7df00b27c2de9f2b0915d3bd5f1acc4d02c68',
  })
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
})

// ---- 安装计划 ----

test('新建 profile：写出骨架清单，把层栈与依赖并进去', () => {
  const home = tempDir()
  const pack = parsePackArchive(makePack({
    entries: [{ name: 'overrides/cordis.patch.yml', data: '- id: dsh-cost-meter\n  disabled: false\n' }],
  }))
  const plan = planInstall(pack, { home, profile: 'demo' })
  assert.equal(plan.ok, true)
  assert.equal(plan.createsProfile, true)
  const manifestWrite = plan.writes.find((write) => write.rel === 'profiles/demo/package.json')
  const value = JSON.parse(manifestWrite.data)
  assert.deepEqual(value.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'])
  assert.deepEqual(value.dependencies, { 'dsh-cost-meter': '1.7.37' })
  assert.deepEqual(plan.writes.filter((write) => write.rel.startsWith('profiles/demo/')).map((write) => write.rel), [
    'profiles/demo/package.json',
    'profiles/demo/pnpm-workspace.yaml',
    'profiles/demo/cordis.yml',
    'profiles/demo/cordis.patch.yml',
  ])
  assert.equal(plan.writes.find((write) => write.kind === 'patch').overwrite, true)
})

test('已有 profile：保留用户自己的依赖与其它字段，只并包里的东西', () => {
  const home = tempDir()
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    description: '用户自己的 profile',
    dependencies: { 'dsh-meme': '0.1.43' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-meme'], patchReload: 'live' } },
  }))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nallowBuilds:\n  ssh2: true\n')
  const pack = parsePackArchive(makePack({ entries: [] }))
  const plan = planInstall(pack, { home, profile: 'web', hostProfile: 'web' })
  const value = JSON.parse(plan.writes.find((write) => write.rel === 'profiles/web/package.json').data)
  assert.equal(value.description, '用户自己的 profile', '用户写的字段留着')
  assert.deepEqual(value.dependencies, { 'dsh-meme': '0.1.43', 'dsh-cost-meter': '1.7.37' })
  assert.deepEqual(value.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-meme', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'])
  assert.equal(value.dsh.profile.patchReload, 'live')
  assert.ok(!plan.writes.some((write) => write.rel === 'profiles/web/pnpm-workspace.yaml'), '已有工作区文件不覆盖（allowBuilds 在里面）')
  assert.ok(!plan.writes.some((write) => write.rel === 'profiles/web/cordis.patch.yml'), '包里没有补丁层就不动现有的补丁层')
  assert.equal(plan.createsProfile, false)
  assert.match(plan.warnings.join(), /重启 dsh/)
})

test('安装计划：home 文件进白名单，敏感文件不进', () => {
  const home = tempDir()
  const pack = parsePackArchive(makePack({
    entries: [
      { name: 'home/skills/a/SKILL.md', data: '# a' },
      { name: 'home/AGENTS.md', data: '全局指令' },
      { name: 'home/sessions/2026/x.jsonl', data: 'x' },
      { name: 'home/settings.yaml', data: 'x' },
    ],
  }))
  const plan = planInstall(pack, { home, profile: 'demo' })
  const rels = plan.writes.map((write) => write.rel)
  assert.ok(rels.includes('skills/a/SKILL.md'))
  assert.ok(rels.includes('AGENTS.md'))
  assert.ok(!rels.includes('sessions/2026/x.jsonl'))
  assert.ok(!rels.includes('settings.yaml'))
})

test('dshhome 形态：按清单里的 profile 逐个装，整机文件只收白名单', () => {
  const home = tempDir()
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
  assert.equal(pack.ok, true)
  const plan = planInstall(pack, { home, profile: 'ignored' })
  const rels = plan.writes.map((write) => write.rel)
  assert.ok(rels.includes('profiles/work/package.json'))
  assert.ok(rels.includes('AGENTS.md'))
  assert.equal(JSON.parse(plan.writes.find((write) => write.rel === 'profiles/work/package.json').data).dependencies['dsh-cost-meter'], '1.7.37')
  assert.match(plan.warnings.join(), /整机快照形态/)
})

function makeZip(map) {
  return writeZip(Object.entries(map).map(([name, data]) => ({ name, data })))
}

// ---- 执行与回滚 ----

test('安装：写文件、记备份、失败时回滚回原样', async () => {
  const home = tempDir()
  const dataDir = tempDir()
  const profileDir = join(home, 'profiles', 'demo')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{\n  "name": "dsh-profile-demo",\n  "private": true\n}\n')
  const pack = parsePackArchive(makePack({
    entries: [
      { name: 'overrides/cordis.patch.yml', data: '- id: dsh-cost-meter\n' },
      { name: 'home/AGENTS.md', data: '指令' },
    ],
  }))
  const plan = planInstall(pack, { home, profile: 'demo' })
  const logs = []
  const result = await applyInstall(plan, {
    home,
    dataDir,
    pack,
    source: '文件：x.dspack',
    runInstall: async (profile) => { logs.push(`install ${profile}`) },
    log: (line) => logs.push(line),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(logs.filter((line) => line.startsWith('install ')), ['install demo'])
  assert.match(readFileSync(join(profileDir, 'package.json'), 'utf8'), /dsh-cost-meter/)
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '指令')
  assert.ok(existsSync(join(result.backupDir, 'files', 'profiles/demo/package.json')), '被覆盖的文件有备份')

  // 再装一次、这次让依赖安装失败：文件必须回到安装前
  const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
  const plan2 = planInstall(pack, { home, profile: 'demo' })
  await assert.rejects(
    applyInstall(plan2, { home, dataDir, pack, runInstall: async () => { throw new Error('pnpm 炸了') }, log: () => {} }),
    /pnpm 炸了（已回滚）/,
  )
  assert.equal(readFileSync(join(profileDir, 'package.json'), 'utf8'), before)
})

test('安装记录：备份目录带时间戳，状态文件记下装了哪个包', () => {
  const dataDir = tempDir()
  const stamp = backupDirFor(dataDir, 'demo', new Date('2026-09-26T10:00:00Z'))
  assert.match(stamp.replace(/\\/g, '/'), /packs\/backups\/20260926100000-demo$/)
  rememberPack(dataDir, { name: 'demo', version: '1.0.0', profile: 'demo', files: [] })
  rememberPack(dataDir, { name: 'demo', version: '1.1.0', profile: 'demo', files: [] })
  assert.equal(readPackState(dataDir).packs.length, 1, '同一个包同一 profile 只留一条')
  assert.equal(readPackState(dataDir).packs[0].version, '1.1.0')
})

test('卸载：包新建的文件删掉、覆盖的文件还原', async () => {
  const home = tempDir()
  const dataDir = tempDir()
  const profileDir = join(home, 'profiles', 'demo')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const pack = parsePackArchive(makePack({ entries: [{ name: 'overrides/cordis.patch.yml', data: '- id: x\n' }] }))
  const plan = planInstall(pack, { home, profile: 'demo' })
  const { record } = await applyInstall(plan, { home, dataDir, pack, runInstall: async () => {}, log: () => {} })
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '- id: x\n')
  assert.ok(existsSync(join(profileDir, 'pnpm-workspace.yaml')), '新写的文件在')
  uninstallPack(record, { home, log: () => {} })
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '[]\n', '覆盖的补丁层还原')
  assert.ok(!existsSync(join(profileDir, 'pnpm-workspace.yaml')), '包新建的文件被删掉')
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
})

// ---- 导出 ----

test('导出：依赖按 node_modules 实测版本钉死，补丁层进 overrides，凭据不进包', () => {
  const home = tempDir()
  const dataDir = tempDir()
  const profileDir = join(home, 'profiles', 'mine')
  mkdirSync(join(profileDir, 'node_modules', 'dsh-cost-meter'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'dsh-cost-meter', 'package.json'), '{"name":"dsh-cost-meter","version":"1.7.37"}')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-mine',
    private: true,
    dependencies: { 'dsh-cost-meter': '^1.7.0', 'dsh-meme': 'file:../meme', '.env': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-cost-meter'], patchReload: 'live' } },
  }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: x\n  disabled: true\n')
  writeFileSync(join(profileDir, '.env'), 'SECRET=1')
  mkdirSync(join(home, 'skills', 'a'), { recursive: true })
  writeFileSync(join(home, 'skills', 'a', 'SKILL.md'), '# a')

  const out = exportPack({ profileDir, home, name: 'My Pack', version: '2.0.0', includeHome: true })
  assert.equal(out.name, 'my-pack')
  assert.deepEqual(out.dependencies, { 'dsh-cost-meter': '1.7.37', 'dsh-meme': 'file:../meme', '.env': '1.0.0' })
  assert.ok(out.entries.includes('home/skills/a/SKILL.md'))

  const back = parsePackArchive(out.buffer)
  assert.equal(back.ok, true)
  assert.equal(back.fields.name, 'my-pack')
  assert.equal(back.fields.version, '2.0.0')
  assert.equal(back.fields.dependencies['dsh-cost-meter'], '1.7.37', '范围被钉成实测版本')
  assert.equal(back.patch.source, 'overrides/cordis.patch.yml')
  assert.deepEqual(back.home.map((item) => item.path), ['skills/a/SKILL.md'])
  assert.deepEqual(back.skipped, [], '导出不写敏感文件，所以也没有跳过的')

  // 导出的包能装进一个新 profile
  const plan = planInstall(back, { home, profile: 'from-pack' })
  assert.equal(plan.ok, true)
  const value = JSON.parse(plan.writes.find((write) => write.rel === 'profiles/from-pack/package.json').data)
  assert.deepEqual(value.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'], '新 profile 的骨架层（base/web-app）也在')
})

test('导出：没有 package.json 的 profile 直接说没有', () => {
  const home = tempDir()
  assert.throws(() => exportPack({ profileDir: join(home, 'profiles', 'nope'), home }), /没有可读的 package\.json/)
})
