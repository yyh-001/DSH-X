/**
 * DSH-X Cloudflare Tunnel Dispatcher Worker
 *
 * MIT License
 * Adapted from GHSaiMo/antigravity-mobile (scripts/cloudflare-worker/worker.js)
 * for DSH-X Issue #124 (公网穿透与手机远程控制台).
 *
 * 职责边界：
 * 本 Worker 仅在 DSH-X 首次注册（或本地网关端口变更）时，按稳定 machine_id 幂等创建/更新
 * Cloudflare Tunnel、Ingress 规则与 Proxied CNAME 记录并返回 TUNNEL_TOKEN。
 * 业务流量与 WebSocket 通信直接走「本机 cloudflared ↔ Cloudflare 边缘节点 ↔ 手机」，
 * 绝不经过本 Worker 中转。
 *
 * 必需环境变量（Cloudflare Worker Secrets / Vars）：
 * - CF_ACCOUNT_ID   Cloudflare Account ID
 * - CF_ZONE_ID      承载 BASE_DOMAIN 的 Cloudflare Zone ID
 * - CF_API_TOKEN    最小权限 API Token（Account: Cloudflare Tunnel:Edit + Zone: DNS:Edit）
 * - BASE_DOMAIN     分配子域名的根域名（如 tunnel.example.com）
 *
 * 可选环境变量：
 * - INVITE_CODE      共享邀请码；配置后客户端必须携带一致的 X-Invite-Code 或 invite_code
 * - TARGET_PORT      默认本地网关端口（默认 3781）
 * - LOCK_TARGET_PORT 设为 "true" 时强制使用 TARGET_PORT，忽略客户端上报的动态 target_port
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
const DEFAULT_TARGET_PORT = 3781

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function sha256Bytes(text) {
  const data = new TextEncoder().encode(String(text))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

async function sha256Hex(text) {
  const bytes = await sha256Bytes(text)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 常量时间字符串比对：先各自做 SHA-256 再逐字节异或，
 * 避免直接比较长度或前缀导致邀请码被时序侧信道探测。
 */
async function timingSafeStringEqual(a, b) {
  const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)])
  let diff = 0
  for (let i = 0; i < hashA.length; i += 1) {
    diff |= hashA[i] ^ hashB[i]
  }
  return diff === 0
}

/** 生成 Cloudflare Tunnel 创建接口所需的 32 字节随机 base64 密钥。 */
function randomTunnelSecretBase64() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 解析并校验本地网关端口：支持客户端动态上报，也支持服务端锁定固定端口。 */
function resolveTargetPort(bodyPort, env) {
  const envPort = Number(env.TARGET_PORT)
  const fallback = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535
    ? envPort
    : DEFAULT_TARGET_PORT

  if (String(env.LOCK_TARGET_PORT || '').toLowerCase() === 'true') {
    return fallback
  }

  const parsed = Number(bodyPort)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed
  }
  return fallback
}

async function cfApi(env, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${CF_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.success) {
    const firstErr = payload?.errors?.[0]
    const detail = firstErr ? `${firstErr.code || ''} ${firstErr.message || ''}`.trim() : `HTTP ${response.status}`
    throw new Error(`Cloudflare API 失败（${method} ${path}）：${detail}`)
  }
  return payload.result
}

/** 按 tunnelName 幂等查找或创建由 Cloudflare 托管配置（config_src: cloudflare）的隧道。 */
async function ensureTunnel(env, tunnelName) {
  const query = new URLSearchParams({ name: tunnelName, is_deleted: 'false' })
  const existing = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?${query}`)
  if (Array.isArray(existing) && existing.length > 0 && existing[0]?.id) {
    return existing[0]
  }
  return cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, {
    method: 'POST',
    body: {
      name: tunnelName,
      tunnel_secret: randomTunnelSecretBase64(),
      config_src: 'cloudflare',
    },
  })
}

/** 写入云端 Ingress 规则：将该机器专属子域名转发到本机 127.0.0.1:<targetPort> 远程网关。 */
async function syncTunnelIngress(env, tunnelId, hostname, targetPort) {
  await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    body: {
      config: {
        ingress: [
          {
            hostname,
            service: `http://127.0.0.1:${targetPort}`,
            originRequest: {
              connectTimeout: 15,
            },
          },
          {
            service: 'http_status:404',
          },
        ],
      },
    },
  })
}

/** 幂等创建/更新 Proxied CNAME 记录，使公网 HTTPS 证书由 Cloudflare 边缘自动签发。 */
async function ensureDnsCname(env, hostname, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`
  const query = new URLSearchParams({ type: 'CNAME', name: hostname })
  const existing = await cfApi(env, `/zones/${env.CF_ZONE_ID}/dns_records?${query}`)

  if (Array.isArray(existing) && existing.length > 0) {
    const record = existing[0]
    if (record.content === target && record.proxied === true) return record
    return cfApi(env, `/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, {
      method: 'PUT',
      body: {
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
        ttl: 1,
      },
    })
  }

  return cfApi(env, `/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: 'POST',
    body: {
      type: 'CNAME',
      name: hostname,
      content: target,
      proxied: true,
      ttl: 1,
    },
  })
}

function validateEnv(env) {
  const required = ['CF_ACCOUNT_ID', 'CF_ZONE_ID', 'CF_API_TOKEN', 'BASE_DOMAIN']
  const missing = required.filter((key) => !String(env?.[key] || '').trim())
  if (missing.length) {
    return `Worker 缺少必需环境变量：${missing.join(', ')}`
  }
  return ''
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'dsh-x-tunnel-dispatcher' })
    }

    if (url.pathname !== '/api/tunnel/register') {
      return jsonResponse({ error: 'Not Found' }, 404)
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method Not Allowed' }, 405)
    }

    const envError = validateEnv(env)
    if (envError) {
      return jsonResponse({ error: envError }, 500)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: '请求体必须是合法 JSON' }, 400)
    }

    // 邀请码校验：支持通过请求头 X-Invite-Code 或 JSON 字段 invite_code 传入
    const expectedInvite = String(env.INVITE_CODE || '').trim()
    if (expectedInvite) {
      const providedInvite = String(
        request.headers.get('x-invite-code') || body?.invite_code || '',
      ).trim()
      if (!providedInvite || !(await timingSafeStringEqual(providedInvite, expectedInvite))) {
        return jsonResponse({ error: '邀请码无效' }, 401)
      }
    }

    const machineId = String(body?.machine_id || '').trim()
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(machineId)) {
      return jsonResponse({ error: 'machine_id 格式无效（需为 8~128 位字母数字）' }, 400)
    }

    const baseDomain = String(env.BASE_DOMAIN).trim().replace(/^\.+|\.+$/g, '').toLowerCase()
    const shortId = (await sha256Hex(machineId)).slice(0, 10)
    const subdomain = `dshx-${shortId}`
    const tunnelName = subdomain
    const hostname = `${subdomain}.${baseDomain}`
    const targetPort = resolveTargetPort(body?.target_port, env)

    try {
      const tunnel = await ensureTunnel(env, tunnelName)
      const tunnelId = tunnel.id
      const [token] = await Promise.all([
        cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`),
        syncTunnelIngress(env, tunnelId, hostname, targetPort),
        ensureDnsCname(env, hostname, tunnelId),
      ])

      return jsonResponse({
        tunnel_id: tunnelId,
        token,
        subdomain,
        hostname,
        public_url: `https://${hostname}`,
        target_port: targetPort,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return jsonResponse({ error: message }, 502)
    }
  },
}
