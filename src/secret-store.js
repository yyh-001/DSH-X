/**
 * 连接凭据的本地加密。
 *
 * Windows 走 DPAPI（CurrentUser）：密文只能被当前 Windows 用户解开，进程换用户/换机器都解不开。
 * 其他平台用一个 0600 的本地密钥文件 + AES-256-GCM（Windows 上如果 DPAPI 不可用也走这条兜底）。
 *
 * 信封格式固定为 `v1:<base64>`：settings.json 里只有这一串，明文永远不落盘、不进日志。
 */
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { IS_WINDOWS } from './platform.js'

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

function envelope(buffer) {
  return `${VERSION}:${buffer.toString('base64')}`
}

function unpack(text) {
  const raw = String(text ?? '')
  if (!raw.startsWith(`${VERSION}:`)) throw new Error('凭据格式无法识别')
  const bytes = Buffer.from(raw.slice(VERSION.length + 1), 'base64')
  if (!bytes.length) throw new Error('凭据内容为空')
  return bytes
}

// ---- Windows DPAPI ----

const DPAPI_PROTECT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$plain = [Console]::In.ReadToEnd()',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
  '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join('\n')

const DPAPI_REVEAL = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$text = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($text)',
  '$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
].join('\n')

function runPowerShell(script, input) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(String(result.stderr || 'DPAPI 调用失败').trim())
  return String(result.stdout || '')
}

function dpapiProtect(plain) {
  const text = runPowerShell(DPAPI_PROTECT, plain)
  if (!text) throw new Error('DPAPI 没有返回密文')
  return envelope(Buffer.from(text, 'base64'))
}

function dpapiReveal(text) {
  return runPowerShell(DPAPI_REVEAL, text)
}

// ---- 本地密钥文件 + AES-256-GCM ----

function ensureKeyFile(keyFile) {
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile)
    if (key.length === KEY_BYTES) return key
    // 长度不对的密钥文件不能直接用：换一把新钥匙会让旧密文全部解不开，先明确报错。
    throw new Error('凭据密钥文件损坏，请删除后重新输入连接密码')
  }
  mkdirSync(dirname(keyFile), { recursive: true })
  const key = randomBytes(KEY_BYTES)
  writeFileSync(keyFile, key, { mode: 0o600 })
  try { chmodSync(keyFile, 0o600) } catch { /* Windows 上 mode 不生效，靠用户目录 ACL */ }
  return key
}

function aesProtect(keyFile, plain) {
  const key = ensureKeyFile(keyFile)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return envelope(Buffer.concat([iv, cipher.getAuthTag(), encrypted]))
}

function aesReveal(keyFile, text) {
  const key = ensureKeyFile(keyFile)
  const bytes = unpack(text)
  if (bytes.length <= IV_BYTES + TAG_BYTES) throw new Error('凭据内容不完整')
  const iv = bytes.subarray(0, IV_BYTES)
  const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const encrypted = bytes.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function createSecretStore({ keyFile = '', forceFileKey = false } = {}) {
  const useDpapi = IS_WINDOWS && !forceFileKey
  const protect = (plain) => {
    const text = String(plain ?? '')
    if (!text) return ''
    if (useDpapi) return dpapiProtect(text)
    if (!keyFile) throw new Error('缺少凭据密钥文件路径')
    return aesProtect(keyFile, text)
  }
  const reveal = (value) => {
    const text = String(value ?? '')
    if (!text) return ''
    if (useDpapi) {
      try { return dpapiReveal(text.slice(VERSION.length + 1)) } catch (error) {
        // DPAPI 解不开（换了 Windows 用户/机器）时，别把密文透给上层。
        throw new Error(`连接凭据无法解密，请重新输入密码（${error.message}）`)
      }
    }
    if (!keyFile) throw new Error('缺少凭据密钥文件路径')
    try { return aesReveal(keyFile, text) } catch (error) {
      throw new Error(`连接凭据无法解密，请重新输入密码（${error.message}）`)
    }
  }
  return { protect, reveal, backend: useDpapi ? 'dpapi' : 'aes-gcm' }
}

/** DPAPI 信封是 base64 的 ProtectedData 结果，不是 AES 布局；测试用这个判断格式即可。 */
export function isSecretEnvelope(value) {
  return /^v1:[A-Za-z0-9+/=]{8,8192}$/.test(String(value ?? ''))
}
