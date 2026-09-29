"""把生成的分层总图（layer-sheet-*.png）按连通域拆成单件 PNG。

用法：python slice-layer-sheet.py <sheet.png> <输出目录>
总图要求：透明背景，部件互不接触（部件之间有透明空隙）。
输出：每个部件一张裁剪 PNG（保留全图坐标系信息打印在 stdout），供人工确认后再合成。
"""
import sys
from PIL import Image

def main():
    src, outdir = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    alpha = im.getchannel('A')
    # 缩小 4 倍做连通域标记，纯 Python 也够快；部件间空隙远大于 4px
    small = alpha.resize((w // 4, h // 4), Image.BOX)
    sw, sh = small.size
    pix = small.load()
    seen = bytearray(sw * sh)
    comps = []
    for start in range(sw * sh):
        if seen[start] or pix[start % sw, start // sw] < 8:
            continue
        queue = [start]
        seen[start] = 1
        minx, miny, maxx, maxy, area = sw, sh, 0, 0, 0
        while queue:
            i = queue.pop()
            x, y = i % sw, i // sw
            area += 1
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
            for nx, ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                if 0 <= nx < sw and 0 <= ny < sh:
                    j = ny * sw + nx
                    if not seen[j] and pix[nx, ny] >= 8:
                        seen[j] = 1
                        queue.append(j)
        comps.append((area, minx*4, miny*4, (maxx+1)*4, (maxy+1)*4))
    comps.sort(reverse=True)
    print(f'{src}: {w}x{h}, 部件 {len(comps)} 个（面积降序）')
    for n, (area, x0, y0, x1, y1) in enumerate(comps):
        print(f'  #{n}: bbox=({x0},{y0})-({x1},{y1}) size={x1-x0}x{y1-y0} small-area={area}')
    # 检查放大后的 bbox 是否互相重叠（不重叠才能按 bbox 直接归属像素）
    for a in range(len(comps)):
        for b in range(a + 1, len(comps)):
            _, ax0, ay0, ax1, ay1 = comps[a]
            _, bx0, by0, bx1, by1 = comps[b]
            if ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1:
                print(f'  ! bbox #{a} 与 #{b} 重叠，需要更细的归属')
    for n, (area, x0, y0, x1, y1) in enumerate(comps):
        if area < 40:
            continue
        crop = im.crop((x0, y0, x1, y1))
        # 边缘留 2px 透明边，避免裁到抗锯齿像素
        padded = Image.new('RGBA', (crop.width + 4, crop.height + 4), (0, 0, 0, 0))
        padded.paste(crop, (2, 2))
        out = f'{outdir}/piece-{n}.png'
        padded.save(out)
        print(f'  saved {out} ({padded.width}x{padded.height})')

if __name__ == '__main__':
    main()
