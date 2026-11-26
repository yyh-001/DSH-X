#!/usr/bin/env python3
"""Render the README hero banners (light/dark × zh/en):

    python scripts/make-hero.py

Outputs:
    docs/hero-zh-light.png  (also copied to docs/hero.png)
    docs/hero-zh-dark.png
    docs/hero-en-light.png  (also copied to docs/hero-en.png)
    docs/hero-en-dark.png

Minimalist 1920×760 wide banner: subtle dot-grid + ambient glow backdrop,
brand lockup and concise value proposition on the left, and a single clean
frameless rounded app window emerging gracefully on the right.
"""

from __future__ import annotations

import io
import importlib.util
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'
ICON = ROOT / 'src' / 'assets' / 'icon.png'
FONT_ROOT = Path(r'C:\Windows\Fonts')

W, H = 1920, 760
BANNER_RADIUS = 24


def load_font(size: int, weight: int = 400, en: bool = False) -> ImageFont.FreeTypeFont:
    if en:
        name = 'segoeuib.ttf' if weight >= 650 else ('seguisb.ttf' if weight >= 550 else 'segoeui.ttf')
        path = FONT_ROOT / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    vf = FONT_ROOT / 'NotoSansSC-VF.ttf'
    if vf.exists():
        font = ImageFont.truetype(str(vf), size)
        try:
            font.set_variation_by_axes([weight])
        except Exception:
            pass
        return font
    fallback = FONT_ROOT / ('msyhbd.ttc' if weight >= 600 else 'msyh.ttc')
    return ImageFont.truetype(str(fallback), size)


def rounded_icon(size: int) -> Image.Image:
    spec = importlib.util.spec_from_file_location('make_icons', ROOT / 'scripts' / 'make-icons.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.fit(512, Image.open(ICON).convert('RGBA')).resize((size, size), Image.Resampling.LANCZOS)


def load_shot(name: str) -> Image.Image:
    # 工作区里的截图才是刚拍的；只有文件不在磁盘上时才回退到 HEAD 里的版本。
    # （反过来先读 HEAD 会让重拍过的截图被悄悄忽略，主图继续用旧的那张。）
    local = DOCS / 'screenshots' / name
    if local.exists():
        return Image.open(local).convert('RGBA')
    raw = subprocess.check_output(
        ['git', 'show', f'HEAD:docs/screenshots/{name}'],
        cwd=ROOT,
        stderr=subprocess.DEVNULL,
    )
    return Image.open(io.BytesIO(raw)).convert('RGBA')


def make_rounded_mask(w: int, h: int, r: int, ss: int = 4) -> Image.Image:
    hi = Image.new('L', (w * ss, h * ss), 0)
    ImageDraw.Draw(hi).rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=r * ss, fill=255)
    return hi.resize((w, h), Image.Resampling.LANCZOS)


def make_backdrop(dark: bool) -> Image.Image:
    top = (15, 20, 34) if dark else (244, 248, 255)
    bottom = (11, 15, 25) if dark else (232, 240, 254)
    grad = Image.linear_gradient('L').resize((W, H), Image.Resampling.BILINEAR)
    bg = Image.composite(
        Image.new('RGBA', (W, H), bottom + (255,)),
        Image.new('RGBA', (W, H), top + (255,)),
        grad,
    )

    # 柔和环境光晕（右上偏蓝主光 + 左下极淡提亮）
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    if dark:
        gd.ellipse((740, -280, 2040, 760), fill=(62, 108, 232, 66))
        gd.ellipse((-260, 240, 780, 1080), fill=(48, 86, 180, 42))
    else:
        gd.ellipse((760, -260, 2060, 760), fill=(116, 166, 255, 62))
        gd.ellipse((-240, -180, 820, 560), fill=(255, 255, 255, 160))
    bg.alpha_composite(glow.filter(ImageFilter.GaussianBlur(140)))

    # 极克制的工程感微点阵（仅作背景肌理，不喧宾夺主）
    dots = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    dot_color = (148, 176, 230, 26) if dark else (77, 107, 254, 24)
    step = 32
    for y in range(24, H, step):
        for x in range(24, W, step):
            dd.ellipse((x - 1, y - 1, x + 1, y + 1), fill=dot_color)
    bg.alpha_composite(dots)
    return bg


