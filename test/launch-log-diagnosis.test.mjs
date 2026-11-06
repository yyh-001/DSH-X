/**
 * 启动项日志顶部的「插件诊断」：日志里的三类行压成一行一个包。
 *
 * 这里钉住两点：
 *   1. 同一条拒载日志按行重复出现（tool-subagent 三行）时只列一次；
 *   2. `skipping profile bundle … is incompatible with dsh …` 也要按版本不兼容归类，
 *      不能因为走了 skipped 通道就标成“激活异常”。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const section = page.slice(page.indexOf('    function diagnosisIssueRows'), page.indexOf('/** 启动项当前实例的插件诊断', page.indexOf('    function diagnosisIssueRows')))

function rows(report) {
  const context = vm.createContext({ t: value => value })
  vm.runInContext(section, context)
  return JSON.parse(JSON.stringify(context.diagnosisIssueRows(report)))
}

test('同一版本被多行拒载只列一次', () => {
  const report = {
    rejected: [
      { id: 'subagent-model-selection-settings', package: '@deepseek-ai/dsh-tool-subagent@0.2.2-alpha.2', requirements: '{}' },
      { id: 'tool-subagent', package: '@deepseek-ai/dsh-tool-subagent@0.2.2-alpha.2', requirements: '{}' },
      { id: 'tool-subagent-fork', package: '@deepseek-ai/dsh-tool-subagent@0.2.2-alpha.2', requirements: '{}' },
    ],
  }
  assert.deepEqual(rows(report), [{ name: '@deepseek-ai/dsh-tool-subagent', version: '0.2.2-alpha.2', tag: '插件版本不兼容', detail: '{}' }])
})

test('被跳过的整包也按版本不兼容归类，并带出版本号', () => {
  const report = {
    skipped: {
      entries: [{
        package: '@deepseek-ai/dsh-subagent-codex',
        reason: 'Error: Plugin @deepseek-ai/dsh-subagent-codex@0.2.2-alpha.2 is incompatible with dsh 0.2.2-rc.1: requirements {}',
      }],
    },
  }
  assert.deepEqual(rows(report), [{ name: '@deepseek-ai/dsh-subagent-codex', version: '0.2.2-alpha.2', tag: '插件版本不兼容', detail: 'Error: Plugin @deepseek-ai/dsh-subagent-codex@0.2.2-alpha.2 is incompatible with dsh 0.2.2-rc.1: requirements {}' }])
})

test('激活失败与配置校验失败分开标注', () => {
  const report = {
    failed: [
      { id: 'webserver', package: '@deepseek-ai/dsh-host-webserver', reason: 'listen EADDRINUSE: address already in use' },
      { id: 'options', package: '@deepseek-ai/dsh-host-product-telemetry-otel', reason: 'ValidationError: $.serviceVersion missing required value' },
    ],
  }
  assert.deepEqual(rows(report).map(row => [row.name, row.tag]), [
    ['@deepseek-ai/dsh-host-webserver', '插件激活异常'],
    ['@deepseek-ai/dsh-host-product-telemetry-otel', '配置问题'],
  ])
})
