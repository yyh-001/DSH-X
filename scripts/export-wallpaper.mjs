import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, 'release/wallpaper/DSH-X');
await mkdir(path.join(output, 'assets/mascot'), { recursive: true });
for (const name of ['index.html', 'terminal.css', 'wallpaper.js', 'spectrum.js', 'intro.js', 'project.json', 'preview.jpg']) {
  await copyFile(path.join(root, 'wallpaper', name), path.join(output, name));
}
for (const name of ['mascot.css', 'background-character.png']) {
  await copyFile(path.join(root, 'public', name), path.join(output, 'assets', name));
}
for (const part of ['head', 'ear', 'tuft', 'bow']) {
  for (const version of [8, 9]) {
    const name = `${part}-v${version}.png`;
    await copyFile(path.join(root, 'public/mascot', name), path.join(output, 'assets/mascot', name));
  }
}
// 只适配导出的副本，启动器动画仍按原有策略运行。
let mascot = await readFile(path.join(root, 'public/mascot.js'), 'utf8');
const tick = '    const dt = last ? Math.min((now - last) / 1000, .035) : 1 / 60;';
if (!mascot.includes(tick)) throw new Error('看板娘动画结构已变化，请更新壁纸 FPS 适配。');
// rAF 时间戳有小幅误差，留半毫秒余量，防止 60 Hz 下误跳过正常的一帧。
mascot = mascot.replace(tick, `    if (last && now - last < 1000 / window.wallpaperFPS - .5) { frame = requestAnimationFrame(tick); return; }
    const dt = last ? Math.min((now - last) / 1000, .1) : 1 / window.wallpaperFPS;`);
await writeFile(path.join(output, 'assets/mascot.js'), mascot);
let water = await readFile(path.join(root, 'public/water.js'), 'utf8');
if (!water.includes('1000/24')) throw new Error('水面动画结构已变化，请更新壁纸 FPS 适配。');
water = water.replace('1000/24', '1000/window.wallpaperFPS-.5');
// 壁纸副本将日夜水面混合，避免主题切换时 shader 突然跳色。
const adaptWater = (from, to) => {
  if (!water.includes(from)) throw new Error('水面主题结构已变化，请更新壁纸过渡适配。');
  water = water.replace(from, to);
};
adaptWater('if(night>.5){', '');
adaptWater('gl_FragColor=vec4(darkWater,1.);\n        return;\n      }'.replaceAll('\n', water.includes('\r\n') ? '\r\n' : '\n'), '');
adaptWater('gl_FragColor=vec4(color,1.);', 'gl_FragColor=vec4(mix(color,darkWater,clamp(night,0.,1.)),1.);');
adaptWater('color+=vec3(.085,.075,.055)*light;', 'color+=vec3(.16,.14,.10)*light;');
adaptWater('let frame=0,last=0,time=0,slot=0,lastRipple=-1,lost=false;', `let frame=0,last=0,time=0,slot=0,lastRipple=-1,lost=false;
  let nightMix=document.documentElement.dataset.colorScheme==='dark'?1:0;
  let themeFrom=nightMix,themeTarget=nightMix,themeAt=performance.now();`);
adaptWater("gl.uniform1f(uniforms.night,document.documentElement.dataset.colorScheme==='dark'?1:0);", `const target=document.documentElement.dataset.colorScheme==='dark'?1:0;
    const now=performance.now();
    if(target!==themeTarget){themeFrom=nightMix;themeTarget=target;themeAt=now;}
    if(!active()) nightMix=themeTarget;
    else {
      const progress=Math.min(1,(now-themeAt)/700);
      const eased=progress*progress*(3-2*progress);
      nightMix=themeFrom+(themeTarget-themeFrom)*eased;
    }
    gl.uniform1f(uniforms.night,nightMix);`);
await writeFile(path.join(output, 'assets/water.js'), water);
// 缩略图采用已验证的实际终端截图。
await writeFile(path.join(output, '使用说明.txt'), `DSH-X · 大肥鱼桌面终端

导入 Wallpaper Engine：
1. 解压 ZIP 到独立文件夹。
2. 打开 Wallpaper Engine 壁纸编辑器，将本文件夹中的 index.html 拖到“创建壁纸”。
3. 保存并应用。在壁纸属性中调整主题、动画、看板娘大小和 DSH-X 标识。

默认按本机时间自动切换：07:00–19:00 为浅色，其余时间为深色。
每分钟检查一次；从休眠或暂停恢复时立即校正。也可手动选择浅色、深色或跟随系统主题。
右上角 DAY / NIGHT DISPLAY 按钮可一键切换昼夜，配色约 0.7 秒平滑过渡。按时间模式下手动切换保留到下一个 07:00 / 19:00 分界，再恢复自动；切换不重播入场。
右上角显示本机 24 小时时间（小时:分钟），整分钟更新；壁纸属性中可单独关闭时间显示。
时间下方的频谱随电脑正在播放的声音跳动，可调整灵敏度或关闭；仅在 Wallpaper Engine 中接收系统音频，普通网页预览保持静止。
DSH-X 字标与进度条从左向右同步展开，开场约 2.7 秒；可跳过或在右下角重播，壁纸属性中可关闭开场。
开场遮罩退场后，大肥鱼从下方浮出，圆环、标题、时间、日期、频谱与页脚依次加载；圆环缓慢转动、状态灯呼吸、时钟冒号闪动。关闭动画时静态显示，宿主暂停或页面隐藏时停止持续动效。

点击空白水面产生涟漪，鼠标靠近看板娘可互动。桌面图标可能优先接收点击。
这是独立展示壁纸，无启动器管理按钮，不需要启动器运行，也不访问网络。
水面与角色默认最高 60 FPS，同时服从 Wallpaper Engine 更低的 FPS 设置。
如需流畅互动，请在 Wallpaper Engine 的设置 → 性能中将 FPS 设为 60。
宿主暂停、页面隐藏或系统减弱动画设置会停止持续动画。

重新导出：node scripts/export-wallpaper.mjs
来源：https://github.com/yyh-001/DSH-X
`);
await copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
console.log(output);
