// 公共 UI 纯工具：图标色调、安全外链与图片地址校验（供 index.html / environments-page.js 等共用）
const CARD_ICON_TONES = ['blue', 'indigo', 'cyan', 'purple', 'emerald', 'amber', 'pink']

function toneForCardName(name) {
  let hash = 0
  for (const ch of String(name || '')) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0
  return CARD_ICON_TONES[hash % CARD_ICON_TONES.length]
}

function safeExternalHref(raw) {
  const value = String(raw || '').trim()
  return /^https?:\/\//i.test(value) ? value : ''
}

function safeIconUrl(raw) {
  const value = String(raw || '').trim()
  return /^(?:https?:\/\/|data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,)/i.test(value) ? value : ''
}

function isAvatarIconUrl(raw) {
  return /^https:\/\/(?:avatars\.githubusercontent\.com|github\.com)\//i.test(String(raw || '').trim())
}
