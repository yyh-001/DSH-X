import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

isolateUserHome(mkdtempSync(join(tmpdir(), 'dsh-picker-script-')))
const { directoryPickerWinScript } = await import('../server.js')

test('Windows 目录选择脚本可解析，中文、空格和特殊字符路径按数据传递', { skip: process.platform !== 'win32' }, () => {
  for (const path of ['', "C:\\中文目录\\space and 'quote' $name (folder)"]) {
    const script = directoryPickerWinScript(path)
    // 只解析完整脚本、执行路径解码，不弹选择框，也不执行路径中的特殊字符。
    const check = [
      "$ProgressPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      `$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}'))`,
      '$errors = $null; $tokens = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)',
      'if ($errors.Count) { throw ($errors | Out-String) }',
      "Invoke-Expression ($script.Split(';') | Where-Object { $_.Trim().StartsWith('$initialPath =') })",
      '[Console]::Out.Write($initialPath)',
    ].join('; ')
    const actual = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    assert.equal(actual, path)
  }
})
