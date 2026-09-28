# 发布清单（dsh-x-sync）

现在这个包**已经能装能用**（`dsh plugin --profile web add file:<路径>` 验过，设置页里那块面板、两个 agent 工具、本机路由都在真 dsh 上跑通了）。差的是「发给别人」那几步——都要用到你自己的账号，所以留给你拍板：

## 1. 发布到 npm

```sh
cd dsh-x-sync
npm publish --access public        # 包名 dsh-x-sync 若被占，改名后记得同步 cordis.patch.yml 里的 name
```

发布前过一遍：

- `npm test` 全绿；
- `package.json` 的 `files` 只带 `lib`、`cordis.patch.yml`、两个 README、LICENSE（不含 test/scripts）；
- `lib/engine/` 是最后一次 `npm run sync-engine` 的结果（别把没同步的引擎发出去）。

## 2. 上插件市场

市场收录的硬要求（缺一不收）：

- 包内 `dsh.bundle.patch` 指向的 `cordis.patch.yml` 存在且合法（本包 ✓）；
- npm 包的 `keywords` 里有 **`dsh-plugin`**（本包 ✓）；
- 往市场仓库提一个 PR，加一个描述本包的 YAML 条目（描述、分类、仓库地址、图标等按对方 CONTRIBUTING 的字段来）。

市场条目要用的现成文案在 `package.json` 的 `dshhub` 字段里（displayName / summary / categories）——直接抄过去。

## 3. 与 DSH-X 启动器的关系

- **引擎是同一份**：`lib/engine/{sync,zipfile,version}.js` 从 `DSH-X/strategies` 拷来，改引擎要改那边再 `npm run sync-engine`。
- **桶布局是同一套**：`dsh-x/v1/…`，所以启动器和插件能对同一只桶交替使用。升级引擎时注意别把布局改了（改了就是两套语义）。
- 以后想让「DSH-X 整合包」带上这个插件：把 `file:<路径>` 或 npm 包名写进 `.dspack` 的 manifest 即可（插件本身是标准形态，不需要特殊处理）；用户装完就是「一个界面（设置页 → 同步）管全部」。
