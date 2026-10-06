# dsh-x-aquarium

把 DSH-X 启动器主页的水面和大肥鱼搬进 dsh 网页：一块纯装饰的固定背景层（WebGL 水面 + 漂浮的大肥鱼），深浅色自适应，不碰任何界面功能。

- 水面着色器与启动器 `public/water.js` 同源：焦散、点头涟漪、深色月光带都在。
- 大肥鱼是启动器同款图缩到的 720px WebP，内联进客户端，无额外请求。
- 尊重系统的「减少动态效果」；点空白处仍有水波纹。

装进某个 profile（要 web 类 profile，桌面壳不渲染网页装饰）：

```
dsh plugin --profile web add -w file:<这份目录>
```
