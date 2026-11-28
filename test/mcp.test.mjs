import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listMcpServers, parseMcpCommand, removeMcpServer, saveMcpServer, setMcpEnabled } from '../src/mcp.js'
import { looksLikeEntryList } from '../src/plugins.js'

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


test('完整 MCP 命令拆成 argv，保存和编辑保留空格、引号与 Windows 路径', () => {
  const box = sandbox()
  try {
    const argv = ['C:\\Program Files\\nodejs\\node.exe', '-y', 'C:\\MCP Servers\\entry.js', 'say "hello"', '', 'a-n-b']
    const commandLine = argv.map(value => JSON.stringify(value)).join(' ')
    assert.deepEqual(parseMcpCommand(commandLine), { command: argv[0], args: argv.slice(1) })
    assert.deepEqual(parseMcpCommand("npx -y '@scope/my server'"), { command: 'npx', args: ['-y', '@scope/my server'] })
    assert.deepEqual(parseMcpCommand('node "C:\\test\\entry.js"'), { command: 'node', args: ['C:\\test\\entry.js'] })
    assert.throws(() => parseMcpCommand('npx "unfinished'), /引号没有闭合/)
    assert.throws(() => parseMcpCommand(''), /填写启动命令/)
    saveMcpServer(box.patch, { serverName: 'quoted', transport: 'stdio', commandLine })
    const saved = listMcpServers(box.patch).servers[0]
    assert.equal(saved.command, argv[0])
    // 现有 schema 会滤掉空参数；非空的引用、换行和路径必须完整保留。
    assert.deepEqual(saved.args, argv.slice(1).filter(Boolean))
  } finally { box.done() }
})

// ---- 补丁层里的外来 MCP 行（issue #125）：不是本启动器写的也要列出来 ----

const PROFILE_ROW = [
  '- insert:',
  '    - id: panel-mcp-codegraph',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: codegraph',
  '        transport: stdio',
  '        command: npx',
  '        args:',
  '          - -y',
  '          - codegraph-mcp',
  '    - id: other-plugin',
  '      name: some-other-plugin',
  '      config:',
  '        foo: bar',
  '- id: ctx7',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config: {"serverName":"ctx7","transport":"streamable-http","url":"https://example.com/mcp"}',
  '',
].join('\n')

test('读取 profile 里手写的 MCP 行：顶层条目与 insert 成员都列出来，其他插件的行不列', () => {
  const box = sandbox()
  try {
    writeFileSync(box.patch, PROFILE_ROW)
    const { servers } = listMcpServers(box.patch)
    assert.deepEqual(servers.map((server) => server.serverName), ['codegraph', 'ctx7'])
    const [codegraph, ctx7] = servers
    assert.equal(codegraph.source, 'profile')
    assert.equal(codegraph.id, 'panel-mcp-codegraph')
    assert.equal(codegraph.transport, 'stdio')
    assert.equal(codegraph.command, 'npx')
    assert.deepEqual(codegraph.args, ['-y', 'codegraph-mcp'])
    assert.equal(codegraph.editable, true)
    assert.equal(codegraph.inserted, true, 'insert 成员才会真正加入组合树')
    assert.equal(ctx7.transport, 'streamable-http')
    assert.equal(ctx7.url, 'https://example.com/mcp')
    assert.equal(ctx7.inserted, false, '顶层行只覆盖已有 id，页面要标出来')
  } finally { box.done() }
})

test('标记区块里的条目不会被当成外来行重复列出', () => {
  const box = sandbox()
  try {
    writeFileSync(box.patch, '[]\n')
    saveMcpServer(box.patch, stdioSpec)
    const { servers } = listMcpServers(box.patch)
    assert.equal(servers.length, 1)
    assert.equal(servers[0].source, 'dshx')
  } finally { box.done() }
})

