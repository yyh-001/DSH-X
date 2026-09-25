import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listSkills, setSkillEnabled } from '../skills.js'

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
