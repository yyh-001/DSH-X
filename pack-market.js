/** 市场索引不含 Star，仓库统计单独读取并缓存，不拖住卡片列表。 */
export function marketRepository(entry) {
  let owner = String(entry?.owner || '')
  let repo = String(entry?.repo || '')
  if (!owner || !repo) {
    try {
      const url = new URL(entry?.downloadUrl || '')
      if (url.hostname !== 'github.com') return null
      ;[owner, repo] = url.pathname.split('/').filter(Boolean)
    } catch { return null }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner || '') || !/^[A-Za-z0-9_.-]+$/.test(repo || '')) return null
  return { owner, repo, url: `https://github.com/${owner}/${repo}` }
}

export function createMarketStatsReader({ fetchRepo, now = Date.now, ttl = 60 * 60 * 1000 }) {
  const cache = new Map()
  const pending = new Map()
  let budgetAt = now(), requests = 0
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
  return async function readStats(entry) {
    const repository = marketRepository(entry)
    if (!repository) return { id: entry.id, stars: null, forks: null, repoUrl: '' }
    const key = `${repository.owner}/${repository.repo}`.toLowerCase()
    const cached = cache.get(key)
    if (cached && now() < cached.until) return { id: entry.id, ...cached.data }
    if (now() - budgetAt >= ttl) { budgetAt = now(); requests = 0 }
    if (!pending.has(key)) {
      // GitHub 匿名额度也用于安装包查询，统计留出余量；缺失显示未知，不能伪装成零。
      if (requests >= 48) return { id: entry.id, stars: null, forks: null, repoUrl: repository.url }
      requests += 1
      pending.set(key, (async () => {
        let data = { stars: null, forks: null, repoUrl: repository.url }
        try {
          const response = await fetchRepo(`https://api.github.com/repos/${repository.owner}/${repository.repo}`, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-x' },
            signal: AbortSignal.timeout(5000),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const raw = await response.json()
          data = { ...data, stars: count(raw.stargazers_count), forks: count(raw.forks_count) }
        } catch { /* 统计不可用不影响浏览与安装。 */ }
        cache.set(key, { data, until: now() + (data.stars === null ? 60_000 : ttl) })
        return data
      })().finally(() => pending.delete(key)))
    }
    return { id: entry.id, ...(await pending.get(key)) }
  }
}
