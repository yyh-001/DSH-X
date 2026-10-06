				// 侧栏列与底部输入区的底色：给「30% 透明」的主题色（水面只透一点，文字保持可读）。
				// 只涂自己没底色的容器（侧栏列、输入区外壳），已有底色的卡片不动；
				// 嵌套的匹配只涂最外层，避免两层 rgba 叠出更深的颜色。
				const paintPanels = () => {
					const bodyBg = getComputedStyle(document.body).backgroundColor;
					const translucent = bodyBg.startsWith('rgb(') ? 'rgba(' + bodyBg.slice(4, -1) + ', .7)' : 'rgba(255, 255, 255, .7)';
					for (const el of document.querySelectorAll('#root div')) {
						const rect = el.getBoundingClientRect();
						const sideCol = rect.x <= 8 && rect.width >= 40 && rect.width <= innerWidth * 0.3 && rect.height >= innerHeight * 0.85;
						const composerStrip = rect.bottom >= innerHeight - 24 && rect.height >= 60 && rect.height <= innerHeight * 0.3 && rect.width >= innerWidth * 0.5;
						if (!(sideCol || composerStrip)) continue;
						if (el.style.backgroundColor) continue;
						if (el.parentElement && el.parentElement.style.backgroundColor === translucent) continue;
						if (!isTransparent(getComputedStyle(el).backgroundColor)) continue;
						el.style.backgroundColor = translucent;
					}
				};
