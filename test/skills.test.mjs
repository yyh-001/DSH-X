import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSkill, listSkills, readSkill, removeSkill, setSkillEnabled } from '../skills.js'

// 技能开关只动 frontmatter 里那一行，其余字节一个字不碰（用户手写的 YAML 不该被重排）。
// 技能根有两层（~/.dsh/skills 与 ~/.agents/skills），测试里用临时目录充当其中一层。

const GOOD = [
  '---',
  'name: my-skill',
  'description: 干点什么',
  'whenToUse: 需要的时候',
  '---',
  '',
  '# 正文',
  '',
].join('\n')

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  return { dir, roots: [{ key: 'dsh', dir }], done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('详情保留完整原文，不改变开关，且拒绝越界读取', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, 'my-skill'))
    const file = join(box.dir, 'my-skill', 'SKILL.md')
    const text = `${GOOD}<script>alert('local')</script>\n完整的技能正文\n`
    writeFileSync(file, text)
    const detail = readSkill(box.dir, 'my-skill/SKILL.md')
    assert.equal(detail.content, text)
    assert.equal(detail.description, '干点什么')
    assert.equal(detail.disableModelInvocation, false)
    assert.equal(readFileSync(file, 'utf8'), text)
    mkdirSync(join(box.dir, 'my-skill-1.0.1'))
    writeFileSync(join(box.dir, 'my-skill-1.0.1', 'SKILL.md'), text)
    assert.equal(readSkill(box.dir, 'my-skill-1.0.1/SKILL.md').content, text)
    setSkillEnabled(box.dir, 'my-skill-1.0.1/SKILL.md', false)
    assert.equal(readSkill(box.dir, 'my-skill-1.0.1/SKILL.md').disableModelInvocation, true)
    assert.throws(() => readSkill(box.dir, '../outside.md'), /不支持的技能路径/)
  } finally { box.done() }
})

test('列表：目录包与平文件都认，frontmatter 按 dsh 的规则校验', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, 'my-skill'))
    writeFileSync(join(box.dir, 'my-skill', 'SKILL.md'), GOOD)
    writeFileSync(join(box.dir, 'flat.md'), GOOD.replace('my-skill', 'flat-one'))
    // 缺 description：dsh 会丢弃整个技能，这里要如实标出来
    writeFileSync(join(box.dir, 'broken.md'), '---\nname: broken\n---\n\n正文\n')
    // 目录里没有 SKILL.md 的不算技能
    mkdirSync(join(box.dir, 'not-a-skill'))

    const skills = listSkills(box.roots)
    assert.deepEqual(skills.map((item) => item.dirName).sort(), ['broken', 'flat', 'my-skill'])
    const broken = skills.find((item) => item.dirName === 'broken')
    assert.equal(broken.frontmatterOk, false)
    assert.match(broken.frontmatterIssue, /description/)
    const ok = skills.find((item) => item.dirName === 'flat' && item.kind === 'flat')
    assert.equal(ok.frontmatterOk, true)
    assert.equal(ok.kind, 'flat')
  } finally {
    box.done()
  }
})

test('链进来的技能也认（目录软链 / junction），断链只跳过不出错', () => {
  const box = sandbox()
  const real = mkdtempSync(join(tmpdir(), 'dsh-skills-real-'))
  // Windows 上 junction 不需要管理员权限；POSIX 上就是普通目录软链
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    mkdirSync(join(real, 'linked'))
    const realFile = join(real, 'linked', 'SKILL.md')
    writeFileSync(realFile, GOOD.replace('my-skill', 'linked-one'))
    try {
      symlinkSync(join(real, 'linked'), join(box.dir, 'linked'), linkType)
      // 目标不存在的链：不能让它把整张列表带崩（Windows 上读悬空 junction 会报 UNKNOWN -4094）
      symlinkSync(join(real, 'gone'), join(box.dir, 'dangling'), linkType)
    } catch {
      console.log('  这台机器建不了链接，跳过')
      return
    }

    const skills = listSkills(box.roots)
    assert.deepEqual(skills.map((item) => item.dirName), ['linked'], '真链要认出来，断链不该冒出来')
    assert.equal(skills[0].kind, 'dir')
    assert.equal(skills[0].frontmatterOk, true)

    // 开关要写到链那一头的真文件
    setSkillEnabled(box.dir, 'linked/SKILL.md', false)
    assert.match(readFileSync(realFile, 'utf8'), /^disable-model-invocation: true$/m)
  } finally {
    try { box.done() } catch { /* 悬空 junction 在 Windows 上可能删不掉，测试用临时目录，留着无妨 */ }
    try { rmSync(real, { recursive: true, force: true }) } catch { /* 同上 */ }
  }
})

test('停用/启用：只改 disable-model-invocation 一行，正文与其它字段原样', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, 'my-skill'))
    const file = join(box.dir, 'my-skill', 'SKILL.md')
    writeFileSync(file, GOOD)

    const off = setSkillEnabled(box.dir, 'my-skill/SKILL.md', false)
    assert.equal(off.changed, true)
    const disabled = readFileSync(file, 'utf8')
    assert.match(disabled, /^disable-model-invocation: true$/m)
    assert.ok(disabled.includes('description: 干点什么'), '其它字段原样')
    assert.ok(disabled.endsWith('# 正文\n'), '正文原样')

    // 再停一次：幂等（值一样）
    assert.equal(setSkillEnabled(box.dir, 'my-skill/SKILL.md', false).changed, false)

    const on = setSkillEnabled(box.dir, 'my-skill/SKILL.md', true)
    assert.equal(on.changed, true)
    const enabled = readFileSync(file, 'utf8')
    assert.match(enabled, /^disable-model-invocation: false$/m)
  } finally {
    box.done()
  }
})

