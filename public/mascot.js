(() => {
  const host = document.createElement('aside');
  host.className = 'mascot';
  host.setAttribute('aria-label', '互动看板娘');
  host.innerHTML = `
    <button class="mascot-puppet" type="button" aria-label="互动看板娘">
      <svg viewBox="0 0 1254 1254" aria-hidden="true">
        <defs>
          <mask id="mascot-base-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><path d="M0 229Q35 207 55 227Q68 191 115 173Q180 154 188 181Q193 190 202 166Q244 124 312 130Q379 130 384 154Q390 168 412 163Q429 134 476 144Q543 145 561 184Q577 205 595 188Q615 175 657 195Q716 216 739 250Q743 280 764 274Q785 264 822 291Q873 329 886 371Q890 392 879 401Q872 413 896 420Q917 411 941 447Q974 497 982 533Q987 558 962 575Q975 571 993 602Q1028 655 1021 698Q1016 725 998 736C1064 835 1125 1057 1216 1095Q1174 1130 1114 1111Q1090 1120 1083 1112L1147 1254H0Z" fill="white" stroke="black" stroke-width="10" stroke-linejoin="round"/></mask>
          <linearGradient id="mascot-eye" x2="1" y2="1"><stop stop-color="#141a32"/><stop offset="1" stop-color="#242b49"/></linearGradient>
        </defs>
        <g data-part="head">
          <image class="mascot-light-layer" href="/mascot/base.png" width="1254" height="1254" mask="url(#mascot-base-mask)"/>
          <image class="mascot-dark-layer" href="/mascot/base-dark-soft.png" width="1254" height="1254" mask="url(#mascot-base-mask)"/>
          <g data-part="tuft"><image class="mascot-light-layer" href="/mascot/tuft.svg" width="1254" height="1254"/><image class="mascot-dark-layer" href="/mascot/tuft-dark.svg" width="1254" height="1254"/></g>
          <g data-part="bow"><image class="mascot-light-layer" href="/mascot/bow.svg" width="1254" height="1254"/><image class="mascot-dark-layer" href="/mascot/bow-dark.svg" width="1254" height="1254"/></g>
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
  let blinkStart = -10, happyUntil = 0, swayStart = -10;
  let targetX = 0, targetY = 0, x = 0, y = 0, tuft = 0, velocity = 0, bow = 0, bowVelocity = 0;
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
    for (const name of ['head','tuft','bow','gaze','eye-left','eye-right']) parts[name].removeAttribute('transform');
    for (const name of ['lid-left','lid-right','blush']) parts[name].setAttribute('opacity','0');
  }
  function sync() {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    if (active()) frame = requestAnimationFrame(tick);
    else neutral();
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
  let lastPet = -10;
  button.addEventListener('pointermove', event => {
    if (!active() || clock - lastPet < .3) return;
    const py = (event.clientY - rect.top) / rect.height;
    if (py < .45) { velocity += clamp(event.movementX || 0, -15, 15) * 2; lastPet = clock; }
  }, { passive: true });
  // 点击回应：闭眼呼一口气，外加一次缓慢的左右晃动。不再给 tuft/bow 灌角速度、
  // 头部也不位移，所以不会像以前那样抖一下。
  button.addEventListener('click', () => {
    if (!active()) return;
    happyUntil = clock + 1.15;
    swayStart = clock;
  });
  function tick(now) {
    if (!active()) { frame = 0; return; }
    const dt = last ? Math.min((now - last) / 1000, .035) : 1 / 60;
    last = now; clock += dt;
    const ease = 1 - Math.exp(-dt * 7);
    x += (targetX - x) * ease; y += (targetY - y) * ease;
    // 点击后的晃动：1.8s 内两个来回，振幅由两端归零的 sin 包络给出，起手和收尾都从 0
    // 平滑过渡，所以没有突然的位移。呆毛和蝴蝶结跟着这个包络走弹簧（而不是灌一次性的
    // 角速度），既有跟随和回摆，又不会抖。
    const swayAge = clock - swayStart;
    const sway = swayAge > 0 && swayAge < 1.8
      ? Math.sin(swayAge / 1.8 * Math.PI) * Math.sin(swayAge / 1.05 * Math.PI * 2) * 2.4
      : 0;
    const tuftTarget = x * 7 + Math.sin(clock * 2.3) * 2 + sway * 2.8;
    velocity += ((tuftTarget - tuft) * 65 - velocity * 9) * dt; tuft += velocity * dt;
    const bowTarget = -x * 5 + Math.sin(clock * 2.7 + 1) * 2.5 - sway * 2.2;
    bowVelocity += ((bowTarget - bow) * 75 - bowVelocity * 10) * dt; bow += bowVelocity * dt;
    parts.head.setAttribute('transform', `translate(${x * 8} ${Math.sin(clock * 1.6) * 3 + y * 5}) rotate(${x * 2.4 + sway} 460 1080)`);
    parts.tuft.setAttribute('transform', `rotate(${tuft} 472 272)`);
    parts.bow.setAttribute('transform', `rotate(${bow} 1022 818)`);
    parts.gaze.setAttribute('transform', `translate(${x * 19} ${y * 13})`);
    if (clock >= nextBlink) { blinkStart = clock; nextBlink = clock + 2.6 + Math.random() * 4; }
    const blinkAge = clock - blinkStart;
    const blink = blinkAge < .19 ? 1 - Math.sin(blinkAge / .19 * Math.PI) * .97 : 1;
    const happy = clock < happyUntil;
    for (const side of ['left','right']) {
      parts[`eye-${side}`].setAttribute('transform', `scale(1 ${happy ? 0 : Math.max(.03,blink)})`);
      parts[`lid-${side}`].setAttribute('opacity', happy ? '1' : '0');
    }
    parts.blush.setAttribute('opacity', happy ? '.42' : '0');
    frame = requestAnimationFrame(tick);
  }
  // If the layer fails to load, keep the original illustration instead of a partial face.
  const base = new Image();
  base.onerror = () => { failed = true; sync(); host.remove(); document.querySelector('.backdrop-character').style.display = 'block'; };
  base.src = '/mascot/base.png';
  sync();
})();
