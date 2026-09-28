/**
 * dsh-x-memory 的模型工具：六个，覆盖 ZCode 那套「查重 → 写 → 改 → 删」的动作。
 *
 * 设计上有意和 ZCode 一致的地方：
 * - 查重是提示词里的纪律（「已有覆盖同一事实的文件就改它」），不是工具的强制；
 *   memory_save 撞到同名会返回 action=exists（而不是静默覆盖），让模型自己决定改还是新建；
 * - 删除是真删（ZCode 也是真删文件），误删就从版本控制/备份里找 —— 记忆目录是纯文件，这是它
 *   相对数据库记忆的一个已知代价。
 *
 * 工具只认 slug，路径天然关在记忆根目录内；不接受任何路径参数。
 */
import { MEMORY_TYPES } from './store.js'

const text = (value) => [{ type: 'text', text: value }]

export function createTools({ defineTool, storeFor }) {
  if (typeof defineTool !== 'function') throw new Error('createTools 需要 defineTool')

  /** 每次调用都按「调用者所在工作区」取库；取不到就报清楚。 */
  const withStore = (exec, run) => {
    try {
      const store = storeFor(exec)
      return run(store)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return [
    defineTool({
      name: 'memory_save',
      description:
        'Save one durable memory as a Markdown file (one fact per file) plus a line in the MEMORY.md index. Use it when the user says "remember", states a durable preference or working style (type=feedback: include **Why:** and **How to apply:** lines), when a project fact/decision/constraint is not derivable from the repo (type=project: convert relative dates to absolute), for pointers to external resources (type=reference), or for facts about the user (type=user). First search with memory_search / memory_list: if an existing memory already covers it, use memory_update instead of creating a duplicate. Do not save what the repo already records (code structure, past fixes, git history, AGENTS.md).',
      parameters: {
        title: { type: 'string', required: true, description: 'Short human title (used for the index line and the file name).' },
        type: { type: 'string', required: true, enum: MEMORY_TYPES, description: 'user | feedback | project | reference' },
        description: { type: 'string', required: true, description: 'One-line summary that decides relevance during recall (the index hook).' },
        content: { type: 'string', required: true, description: 'The fact itself. One fact, a few lines; link related memories with [[name]].' },
        name: { type: 'string', description: 'Optional explicit slug for the file name (lowercase letters, digits, dashes). Pass one when the title has no ASCII letters (e.g. a Chinese title) so the file stays readable — otherwise the name is derived from the title.' },
        overwrite: { type: 'boolean', description: 'Replace an existing memory with the same name (default false: report exists instead).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', enum: ['created', 'overwritten', 'exists', 'error'] },
            name: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => text(value.ok ? `memory ${value.action}: ${value.name}` : `memory save failed: ${value.error ?? value.action}`),
      },
      async execute(args, exec) {
        return withStore(exec, (store) => {
          try {
            const result = store.save({
              name: args?.name,
              title: args?.title,
              description: args?.description,
              type: args?.type,
              body: args?.content,
              overwrite: args?.overwrite === true,
            })
            if (result.action === 'exists') {
              return { ok: false, action: 'exists', name: result.name, error: `同名记忆已存在（${result.name}.md）：要更新用 memory_update，确实要替换传 overwrite=true` }
            }
            return { ok: true, action: result.action, name: result.name }
          } catch (error) {
            return { ok: false, action: 'error', error: error instanceof Error ? error.message : String(error) }
          }
        })
      },
    }),

    defineTool({
      name: 'memory_search',
      description:
        'Search memories of this workspace by keyword. Every whitespace-separated token must appear somewhere (title, description, body); results are ranked and carry a short snippet. Use it before saving (to avoid duplicates) and whenever past context may be relevant.',
      parameters: {
        query: { type: 'string', required: true, description: 'Keywords, e.g. "deploy 端口" or "user preference tabs".' },
        limit: { type: 'integer', description: 'Max results (default 8).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            count: { type: 'integer' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  type: { type: 'string', required: true },
                  description: { type: 'string' },
                  snippet: { type: 'string' },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return text(`memory search failed: ${value.error}`)
          if (!value.count) return text('no matching memories')
          return text(
            value.results
              .map((hit) => `- [${hit.type}] ${hit.title} (${hit.name}.md)${hit.description ? ` — ${hit.description}` : ''}${hit.snippet ? `\n    ${hit.snippet}` : ''}`)
              .join('\n'),
          )
        },
      },
      async execute(args, exec) {
        return withStore(exec, (store) => {
          try {
            const results = store.search(args?.query, { limit: Number.isFinite(args?.limit) ? args.limit : 8 })
            return {
              ok: true,
              count: results.length,
              results: results.map(({ name, title, type, description, snippet }) => ({ name, title, type, description: description ?? '', snippet })),
            }
          } catch (error) {
            return { ok: false, count: 0, results: [], error: error instanceof Error ? error.message : String(error) }
          }
        })
      },
    }),

    defineTool({
      name: 'memory_list',
      description: 'List the memories of this workspace (optionally only one type). Cheaper than reading files when you need to know what is already known.',
      parameters: {
        type: { type: 'string', enum: MEMORY_TYPES, description: 'Optional type filter.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            count: { type: 'integer' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  type: { type: 'string', required: true },
                  description: { type: 'string' },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.ok) return text(`memory list failed: ${value.error}`)
          if (!value.count) return text('no memories yet')
          return text(value.entries.map((entry) => `- [${entry.type}] ${entry.title} (${entry.name}.md)${entry.description ? ` — ${entry.description}` : ''}`).join('\n'))
        },
      },
      async execute(args, exec) {
        return withStore(exec, (store) => {
          try {
            const entries = store.list({ type: args?.type })
            return {
              ok: true,
              count: entries.length,
              entries: entries.map(({ name, title, type, description }) => ({ name, title, type, description: description ?? '' })),
            }
          } catch (error) {
            return { ok: false, count: 0, entries: [], error: error instanceof Error ? error.message : String(error) }
          }
        })
      },
    }),

    defineTool({
      name: 'memory_read',
      description: 'Read one memory in full by its name (slug). Use after memory_search / memory_list picked the candidates.',
      parameters: {
        name: { type: 'string', required: true, description: 'Memory slug, e.g. "dsh-plugin-install-recipe".' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            name: { type: 'string' },
            title: { type: 'string' },
            type: { type: 'string' },
            description: { type: 'string' },
            content: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => (value.ok ? text(value.content ?? '') : text(`memory read failed: ${value.error}`)),
      },
      async execute(args, exec) {
        return withStore(exec, (store) => {
          try {
            const entry = store.read(String(args?.name ?? ''))
            if (!entry) return { ok: false, error: `没有这条记忆：${args?.name}` }
            return { ok: true, name: entry.name, title: entry.title, type: entry.type, description: entry.description ?? '', content: entry.body }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        })
      },
    }),

    defineTool({
      name: 'memory_update',
      description:
        'Update fields of an existing memory (only the ones you pass change). Use it whenever a memory already covers the fact — updating beats creating near-duplicates. Keep the same name unless the topic really changed.',
      parameters: {
        name: { type: 'string', required: true, description: 'Slug of the memory to update.' },
        title: { type: 'string', description: 'New human title.' },
        type: { type: 'string', enum: MEMORY_TYPES, description: 'New type.' },
        description: { type: 'string', description: 'New one-line summary.' },
        content: { type: 'string', description: 'New body (replaces the old body).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            name: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => text(value.ok ? `memory updated: ${value.name}` : `memory update failed: ${value.error}`),
      },
      async execute(args, exec) {
        return withStore(exec, (store) => {
          try {
            const updated = store.update(String(args?.name ?? ''), {
              title: args?.title,
              type: args?.type,
              description: args?.description,
              body: args?.content,
            })
            if (!updated) return { ok: false, error: `没有这条记忆：${args?.name}` }
            return { ok: true, name: updated.name }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        })
      },
    }),

    defineTool({
      name: 'memory_delete',
      description: 'Delete a memory that turned out to be wrong or obsolete. Prefer fixing it with memory_update; delete when the fact is simply gone.',
      parameters: {
        name: { type: 'string', required: true, description: 'Slug of the memory to delete.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            deleted: { type: 'boolean' },
            name: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => text(value.ok ? `memory deleted: ${value.name}` : `memory delete failed: ${value.error}`),
      },
      async execute(args, exec) {
        return withStore(exec, (store) => {
          try {
            const name = String(args?.name ?? '')
            const deleted = store.remove(name)
            return deleted ? { ok: true, deleted: true, name } : { ok: false, deleted: false, name, error: `没有这条记忆：${name}` }
          } catch (error) {
            return { ok: false, deleted: false, error: error instanceof Error ? error.message : String(error) }
          }
        })
      },
    }),
  ]
}