test('外来行启停：只动 disabled，文件其他字节保持不变（含 CRLF 与注释）', () => {
  const box = sandbox()
  try {
    const text = '# 用户注释\r\n' + PROFILE_ROW.replace(/\n/g, '\r\n')
    writeFileSync(box.patch, text)
    setMcpEnabled(box.patch, { serverName: 'codegraph', id: 'panel-mcp-codegraph' }, false)
    let next = readFileSync(box.patch, 'utf8')
    assert.ok(next.startsWith('# 用户注释\r\n'), '文件头不能动')
    assert.match(next, /      disabled: true\r\n/)
    assert.ok(next.includes("- id: ctx7\r\n"), '其他条目原样保留')
    let { servers } = listMcpServers(box.patch)
    assert.equal(servers.find((server) => server.serverName === 'codegraph').disabled, true)

    setMcpEnabled(box.patch, { serverName: 'codegraph', id: 'panel-mcp-codegraph' }, true)
    next = readFileSync(box.patch, 'utf8')
    assert.ok(!next.includes('disabled: true'), '启用时整行删掉')
    ;({ servers } = listMcpServers(box.patch))
    assert.equal(servers.find((server) => server.serverName === 'codegraph').disabled, false)
  } finally { box.done() }
})

test('外来行删除：insert 里唯一成员删掉后留 insert: []，不拔掉别的工具的受管块', () => {
  const box = sandbox()
  try {
    writeFileSync(box.patch, PROFILE_ROW)
    removeMcpServer(box.patch, { serverName: 'codegraph', id: 'panel-mcp-codegraph' })
    let text = readFileSync(box.patch, 'utf8')
    assert.ok(!text.includes('codegraph'), 'codegraph 行要删掉')
    assert.ok(text.includes('other-plugin'), '同 insert 里的其他插件行不能动')
    assert.ok(text.includes('id: ctx7'), '顶层 MCP 行不能动')

    removeMcpServer(box.patch, { serverName: 'ctx7', id: 'ctx7' })
    text = readFileSync(box.patch, 'utf8')
    assert.ok(!text.includes('ctx7'))
    assert.ok(text.includes('other-plugin'))

    // 最后一条 MCP 行在只有它一个成员的 insert 里：删成员、把 insert 写成 []
    const single = [
      '# >>> dsh-skill-mcp-panel:mcp:begin',
      '- insert:',
      "    - id: panel-mcp-only",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: only',
      '        transport: stdio',
      '        command: npx',
      '# <<< dsh-skill-mcp-panel:mcp:end',
      '',
    ].join('\n')
    writeFileSync(box.patch, single)
    removeMcpServer(box.patch, { serverName: 'only', id: 'panel-mcp-only' })
    text = readFileSync(box.patch, 'utf8')
    assert.match(text, /- insert: \[\]/, `insert 应该留空数组：${text}`)
    assert.ok(text.includes('# >>> dsh-skill-mcp-panel:mcp:begin'), '受管块标记不能删')
    assert.ok(text.includes('# <<< dsh-skill-mcp-panel:mcp:end'), '受管块标记不能删')
    assert.equal(listMcpServers(box.patch).servers.length, 0)
  } finally { box.done() }
})

test('外来行编辑：只重写那一条，保留 id、停用状态和表单没建模的配置键', () => {
  const box = sandbox()
  try {
    const text = [
      '- id: keep',
      '  name: other-plugin',
      '- id: hand',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  disabled: true',
      '  config:',
      '    serverName: hand',
      '    transport: stdio',
      '    command: npx',
      '    customFlag: keep-me',
      '',
    ].join('\n')
    writeFileSync(box.patch, text)
    saveMcpServer(box.patch, {
      id: 'hand',
      serverName: 'hand',
      transport: 'stdio',
      command: 'node',
      args: ['entry.js'],
      toolCallTimeoutMs: 5000,
    })
    const next = readFileSync(box.patch, 'utf8')
    assert.ok(next.startsWith('- id: keep\n  name: other-plugin\n'), '别的条目字节不动')
    const row = next.slice(next.indexOf('- id: "hand"'))
    assert.match(row, /"command":"node"/)
    assert.match(row, /"toolCallTimeoutMs":5000/)
    assert.match(row, /"customFlag":"keep-me"/, '表单不认识的配置键要带回来')
    assert.match(row, /disabled: true/, '编辑不能把停用状态改成启用')
    const { servers } = listMcpServers(box.patch)
    const hand = servers.find((server) => server.serverName === 'hand')
    assert.equal(hand.disabled, true)
    assert.equal(hand.config.customFlag, 'keep-me')
  } finally { box.done() }
})

