#!/bin/bash
set -euo pipefail

if [[ -z "${DSH_MAC_CERT_P12_BASE64:-}" && -z "${DSH_MAC_CERT_PASSWORD:-}" && -z "${DSH_MAC_EXPECTED_SHA1:-}" ]]; then
  if [[ "${DSH_MAC_REQUIRE_SIGNED:-}" == '1' ]]; then
    echo '正式 macOS 构建缺少固定签名证书、密码或证书指纹' >&2
    exit 1
  fi
  echo '没有配置 macOS 证书，本次手动构建使用 ad-hoc 签名'
  exit 0
fi

if [[ -z "${DSH_MAC_CERT_P12_BASE64:-}" || -z "${DSH_MAC_CERT_PASSWORD:-}" || ! "${DSH_MAC_EXPECTED_SHA1:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo 'macOS 签名配置不完整：需要 P12、密码和 40 位证书 SHA-1 指纹' >&2
  exit 1
fi

umask 077
keychain="$RUNNER_TEMP/dsh-mac-signing.keychain-db"
p12="$RUNNER_TEMP/dsh-mac-signing.p12"
cert="$RUNNER_TEMP/dsh-mac-signing.crt"
trap 'rm -f "$p12" "$cert"' EXIT
printf '%s' "$DSH_MAC_CERT_P12_BASE64" | base64 -D > "$p12"
[[ -s "$p12" ]] || { echo 'macOS P12 解码后为空' >&2; exit 1; }

keychain_password="$(openssl rand -hex 24)"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$p12" -k "$keychain" -P "$DSH_MAC_CERT_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain"

expected="$(printf '%s' "$DSH_MAC_EXPECTED_SHA1" | tr '[:lower:]' '[:upper:]')"
identity_present() {
  security find-identity -v -p codesigning "$keychain" | grep -Eiq "^[[:space:]]*[0-9]+\) $expected[[:space:]]"
}

# 自签名证书导入临时钥匙串后可能丢失原机器的信任设置；只给本次 runner 的钥匙串补信任。
if ! identity_present; then
  openssl pkcs12 -in "$p12" -clcerts -nokeys -passin env:DSH_MAC_CERT_PASSWORD -out "$cert"
  subject="$(openssl x509 -in "$cert" -noout -subject | sed 's/^subject= *//')"
  issuer="$(openssl x509 -in "$cert" -noout -issuer | sed 's/^issuer= *//')"
  if [[ "$subject" == "$issuer" ]]; then
    security add-trusted-cert -r trustRoot -k "$keychain" "$cert"
  fi
fi

if ! identity_present; then
  echo '钥匙串中没有与固定 SHA-1 指纹匹配的有效代码签名身份' >&2
  exit 1
fi
printf 'DSH_MAC_SIGNING_IDENTITY=%s\nDSH_MAC_KEYCHAIN=%s\n' "$expected" "$keychain" >> "$GITHUB_ENV"
echo "已载入固定 macOS 签名身份 $expected"
