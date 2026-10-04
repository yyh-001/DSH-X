import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installSkillPackages, parseSkillGithub, prepareSkillImport, previewSkillFiles } from '../skills.js'
import { writeZip } from '../zip.js'
import { safeLaunchIcon, safeLaunchPresets } from '../settings.js'
const text = (name) => `---\nname: ${name}\ndescription: A skill with resources\n---\n# Instructions\n`
const files = [
  { path: 'repo/skills/demo/SKILL.md', data: Buffer.from(text('demo')) },
  { path: 'repo/skills/demo/scripts/run.py', data: Buffer.from('#!/usr/bin/env python3\nprint("hello")\n') },
  { path: 'repo/skills/demo/assets/data.bin', data: Buffer.from([0, 128, 255]) },
  { path: 'repo/skills/second/SKILL.md', data: Buffer.from(text('second')) },
]
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-install-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('完整技能预览和选择安装：字节、资源、同名与批量验证', (t) => {
  const root = sandbox(t), packages = previewSkillFiles(files)
  assert.equal(packages.length, 2); assert.equal(packages[0].fileCount, 3)
  installSkillPackages(root, packages, [packages[0].id])
  assert.equal(readFileSync(join(root, 'demo', 'SKILL.md'), 'utf8'), text('demo'))
  assert.deepEqual(readFileSync(join(root, 'demo', 'assets', 'data.bin')), Buffer.from([0,128,255]))
  assert.equal(existsSync(join(root, 'second')), false)
  assert.throws(() => installSkillPackages(root, packages, [packages[1].id, packages[0].id]), /已存在/)
  assert.equal(existsSync(join(root, 'second')), false)
  assert.throws(() => installSkillPackages(root, packages, [packages[1].id, packages[1].id]), /重复/)
})
test('拒绝越界、平台危险路径、重复文件和无效技能', () => {
  for (const path of ['../SKILL.md', '/SKILL.md', 'a/../../SKILL.md', 'C:/a/SKILL.md', 'a/con.txt', 'a/b./SKILL.md', 'a\\b/SKILL.md']) {
    assert.throws(() => previewSkillFiles([{ path, data: Buffer.from(text('demo')) }]), /路径无效/)
  }
  assert.throws(() => previewSkillFiles([...files, { ...files[0], path: files[0].path.toUpperCase() }]), /重名/)
  assert.throws(() => previewSkillFiles([{path:'a/readme.md',data:Buffer.from('hello')}]), /没有找到/)
  assert.throws(() => previewSkillFiles([{path:'a/SKILL.md',data:Buffer.alloc(2*1024*1024+1)}]), /过大/)
  const bad = previewSkillFiles([{path:'bad/SKILL.md',data:Buffer.from(text('../outside'))}])
  assert.ok(bad[0].issue)
})
test('写入失败会撤回整批新建目录，不损坏原有技能', (t) => {
  const root=sandbox(t)
  mkdirSync(join(root,'existing'));writeFileSync(join(root,'existing','keep.txt'),'keep')
  const packages=previewSkillFiles([...files,{path:'repo/skills/second/collision',data:Buffer.from('file')},{path:'repo/skills/second/collision/child',data:Buffer.from('child')}])
  assert.throws(() => installSkillPackages(root,packages,packages.map(p=>p.id)))
  assert.equal(existsSync(join(root,'demo')),false);assert.equal(existsSync(join(root,'second')),false)
  assert.equal(readFileSync(join(root,'existing','keep.txt'),'utf8'),'keep')
})
test('ZIP 和 GitHub 目录导入，默认分支与错误响应', async (t) => {
  const zip=writeZip(files.map(({path,data})=>({name:path,data})))
  const local=await prepareSkillImport({zip:zip.toString('base64')})
  assert.equal(local.length,2);assert.deepEqual(local[0].files[2].data,Buffer.from([0,128,255]))
  const calls=[]
  const fetcher=async url=>{calls.push(url);return url.includes('api.github.com')?Response.json({default_branch:'main'}):new Response(zip)}
  const selected=await prepareSkillImport({source:'https://github.com/example/repo/tree/main/skills/demo'},fetcher)
  assert.equal(selected.length,1);assert.equal(selected[0].name,'demo');assert.equal(calls.length,1)
  calls.length=0;assert.equal((await prepareSkillImport({source:'example/repo'},fetcher)).length,2)
  assert.ok(calls[0].includes('api.github.com'));assert.ok(calls[1].endsWith('/zip/main'))
  await assert.rejects(prepareSkillImport({source:'example/repo'},async()=>new Response('',{status:404})),/404/)
  const traversal=writeZip([{name:'repo/../SKILL.md',data:text('demo')}])
  await assert.rejects(prepareSkillImport({zip:traversal.toString('base64')}),/路径无效/)
  const root=sandbox(t);installSkillPackages(root,local,[local[0].id]);assert.equal(readFileSync(join(root,'demo','scripts','run.py'),'utf8'),files[1].data.toString())
})
test('GitHub 仅接受仓库和目录链接，支持指定含斜杠的分支', () => {
  assert.deepEqual(parseSkillGithub('openai/skills'),{owner:'openai',repo:'skills',ref:'',path:''})
  assert.equal(parseSkillGithub('https://github.com/openai/skills/tree/main/skills/demo','feature/skills').ref,'feature/skills')
  for(const source of ['https://example.com/a/b','http://github.com/a/b','https://github.com/a/b/blob/main/SKILL.md','https://user@github.com/a/b','https://github.com/a/b/tree/main/skills/%2e%2e/demo']) assert.throws(()=>parseSkillGithub(source))
})
test('启动图标可保存，旧配置兼容，拒绝 SVG、外链和伪装位图', () => {
  assert.equal(safeLaunchIcon('rocket'),'rocket');assert.equal(safeLaunchIcon(undefined),'terminal')
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  assert.equal(safeLaunchIcon(png),png)
  for(const icon of ['https://example.com/icon.png','data:image/svg+xml;base64,AAAA','data:image/png;base64,AAAA','bogus']) assert.throws(()=>safeLaunchIcon(icon))
  const entry={id:'0123456789abcdef',name:'Demo',version:'0.2.1-alpha.1',profile:'web',port:0}
  assert.equal(safeLaunchPresets([{...entry,icon:'globe'}]).at(-1).icon,'globe')
  assert.equal(safeLaunchPresets([{...entry,icon:png}]).at(-1).icon,png)
  assert.deepEqual(safeLaunchPresets([{...entry,icon:'bogus'}]).at(-1),entry)
})
