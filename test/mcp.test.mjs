import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listMcpServers, removeMcpServer, saveMcpServer, setMcpEnabled } from '../mcp.js'
import { looksLikeEntryList } from '../plugins.js'

// MCP 条目是写进 profile 补丁层 cordis.patch.yml 的：只动自己那对标记之间的字节，
// 别人的条目（包括 !!js 表达式）永远不碰。这几条钉的就是这个边界。

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
  const patch = join(dir, 'cordis.patch.yml')
  return { dir, patch, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const stdioSpec = { serverName: 'memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }

test('保存 stdio 服务器：写进标记区块，条目是单行 JSON', () => {
  const box = sandbox()
  try {
    writeFileSync(box.patch, '[]\n')
    const result = saveMcpServer(box.patch, stdioSpec)
    assert.equal(result.ok, true)
    const text = readFileSync(box.patch, 'utf8')
    assert.match(text, /# ==== dshx-mcp:begin memory ====/)
    assert.match(text, /# ==== dshx-mcp:end ====/)
    assert.match(text, /dsh-mcp-client/)
    assert.match(text, /"serverName":"memory"/)
    const { servers } = listMcpServers(box.patch)
    assert.equal(servers.length, 1)
    assert.equal(servers[0].serverName, 'memory')
    assert.equal(servers[0].transport, 'stdio')
    assert.equal(servers[0].disabled, false)
  } finally {
    box.done()
  }
})

test('标记区块之外的字节一个字都不动（别人的 !!js 条目照样在）', () => {
  const box = sandbox()
  try {
    const outside = '[]\n# 用户自己的东西\n- id: 别动我\n  config: !!js process.env.X\n'
    writeFileSync(box.patch, outside)
    saveMcpServer(box.patch, stdioSpec)
    const text = readFileSync(box.patch, 'utf8')
    assert.ok(text.includes(outside.trim()), '区块外必须原样保留')
  } finally {
    box.done()
  }
})

test('HTTP 传输：要 http(s) 地址，命令字段会被忽略并给出提示', () => {
  const box = sandbox()
  try {
    writeFileSync(box.patch, '[]\n')
    const result = saveMcpServer(box.patch, {
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:8000/mcp',
      command: 'npx',
    })
    assert.equal(result.ok, true)
    assert.ok(result.warnings.some((item) => item.includes('命令')), `要说清楚命令被忽略了：${result.warnings}`)
    const { servers } = listMcpServers(box.patch)
    assert.equal(servers[0].transport, 'streamable-http')
  } finally {
    box.done()
  }
})

test('校验：名字/传输/必填项不对就报错，不写文件', () => {
  const box = sandbox()
  try {
    writeFileSync(box.patch, '[]\n')
    const before = readFileSync(box.patch, 'utf8')
    const cases = [
      [{ ...stdioSpec, serverName: '带空格 的名字' }, /名称/],
      [{ serverName: 'x', transport: 'sse', url: 'http://a' }, /stdio 和 streamable-http/],
      [{ serverName: 'x', transport: 'stdio' }, /启动命令/],
      [{ serverName: 'x', transport: 'streamable-http', url: 'ftp://a' }, /http\(s\)/],
      [{ ...stdioSpec, toolCallTimeoutMs: -1 }, /正整数/],
    ]
    for (const [spec, re] of cases) {
      assert.throws(() => saveMcpServer(box.patch, spec), re, JSON.stringify(spec))
    }
    assert.equal(readFileSync(box.patch, 'utf8'), before, '失败不该改文件')
  } finally {
    box.done()
  }
})

test('停用 / 启用 / 删除：停用后仍在列表里但 enabled=false，删除后回到 [] 占位', () => {
  const box = sandbox()
  try {
    writeFileSync(box.patch, '[]\n')
    saveMcpServer(box.patch, stdioSpec)

    setMcpEnabled(box.patch, 'memory', false)
    let { servers } = listMcpServers(box.patch)
    assert.equal(servers.length, 1, '停用不是删除')
    assert.equal(servers[0].disabled, true)

    setMcpEnabled(box.patch, 'memory', true)
    ;({ servers } = listMcpServers(box.patch))
    assert.equal(servers[0].disabled, false)

    removeMcpServer(box.patch, 'memory')
    ;({ servers } = listMcpServers(box.patch))
    assert.equal(servers.length, 0)
    const text = readFileSync(box.patch, 'utf8')
    assert.equal(text.replace(/^[ \t]*#.*$/gmu, '').trim(), '[]', '补丁层空了要留回 [] 占位')
  } finally {
    box.done()
  }
})

test('损坏的区块：列表如实报 broken，再保存一次会被修好', () => {
  const box = sandbox()
  try {
    // 真实的坏法：占位符已经被注释掉（我们自己的写入就是这么留的），区块里那行坏掉了
    writeFileSync(box.patch, '# []\n# ==== dshx-mcp:begin memory ====\n  - {这不是合法条目}\n# ==== dshx-mcp:end ====\n')
    let { servers } = listMcpServers(box.patch)
    assert.equal(servers.length, 1)
    assert.equal(servers[0].broken, true)

    const result = saveMcpServer(box.patch, stdioSpec)
    assert.equal(result.repaired, true, '保存时应把损坏区块整段替换掉')
    ;({ servers } = listMcpServers(box.patch))
    assert.equal(servers[0].broken, false)
  } finally {
    box.done()
  }
})

test('补丁层不是条目数组时不写（宁可拒绝也不写坏）', () => {
  const box = sandbox()
  try {
    const bad = '这是一段谁也不认识的文本\n'
    writeFileSync(box.patch, bad)
    assert.equal(looksLikeEntryList(bad), false)
    assert.throws(() => saveMcpServer(box.patch, stdioSpec), /不再是合法的条目数组/)
    assert.equal(readFileSync(box.patch, 'utf8'), bad)
  } finally {
    box.done()
  }
})

test('文件不存在时也能创建（新 profile 没写过补丁层）', () => {
  const box = sandbox()
  try {
    const missing = join(box.dir, 'nope', 'cordis.patch.yml')
    saveMcpServer(missing, stdioSpec)
    assert.equal(existsSync(missing), true)
    assert.equal(listMcpServers(missing).servers.length, 1)
  } finally {
    box.done()
  }
})
