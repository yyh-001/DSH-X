(() => {
  const root = document.documentElement;
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  let theme = 'schedule', motion = true, paused = false;
  let manualScheme = null, manualBaseline = null;
  // 默认优先保证互动流畅，同时服从 Wallpaper Engine 更低的帧率限制。
  window.wallpaperFPS = 60;
  window.wallpaperAudioSensitivity = 1;
  const syncMotion = () => {
    root.classList.toggle('reduce-motion', !motion || paused);
    root.classList.toggle('wallpaper-paused', paused);
    root.classList.toggle('wallpaper-hidden', document.hidden);
  };
  const baseScheme = () => {
    let scheme = theme;
    if (theme === 'schedule') {
      const hour = new Date().getHours();
      scheme = hour >= 7 && hour < 19 ? 'light' : 'dark';
    } else if (theme === 'system') {
      scheme = systemDark.matches ? 'dark' : 'light';
    }
    return scheme;
  };
  const syncTheme = () => {
    const base = baseScheme();
    // 快捷切换只覆盖当前昼夜时段，下一次时间分界或系统主题变化后恢复自动。
    if (manualScheme && base !== manualBaseline) manualScheme = null;
    const scheme = manualScheme || base;
    // 不重复写属性，避免每分钟唤醒水面的主题观察器。
    if (root.dataset.colorScheme !== scheme) root.dataset.colorScheme = scheme;
    const button = document.getElementById('toggleTheme');
    if (button) {
      button.setAttribute('aria-pressed', String(scheme === 'dark'));
      button.title = scheme === 'dark' ? '切换到白天模式' : '切换到夜间模式';
    }
  };
  const syncClock = () => {
    const clock = document.getElementById('clockTime');
    if (!clock) return;
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0'), minutes = String(now.getMinutes()).padStart(2, '0');
    const hourDigits = document.getElementById('clockHour'), minuteDigits = document.getElementById('clockMinute');
    // 仅更新数字，保留冒号的独立动画节点，整分钟更新不会重置它。
    if (hourDigits.textContent !== hours) hourDigits.textContent = hours;
    if (minuteDigits.textContent !== minutes) minuteDigits.textContent = minutes;
    clock.dateTime = `${hours}:${minutes}`;
    const date = document.getElementById('clockDate');
    const weekday = document.getElementById('clockWeekday');
    const timezone = document.getElementById('clockTimezone');
    if (date) date.textContent = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    if (weekday) weekday.textContent = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
    if (timezone) {
      const offset = -now.getTimezoneOffset();
      timezone.textContent = `${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    }
  };
  const refresh = () => { syncTheme(); syncClock(); };
  systemDark.addEventListener('change', syncTheme);
  // 对齐本机整分钟更新时间，避免时钟比系统时间落后几十秒。
  const tick = () => {
    if (!paused && !document.hidden) refresh();
    setTimeout(tick, 60_000 - Date.now() % 60_000 + 25);
  };
  document.addEventListener('DOMContentLoaded', () => {
    refresh();
    document.getElementById('toggleTheme').addEventListener('click', () => {
      manualBaseline = baseScheme();
      manualScheme = root.dataset.colorScheme === 'dark' ? 'light' : 'dark';
      syncTheme();
    });
  });
  document.addEventListener('visibilitychange', () => { syncMotion(); if (!document.hidden) refresh(); });
  // 在脚本加载时注册，保证 Wallpaper Engine 的首批属性不会被遗漏。
  window.wallpaperPropertyListener = {
    applyUserProperties(properties) {
      if (properties.theme && ['schedule', 'light', 'dark', 'system'].includes(properties.theme.value)) {
        if (properties.theme.value !== theme) manualScheme = null;
        theme = properties.theme.value; syncTheme();
      }
      if (properties.motion) { motion = properties.motion.value === true; syncMotion(); }
      if (properties.showlogo) root.classList.toggle('hide-logo', properties.showlogo.value === false);
      if (properties.showclock) root.classList.toggle('hide-clock', properties.showclock.value === false);
      if (properties.showspectrum) root.classList.toggle('hide-spectrum', properties.showspectrum.value === false);
      if (properties.showintro) root.classList.toggle('skip-intro', properties.showintro.value === false);
      if (properties.audiosensitivity) {
        const value = Number(properties.audiosensitivity.value);
        if (Number.isFinite(value)) window.wallpaperAudioSensitivity = Math.max(50, Math.min(200, value)) / 100;
      }
      if (properties.charactersize) {
        const size = Number(properties.charactersize.value);
        if (Number.isFinite(size)) root.style.setProperty('--mascot-scale', String(Math.max(50, Math.min(120, size)) / 100));
      }
    },
    applyGeneralProperties(properties) {
      const fps = Number(properties.fps);
      if (Number.isFinite(fps) && fps > 0) window.wallpaperFPS = Math.max(1, Math.min(60, fps));
    },
    setPaused(value) { paused = value === true; syncMotion(); if (!paused) refresh(); }
  };
  tick(); syncMotion();
})();
