"""把 v7 层图的各部件按目标锚点缩放摆到 1254x1254 rig 画布上。

canvas = sheet * S + (dx, dy)，每个部件一组 (S, 锚点)。
叠层顺序：ear → tuft → head → bow（呆毛和耳朵的根部都藏进头发后面）。
输出：public/mascot/ 四张紧裁剪 PNG（资产）+ Temp 下合成预览（含代码画的眼）。
"""
from PIL import Image, ImageDraw
import math, os, sys

SHEET = 'docs/mascot-design/layer-sheet-v7-no-eyes.png'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'public/mascot'
TMP = 'C:/Users/yyh/AppData/Local/Temp/mascot-v7'
CANVAS = 1254

# (名字, sheet 裁剪框, S, 锚点 sheet 点, 锚点 canvas 点)
PIECES = [
    ('head', (36, 64, 1076, 984),    1.15, (36, 64),     (-30, 200)),
    ('tuft', (1084, 88, 1468, 376),  1.15, (1390, 355),  (590, 310)),
    ('bow',  (1204, 424, 1424, 596), 1.15, (1314, 510),  (1180, 855)),
    ('ear',  (1168, 632, 1488, 944), 1.15, (1168, 632),  (1075, 855)),
]
# 眼睛（v6 实测迁移到 canvas）：半轴/倾角/中心
EYES = [((206, 760), 52, 90, 19), ((631, 908), 50, 87, 19)]
EYE_FILL = (26, 34, 62, 255)

# 素材导出尺寸保持不变；页面按原版轮廓独立排布，预览也使用同一套坐标。
RIG = {
    'head': (-365, 128, 1404, 1242),
    'tuft': (195, 15, 390, 292),
    'bow': (950, 715, 174, 136),
    'ear': (934, 742, 300, 293),
}

im = Image.open(SHEET).convert('RGBA')

def piece_layer(box, s, sp, cp, name):
    dx, dy = cp[0] - sp[0] * s, cp[1] - sp[1] * s
    crop = im.crop(box)
    nw, nh = round(crop.width * s), round(crop.height * s)
    scaled = crop.resize((nw, nh), Image.LANCZOS)
    if name == 'head':
        scaled = remove_specks(scaled)
    x0, y0 = round(box[0] * s + dx), round(box[1] * s + dy)
    return name, scaled, x0, y0

def remove_specks(img, min_area=400):
    """只保留最大连通域（生成图头件右上角有个小蓝点残留）。"""
    w, h = img.size
    a = img.getchannel('A').load()
    seen = bytearray(w * h)
    sizes = {}
    comp_id = [0] * (w * h)
    cid = 0
    for start in range(w * h):
        if seen[start] or a[start % w, start // w] < 8:
            continue
        cid += 1
        queue = [start]; seen[start] = 1; n = 0
        while queue:
            i = queue.pop(); n += 1; comp_id[i] = cid
            x, y = i % w, i // w
            for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if not seen[j] and a[nx, ny] >= 8:
                        seen[j] = 1; queue.append(j)
        sizes[cid] = n
    if not sizes: return img
    main = max(sizes, key=sizes.get)
    if sizes[main] == sum(sizes.values()): return img
    print(f'  [cleanup] 丢弃 {sum(sizes.values()) - sizes[main]}px 杂点（{len(sizes)-1} 块）')
    px = img.load()
    for i in range(w * h):
        if comp_id[i] and comp_id[i] != main:
            px[i % w, i // w] = (0, 0, 0, 0)
    return img

order = {'ear': 0, 'head': 1, 'tuft': 2, 'bow': 3}
placed = []
for name, box, s, sp, cp in PIECES:
    placed.append(piece_layer(box, s, sp, cp, name))

canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
for name, scaled, x0, y0 in sorted(placed, key=lambda p: order[p[0]]):
    x, y, w, h = RIG[name]
    canvas.alpha_composite(scaled.resize((w, h), Image.LANCZOS), (x, y))
    print(f'{name:5s} canvas rect ({x},{y})-({x+w},{y+h})')

# 预览：把代码要画的眼也画上（旋转椭圆 + 高光），只进预览不进资产
prev = canvas.copy()
d = ImageDraw.Draw(prev)
for (cx, cy), rx, ry, ang in EYES:
    t = math.radians(ang)
    pts = [(cx + rx * math.cos(i / 40 * 2 * math.pi) * math.cos(t) - ry * math.sin(i / 40 * 2 * math.pi) * math.sin(t),
            cy + rx * math.cos(i / 40 * 2 * math.pi) * math.sin(t) + ry * math.sin(i / 40 * 2 * math.pi) * math.cos(t))
           for i in range(41)]
    d.polygon(pts, fill=EYE_FILL)
    hx, hy = cx - 0.28 * rx * math.cos(t) - 0.42 * ry * math.sin(t), cy - 0.28 * rx * math.sin(t) + 0.42 * ry * math.cos(t)
    d.ellipse([hx - 9, hy - 9, hx + 9, hy + 9], fill=(255, 255, 255, 170))

os.makedirs(TMP, exist_ok=True)
for tag, bg in [('gray', (235, 235, 235, 255)), ('page', (228, 242, 250, 255))]:
    p = Image.new('RGBA', (CANVAS, CANVAS), bg)
    p.alpha_composite(prev)
    p.convert('RGB').save(f'{TMP}/composite-{tag}.png')

os.makedirs(OUT, exist_ok=True)
for name, scaled, x0, y0 in placed:
    scaled.save(f'{OUT}/{name}-v7.png')
    print(f'  saved {OUT}/{name}-v7.png  pos=({x0},{y0}) size=({scaled.width}x{scaled.height})')