def make_clean_window(src: Image.Image, target_w: int, dark: bool, radius: int = 16) -> Image.Image:
    """纯净圆角应用窗口：不套黑壳、不加假标题栏，仅柔和圆角 + 1px 玻璃感描边。"""
    scale = target_w / src.width
    target_h = round(src.height * scale)
    resized = src.resize((target_w, target_h), Image.Resampling.LANCZOS)

    mask = make_rounded_mask(target_w, target_h, radius)
    win = Image.new('RGBA', (target_w, target_h), (0, 0, 0, 0))
    win.paste(resized, (0, 0), mask)

    ss = 4
    border_hi = Image.new('RGBA', (target_w * ss, target_h * ss), (0, 0, 0, 0))
    border_color = (255, 255, 255, 44) if dark else (22, 35, 61, 24)
    ImageDraw.Draw(border_hi).rounded_rectangle(
        (0, 0, target_w * ss - 1, target_h * ss - 1),
        radius=radius * ss,
        outline=border_color,
        width=ss,
    )
    win.alpha_composite(border_hi.resize((target_w, target_h), Image.Resampling.LANCZOS))
    return win


def draw_pill(canvas: Image.Image, x: int, y: int, text: str, font: ImageFont.FreeTypeFont, dark: bool) -> int:
    draw = ImageDraw.Draw(canvas)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    pw = tw + 34
    ph = 40
    pill_bg = (255, 255, 255, 16) if dark else (255, 255, 255, 195)
    pill_border = (255, 255, 255, 34) if dark else (77, 107, 254, 42)
    text_color = (212, 224, 246, 235) if dark else (45, 66, 108, 240)

    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle((x, y, x + pw, y + ph), radius=20, fill=pill_bg, outline=pill_border, width=1)
    canvas.alpha_composite(layer)

    draw = ImageDraw.Draw(canvas)
    draw.text((x + pw // 2, y + ph // 2), text, fill=text_color, font=font, anchor='mm')
    return pw


def render_variant(lang: str, dark: bool) -> Image.Image:
    en = lang == 'en'
    canvas = make_backdrop(dark)

    # 右侧：单张纯净无壳圆角窗口，从右下方自然探出，呼吸感充足
    if dark:
        shot_name = 'screenshot-home-dark-en.jpg' if en else 'screenshot-launches.png'
    else:
        shot_name = 'screenshot-home-en.jpg' if en else 'screenshot-home.jpg'

    win = make_clean_window(load_shot(shot_name), target_w=1080, dark=dark, radius=18)
    wx, wy = 890, 92

    # 柔和双层环境阴影
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (wx - 4, wy + 24, wx + win.width + 4, wy + win.height + 24),
        radius=18,
        fill=(6, 12, 28, 160 if dark else 54),
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(38)))

    near = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(near).rounded_rectangle(
        (wx, wy + 8, wx + win.width, wy + win.height + 8),
        radius=18,
        fill=(6, 12, 28, 95 if dark else 26),
    )
    canvas.alpha_composite(near.filter(ImageFilter.GaussianBlur(12)))
    canvas.alpha_composite(win, (wx, wy))

    # 左侧品牌与定位区
    lx = 104
    icon_size = 84
    icon_y = 148
    icon = rounded_icon(icon_size)
    ishadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(ishadow).rounded_rectangle(
        (lx, icon_y + 10, lx + icon_size, icon_y + icon_size + 10),
        radius=20,
        fill=(22, 48, 112, 85 if dark else 52),
    )
    canvas.alpha_composite(ishadow.filter(ImageFilter.GaussianBlur(16)))
    canvas.alpha_composite(icon, (lx, icon_y))

    draw = ImageDraw.Draw(canvas)
    accent = (108, 152, 255, 255) if dark else (59, 111, 224, 255)
    title_color = (248, 250, 252, 255) if dark else (15, 23, 42, 255)
    sub_color = (182, 196, 222, 235) if dark else (71, 85, 105, 240)
    foot_color = (130, 146, 174, 195) if dark else (112, 128, 154, 210)

    brand_font = load_font(68, weight=700, en=True)
    draw.text((lx + icon_size + 26, icon_y + icon_size // 2 - 2), 'DSH-X', fill=title_color, font=brand_font, anchor='lm')

    if en:
        kicker_font = load_font(34, weight=600, en=True)
        sub_font = load_font(23, weight=400, en=True)
        pill_font = load_font(18, weight=500, en=True)
        foot_font = load_font(17, weight=400, en=True)

        draw.text((lx, 286), 'DeepSeek Harness Launcher', fill=accent, font=kicker_font)
        draw.text((lx, 354), 'Multi-instance isolation, built-in plugin market,', fill=sub_color, font=sub_font)
        draw.text((lx, 390), 'WSL / SSH remotes, and mobile control.', fill=sub_color, font=sub_font)

        px = lx
        for label in ('Multi-Instance', 'Plugin Market', 'WSL & SSH', 'Mobile PWA'):
            w = draw_pill(canvas, px, 466, label, pill_font, dark)
            px += w + 12

        draw = ImageDraw.Draw(canvas)
        draw.text((lx, 566), 'Windows · macOS · Linux  ·  MIT Open Source', fill=foot_color, font=foot_font)
    else:
        kicker_font = load_font(36, weight=700, en=False)
        sub_font = load_font(24, weight=400, en=False)
        pill_font = load_font(18, weight=500, en=False)
        foot_font = load_font(18, weight=400, en=False)

        draw.text((lx, 286), 'DeepSeek Harness 启动器', fill=accent, font=kicker_font)
        draw.text((lx, 356), '多实例环境隔离、在线插件与技能市场，', fill=sub_color, font=sub_font)
        draw.text((lx, 394), '支持本机、WSL / SSH 远端与手机随时遥控。', fill=sub_color, font=sub_font)

        px = lx
        for label in ('多实例隔离', '插件市场', 'WSL / SSH', '手机远程'):
            w = draw_pill(canvas, px, 470, label, pill_font, dark)
            px += w + 12

        draw = ImageDraw.Draw(canvas)
        draw.text((lx, 568), 'Windows · macOS · Linux  ·  社区开源（非 DeepSeek 官方产品）', fill=foot_color, font=foot_font)

    # 整体圆角裁切 + 极细外描边
    mask = make_rounded_mask(W, H, BANNER_RADIUS)
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), mask)

    ss = 2
    border_hi = Image.new('RGBA', (W * ss, H * ss), (0, 0, 0, 0))
    border_color = (255, 255, 255, 28) if dark else (22, 35, 61, 18)
    ImageDraw.Draw(border_hi).rounded_rectangle(
        (0, 0, W * ss - 1, H * ss - 1),
        radius=BANNER_RADIUS * ss,
        outline=border_color,
        width=ss,
    )
    out.alpha_composite(border_hi.resize((W, H), Image.Resampling.LANCZOS))
    return out


def main() -> None:
    for lang in ('zh', 'en'):
        for dark in (False, True):
            theme = 'dark' if dark else 'light'
            img = render_variant(lang, dark)
            dest = DOCS / f'hero-{lang}-{theme}.png'
            img.save(dest, optimize=True)
            print(f'wrote {dest.relative_to(ROOT)}')
            if not dark:
                compat = DOCS / ('hero-en.png' if lang == 'en' else 'hero.png')
                img.save(compat, optimize=True)


if __name__ == '__main__':
    main()