test('开关按 dsh 的读法回显：true/yes/on/1 都算停用', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, 's1'))
    writeFileSync(join(box.dir, 's1', 'SKILL.md'), GOOD.replace('---\n\n# 正文', 'disable-model-invocation: yes\n---\n\n# 正文'))
    const skill = listSkills(box.roots)[0]
    assert.equal(skill.disableModelInvocation, true)
  } finally {
    box.done()
  }
})

test('CRLF 文件写回去还是 CRLF（不制造混合换行）', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, 'crlf'))
    const file = join(box.dir, 'crlf', 'SKILL.md')
    writeFileSync(file, GOOD.replace(/\n/g, '\r\n'))
    setSkillEnabled(box.dir, 'crlf/SKILL.md', false)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes('disable-model-invocation: true\r\n'), '插入的行也用 CRLF')
    assert.ok(!/[^\r]\n/.test(text.replace(/\r\n/g, '')), '不该混进裸 LF')
  } finally {
    box.done()
  }
})

test('路径白名单：越界、不存在的文件、奇怪的路径都拒绝', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.dir, 'my-skill'))
    writeFileSync(join(box.dir, 'my-skill', 'SKILL.md'), GOOD)
    const cases = [
      '../outside.md',
      'my-skill/../../etc/passwd',
      'nope/SKILL.md',
      'my-skill/other.md',
      '',
      'my-skill/SKILL.md/extra',
    ]
    for (const bad of cases) {
      assert.throws(() => setSkillEnabled(box.dir, bad, false), /不支持|越界|不存在/, `应当拒绝：${bad}`)
    }
  } finally {
    box.done()
  }
})

test('没有 frontmatter 的文件不能开关，但要给出人能看懂的原因', () => {
  const box = sandbox()
  try {
    writeFileSync(join(box.dir, 'plain.md'), '# 就是一篇普通 markdown\n')
    const skill = listSkills(box.roots)[0]
    assert.equal(skill.frontmatterOk, false)
    assert.match(skill.frontmatterIssue, /frontmatter/)
    assert.throws(() => setSkillEnabled(box.dir, 'plain.md', false), /frontmatter/)
  } finally {
    box.done()
  }
})


test('新增技能生成有效 frontmatter，拒绝同名、保留名、越界和缺正文', () => {
  const box = sandbox()
  try {
    const spec = { name: 'new-skill', description: '说明："引用" #标签\n第二行', content: '# 完整正文\n带资源说明' }
    const created = createSkill(box.dir, spec)
    const skill = listSkills(box.roots)[0]
    assert.equal(skill.frontmatterOk, true)
    assert.equal(skill.description, '说明："引用" #标签 第二行')
    assert.match(readSkill(box.dir, created.relPath).content, /# 完整正文/)
    const before = readFileSync(join(box.dir, created.relPath), 'utf8')
    assert.throws(() => createSkill(box.dir, spec), /已存在/)
    writeFileSync(join(box.dir, 'flat-skill.MD'), GOOD)
    assert.throws(() => createSkill(box.dir, { ...spec, name: 'flat-skill' }), /已存在/)
    for (const name of ['../outside', 'UPPER', 'nul', 'con', 'x'.repeat(65)]) assert.throws(() => createSkill(box.dir, { ...spec, name }), /技能名称/)
    assert.throws(() => createSkill(box.dir, { ...spec, name: 'bad', description: '' }), /技能说明/)
    assert.throws(() => createSkill(box.dir, { ...spec, name: 'bad', content: '' }), /技能正文/)
    assert.equal(existsSync(join(box.dir, 'bad')), false)
    assert.equal(readFileSync(join(box.dir, created.relPath), 'utf8'), before)
  } finally { box.done() }
})

test('删除清理整个技能包和单文件，链接技能保留外部原件及资源', () => {
  const box = sandbox()
  const external = mkdtempSync(join(tmpdir(), 'dsh-external-skill-'))
  try {
    createSkill(box.dir, { name: 'regular', description: '说明', content: '正文' })
    writeFileSync(join(box.dir, 'regular', 'resource.txt'), '资源')
    assert.throws(() => removeSkill(box.dir, '../outside/SKILL.md'), /不支持/)
    assert.throws(() => removeSkill(box.dir, './SKILL.md'), /不支持/)
    removeSkill(box.dir, 'regular/SKILL.md')
    assert.equal(existsSync(join(box.dir, 'regular')), false)
    writeFileSync(join(box.dir, 'flat.md'), GOOD)
    removeSkill(box.dir, 'flat.md')
    assert.equal(existsSync(join(box.dir, 'flat.md')), false)
    writeFileSync(join(external, 'SKILL.md'), GOOD)
    writeFileSync(join(external, 'resource.txt'), '外部资源')
    symlinkSync(external, join(box.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(listSkills(box.roots)[0].linked, true)
    assert.equal(removeSkill(box.dir, 'linked/SKILL.md').linked, true)
    assert.equal(existsSync(join(box.dir, 'linked')), false)
    assert.equal(readFileSync(join(external, 'resource.txt'), 'utf8'), '外部资源')
    assert.equal(readFileSync(join(external, 'SKILL.md'), 'utf8'), GOOD)
  } finally { box.done(); rmSync(external, { recursive: true, force: true }) }
})
