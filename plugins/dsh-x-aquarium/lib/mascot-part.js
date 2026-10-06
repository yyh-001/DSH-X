		// ---- 看板娘：自启动器 public/mascot.js 移植（分层 rig + 弹簧 + 情绪轮播 + 注视/眨眼）。
		// 去掉需要接收鼠标的部分（悬停/摸头/点击反应）——她在 dsh 页面是装饰，不挡操作，
		// 但注视、眨眼、呆毛/耳/蝴蝶结的跟随和情绪轮播都保留。
		const MASCOT_IMAGES = {
			head8: "__M_HEAD8__", head9: "__M_HEAD9__",
			ear8: "__M_EAR8__", ear9: "__M_EAR9__",
			tuft8: "__M_TUFT8__", tuft9: "__M_TUFT9__",
			bow8: "__M_BOW8__", bow9: "__M_BOW9__",
		};
		const MASCOT_STYLE = `
#dshx-aquarium .dshx-mascot { position: absolute; left: -6vh; bottom: -5vh; width: min(72vh, 92vw); aspect-ratio: 1; }
#dshx-aquarium .dshx-mascot svg { display: block; width: 100%; height: 100%; overflow: visible; opacity: .9; }
#dshx-aquarium .dshx-mascot [data-part] { will-change: transform; }
#dshx-aquarium .dshx-mascot .dshx-dark-layer { display: none; }
#dshx-aquarium[data-dshx-night="1"] .dshx-mascot .dshx-light-layer { display: none; }
#dshx-aquarium[data-dshx-night="1"] .dshx-mascot .dshx-dark-layer { display: inline; }
@media (prefers-reduced-motion: reduce) { #dshx-aquarium .dshx-mascot { display: none; } }
`;
		function startMascot(host) {
			const image = (cls, src, rect) => `<image class="${cls}" href="${src}" x="${rect[0]}" y="${rect[1]}" width="${rect[2]}" height="${rect[3]}"/>`;
			host.innerHTML = `
<svg viewBox="0 0 1254 1254" aria-hidden="true">
	<defs>
		<linearGradient id="dshx-mascot-eye" x2="1" y2="1"><stop stop-color="#141a32"/><stop offset="1" stop-color="#242b49"/></linearGradient>
	</defs>
	<g data-part="head">
		<g data-part="ear">${image('dshx-light-layer', MASCOT_IMAGES.ear8, [871, 843, 413, 368])}${image('dshx-dark-layer', MASCOT_IMAGES.ear9, [871, 843, 413, 368])}</g>
		${image('dshx-light-layer', MASCOT_IMAGES.head8, [-325, 198, 1398.6, 1225.8])}
		${image('dshx-dark-layer', MASCOT_IMAGES.head9, [-325, 198, 1398.6, 1225.8])}
		<g data-part="tuft">${image('dshx-light-layer', MASCOT_IMAGES.tuft8, [250, 70, 410, 293.894])}${image('dshx-dark-layer', MASCOT_IMAGES.tuft9, [250, 70, 410, 293.894])}</g>
		<g data-part="bow">${image('dshx-light-layer', MASCOT_IMAGES.bow8, [896, 827, 230, 175])}${image('dshx-dark-layer', MASCOT_IMAGES.bow9, [896, 827, 230, 175])}</g>
		<g data-part="gaze">
			<g transform="translate(246 830) rotate(19)"><g data-part="eye-left"><ellipse rx="52" ry="90" fill="url(#dshx-mascot-eye)"/><ellipse cx="-14" cy="-35" rx="9" ry="13" fill="white" opacity=".65"/></g><path data-part="lid-left" d="M-46 8Q0 -30 46 8" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
			<g transform="translate(671 978) rotate(19)"><g data-part="eye-right"><ellipse rx="50" ry="87" fill="url(#dshx-mascot-eye)"/><ellipse cx="-13" cy="-34" rx="8" ry="12" fill="white" opacity=".65"/></g><path data-part="lid-right" d="M-44 8Q0 -29 44 8" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
		</g>
	</g>
</svg>`;
			const parts = Object.fromEntries([...host.querySelectorAll('[data-part]')].map((el) => [el.dataset.part, el]));
			const reduced = matchMedia('(prefers-reduced-motion: reduce)');
			let frame = 0, last = 0, clock = 0, nextBlink = 2 + Math.random() * 3;
			let blinkStart = -10, blinkDuration = .23, doubleBlinkAt = Infinity, nextGlance = 1.5;
			let glanceX = 0, glanceY = 0, gazeX = 0, gazeY = 0, pointerAt = -10;
			let targetX = 0, targetY = 0, x = 0, y = 0;
			const defaults = { tilt: 0, lift: 0, squash: 1, left: 1, right: 1, smile: 0, ear: 0, tuft: 0, bow: 0, energy: 1, droop: 0 };
			const springs = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { value, velocity: 0 }]));
			const playlist = ['curious', 'idle', 'thinking', 'idle', 'playful', 'idle', 'drowsy', 'sleeping', 'waking', 'idle'];
			let state = 'curious', stateAt = 0, stateUntil = 3.2, sequence = 0;
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
			function setState(next, duration) {
				if (next === 'waking' && (state === 'sleeping' || state === 'drowsy')) {
					blinkStart = clock; blinkDuration = .38; nextBlink = clock + 2; doubleBlinkAt = Infinity;
				}
				state = next; stateAt = clock; stateUntil = clock + duration;
			}
			function spring(key, target, dt, stiffness = 110, damping = 21) {
				const channel = springs[key];
				const steps = Math.ceil(dt / .008), step = dt / steps;
				for (let i = 0; i < steps; i++) {
					channel.velocity += ((target - channel.value) * stiffness - channel.velocity * damping) * step;
					channel.value += channel.velocity * step;
				}
				return channel.value;
			}
			const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
			const active = () => !reduced.matches && !document.hidden;
			function neutral() {
				for (const [key, channel] of Object.entries(springs)) { channel.value = defaults[key]; channel.velocity = 0; }
				x = y = 0;
				gazeX = gazeY = glanceX = glanceY = 0;
				nextGlance = clock + 1.5; nextBlink = clock + 2; doubleBlinkAt = Infinity; pointerAt = -10;
				for (const name of ['head', 'tuft', 'bow', 'ear', 'gaze', 'eye-left', 'eye-right']) { parts[name].removeAttribute('transform'); parts[name].removeAttribute('opacity'); }
				for (const name of ['lid-left', 'lid-right']) { parts[name].setAttribute('opacity', '0'); parts[name].removeAttribute('transform'); }
			}
			function sync() {
				cancelAnimationFrame(frame); frame = 0; last = 0;
				if (active()) frame = requestAnimationFrame(tick);
				else neutral();
			}
			reduced.addEventListener('change', sync);
			document.addEventListener('visibilitychange', sync);
			window.addEventListener('pointermove', (event) => {
				if (!active() || event.pointerType === 'touch') return;
				pointerAt = clock;
				const rect = host.getBoundingClientRect();
				targetX = clamp((event.clientX - rect.left - rect.width * .4) / (innerWidth * .55), -1, 1);
				targetY = clamp((event.clientY - rect.top - rect.height * .62) / (innerHeight * .55), -1, 1);
			}, { passive: true });
			window.addEventListener('blur', () => { targetX = 0; targetY = 0; });
			function tick(now) {
				if (!active()) { frame = 0; return; }
				const dt = last ? Math.min((now - last) / 1000, .035) : 1 / 60;
				last = now; clock += dt;
				const ease = 1 - Math.exp(-dt * 7);
				x += (targetX - x) * ease; y += (targetY - y) * ease;
				if (clock >= stateUntil) {
					sequence = (sequence + 1) % playlist.length;
					setState(playlist[sequence], playlist[sequence] === 'sleeping' ? 4 : 3.2);
				}
				const age = clock - stateAt;
				let tilt = Math.sin(clock * .8) * 1.2, lift = Math.sin(clock * 1.6) * 4;
				let squash = 1, left = 1, right = 1, smile = 0;
				if (clock >= nextGlance) {
					glanceX = (Math.random() - .5) * .65;
					glanceY = (Math.random() - .5) * .35;
					nextGlance = clock + 1.8 + Math.random() * 3;
				}
				const attention = clamp(1 - (clock - pointerAt - 1.5) / 2, 0, 1);
				let lookX = targetX * attention + glanceX * (1 - attention);
				let lookY = targetY * attention + glanceY * (1 - attention);
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
				const inertia = clamp(-springs.tilt.velocity * .09, -2.5, 2.5);
				const tuftTarget = mood.tuft + x * 4 * energy + breath * 1.6 * energy - droop * 9
					+ inertia + play * 4 + stretch * 3;
				const tuft = spring('tuft', clamp(tuftTarget, -13, 13), dt, 65, 17);
				const earTarget = mood.ear - x * 3 * energy + Math.sin(clock * 1.6 - .45) * 1.5 * energy
					+ droop * 6 + inertia * .7 - play * 2 - stretch * 2;
				const ear = spring('ear', clamp(earTarget, -8, 10), dt, 55, 16);
				const bowTarget = mood.bow + ear * .35 + breath * .5 * energy - droop * 3;
				const bow = spring('bow', clamp(bowTarget, -7, 7), dt, 85, 19);
				const angle = tilt + x * 2.4;
				const shiftX = x * 8;
				parts.head.setAttribute('transform', `translate(${shiftX} ${lift + y * 5}) rotate(${angle} 440 1385) translate(440 1385) scale(${1 / squash} ${squash}) translate(-440 -1385)`);
				parts.tuft.setAttribute('transform', `rotate(${tuft} 505 350)`);
				parts.ear.setAttribute('transform', `rotate(${ear} 990 920)`);
				const earRadians = ear * Math.PI / 180;
				parts.bow.setAttribute('transform', `translate(${28 * (Math.cos(earRadians) - 1)} ${28 * Math.sin(earRadians)}) rotate(${bow} 1018 920)`);
				const gazeEase = 1 - Math.exp(-dt * (state === 'drowsy' ? 5 : 18));
				gazeX += (clamp(lookX, -1, 1) * 22 - gazeX) * gazeEase;
				gazeY += (clamp(lookY, -1, 1) * 15 - gazeY) * gazeEase;
				parts.gaze.setAttribute('transform', `translate(${gazeX} ${gazeY})`);
				if (state !== 'sleeping' && (clock >= nextBlink || clock >= doubleBlinkAt)) {
					const second = clock >= doubleBlinkAt;
					blinkStart = clock;
					blinkDuration = state === 'drowsy' ? .48 : second ? .19 : .23;
					doubleBlinkAt = !second && state !== 'drowsy' && Math.random() < .18 ? clock + .34 : Infinity;
					nextBlink = clock + (state === 'drowsy' ? 1.8 : 2.8) + Math.random() * 3.5;
				}
				for (const side of ['left', 'right']) {
					const phase = (clock - blinkStart - (side === 'right' ? .012 : 0)) / blinkDuration;
					const smooth = (t) => t * t * (3 - 2 * t);
					const blink = phase < 0 || phase >= 1 ? 1
						: phase < .3 ? 1 - smooth(phase / .3)
						: phase < .42 ? 0 : smooth((phase - .42) / .58);
					const open = (side === 'left' ? left : right) * blink * (1 - smile);
					const eyeShown = clamp((open - .12) / .18, 0, 1);
					const width = 1 + Math.max(0, 1 - open) * .045;
					parts[`eye-${side}`].setAttribute('transform', `scale(${width} ${Math.max(.02, open)})`);
					parts[`eye-${side}`].setAttribute('opacity', String(eyeShown));
					parts[`lid-${side}`].setAttribute('opacity', String(1 - eyeShown));
					const half = side === 'left' ? 46 : 44;
					const curve = 5 - smile * 35;
					parts[`lid-${side}`].setAttribute('d', `M-${half} 8Q0 ${curve} ${half} 8`);
				}
				frame = requestAnimationFrame(tick);
			}
			sync();
		}
