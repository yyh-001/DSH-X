import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const css = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const at = (needle) => {
  const index = page.indexOf(needle)
  assert.ok(index >= 0, `页面里找不到 ${needle}`)
  return index
}

test('启动项只有一套表单：连接作为「目录」出现在三级选择窗里，不再有单独的 WSL 选项', () => {
  assert.doesNotMatch(page, /id="launchBackendTabs"/)
  assert.doesNotMatch(page, /id="launchWslEnvPick"/)
  assert.doesNotMatch(page, /id="wslPickDialog"/)
  assert.match(page, /id="launchWslDistro" hidden/)
  assert.match(page, /id="launchWslProfile" hidden/)
  assert.match(page, /id="launchWslHome" type="hidden"/)
  assert.match(page, /id="launchConnectionId" type="hidden"/)
  assert.match(page, /id="launchRemoteHome" type="hidden"/)
  assert.match(page, /id="launchWslWorkdirField" hidden/)
  assert.match(page, /function parseWslHomeKey\(/)
  assert.match(page, /function parseSshHomeKey\(/)
  assert.match(page, /for \(const connection of connectionsList\(\)\)/, '左栏把已保存连接当目录行')
  assert.match(page, /name: folderBaseName\('~\/\.dsh'\) \|\| connection\.name/, '连接行默认用文件夹名')
  assert.match(page, /row\.remote \? `\$\{server\}/, '本机用文件夹图标、远程用服务器图标区分')
  assert.match(page, /connectionHomeKey\(connection, '~\/\.dsh'\)/)
  assert.match(page, /async function selectPickerHome\(home\)[\s\S]{0,1200}?const connection = connectionForHomeKey\(home\)/, '选中连接目录走远端探测')
  assert.match(page, /function applyRemotePickerToLaunchForm\(connection, home, profile\)/)
  assert.match(page, /if \(connection && parsed\) applyRemotePickerToLaunchForm\(connection, parsed\.home, pickerProfile\)/)
})

test('新增目录弹窗用两个页签区分本机 / 远程连接，远程页签填连接 + 远端目录', () => {
  assert.match(page, /id="pickHomeAddDialog"/)
  assert.match(page, /id="pickHomeTabs"[^>]*data-active="local"/, '本机 / 远程连接做成页签，默认本机')
  assert.match(page, /data-pick-home-kind="local"[^>]*data-i18n="本机目录"/)
  assert.match(page, /data-pick-home-kind="wsl"[^>]*data-i18n="远程连接"/)
  assert.match(page, /function paintPickHomeKind\(kind\)/, '页签切换只切字段，不再用两个大按钮')
  assert.match(page, /id="pickHomeLocalPath"/, '本机页签有目录路径输入框')
  assert.match(page, /id="pickHomeLocalBrowse"/, '浏览按钮只回填路径，不直接登记')
  assert.match(page, /pickHomeKind === 'local'[\s\S]{0,500}?registerPickerHome\(path\)/, '本机页签点「添加」登记输入的路径')
  assert.match(page, /function paintPickHomeConnections\(selected = ''\)/, '远程页签列已保存连接')
  assert.match(page, /id="pickHomeWslDistro"/)
  assert.match(page, /id="pickHomeWslHome"/)
  assert.match(page, /function confirmPickHomeAdd\(\)[\s\S]{0,1400}?pickerHome = connectionHomeKey\(connection, home\)/)
  assert.doesNotMatch(page, /id="profilePickHomeAdd"/, '右上角不再重复放添加目录按钮')
  assert.doesNotMatch(page, /id="pickerNewConnection"/, '底部不再堆新建连接，统一走添加目录里的连接下拉')
  assert.match(page, /class="ghost icon-btn profile-pick-tool" id="pickerCreateProject"/, '创建项目是环境右上角的纯图标按钮')
  assert.match(page, /value="\$\{NEW_CONNECTION_OPTION\}"[\s\S]{0,80}?新建远程连接…/, '远程连接下拉最后一项是新建连接')
  assert.match(css, /\.pick-home-tabs::after \{[^}]*transition: transform 240ms/, '选中块滑动')
  assert.match(css, /html\.reduce-motion \.pick-home-tabs::after \{ transition: none; \}/, '减动效时关掉滑动')
})

test('远端也用本机版本选择器：版本组露出，数据源切到远端 core', () => {
  assert.match(page, /launchLocalVersionGroupEl\.hidden = false/, '远端不再藏掉版本组')
  assert.match(page, /document\.getElementById\('launchVersionField'\)\.hidden = false/, '版本下拉对连接可见')
  assert.match(page, /document\.getElementById\('launchManageVersions'\)\.hidden = false/, '管理版本按钮对连接可见')
  assert.match(page, /function versionTargetIsRemote\(\)/)
  assert.match(page, /getJson\('\/api\/state', versionScopeOptions\(\)\)/, '版本管理按启动项作用域读远端 state')
  assert.match(page, /post\('\/api\/install', \{ version \}, versionScopeOptions\(\)\)/, '安装走远端 core 代理')
  assert.match(page, /post\('\/api\/uninstall', \{ version \}, versionScopeOptions\(\)\)/, '卸载走远端 core 代理')
  assert.match(page, /version: versionValue \|\| 'auto'/, '远端启动项保存选中的版本')
  assert.match(page, /launchWslWorkdirFieldEl\.hidden = !remote/)
  assert.match(page, /launchWslLocationFieldsEl\.hidden = !remote/)
  assert.match(page, /if \(launchBackendIsRemote\(\)\) setLaunchBackend\('local'\)/, '选择本机目录时切回本机')
  assert.match(page, /launch-tag launch-tag-wsl/, '启动项卡片上有 WSL 标签')
  assert.match(page, /post\('\/api\/wsl\/path'/, 'WSL 目录选择要走 wslpath 转换接口')
})

test('常规设置里不再重复 WSL 默认值：发行版 / 用户目录都在连接里选', () => {
  assert.doesNotMatch(page, /id="wslDefaultDistro"/)
  assert.doesNotMatch(page, /id="wslDefaultHome"/)
  assert.doesNotMatch(page, /id="wslDshCommand"/)
  assert.match(page, /WSL 的默认值不再单独占一块设置/)
})

test('连接来自状态推送；新建 WSL 连接时才按需拉发行版列表', () => {
  assert.match(page, /connections: Array\.isArray\(data\.connections\)/, '/api/state 自带连接列表')
  const ensure = page.indexOf('async function ensureWslInfo')
  assert.ok(ensure >= 0, '页面里要有 ensureWslInfo')
  assert.match(page.slice(ensure, ensure + 1200), /getJson\('\/api\/wsl'\)/)
  assert.match(page, /async function paintConnectionWslDistros\(selected = ''\)[\s\S]{0,300}?await ensureWslInfo\(\)/, '连接对话框才拉发行版列表')
  assert.doesNotMatch(page, /wslInfoLoaded/, '发行版列表不做跨会话缓存，靠服务端 10 秒缓存控成本')
})

test('远端 Profile 可以直接删除：请求走 /api/remote/profile/remove', () => {
  assert.match(page, /const canRemove = !pickerBusy && \(row\.wsl \|\| Boolean\(row\.pack\) && row\.pack\?\.removable !== false\)/, '远端行也允许删除')
  assert.match(page, /post\('\/api\/remote\/profile\/remove', \{ connectionId: connection\.id, home: parsed\.home, profile \}\)/)
  assert.match(page, /删除\{kind\}「\{name\}」里的 Profile「\{profile\}」？/, '删除确认要说清是哪个连接里的哪一份')
  assert.match(page, /for \(const key of \[\.\.\.pickerWslProfileCache\.keys\(\)\]\)/, '删完清掉这份 Profile 的插件摘要缓存')
})

test('连接的 Linux 用户属于连接，不属于启动项', () => {
  assert.match(page, /id="connectionWslUser"/)
  assert.match(page, /body\.wslUser = connectionWslUserEl\.value\.trim\(\)/, '保存连接时带用户')
  assert.match(page, /launchWslUserFieldEl\.hidden = true/, '启动项不再显示用户字段')
  assert.match(page, /user: connection\?\.wslUser \|\| pickerWslUser\(\)/, 'WSL 打开目录按连接用户展开 ~')
  assert.match(page, /pickWslDirectory\(connection\.wslDistro, pickHomeWslHomeEl\.value, connection\.wslUser \|\| ''\)/, '添加目录按连接用户转换路径')
  assert.match(page, /connectionId=\$\{encodeURIComponent\(connection\.id\)\}&home=/, 'Profile 详情按连接 + 目录请求')
})

test('连接可以测试 / 编辑 / 删除，选择窗行尾也能编辑', () => {
  assert.match(page, /post\('\/api\/connections\/test', body\)/)
  assert.match(page, /post\('\/api\/connections\/remove', \{ id: connection\.id \}\)/)
  assert.match(page, /data-project-edit="\$\{escapeHtml\(row\.connection\.id\)\}"/, '连接行的铅笔打开项目编辑')
  assert.match(page, /void openConnectionDialog\(connection\)/)
  assert.match(page, /id="connectionDelete"/, '编辑连接时能删除')
  assert.match(page, /id="connectionKindTabs"/)
  assert.match(page, /id="projectDevice"/, '创建项目里能选设备')
  assert.match(page, /ADD_REMOTE_DEVICE/, '设备下拉里有添加远程设备')
})

test('目录下拉底部能创建项目：名称 + 设备 + 源文件夹', () => {
  assert.match(page, /id="pickerCreateProject"/)
  assert.match(page, /id="projectDialog"/)
  assert.match(page, /id="projectName"/)
  assert.match(page, /id="projectDevice"/)
  assert.match(page, /id="projectFolder"/)
  assert.match(page, /id="projectCreate"/)
  assert.match(page, /ADD_REMOTE_DEVICE/, '设备下拉里能添加远程设备')
  assert.match(page, /if \(!connection && !folder\)[\s\S]{0,160}?先选择源文件夹。/, '本机项目必须选目录')
  assert.match(page, /backend: connection\.kind, connectionId: connection\.id/, '远端项目带连接')
  assert.match(page, /dshHome: folder/, '本机项目把源文件夹作为 dsh 目录')
})

test('WSL 和本机一样有版本类型与兼容性检查', () => {
  assert.doesNotMatch(page, /launchChannelFieldEl\.hidden = wsl/)
  assert.match(page, /launchChannelFieldEl\.hidden = !autoVersion/, '自动版本时 WSL 也显示版本类型')
  assert.match(page, /launchUpdateChannelHintEl\.hidden = !autoVersion/)
  assert.doesNotMatch(page, /launchCheckCompatibilityEl\.hidden = versionTargetIsWsl\(\)/, '兼容性检查对 WSL 也开放')
  assert.match(page, /updateChannel: draftLaunchChannel\(\)/, 'WSL 保存也带版本类型')
  assert.match(page, /const scope = \{ launchId: '', home: target\.home \}/)
  assert.match(page, /scope\.wslUser = draftWslUserValue\(\)/)
  assert.match(page, /versionScopeState\?\.channelPlans\?\.\[channel\]/, '自动选版本读远端 state 的通道计划')
})

test('WSL 引导也有隔离方式：运行位置切到 WSL 后由远端建 Profile / 目录', () => {
  assert.match(page, /id="launchGuideBackendTabs"/)
  assert.match(page, /data-guide-backend="local"/)
  assert.match(page, /data-guide-backend="wsl"/)
  assert.match(page, /id="launchGuideWslDistro"/)
  assert.match(page, /id="launchGuideWslUser"/)
  assert.match(page, /id="launchGuideWslHome"/)
  assert.match(page, /function setLaunchGuideBackend\(/)
  assert.match(page, /async function prepareGuidedLaunchWsl\(/)
  assert.match(page, /getJson\('\/api\/state', \{ home: key, launchId: '', wslUser: user \}\)/)
  assert.match(page, /post\('\/api\/profiles\/create', \{ profile: name \}, \{ home: key, launchId: '', wslUser: user \}\)/)
  assert.match(page, /post\('\/api\/profiles\/copy', \{ profile: name, source: copy\.profile, sourceHome \}, \{ home: key, launchId: '', wslUser: user \}\)/)
  assert.match(page, /launchIsolationFieldEl\.hidden = !creating/, '隔离方式不再因为 WSL 整块藏掉')
  assert.match(page, /launchBackendIsWsl\(\)[\s\S]{0,300}?launchGuideBackend === 'wsl'/, '引导里的运行位置参与后端判定')
})

test('连接弹窗用紧凑分段按钮，引导里的两档浮块按 1/2 平分', () => {
  assert.match(css, /\.connection-kind-tabs button\[aria-selected="true"\], \.connection-auth-tabs button\[aria-selected="true"\]/)
  assert.match(css, /\.connection-kind-tabs, \.connection-auth-tabs \{ display: inline-flex;/)
  assert.match(css, /#launchGuideBackendTabs::after \{ width: calc\(\(100% - 10px\) \/ 2\); \}/)
  assert.match(css, /#launchGuideBackendTabs\[data-active="wsl"\]::after/)
})

test('WSL 发行版也走应用内下拉，不弹系统原生菜单', () => {
  assert.match(page, /#connectionWslDistro, #launchGuideWslDistro/, '发行版下拉包成 ui-select')
  assert.doesNotMatch(page, /#connectionSshImport, #connectionWslDistro/, 'SSH 导入有自己的富选择面板，不再走通用 ui-select')
})

test('创建项目的设备下拉显示机器名、路径和在线绿点', () => {
  assert.match(page, /id="projectDeviceTrigger"/)
  assert.match(page, /id="projectDevicePanel"/)
  assert.match(page, /id="projectDevice" hidden/)
  assert.match(page, /projectDeviceStatusMark/)
  assert.match(page, /const host = runtime\.hostname[\s\S]{0,100}?const user = runtime\.osUser|runtime\.osUser/, '设备名优先用握手识别到的机器名 + 用户')
  assert.match(page, /projectDevicePath/)
  assert.match(css, /\.project-device-dot\.is-online/)
  assert.match(css, /\.project-device-option-text small/)
})

test('SSH config 导入是带搜索的富下拉：别名 + 用户@主机:端口', () => {
  assert.match(page, /id="connectionSshImportTrigger"/)
  assert.match(page, /id="connectionSshImportPanel"/)
  assert.match(page, /id="connectionSshImportSearch"/)
  assert.match(page, /id="connectionSshImportList"/)
  assert.match(page, /id="connectionSshImport" hidden/, '原生 select 只留作保存用的值源')
  assert.match(page, /搜索 SSH 配置别名/)
  assert.match(page, /lucide-chevron-down/)
  assert.match(page, /lucide-server/, '每个别名前有服务器图标')
  assert.match(page, /let connectionSshAliases = \[\]/)
  assert.match(page, /function paintSshImportList\(\)/)
  assert.match(page, /data-ssh-alias=/)
  assert.match(page, /\[item\.username, item\.host\]\.filter\(Boolean\)\.join\('@'\)/, '副标题是 user@host:port')
  assert.match(css, /\.connection-import-panel \{[\s\S]{0,200}?position: fixed/)
  assert.match(css, /\.connection-import-option\.is-selected \{[^}]*background: var\(--accent-soft\)/)
})

test('目录栏不单独标注远程连接：就绪的连接只用绿点表示', () => {
  assert.match(page, /id="profilePickHomeCaption"/)
  assert.match(page, /profilePickHomeCaptionEl\.textContent = t\(homeCaption\)/, '挑启动环境时叫「环境」，复制 Profile 时叫「用户目录」')
  assert.doesNotMatch(page, /profile-pick-group/, '不再有「远程连接」分组标题')
  assert.match(page, /online: connectionRuntime\[connection\.id\]\?\.status === 'online'/, '连接就绪状态来自运行时')
  assert.match(page, /profile-pick-online-dot/, '就绪的远端行只加一个绿点')
  assert.match(page, /还没有其他环境/, '没有其它环境时用通用空状态')
  assert.match(css, /#profilePickHomes \{ display: flex; flex-direction: column;/, '空状态要能撑满列表高度')
  assert.match(css, /\.profile-pick-empty \{[^}]*place-content: center;/, '空状态居中')
  assert.match(css, /\.profile-pick-row\.is-selected \{[^}]*box-shadow: inset 0 0 0 1px var\(--accent-dim\)/, '选中行用细描边，不用左侧色条')
})

test('所有浏览目录按钮都是文件夹图标，不再写「浏览…」', () => {
  for (const id of ['pickDir', 'projectFolderBrowse', 'connectionSshKeyBrowse', 'pickLaunchWslWorkdir', 'pickHomeLocalBrowse', 'pickHomeWslBrowse']) {
    assert.match(page, new RegExp(`class="ghost browse-btn" id="${id}"[^>]*aria-label="浏览…"[^>]*><svg[^>]*><use href="/icons.svg#lucide-folder"/>`), `${id} 要换成文件夹图标`)
  }
  assert.doesNotMatch(page, />浏览…<\/button>/, '不再有文字版浏览按钮')
  assert.match(css, /\.ghost\.browse-btn \{[\s\S]{0,200}?width: var\(--control-height\)/, '图标按钮和输入框同高')
  assert.match(css, /#launchDialog \.control-row \.ghost\.browse-btn \{[\s\S]{0,120}?height: 42px/, '启动项弹窗里跟随 42px 控件')
})

test('选择窗的切换 / 增删动效：方向推入、删除淡出、新增高亮，且遵守减动效', () => {
  assert.match(css, /@keyframes profile-pick-refresh-right/)
  assert.match(css, /@keyframes profile-pick-refresh-left/)
  assert.match(css, /@keyframes profile-pick-row-out/)
  assert.match(css, /@keyframes profile-pick-row-new/)
  assert.match(css, /\.profile-pick-row\.is-removing \{ animation: profile-pick-row-out/)
  assert.match(css, /\.profile-pick-row\.is-new \{ animation: profile-pick-row-new/)
  assert.match(css, /html\.reduce-motion \.profile-pick-row\.is-removing/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}?\.profile-pick-row\.is-new \{ animation: none; \}/)
  assert.match(page, /async function fadePickerRowOut\(row\)/)
  assert.match(page, /pickerNewRow = `home:\$\{added\}`/, '新增目录高亮')
  assert.match(page, /pickerNewRow = `profile:\$\{data\.createdProfile\}`/, '新建 Profile 高亮')
})
