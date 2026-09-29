(() => {
  const assetRoot = new URL('./mascot/', document.currentScript.src);
  const host = document.createElement('aside');
  host.className = 'mascot';
  host.setAttribute('aria-label', '互动看板娘');
  // v8（蓝发，浅色）/ v9（黑白，深色）分层素材（docs/mascot-design/）：同位矩形，
  // 靠 mascot.css 的 light/dark 类切换。ear 在头图层后面（发锁从主头发后面伸出），
  // bow 画在头图层上面、整只可见（对齐旧版观感：约 200x201、结心 (1028,820)）；
  // 眼睛仍由代码画（素材是无眼版）；完整头件向左延伸，以保留原版探头构图。
  // ear 按旧版可见范围拟合（1.15 倍，发锁尖 (1216,1095)、上端从发带右端下探出）。
  host.innerHTML = `
    <button class="mascot-puppet" type="button" aria-label="互动看板娘">
      <svg viewBox="0 0 1254 1254" aria-hidden="true">
        <defs>
          <linearGradient id="mascot-eye" x2="1" y2="1"><stop stop-color="#141a32"/><stop offset="1" stop-color="#242b49"/></linearGradient>
        </defs>
        <g data-part="head">
          <g data-part="ear">
            <image class="mascot-light-layer" href="${assetRoot}ear-v8.png" x="871" y="863" width="413" height="368"/>
            <image class="mascot-dark-layer" href="${assetRoot}ear-v9.png" x="871" y="863" width="413" height="368"/>
          </g>
          <image class="mascot-light-layer" href="${assetRoot}head-v8.png" x="-325" y="218" width="1398.6" height="1225.8"/>
          <image class="mascot-dark-layer" href="${assetRoot}head-v9.png" x="-325" y="218" width="1398.6" height="1225.8"/>
          <g data-part="tuft">
            <image class="mascot-light-layer" href="${assetRoot}tuft-v8.png" x="250" y="90" width="410" height="293.894"/>
            <image class="mascot-dark-layer" href="${assetRoot}tuft-v9.png" x="250" y="90" width="410" height="293.894"/>
          </g>
          <g data-part="bow">
            <image class="mascot-light-layer" href="${assetRoot}bow-v8.png" x="896" y="847" width="230" height="175"/>
            <image class="mascot-dark-layer" href="${assetRoot}bow-v9.png" x="896" y="847" width="230" height="175"/>
          </g>
          <g data-part="gaze">
            <g transform="translate(246 850) rotate(19)"><g data-part="eye-left"><ellipse rx="52" ry="90" fill="url(#mascot-eye)"/><ellipse cx="-14" cy="-35" rx="9" ry="13" fill="white" opacity=".65"/></g><path data-part="lid-left" d="M-46 8Q0 -30 46 8" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
            <g transform="translate(671 998) rotate(19)"><g data-part="eye-right"><ellipse rx="50" ry="87" fill="url(#mascot-eye)"/><ellipse cx="-13" cy="-34" rx="8" ry="12" fill="white" opacity=".65"/></g><path data-part="lid-right" d="M-44 8Q0 -29 44 8" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
          </g>
        </g>
      </svg>
    </button>`;
  document.body.append(host);
  const button = host.querySelector('button');
  const parts = Object.fromEntries([...host.querySelectorAll('[data-part]')].map(el => [el.dataset.part, el]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let failed = false;
  let frame = 0, last = 0, clock = 0, nextBlink = 2 + Math.random() * 3;
  let blinkStart = -10, reactionAt = -10, reactionTuft = 0, reactionBow = 0, reactionEar = 0;
  let targetX = 0, targetY = 0, x = 0, y = 0, pet = 0;
  // Original rig, with independently sprung pose and expression channels.
  const defaults = { tilt: 0, lift: 0, squash: 1, left: 1, right: 1, smile: 0, ear: 0, tuft: 0, bow: 0, energy: 1, droop: 0 };
  const springs = Object.fromEntries(Object.entries(defaults)
    .map(([key, value]) => [key, { value, velocity: 0 }]));
  const playlist = ['curious', 'idle', 'thinking', 'idle', 'playful', 'idle', 'drowsy', 'sleeping', 'waking', 'idle'];
  let state = 'curious', stateAt = 0, stateUntil = 3.2, sequence = 0, hovering = false;
  // 配件共享情绪与呼吸节奏，再用不同阻尼产生先后关系；睡眠时不能还像清醒时一样摆动。
  const moods = {
    idle: { energy: .65, tuft: 0, ear: 0, bow: 0 },
    curious: { energy: .85, tuft: 3, ear: -2, bow: -1 },
    thinking: { energy: .3, tuft: -4, ear: 2, bow: 1 },
    playful: { energy: 1.2, tuft: 2, ear: -2, bow: 1 },
    happy: { energy: .9, tuft: 4, ear: -3, bow: -2 },
    drowsy: { energy: .2, tuft: -2, ear: 1, bow: 1 },
    sleeping: { energy: .06, tuft: 0, ear: 0, bow: 0 },
    waking: { energy: .7, tuft: 4, ear: -3, bow: -1 },
  };
  let previewState = '';
  // 状态选择只在独立预览页开放，不影响管理页的自动播放与交互。
  if (location.pathname === '/mascot-preview.html') host.addEventListener('mascot-preview-state', event => {
    previewState = Object.hasOwn(moods, event.detail) ? event.detail : '';
    setState(previewState || 'idle', previewState ? Infinity : 3.2);
  });
  function setState(next, duration) {
    state = next; stateAt = clock; stateUntil = clock + duration;
    host.dataset.state = next;
  }
  function spring(key, target, dt, stiffness = 110, damping = 21) {
    const channel = springs[key];
    // Substeps keep the damped oscillator stable on slower displays.
    const steps = Math.ceil(dt / .008), step = dt / steps;
    for (let i = 0; i < steps; i++) {
      channel.velocity += ((target - channel.value) * stiffness - channel.velocity * damping) * step;
      channel.value += channel.velocity * step;
    }
    return channel.value;
  }
  host.dataset.state = state;
  let rect = host.getBoundingClientRect();
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const active = () => !failed && !reduced.matches && !document.hidden
    && !document.documentElement.classList.contains('reduce-motion')
    && !document.documentElement.classList.contains('big-fish-hidden')
    && !document.body.classList.contains('subpage-open');
  const refreshRect = () => { rect = host.getBoundingClientRect(); };
  new ResizeObserver(refreshRect).observe(host);
  window.addEventListener('resize', refreshRect);
  function neutral() {
    // 清空积存的速度，恢复动画时从静止姿态进入，避免暂停前的甩动突然重放。
    for (const [key, channel] of Object.entries(springs)) { channel.value = defaults[key]; channel.velocity = 0; }
    x = y = pet = 0; reactionAt = blinkStart = -10; hovering = false;
    // 眼球会被 tick 写 opacity（闭眼时淡出），静止态必须还原，否则暂停动画后可能留下没眼睛的脸
    for (const name of ['head','tuft','bow','ear','gaze','eye-left','eye-right']) { parts[name].removeAttribute('transform'); parts[name].removeAttribute('opacity'); }
    for (const name of ['lid-left','lid-right']) parts[name].setAttribute('opacity','0');
  }
  function sync() {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    if (active()) frame = requestAnimationFrame(tick);
    else { neutral(); relax(); }
  }
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('pointermove', event => {
    if (!active() || event.pointerType === 'touch') return;
    targetX = clamp((event.clientX - rect.left - rect.width * .4) / (innerWidth * .55), -1, 1);
    targetY = clamp((event.clientY - rect.top - rect.height * .62) / (innerHeight * .55), -1, 1);
  }, { passive: true });
  const relax = () => { targetX = 0; targetY = 0; };
  document.documentElement.addEventListener('pointerleave', relax);
  window.addEventListener('blur', relax);
  button.addEventListener('pointerenter', () => {
    if (!active()) return;
    hovering = true;
    if (!previewState) setState(state === 'sleeping' || state === 'drowsy' ? 'waking' : 'curious', 1.8);
  });
  button.addEventListener('pointerleave', () => { hovering = false; });
  let lastPet = -10;
  button.addEventListener('pointermove', event => {
    if (!active() || clock - lastPet < .3) return;
    const py = (event.clientY - rect.top) / rect.height;
    if (py < .45) { pet = clamp(pet + (event.movementX || 0) * .2, -4, 4); lastPet = clock; }
  }, { passive: true });
  button.addEventListener('click', event => {
    if (!active()) return;
    const px = event.detail ? (event.clientX - rect.left) / rect.width : .4;
    const py = event.detail ? (event.clientY - rect.top) / rect.height : .4;
    // 点一下的反应交给一条两端归零的包络去带（以前是往弹簧里灌一次性冲量，呆毛和蝴蝶结会来回摆）
    reactionAt = clock;
    reactionTuft = py < .3 ? 1 : px > .73 ? .25 : .7;
    reactionBow = px > .73 ? 1 : py < .3 ? .25 : .6;
    // 毛耳朵在右下：点右边它摆最猛，点头顶只是被带动
    reactionEar = px > .73 ? .9 : py < .3 ? .2 : .55;
    if (!previewState) setState(state === 'sleeping' || state === 'drowsy' ? 'waking' : 'happy', 1.5);
  });
  /** 点击反应包络：0.9s 内「甩出去—收回来」，两端都归零，不产生过冲。 */
  const reactionAmount = age => age >= 0 && age < .9 ? Math.sin(age / .9 * Math.PI) : 0;
  function tick(now) {
    if (!active()) { frame = 0; return; }
    const dt = last ? Math.min((now - last) / 1000, .035) : 1 / 60;
    last = now; clock += dt;
    const ease = 1 - Math.exp(-dt * 7);
    x += (targetX - x) * ease; y += (targetY - y) * ease;
    const reaction = reactionAmount(clock - reactionAt);
    if (!previewState && clock >= stateUntil) {
      if (hovering) setState('curious', 2.4);
      else { sequence = (sequence + 1) % playlist.length; setState(playlist[sequence], playlist[sequence] === 'sleeping' ? 4 : 3.2); }
    }
    const age = clock - stateAt;
    let tilt = Math.sin(clock * .8) * 1.2, lift = Math.sin(clock * 1.6) * 4;
    let squash = 1, left = 1, right = 1, smile = 0;
    let lookX = x, lookY = y;
    // 状态→配件配合：犯困/睡着时呆毛、蝴蝶结、毛耳朵一起垂下来，醒来/好奇时精神起来（经弹簧平滑，不跳变）
    let droopTarget = 0;
    switch (state) {
      case 'curious': tilt += 6; lift -= 9; left = 1.08; right = .82; droopTarget = -.3; break;
      case 'thinking': tilt -= 5; left = .65; right = .85; lookY -= .6; lookX += .35; break;
      case 'playful': tilt += Math.sin(age * 2.2) * 2; lift -= Math.sin(Math.min(age / 1.2, 1) * Math.PI) * 14; break;
      case 'drowsy': tilt += 4; lift += 10; left = right = .45; droopTarget = .45; break;
      case 'sleeping': tilt += 6; lift += 16; left = right = .055; squash += Math.sin(age * 2) * .012; lookX = lookY = 0; droopTarget = 1; break;
      case 'waking': lift -= 16 * Math.sin(Math.min(age / 1.8, 1) * Math.PI); left = right = 1.12; droopTarget = -.55; break;
      case 'happy': smile = 1; droopTarget = -.25; break;
    }
    const droop = spring('droop', droopTarget, dt);
    const mood = moods[state];
    const energy = spring('energy', mood.energy, dt);
    tilt = spring('tilt', tilt, dt);
    lift = spring('lift', lift, dt);
    squash = spring('squash', squash, dt);
    left = spring('left', left, dt); right = spring('right', right, dt);
    smile = clamp(spring('smile', smile, dt), 0, 1);
    const breath = Math.sin(clock * 1.6);
    const play = state === 'playful' ? Math.sin(age * 3.6) * Math.sin(Math.min(age / 3.2, 1) * Math.PI) : 0;
    const stretch = state === 'waking' ? Math.sin(Math.min(age / 1.8, 1) * Math.PI) : 0;
    pet *= Math.exp(-dt * 5);
    // 头部转动先牵动根部，软配件稍后跟上；限幅保证根部始终藏在接缝内。
    const inertia = clamp(-springs.tilt.velocity * .09, -2.5, 2.5);
    const tuftTarget = mood.tuft + x * 4 * energy + breath * 1.6 * energy - droop * 9
      + inertia + pet + play * 4 + stretch * 3 + reaction * 9 * reactionTuft;
    const tuft = spring('tuft', clamp(tuftTarget, -13, 13), dt, 65, 17);
    const earTarget = mood.ear - x * 3 * energy + Math.sin(clock * 1.6 - .45) * 1.5 * energy
      + droop * 6 + inertia * .7 - play * 2 - stretch * 2
      + reactionAmount(clock - reactionAt - .08) * 6 * reactionEar;
    const ear = spring('ear', clamp(earTarget, -8, 10), dt, 55, 16);
    // 蝴蝶结跟随耳根的小幅位移，并保留自身较快的回位，避免看起来像悬浮在旁边。
    const bowTarget = mood.bow + ear * .35 + breath * .5 * energy - droop * 3
      + reactionAmount(clock - reactionAt - .13) * 5 * reactionBow;
    const bow = spring('bow', clamp(bowTarget, -7, 7), dt, 85, 19);
    const angle = tilt + x * 2.4;
    const shiftX = x * 8;
    parts.head.setAttribute('transform', `translate(${shiftX} ${lift + y * 5 - reaction * 16}) rotate(${angle} 440 1405) translate(440 1405) scale(${1 / squash} ${squash}) translate(-440 -1405)`);
    parts.tuft.setAttribute('transform', `rotate(${tuft} 505 370)`);
    parts.ear.setAttribute('transform', `rotate(${ear} 990 940)`);
    const earRadians = ear * Math.PI / 180;
    parts.bow.setAttribute('transform', `translate(${28 * (Math.cos(earRadians) - 1)} ${28 * Math.sin(earRadians)}) rotate(${bow} 1018 940)`);
    parts.gaze.setAttribute('transform', `translate(${clamp(lookX, -1, 1) * 24} ${clamp(lookY, -1, 1) * 17})`);
    if (clock >= nextBlink) { blinkStart = clock; nextBlink = clock + 2.6 + Math.random() * 4; }
    const blinkAge = clock - blinkStart;
    const blink = blinkAge < .19 ? 1 - Math.sin(blinkAge / .19 * Math.PI) * .97 : 1;
    for (const side of ['left','right']) {
      // 开心时眼睛闭成笑脸弧（∩ 形），眨眼、打瞌睡、睡着同理；
      // 闭眼过程让整只眼球淡出、只留这条弧——眼球若被压成细缝，会和弧叠在同一处变成「两条线」
      const open = (side === 'left' ? left : right) * blink * (1 - smile);
      const eyeShown = clamp((open - .12) / .18, 0, 1);
      parts[`eye-${side}`].setAttribute('transform', `scale(1 ${Math.max(.02, open)})`);
      parts[`eye-${side}`].setAttribute('opacity', String(eyeShown));
      parts[`lid-${side}`].setAttribute('opacity', String(1 - eyeShown));
    }
    frame = requestAnimationFrame(tick);
  }
  // 任一分层加载失败就整个退回原静态插画，不留一张缺件的脸（浅/深两套都要在）。
  const layers = ['head-v8.png', 'tuft-v8.png', 'bow-v8.png', 'ear-v8.png', 'head-v9.png', 'tuft-v9.png', 'bow-v9.png', 'ear-v9.png'];
  for (const file of layers) {
    const probe = new Image();
    probe.onerror = () => {
      failed = true; sync(); host.remove();
      const fallback = document.querySelector('.backdrop-character');
      if (fallback) fallback.style.display = 'block';
    };
    probe.src = new URL(file, assetRoot).href;
  }
  sync();
})();
