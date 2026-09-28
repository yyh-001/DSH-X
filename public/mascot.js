(() => {
  const assetRoot = new URL('./mascot/', document.currentScript.src);
  const host = document.createElement('aside');
  host.className = 'mascot';
  host.setAttribute('aria-label', '互动看板娘');
  host.innerHTML = `
    <button class="mascot-puppet" type="button" aria-label="互动看板娘">
      <svg viewBox="0 0 1254 1254" aria-hidden="true">
        <defs>
          <mask id="mascot-base-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><path d="M0 229Q35 207 55 227Q68 191 115 173Q180 154 188 181Q193 190 202 166Q244 124 312 130Q379 130 384 154Q390 168 412 163Q429 134 476 144Q543 145 561 184Q577 205 595 188Q615 175 657 195Q716 216 739 250Q743 280 764 274Q785 264 822 291Q873 329 886 371Q890 392 879 401Q872 413 896 420Q917 411 941 447Q974 497 982 533Q987 558 962 575Q975 571 993 602Q1028 655 1021 698Q1016 725 998 736C1064 835 1125 1057 1216 1095Q1174 1130 1114 1111Q1090 1120 1083 1112L1147 1254H0Z" fill="white" stroke="black" stroke-width="10" stroke-linejoin="round"/></mask>
          <clipPath id="mascot-ear-clip"><path d="M952 735L996 731C1064 835 1125 1057 1216 1095Q1174 1130 1114 1111Q1090 1120 1083 1112Q998 1112 968 1010Z"/></clipPath>
          <mask id="mascot-head-only" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><rect width="1254" height="1254" fill="white"/><path d="M980 735L996 731C1064 835 1125 1057 1216 1095Q1174 1130 1114 1111Q1090 1120 1083 1112Q998 1112 990 1010Z" fill="black"/></mask>
          <linearGradient id="mascot-eye" x2="1" y2="1"><stop stop-color="#141a32"/><stop offset="1" stop-color="#242b49"/></linearGradient>
        </defs>
        <g data-part="head">
          <g data-part="ear">
          <image class="mascot-light-layer" href="${assetRoot}base.png" width="1254" height="1254" mask="url(#mascot-base-mask)" clip-path="url(#mascot-ear-clip)"/>
          <image class="mascot-dark-layer" href="${assetRoot}base-dark-soft.png" width="1254" height="1254" mask="url(#mascot-base-mask)" clip-path="url(#mascot-ear-clip)"/>
          </g>
          <g mask="url(#mascot-head-only)">
          <image class="mascot-light-layer" href="${assetRoot}base.png" width="1254" height="1254" mask="url(#mascot-base-mask)"/>
          <image class="mascot-dark-layer" href="${assetRoot}base-dark-soft.png" width="1254" height="1254" mask="url(#mascot-base-mask)"/>
          </g>
          <g data-part="tuft"><image class="mascot-light-layer" href="${assetRoot}tuft.svg" width="1254" height="1254"/><image class="mascot-dark-layer" href="${assetRoot}tuft-dark.svg" width="1254" height="1254"/></g>
          <g data-part="bow"><image class="mascot-light-layer" href="${assetRoot}bow.svg" width="1254" height="1254"/><image class="mascot-dark-layer" href="${assetRoot}bow-dark.svg" width="1254" height="1254"/></g>
          <g data-part="gaze">
            <g transform="translate(206 760) rotate(18)"><g data-part="eye-left"><ellipse rx="61" ry="107" fill="url(#mascot-eye)"/><ellipse cx="-17" cy="-42" rx="10" ry="15" fill="white" opacity=".65"/></g><path data-part="lid-left" d="M-53 10Q0 -33 53 10" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
            <g transform="translate(631 908) rotate(18)"><g data-part="eye-right"><ellipse rx="57" ry="103" fill="url(#mascot-eye)"/><ellipse cx="-17" cy="-42" rx="9" ry="14" fill="white" opacity=".65"/></g><path data-part="lid-right" d="M-50 10Q0 -32 50 10" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
          </g>
          <g data-part="blush" opacity="0" fill="#f493ac"><ellipse cx="57" cy="892" rx="74" ry="36" transform="rotate(20 57 892)"/><ellipse cx="683" cy="1074" rx="68" ry="36" transform="rotate(20 683 1074)"/></g>
        </g>
      </svg>
    </button>`;
  document.body.append(host);
  const button = host.querySelector('button');
  const parts = Object.fromEntries([...host.querySelectorAll('[data-part]')].map(el => [el.dataset.part, el]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let failed = false;
  let frame = 0, last = 0, clock = 0, nextBlink = 2 + Math.random() * 3;
  let blinkStart = -10, reactionAt = -10, reactionTuft = 0, reactionBow = 0;
  let targetX = 0, targetY = 0, x = 0, y = 0, tuft = 0, velocity = 0, bow = 0, bowVelocity = 0;
  // Original fish rig, with independently sprung pose and expression channels.
  const springs = Object.fromEntries(Object.entries({ tilt: 0, lift: 0, squash: 1, left: 1, right: 1, smile: 0, ear: 0 })
    .map(([key, value]) => [key, { value, velocity: 0 }]));
  const playlist = ['curious', 'idle', 'thinking', 'idle', 'playful', 'idle', 'drowsy', 'sleeping', 'waking', 'idle'];
  let state = 'curious', stateAt = 0, stateUntil = 3.2, sequence = 0, hovering = false;
  function setState(next, duration) {
    state = next; stateAt = clock; stateUntil = clock + duration;
    host.dataset.state = next;
  }
  function spring(key, target, dt) {
    const channel = springs[key];
    // Substeps keep the damped oscillator stable on slower displays.
    const steps = Math.ceil(dt / .008), step = dt / steps;
    for (let i = 0; i < steps; i++) {
      channel.velocity += ((target - channel.value) * 110 - channel.velocity * 14) * step;
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
    // 眼球会被 tick 写 opacity（闭眼时淡出），静止态必须还原，否则暂停动画后可能留下没眼睛的脸
    for (const name of ['head','tuft','bow','ear','gaze','eye-left','eye-right']) { parts[name].removeAttribute('transform'); parts[name].removeAttribute('opacity'); }
    for (const name of ['lid-left','lid-right','blush']) parts[name].setAttribute('opacity','0');
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
    setState(state === 'sleeping' || state === 'drowsy' ? 'waking' : 'curious', 1.8);
  });
  button.addEventListener('pointerleave', () => { hovering = false; });
  let lastPet = -10;
  button.addEventListener('pointermove', event => {
    if (!active() || clock - lastPet < .3) return;
    const py = (event.clientY - rect.top) / rect.height;
    if (py < .45) { velocity += clamp(event.movementX || 0, -15, 15) * 2; lastPet = clock; }
  }, { passive: true });
  button.addEventListener('click', event => {
    if (!active()) return;
    const px = event.detail ? (event.clientX - rect.left) / rect.width : .4;
    const py = event.detail ? (event.clientY - rect.top) / rect.height : .4;
    // 点一下的反应交给一条两端归零的包络去带（以前是往弹簧里灌一次性冲量，呆毛和蝴蝶结会来回摆）
    reactionAt = clock;
    reactionTuft = py < .3 ? 1 : px > .73 ? .25 : .7;
    reactionBow = px > .73 ? 1 : py < .3 ? .25 : .6;
    setState('happy', 1.5);
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
    // 阻尼比 9/10 时回摆有一成多的过冲，收尾会「荡」两下；提到 13/14 后基本一次到位
    const tuftTarget = x * 7 + Math.sin(clock * 2.3) * 2 + reaction * 16 * reactionTuft;
    velocity += ((tuftTarget - tuft) * 65 - velocity * 13) * dt; tuft += velocity * dt;
    const bowTarget = -x * 5 + Math.sin(clock * 2.7 + 1) * 2.5 + reaction * 11 * reactionBow;
    bowVelocity += ((bowTarget - bow) * 75 - bowVelocity * 14) * dt; bow += bowVelocity * dt;
    if (clock >= stateUntil) {
      if (hovering) setState('curious', 2.4);
      else { sequence = (sequence + 1) % playlist.length; setState(playlist[sequence], playlist[sequence] === 'sleeping' ? 4 : 3.2); }
    }
    const age = clock - stateAt;
    let tilt = Math.sin(clock * .8) * 1.2, lift = Math.sin(clock * 1.6) * 4;
    let squash = 1, left = 1, right = 1, smile = 0;
    let lookX = x, lookY = y;
    switch (state) {
      case 'curious': tilt += 6; lift -= 9; left = 1.08; right = .82; break;
      case 'thinking': tilt -= 5; left = .65; right = .85; lookY -= .6; lookX += .35; break;
      case 'playful': tilt += Math.sin(age * 2.2) * 2; lift -= Math.sin(Math.min(age / 1.2, 1) * Math.PI) * 14; break;
      case 'drowsy': tilt += 4; lift += 10; left = right = .45; break;
      case 'sleeping': tilt += 6; lift += 16; left = right = .055; squash += Math.sin(age * 2) * .012; lookX = lookY = 0; break;
      case 'waking': lift -= 16 * Math.sin(Math.min(age / 1.8, 1) * Math.PI); left = right = 1.12; break;
      case 'happy': smile = 1; break;
    }
    tilt = spring('tilt', tilt, dt);
    lift = spring('lift', lift, dt);
    squash = spring('squash', squash, dt);
    left = spring('left', left, dt); right = spring('right', right, dt);
    smile = clamp(spring('smile', smile, dt), 0, 1);
    const angle = tilt + x * 2.4;
    const radians = angle * Math.PI / 180;
    const limit = (-host.offsetLeft - 3) * 1254 / (host.clientWidth || 1254);
    const edgeX = edgeY => 460 + Math.cos(radians) * (6 - 460) / squash - Math.sin(radians) * (edgeY - 1080) * squash;
    const shiftX = Math.min(x * 8, limit - Math.max(edgeX(229), edgeX(1254)));
    parts.head.setAttribute('transform', `translate(${shiftX} ${lift + y * 5 - reaction * 16}) rotate(${angle} 460 1080) translate(460 1080) scale(${1 / squash} ${squash}) translate(-460 -1080)`);
    parts.tuft.setAttribute('transform', `rotate(${tuft} 472 272)`);
    parts.ear.setAttribute('transform', `rotate(${spring('ear', -x * 2 + Math.sin(clock * 1.9) * 1.2 - bow * .22 + reaction * 4 * reactionTuft, dt)} 969 790)`);
    parts.bow.setAttribute('transform', `rotate(${bow} 1022 818)`);
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
    parts.blush.setAttribute('opacity', String(smile * .42));
    frame = requestAnimationFrame(tick);
  }
  // If the layer fails to load, keep the original illustration instead of a partial face.
  const base = new Image();
  base.onerror = () => { failed = true; sync(); host.remove(); const fallback = document.querySelector('.backdrop-character'); if (fallback) fallback.style.display = 'block'; };
  base.src = new URL('base.png', assetRoot).href;
  sync();
})();
