"""Render docs/hero.png — the banner at the top of the README.

    python scripts/make-hero.py

Style follows the docs landing page and the launcher: the same pale blue radial
gradient, the app icon with a soft shadow, and the product name in the accent
blue.  The icon comes from assets/icon.png, so regenerating the icon and
re-running this keeps the banner in sync.
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(ROOT, "assets", "icon.png")
OUT = os.path.join(ROOT, "docs", "hero.png")

W, H = 1536, 1024
# Same stops as the landing page's .backdrop:
# radial-gradient(ellipse at 25% 10%, #f1fbff, #d9eaf7 65%, #d2e3f5)
STOPS = [(0.0, (241, 251, 255)), (0.65, (217, 234, 247)), (1.0, (210, 227, 245))]
CENTER = (0.25, 0.10)
TITLE_COLOR = (59, 111, 224)
TAGLINE_COLOR = (107, 125, 156)
SHADOW_COLOR = (86, 122, 180)
ICON_SIZE = 320
TITLE = "DSH-X"
TAGLINE = "官方原版 Web 启动器"
FONT_ROOT = r"C:\Windows\Fonts" if os.name == "nt" else "/mnt/c/Windows/Fonts"
TITLE_FONT = os.path.join(FONT_ROOT, "segoeuib.ttf")
TAGLINE_FONT = os.path.join(FONT_ROOT, "MiSans-Regular.otf")


def rounded_icon(size):
    """assets/icon.png is the square master; reuse make-icons.py's corner mask."""
    spec = importlib.util.spec_from_file_location("make_icons", os.path.join(ROOT, "scripts", "make-icons.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.fit(size, Image.open(ICON).convert("RGBA"))


def _mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _sample(t):
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t <= t1 or i == len(STOPS) - 2:
            k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return _mix(c0, c1, max(0.0, min(1.0, k)))
    return STOPS[-1][1]


def radial_bg(size):
    """CSS `radial-gradient(ellipse at CX CY, ...)` with the default farthest-corner
    size: draw at low res, then upscale — a full-res per-pixel loop is far too slow."""
    cx, cy = size[0] * CENTER[0], size[1] * CENTER[1]
    dx, dy = size[0] - cx, size[1] - cy
    # radii that put the farthest corner exactly on the gradient's 100% stop
    k = ((dx / size[0]) ** 2 + (dy / size[1]) ** 2) ** 0.5
    rx, ry = k * size[0], k * size[1]

    small = Image.new("RGB", (size[0] // 8, size[1] // 8))
    px = small.load()
    sw, sh = small.size
    for y in range(sh):
        for x in range(sw):
            d = (((x + 0.5) * 8 - cx) / rx) ** 2 + (((y + 0.5) * 8 - cy) / ry) ** 2
            px[x, y] = _sample(min(1.0, d ** 0.5))
    return small.resize(size, Image.Resampling.BILINEAR)


def drop_shadow(icon, blur=28, offset=(0, 16), alpha=70):
    """Soft shadow so the white icon tile lifts off the pale blue background."""
    pad = blur * 3
    w, h = icon.size
    mask = icon.getchannel("A").point(lambda v: v * alpha // 255)
    solid = Image.new("RGBA", (w, h), SHADOW_COLOR + (0,))
    solid.putalpha(mask)
    canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    canvas.paste(solid, (pad + offset[0], pad + offset[1]), solid)
    return canvas.filter(ImageFilter.GaussianBlur(blur)), pad


def main():
    base = radial_bg((W, H))

    icon = rounded_icon(512).resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
    x = (W - ICON_SIZE) // 2
    icon_y = 196

    shadow, pad = drop_shadow(icon)
    base.paste(shadow, (x - pad, icon_y - pad), shadow)
    base.paste(icon, (x, icon_y), icon)

    draw = ImageDraw.Draw(base)
    title_font = ImageFont.truetype(TITLE_FONT, 132)

    box = draw.textbbox((0, 0), TITLE, font=title_font)
    # 有小字时标题放偏上一点，没有小字就整体居中（+74 是给标题上方留的呼吸位）
    title_y = icon_y + ICON_SIZE + (74 if TAGLINE else 118) - box[1]
    draw.text(((W - (box[2] - box[0])) / 2 - box[0], title_y), TITLE, font=title_font, fill=TITLE_COLOR)

    # 副标题默认不画（TAGLINE 留空即可）；想加就填一行文案，位置会自动跟到标题下面
    if TAGLINE:
        tag_font = ImageFont.truetype(TAGLINE_FONT, 44)
        tag_box = draw.textbbox((0, 0), TAGLINE, font=tag_font)
        draw.text(
            ((W - (tag_box[2] - tag_box[0])) / 2 - tag_box[0], title_y + box[3] + 42),
            TAGLINE,
            font=tag_font,
            fill=TAGLINE_COLOR,
        )

    base.save(OUT)
    print("hero", OUT, base.size, os.path.getsize(OUT))


if __name__ == "__main__":
    main()
