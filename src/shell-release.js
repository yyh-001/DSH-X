import { cmpVer, parseVer } from './registry.js'

/**
 * 外壳不能自更新的安装形态（macOS 临时签名、deb）用的「发布页有更新的安装包」判断。
 *
 * 单独一个纯函数文件：server.js 一 import 就起一堆模块级状态，单测没法只验这段挑版本的规则。
 */

/** 本平台的安装包长什么样：mac 认 dmg（按 CPU 架构），deb 认 .deb（新命名 linux-x64，旧命名 amd64）。 */
export function manualShellAssetMatcher(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return (name) => name.endsWith('.dmg') && (name.includes(arch) || !/(arm64|x64|aarch64|universal)/.test(name))
  if (platform === 'linux') {
    const names = arch === 'x64' ? ['x64', 'amd64'] : [arch]
    return (name) => name.endsWith('.deb') && names.some((item) => name.includes(item))
  }
  return null
}

/**
 * 安装包名里带的是外壳版本（DSH-X-<外壳版本>-mac-arm64.dmg、旧的 DSH-X-0.1.26-arm64.dmg）；
 * tag 是核心版本，纯核心发版的 Release 根本没有安装包。所以版本从包名里读，读不到才退回 tag。
 * 预发布段用懒惰的 `??`：贪婪的话 `-arm64` 会被当成预发布号吞进版本里。
 */
export function shellVersionOfAsset(name, tag = '') {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)??)(?=-(?:mac|linux|win|arm64|x64|amd64|aarch64|universal)\b|\.dmg$|\.deb$)/.exec(String(name))
  return match?.[1] || String(tag || '').replace(/^v/i, '')
}

/**
 * 从 GitHub Releases 列表里挑比当前外壳新、且带本平台安装包的最新一版。
 * allowPrerelease：外壳或核心本身是预发布（rc 通道）时继续收预发布，否则只看正式版。
 * @returns {{ latest: string, url: string, asset: string } | null}
 */
export function pickManualShellRelease(releases, { current, allowPrerelease, match }) {
  if (!match) return null
  const cur = parseVer(current)
  let best = null
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || (release.prerelease && !allowPrerelease)) continue
    const asset = (release.assets || []).find((item) => match(String(item?.name || '')))
    if (!asset) continue
    const version = shellVersionOfAsset(asset.name, release.tag_name)
    const parsed = parseVer(version)
    if (!parsed || (cur && cmpVer(parsed, cur) <= 0)) continue
    if (!best || cmpVer(parsed, parseVer(best.latest)) > 0) {
      best = { latest: version, url: String(release.html_url || ''), asset: String(asset.browser_download_url || '') }
    }
  }
  return best
}
