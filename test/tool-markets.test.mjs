import assert from 'node:assert/strict'
import test from 'node:test'
import { writeZip } from '../src/zip.js'
import { prepareSkillImport } from '../src/skills.js'
import {
  CURATED_MCP_SERVERS,
  createMcpMarketClient,
  createSkillMarketClient,
  normalizeRegistryMcpServer,
  sanitizeMcpServerName,
} from '../src/tool-markets.js'

test('sanitizeMcpServerName 与 normalizeRegistryMcpServer：正确提取包名、参数、远程传输和必填密钥标识', () => {
  assert.equal(sanitizeMcpServerName('io.github.modelcontextprotocol/server-github'), 'github')
  assert.equal(sanitizeMcpServerName('@scope/mcp-server-Brave.Search!!'), 'brave-search')
  assert.equal(sanitizeMcpServerName('   '), 'mcp-server')
  assert.ok(sanitizeMcpServerName('a/'.repeat(30) + 'very-long-name-that-exceeds-32-characters').length <= 32)

  // npm 包且含 required secret env -> needsConfig = true
  const npmWithSecret = normalizeRegistryMcpServer({
    server: {
      name: 'io.github.example/mcp-server-demo',
      title: 'Demo Server',
      description: 'Demo MCP',
      version: '1.2.3',
      websiteUrl: 'https://example.com/demo',
      icons: [{ src: 'javascript:alert(1)' }, { src: 'https://example.com/icon.png' }],
      packages: [{
        registryType: 'npm',
        identifier: '@example/demo-mcp',
        packageArguments: [{ type: 'named', name: '--mode', default: 'stdio' }],
        environmentVariables: [{ name: 'DEMO_TOKEN', isRequired: true, isSecret: true, description: 'API token' }],
      }],
    },
  })
  assert.equal(npmWithSecret.id, 'io.github.example/mcp-server-demo')
  assert.equal(npmWithSecret.name, 'demo')
  assert.equal(npmWithSecret.icon, 'https://example.com/icon.png', '拒绝 javascript: 图标并挑首个合法地址')
  assert.equal(npmWithSecret.needsConfig, true)
  assert.deepEqual(npmWithSecret.installConfig, {
    name: 'demo',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@example/demo-mcp', '--mode', 'stdio'],
    env: { DEMO_TOKEN: '' },
  })

  // pypi 无必填参数/密钥 -> needsConfig = false
  const pypiFree = normalizeRegistryMcpServer({
    name: 'org.test/fetch',
    description: 'Fetch tool',
    packages: [{ registryType: 'pypi', identifier: 'mcp-server-fetch' }],
  })
  assert.equal(pypiFree.needsConfig, false)
  assert.deepEqual(pypiFree.installConfig, {
    name: 'fetch',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: {},
  })

  // remote sse / http 一律映射到 streamable-http（与 src/mcp.js TRANSPORTS 对齐）
  const remoteHttp = normalizeRegistryMcpServer({
    server: {
      name: 'ai.exa/exa',
      description: 'Remote Exa',
      remotes: [{
        type: 'sse',
        url: 'https://mcp.exa.ai/mcp',
        headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
      }],
    },
  })
  assert.equal(remoteHttp.transport, 'streamable-http')
  assert.equal(remoteHttp.needsConfig, true)
  assert.deepEqual(remoteHttp.installConfig, {
    name: 'exa',
    transport: 'streamable-http',
    url: 'https://mcp.exa.ai/mcp',
    headers: { Authorization: '' },
  })

  // Registry 缺省 icons 时从 repository.url 提取 GitHub 头像
  const registryAvatarFallback = normalizeRegistryMcpServer({
    server: {
      name: 'io.test/fallback-avatar',
      repository: { url: 'https://github.com/upstash/context7' },
      packages: [{ registryType: 'npm', identifier: '@upstash/context7-mcp' }],
    },
  })
  assert.equal(registryAvatarFallback.icon, 'https://avatars.githubusercontent.com/upstash?s=96')
})

test('createMcpMarketClient：精选本地过滤与 Registry 缓存、去重、分页及异常降级', async () => {
  let fetches = 0
  const calls = []
  const client = createMcpMarketClient({
    fetch: async (url) => {
      fetches += 1
      calls.push(url)
      if (url.includes('search=fail')) return new Response('', { status: 503 })
      return Response.json({
        servers: [
          { server: { name: 'io.test/one', description: 'First', packages: [{ registryType: 'npm', identifier: 'pkg-one' }] } },
          { server: { name: 'io.test/one', description: 'Duplicate', packages: [{ registryType: 'npm', identifier: 'pkg-dup' }] } },
          { server: { name: 'io.test/two', description: 'Second', packages: [{ registryType: 'oci', identifier: 'ghcr.io/test/two:latest' }] } },
        ],
        metadata: { nextCursor: 'cursor-2' },
      })
    },
  })

  const curatedZh = await client.query({ mode: 'curated', lang: 'zh', q: 'context7' })
  assert.equal(fetches, 0, '精选不发起网络请求')
  assert.equal(curatedZh.items.length, 1)
  assert.equal(curatedZh.items[0].name, 'context7')
  assert.equal(curatedZh.items[0].icon, 'https://avatars.githubusercontent.com/upstash?s=96', '精选 MCP 取主页 GitHub 作者头像')
  assert.equal(curatedZh.items[0].needsConfig, false)
  assert.ok(CURATED_MCP_SERVERS.length >= 8)

  const reg1 = await client.query({ mode: 'registry', q: 'one', limit: 20 })
  assert.equal(fetches, 1)
  assert.ok(calls[0].includes('version=latest') && calls[0].includes('search=one'))
  assert.equal(reg1.items.length, 2, '同一 server.name 自动去重')
  assert.equal(reg1.items[1].installConfig.command, 'docker')
  assert.equal(reg1.nextCursor, 'cursor-2')

  const regCached = await client.query({ mode: 'registry', q: 'one', limit: 20 })
  assert.equal(fetches, 1, '同条件命中缓存')
  assert.equal(regCached.items.length, 2)

  const regFail = await client.query({ mode: 'registry', q: 'fail', refresh: true })
  assert.equal(regFail.items.length, 0)
  assert.match(regFail.error, /HTTP 503/)
})

