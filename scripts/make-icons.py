"""Generate the launcher's .ico / favicon set from assets/icon.png.

assets/icon.png is the master artwork (512x512, opaque).  Run:

    python scripts/make-icons.py                       # icons from the master
    python scripts/make-icons.py <raw.png>             # rebuild the master from raw art

The optional raw path is for character art delivered on a removed (black /
transparent) background: its background is painted white and the result
becomes assets/icon.png, so the icons can be regenerated without the original
file.
"""

from PIL import Image, ImageDraw
import struct
import sys
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "src", "assets")
MASTER = os.path.join(ASSETS, "icon.png")
MASTER_SIZE = 512

ICO_SIZES = [16, 32, 48, 64, 256]
TRAY_SIZES = [16, 20, 24, 32, 48]
FAVICON_PNG = 64

# Corner shape of the app tile: a plain rounded rectangle, like other desktop
# software. 微信 256px 的图标量出来圆角半径是 57px（22.3%），这里照它来。
# 之前按超椭圆（squircle）做：n 小的时候桌面快捷方式显得过圆，n 大了又发方，
# 都不像普通应用的图标。
CORNER_RADIUS = 0.223
SUPERSAMPLE = 4

# A pixel counts as removed background below FULL; up to BLEND it is an
# anti-aliased mix that gets faded into the new background.
FULL = 110
BLEND = 150

_MASKS = {}


def flood_background(img, limit=FULL):
    """Mark background pixels (dark and reachable from the border)."""
    w, h = img.size
    px = img.convert("RGB").load()
    outside = bytearray(w * h)
    stack = []
    for x in range(w):
        stack.append((x, 0))
        stack.append((x, h - 1))
    for y in range(h):
        stack.append((0, y))
        stack.append((w - 1, y))
    while stack:
        x, y = stack.pop()
        i = y * w + x
        if outside[i]:
            continue
        if max(px[x, y]) >= limit:
            continue
        outside[i] = 1
        if x:
            stack.append((x - 1, y))
        if x + 1 < w:
            stack.append((x + 1, y))
        if y:
            stack.append((x, y - 1))
        if y + 1 < h:
            stack.append((x, y + 1))
    return outside


def whiten(raw):
    """Paint the art's removed background white, feathering the cut edge."""
    rgb = raw.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    bg = flood_background(rgb)
    out = Image.new("RGB", (w, h), (255, 255, 255))
    op = out.load()
    for y in range(h):
        for x in range(w):
            if bg[y * w + x]:
                continue
            r, g, b = px[x, y]
            peak = max(r, g, b)
            edge = peak < BLEND and any(
                0 <= x + dx < w and 0 <= y + dy < h and bg[(y + dy) * w + x + dx]
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            )
            if edge:
                t = min(1.0, max(0.0, (peak - FULL) / (BLEND - FULL)))
                op[x, y] = tuple(int(t * c + (1 - t) * 255) for c in (r, g, b))
            else:
                op[x, y] = (r, g, b)
    return out


def corner_mask(size, ratio=CORNER_RADIUS):
    """Anti-aliased rounded-rectangle mask for one size (radius as a share of the edge)."""
    cached = _MASKS.get(size)
    if cached is not None:
        return cached
    big = size * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1),
        radius=max(1, round(big * ratio)),
        fill=255,
    )
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    _MASKS[size] = mask
    return mask


def fit(size, base):
    img = base.resize((size, size), Image.Resampling.LANCZOS)
    img.putalpha(corner_mask(size))
    return img


def bmp_dib(img):
    img = img.convert("RGBA")
    w, h = img.size
    xor = bytearray()
    and_row_bytes = ((w + 31) // 32) * 4
    and_mask = bytearray()
    px = img.load()
    for y in range(h - 1, -1, -1):
        and_row = bytearray(and_row_bytes)
        for x in range(w):
            r, g, b, a = px[x, y]
            xor.extend((b, g, r, a))
            if a < 32:
                and_row[x // 8] |= 0x80 >> (x % 8)
        and_mask.extend(and_row)
    header = struct.pack("<IIIHHIIIIII", 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
    return header + xor + and_mask


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def write_ico(path, sizes, base, png_size=None):
    entries = []
    for sz in sizes:
        frame = fit(sz, base)
        blob = png_bytes(frame) if png_size and sz == png_size else bmp_dib(frame)
        entries.append((sz, sz, blob))
    count = len(entries)
    offset = 6 + 16 * count
    header = struct.pack("<HHH", 0, 1, count)
    dirents = b""
    payload = b""
    for w, h, blob in entries:
        dirents += struct.pack(
            "<BBBBHHII",
            w if w < 256 else 0,
            h if h < 256 else 0,
            0, 0, 1, 32, len(blob), offset,
        )
        payload += blob
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header + dirents + payload)
    return os.path.getsize(path)


def main():
    raw_path = sys.argv[1] if len(sys.argv) > 1 else None
    if raw_path:
        tile = whiten(Image.open(raw_path)).resize((MASTER_SIZE, MASTER_SIZE), Image.Resampling.LANCZOS)
        tile.save(MASTER)
        print("master", MASTER, tile.size)

    base = Image.open(MASTER).convert("RGBA")
    fit(256, base).save(os.path.join(ASSETS, "dsh-preview.png"))
    # 托盘用的 PNG（带圆角/透明边）：Windows 用 tray.ico，mac/Linux 用这张
    fit(64, base).save(os.path.join(ASSETS, "tray.png"))
    # 管理页背景虚影用的大图（浏览器缩放要够清晰，favicon 的 64px 不够）
    base.save(os.path.join(ROOT, "src", "public", "icon.png"))
    write_ico(os.path.join(ASSETS, "dsh.ico"), ICO_SIZES, base, png_size=256)
    write_ico(os.path.join(ASSETS, "icon.ico"), ICO_SIZES, base, png_size=256)
    write_ico(os.path.join(ASSETS, "tray.ico"), TRAY_SIZES, base)
    for target in (os.path.join(ROOT, "src", "public"), os.path.join(ROOT, "docs")):
        write_ico(os.path.join(target, "favicon.ico"), ICO_SIZES, base, png_size=256)
        fit(FAVICON_PNG, base).save(os.path.join(target, "favicon.png"))
    for name in ("dsh.ico", "icon.ico", "tray.ico"):
        print(name, os.path.getsize(os.path.join(ASSETS, name)))


if __name__ == "__main__":
    main()
