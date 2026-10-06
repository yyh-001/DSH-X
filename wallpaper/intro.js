(() => {
  const root = document.documentElement;
  const screen = document.getElementById('bootScreen');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let leavingTimer = 0, finishTimer = 0;
  const allowed = () => !reduced.matches && !root.classList.contains('reduce-motion') && !root.classList.contains('skip-intro');
  const enterDesktop = () => { if (!root.classList.contains('terminal-ready')) root.classList.add('terminal-ready'); };
  const finish = (enter = true) => {
    clearTimeout(leavingTimer); clearTimeout(finishTimer);
    // 禁用动画时避免反复写入根节点 class，触发观察器自身循环。
    if (root.classList.contains('booting')) root.classList.remove('booting');
    screen.hidden = true; screen.classList.remove('is-leaving');
    if (enter) enterDesktop();
  };
  window.replayWallpaperIntro = () => {
    finish(false);
    if (!allowed()) { enterDesktop(); return; }
    if (root.classList.contains('terminal-ready')) root.classList.remove('terminal-ready');
    screen.hidden = false;
    // 重播时重新触发 CSS 时间轴，不积存旧计时器。
    void screen.offsetWidth;
    root.classList.add('booting');
    leavingTimer = setTimeout(() => {
      // 遮罩完全退场后才开始桌面入场，避免角色上浮被开场画面盖住。
      screen.classList.add('is-leaving');
      finishTimer = setTimeout(finish, 450);
    }, 2250);
  };
  document.getElementById('replayIntro').addEventListener('click', window.replayWallpaperIntro);
  document.getElementById('skipIntro').addEventListener('click', () => finish());
  reduced.addEventListener('change', () => { if (!allowed()) finish(); });
  new MutationObserver(() => { if (!allowed()) finish(); }).observe(root, { attributes: true, attributeFilter: ['class'] });
  window.replayWallpaperIntro();
})();
