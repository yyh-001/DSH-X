# 无眼睛分层总图

产物：layer-sheet-v7-no-eyes.png
工具：内置 image_gen
编辑参考：上一版同图生成的完整头脸、呆毛、蝴蝶结和右耳分层总图。
提示词：移除脸部两只深色椭圆眼睛，用连续完整的肤色渐变补齐，保留腮红；保持完整头脸轮廓与同图分开放置的呆毛、蝴蝶结、右耳；背景透明，不留眼洞，不绘制眼睛、眼睑或嘴巴。眼睛后续由代码单独动画。

## 接入页面（2026-09-29；**已被 v8 取代**，现行排布见 `layer-sheet-v8-no-outline.md`）

本图曾拆件接入 `public/mascot.js`，替换原 base.png rig。管线与参数：

- `slice-layer-sheet.py`：按连通域把总图拆成头脸/呆毛/蝴蝶结/右耳四件（背景与件间空隙 alpha=0，头件右上角有生成残留小点，合成时按最大连通域清掉）。
- `compose-v7.py`：四件按统一比例 1.15 摆上 1254² rig 画布，锚点都写在该脚本顶部（呆毛根埋进发饰后、蝴蝶结在右侧发际、耳朵件压在头层下）；输出 `public/mascot/{head,tuft,bow,ear}-v7.png` 与合成预览。眼睛位置从 layer-sheet-v6 实测迁移（中心相对头部映射、半轴≈(52,90) canvas、长轴倾角 19°），枢轴：头 (650,1080)、呆毛 (590,310)、蝴蝶结 (1180,855)、耳朵 (1150,900)。
- 叠层 ear → head → tuft → bow，眼睛最上；深浅色共用这套素材，dark 专用图层与眼色规则已从 `mascot.css` 移除。
- 退役素材（base.png、base-dark*、tuft/bow.svg）留在仓库，已加进 `scripts/pack-common.mjs` 的 SKIP_PUBLIC；`docs/` 落地页副本与安装副本按惯例未动。
- 已验证：预览页浅/深色、`?closed` 闭眼弧、主页真实尺寸与层级、窄屏 390px、坐标点击 happy 反应；`node --test` 315 用例通过。
