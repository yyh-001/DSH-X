(() => {
  const root = document.documentElement;
  const host = document.querySelector('.music-spectrum');
  const container = host.querySelector('.spectrum-bars');
  const status = host.querySelector('.spectrum-status');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const bars = Array.from({ length: 32 }, () => {
    const bar = document.createElement('span');
    bar.className = 'spectrum-bar'; container.append(bar); return bar;
  });
  const levels = new Float32Array(bars.length);
  let lastSignal = -Infinity, signalTimer = 0;
  const enabled = () => !document.hidden && !reduced.matches
    && !root.classList.contains('reduce-motion') && !root.classList.contains('hide-spectrum');
  const quiet = () => {
    levels.fill(0);
    for (const bar of bars) bar.style.transform = 'scaleY(.035)';
    status.textContent = '等待音乐';
    host.dataset.active = 'false';
  };
  const reset = () => { clearTimeout(signalTimer); signalTimer = 0; quiet(); };
  function receive(samples) {
    if (!enabled() || !samples || samples.length < 128) return;
    const safe = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    let peak = 0;
    for (let i = 0; i < bars.length; i++) {
      // 左右声道同频段合并，频段从低到高，避免左右两半重复出现低音峰。
      const index = i * 2;
      const amplitude = (safe(samples[index]) + safe(samples[index + 1])
        + safe(samples[index + 64]) + safe(samples[index + 65])) / 4;
      peak = Math.max(peak, amplitude);
      const target = Math.min(1, Math.sqrt(amplitude) * window.wallpaperAudioSensitivity);
      levels[i] += (target - levels[i]) * (target > levels[i] ? .72 : .28);
      bars[i].style.transform = `scaleY(${Math.max(.035, levels[i])})`;
    }
    if (peak > .003) lastSignal = performance.now();
    const active = peak > .003 || performance.now() - lastSignal < 600;
    status.textContent = active ? '随音乐律动' : '等待音乐';
    host.dataset.active = String(active);
    // 音频回调有时会直接停止；归零计时器避免停歌后频谱冻结在最后一帧。
    clearTimeout(signalTimer); signalTimer = setTimeout(reset, 700);
  }
  new MutationObserver(() => { if (!enabled()) reset(); }).observe(root, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  reduced.addEventListener('change', () => { if (reduced.matches) reset(); });
  quiet();
  // 直接注册宿主音频回调，不另行采集麦克风，也不在浏览器中模拟音乐。
  if (typeof window.wallpaperRegisterAudioListener === 'function') window.wallpaperRegisterAudioListener(receive);
})();
