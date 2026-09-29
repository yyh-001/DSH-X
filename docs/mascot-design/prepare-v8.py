"""从已生成的总图拆出四层；只按透明连通域归属，不重新绘制或拉伸部件。"""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
source = Image.open(ROOT / 'docs/mascot-design/layer-sheet-v8-no-outline.png').convert('RGBA')
alpha = source.getchannel('A')
for name, seed in [('head', (500, 500)), ('ear', (1300, 820)),
                   ('tuft', (1300, 180)), ('bow', (1300, 520))]:
    region = alpha.point(lambda a: 255 if a >= 8 else 0)
    ImageDraw.floodfill(region, seed, 128)
    # 头与呆毛的矩形包围盒有重叠，按连通域隔离，避免另一部件混进裁图。
    mask = region.point(lambda a: 255 if a == 128 else 0).filter(ImageFilter.MaxFilter(5))
    isolated = source.copy()
    isolated.putalpha(ImageChops.multiply(alpha, mask))
    box = isolated.getbbox()
    cropped = isolated.crop(box)
    output = ROOT / f'public/mascot/{name}-v8.png'
    cropped.save(output)
    print(name, box, cropped.size)