test('createSkillMarketClient：skills.sh 排行榜/搜索与 OpenAI .curated 元数据补充', async () => {
  const urls = []
  const client = createSkillMarketClient({
    fetch: async (url) => {
      urls.push(url)
      if (url.includes('/api/skills/all-time/0')) {
        return Response.json({
          skills: [
            { source: 'vercel-labs/skills', skillId: 'find-skills', name: 'find-skills', installs: 12000, isOfficial: true },
            { source: 'acme/tools', skillId: 'alpha-helper', name: 'alpha-helper', installs: 42 },
          ],
          total: 100,
          hasMore: true,
          page: 0,
        })
      }
      if (url.includes('/api/search?q=pdf')) {
        return Response.json({
          skills: [{ source: 'anthropics/skills', skillId: 'pdf', name: 'pdf', installs: 5500 }],
          count: 1,
        })
      }
      if (url.includes('/repos/openai/skills/contents/skills/.curated')) {
        return Response.json([
          { name: 'doc', type: 'dir', html_url: 'https://github.com/openai/skills/tree/main/skills/.curated/doc' },
          { name: '.hidden', type: 'dir' },
          { name: 'README.md', type: 'file' },
        ])
      }
      if (url.includes('/openai/skills/main/skills/.curated/doc/SKILL.md')) {
        return new Response('---\nname: doc\ndescription: "Read and edit Word docs"\n---\nBody\n')
      }
      return new Response('', { status: 404 })
    },
  })

  // 空关键词 & 单字符输入都走排行榜，不触发 /api/search 的最小长度报错
  const top = await client.query({ mode: 'market', page: 0 })
  assert.equal(top.items.length, 2)
  assert.equal(top.items[0].icon, 'https://avatars.githubusercontent.com/vercel-labs?s=96', '技能市场卡片携带仓库所属 GitHub 头像')
  assert.equal(top.hasMore, true)
  const oneChar = await client.query({ mode: 'market', q: 'm', page: 0 })
  assert.equal(oneChar.items.length, 1)
  assert.equal(oneChar.items[0].skillId, 'alpha-helper')
  assert.ok(!urls.some((u) => u.includes('/api/search?q=m')))

  const searched = await client.query({ mode: 'market', q: 'pdf' })
  assert.equal(searched.items.length, 1)
  assert.equal(searched.items[0].source, 'anthropics/skills')

  const openai = await client.query({ mode: 'openai' })
  assert.equal(openai.items.length, 1)
  assert.equal(openai.items[0].skillId, 'doc')
  assert.equal(openai.items[0].icon, 'https://avatars.githubusercontent.com/openai?s=96', 'OpenAI 精选携带 openai 组织头像')
  assert.equal(openai.items[0].description, 'Read and edit Word docs')
  assert.equal(openai.items[0].isOfficial, true)
})

test('prepareSkillImport 支持按 skillId 从多技能仓库 ZIP 精确提取单个技能', async () => {
  const mkSkill = (name) => Buffer.from(`---\nname: ${name}\ndescription: Skill ${name}\n---\n# ${name}\n`)
  const zip = writeZip([
    { name: 'openai-skills-main/skills/.experimental/doc/SKILL.md', data: mkSkill('doc-exp') },
    { name: 'openai-skills-main/skills/.curated/doc/SKILL.md', data: mkSkill('doc') },
    { name: 'openai-skills-main/skills/.curated/doc/scripts/helper.py', data: Buffer.from('print(1)\n') },
    { name: 'openai-skills-main/skills/.curated/other/SKILL.md', data: mkSkill('other-name') },
    { name: 'openai-skills-main/skills/custom-dir/SKILL.md', data: mkSkill('frontmatter-alias') },
  ])
  const fetcher = async (url) => (
    url.includes('api.github.com')
      ? Response.json({ default_branch: 'main' })
      : new Response(zip)
  )

  const matchedCurated = await prepareSkillImport({ source: 'openai/skills', skillId: 'doc' }, fetcher)
  assert.equal(matchedCurated.length, 1, '优先匹配 /.curated/ 下的同名目录并跳过其它技能')
  assert.equal(matchedCurated[0].name, 'doc')
  assert.equal(matchedCurated[0].fileCount, 2)

  const matchedFrontmatter = await prepareSkillImport({ source: 'openai/skills', skillId: 'frontmatter-alias' }, fetcher)
  assert.equal(matchedFrontmatter.length, 1)
  assert.equal(matchedFrontmatter[0].name, 'frontmatter-alias')

  await assert.rejects(
    prepareSkillImport({ source: 'openai/skills', skillId: 'missing-skill' }, fetcher),
    /未在仓库中找到技能/
  )
})
