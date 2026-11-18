/**
 * 把 `@deepseek-ai/dsh-cua` 的 `CuaBackend` 接口接到 DSH-X 外壳。
 * 保留 ZCode + `dsh-cua` 的核心约束：无障碍树优先、观察->动作->再观察、精确匹配应用、遇急停或拒绝立即停止。
 */
import { createDshXChannel } from './channel.js'

export const DSHX_WINDOWS_GUIDANCE = `DSH-X Windows / Desktop Computer Use rules:
- Exact raw tool calls: pass { method, params } ONLY with documented fields (do NOT pass delivery_mode, options, or pid on screenshot/click):
  - Discovery: getCapabilities({}), listApps({}), findApps({ query }), getApp({ selector })
  - Windows & observation: listWindows({ appHandle }), getState({ appHandle, windowId? }), screenshot({ appHandle, windowId })
  - Elements: listActions/invoke({ appHandle, snapshotId, elementId }), setValue({ appHandle, snapshotId, elementId, value }), performAction({ appHandle, snapshotId, elementId, action, argument? })
  - Pointer & keyboard: click({ appHandle, windowId, x, y } | { appHandle, snapshotId, elementId }), mouseMove({ appHandle, windowId, x, y }), scroll({ appHandle, windowId, x, y, deltaLinesX, deltaLinesY }), drag({ appHandle, windowId, fromX, fromY, toX, toY }), typeText({ appHandle, windowId?, text }), paste({ appHandle, windowId?, text }), pressKey({ appHandle, windowId?, key, modifiers? })
- Accessibility first: call listWindows / getState first and locate elements by role/name/title/value and snapshotId+elementId; use coordinates from a fresh screenshot({ appHandle, windowId }) only when structured elements are unavailable (e.g. Chromium/Electron content, canvas).
- Foreground fallback is automatic: never pass delivery_mode or options; the desktop host handles background -> foreground escalation when needed.
- Observe -> Act -> Re-observe: elementIds belong strictly to the latest successful getState snapshot of that window. Never guess or reuse stale elementIds across snapshots.
- Exact app names: pass the user's app name as stated to getApp(selector); if unknown or ambiguous, call listApps() or findApps(query) once first.
- Window scope & boundaries: elevated/administrator windows (Windows UIPI), UAC secure desktop, and lock screen cannot be controlled. If an operation returns ELEVATED_WINDOW_BLOCKED, SESSION_LOCKED, APP_ACCESS_DENIED, APP_ACCESS_REVOKED, or COMPUTER_USE_STOPPED, stop immediately and report to the user without switching to another automation path.`

export function buildGuidance(commonGuidance = '') {
  return commonGuidance ? `${commonGuidance}\n\n${DSHX_WINDOWS_GUIDANCE}` : DSHX_WINDOWS_GUIDANCE
}

export function createDshXBackend({
  client,
  commonGuidance = '',
  platform = process.platform,
  sessionPrefix = '',
} = {}) {
  return {
    helperPath: 'dsh-x-shell',
    createChannel(_owner, nativeConfig) {
      return createDshXChannel({
        client,
        sessionPrefix: sessionPrefix || client.instance || '',
        timeoutMs: nativeConfig?.timeoutMs || 30_000,
      })
    },
    guidance: buildGuidance(commonGuidance),
    capabilities: {
      platform,
      methods: [
        'getCapabilities',
        'listApps',
        'findApps',
        'getApp',
        'activate',
        'show',
        'listWindows',
        'getState',
        'listActions',
        'performAction',
        'invoke',
        'setValue',
        'mouseMove',
        'click',
        'typeText',
        'paste',
        'pressKey',
        'sendKeyEvent',
        'scroll',
        'drag',
        'screenshot',
      ],
      appLevelAccessibility: false,
      systemPointer: true,
      keyboard: ['app', 'window'],
      coordinateSpace: 'screenshot-pixels',
      browser: false,
    },
    permissionParameters(_method, permission, locale) {
      return { permission, locale }
    },
  }
}