test('!!js 这类写法：照常列出、能启停，但表单保存拒绝（不静默丢表达式）', () => {
  const box = sandbox()
  try {
    const text = [
      '- id: js',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: jsonly',
      '    transport: stdio',
      '    command: npx',
      '    env:',
      '      TOKEN: !!js `process.env.TOKEN`',
      '',
    ].join('\n')
    writeFileSync(box.patch, text)
    const server = listMcpServers(box.patch).servers[0]
    assert.equal(server.serverName, 'jsonly')
    assert.equal(server.editable, false)
    assert.match(server.opaque, /js|标签/)
    setMcpEnabled(box.patch, { serverName: 'jsonly', id: 'js' }, false)
    assert.match(readFileSync(box.patch, 'utf8'), /!!js `process\.env\.TOKEN`/, '启停不能碰表达式')
    assert.throws(() => saveMcpServer(box.patch, { id: 'js', serverName: 'jsonly', transport: 'stdio', command: 'node', args: [] }), /没法用表单改写/)
  } finally { box.done() }
})

test('serverName 重复时用 id 精确定位，不会误改另一条', () => {
  const box = sandbox()
  try {
    const text = [
      '- id: first',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: same',
      '    transport: stdio',
      '    command: npx',
      '- id: second',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: same',
      '    transport: streamable-http',
      '    url: https://example.com/mcp',
      '',
    ].join('\n')
    writeFileSync(box.patch, text)
    setMcpEnabled(box.patch, { serverName: 'same', id: 'second' }, false)
    const rows = readFileSync(box.patch, 'utf8').split('\n')
    const firstIndex = rows.findIndex((line) => line.includes('id: first'))
    const secondIndex = rows.findIndex((line) => line.includes('id: second'))
    assert.ok(!rows.slice(firstIndex, secondIndex).some((line) => line.includes('disabled')), '第一条不能被改')
    assert.ok(rows.slice(secondIndex).some((line) => line.includes('disabled: true')), '第二条要停用')
  } finally { box.done() }
})

test('缺结束标记的区块只列一次：不会既报损坏、又被当成外来行', () => {
  const box = sandbox()
  try {
    // 只有 begin 标记：scanBlocks 的范围会一直算到文件尾，不能把后面的外来行也当成区块内容
    writeFileSync(box.patch, [
      '# ==== dshx-mcp:begin memory ====',
      '- insert:',
      '    - {"id":"dshx-mcp-memory","name":"@deepseek-ai/dsh-mcp-client","config":{"serverName":"memory","transport":"stdio","command":"npx"}}',
      '- id: hand',
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      '    serverName: hand',
      '    transport: stdio',
      '    command: node',
      '',
    ].join('\n'))
    const { servers } = listMcpServers(box.patch)
    assert.equal(servers.length, 2, `应该只有损坏区块和 hand 两条：${JSON.stringify(servers.map((server) => [server.serverName, server.source, server.broken]))}`)
    const memory = servers.find((server) => server.serverName === 'memory')
    assert.equal(memory.broken, true)
    assert.equal(memory.source, 'dshx')
    const hand = servers.find((server) => server.serverName === 'hand')
    assert.equal(hand.source, 'profile')
    assert.equal(hand.broken, false)
  } finally { box.done() }
})
