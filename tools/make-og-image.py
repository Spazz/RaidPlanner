"""Regenerates og-image.png (1200x630) for the link previews. Run: python tools/make-og-image.py

Uses Pillow and fonts already on the machine (Barlow Condensed if installed, else Arial Narrow / Bahnschrift).
The anvil mark is the same path as the SVG in index.html (viewBox 0 0 48 48), flattened to a polygon.
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H, SS = 1200, 630, 2  # SS: supersample factor, downscaled at the end for smooth edges
BG, BG_DEEP, GOLD, EMBER, TEXT, MUTED = '#151618', '#1b1d1f', '#e0b53d', '#ffb35c', '#e4e6e3', '#8d918e'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'og-image.png')
FONT_DIRS = [r'C:\Windows\Fonts', os.path.expanduser(r'~\AppData\Local\Microsoft\Windows\Fonts')]


def font(names, size):
    for d in FONT_DIRS:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return ImageFont.truetype(p, size * SS)
    raise SystemExit('no usable font found among ' + ', '.join(names))


BOLD = ['BarlowCondensed-Bold.ttf', 'ARIALNB.TTF', 'bahnschrift.ttf']
REG = ['BarlowCondensed-Regular.ttf', 'ARIALN.TTF', 'bahnschrift.ttf']


def cubic(p0, p1, p2, p3, n=16):
    return [((1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t * t * p2[0] + t ** 3 * p3[0],
             (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t * t * p2[1] + t ** 3 * p3[1])
            for t in [i / n for i in range(1, n + 1)]]


def anvil_points():
    """The index.html path 'M5 26c0-2 1.6-3.6 3.6-3.6H42V30c0 2.2-1.8 4-4 4h-5.5l2.6 5H37v5H13v-5h4l2.6-5H17c-6.6 0-12-3.6-12-8Z',
    shifted by translate(0 -1)."""
    pts = [(5, 26)]
    cur = (5, 26)
    c = cubic(cur, (cur[0] + 0, cur[1] - 2), (cur[0] + 1.6, cur[1] - 3.6), (cur[0] + 3.6, cur[1] - 3.6)); pts += c; cur = c[-1]
    pts.append((42, cur[1])); cur = pts[-1]
    pts.append((42, 30)); cur = pts[-1]
    c = cubic(cur, (cur[0], cur[1] + 2.2), (cur[0] - 1.8, cur[1] + 4), (cur[0] - 4, cur[1] + 4)); pts += c; cur = c[-1]
    cur = (cur[0] - 5.5, cur[1]); pts.append(cur)
    cur = (cur[0] + 2.6, cur[1] + 5); pts.append(cur)
    pts.append((37, cur[1])); cur = pts[-1]
    cur = (cur[0], cur[1] + 5); pts.append(cur)
    pts.append((13, cur[1])); cur = pts[-1]
    cur = (cur[0], cur[1] - 5); pts.append(cur)
    cur = (cur[0] + 4, cur[1]); pts.append(cur)
    cur = (cur[0] + 2.6, cur[1] - 5); pts.append(cur)
    pts.append((17, cur[1])); cur = pts[-1]
    c = cubic(cur, (cur[0] - 6.6, cur[1]), (cur[0] - 12, cur[1] - 3.6), (cur[0] - 12, cur[1] - 8)); pts += c
    return [(x, y - 1) for x, y in pts]


def draw_mark(d, x, y, size, color=GOLD):
    k = size * SS / 48
    for cx, cy in [(9, 14), (16.5, 9), (24, 7), (31.5, 9), (39, 14)]:
        r = 3 * k
        d.ellipse([x * SS + cx * k - r, y * SS + cy * k - r, x * SS + cx * k + r, y * SS + cy * k + r], fill=EMBER)
    d.polygon([(x * SS + px * k, y * SS + py * k) for px, py in anvil_points()], fill=color)


# Colored class stripes and bar widths for the five party cards (the same look as the previous image).
CARDS = [
    ['#c69b6d', '#fff468', '#3fc7eb', '#c69b6d', '#fff468'],
    ['#aad372', '#0070dd', '#ff7c0a', '#aad372', '#0070dd'],
    ['#e6e6e6', '#8788ee', '#f48cba', '#e6e6e6', '#8788ee'],
    ['#3fc7eb', '#c69b6d', '#fff468', '#3fc7eb', '#c69b6d'],
    ['#ff7c0a', '#aad372', '#aad372', '#ff7c0a', '#aad372'],
]
WIDTHS = [[61, 105, 149, 83, 127], [83, 127, 61, 105, 149], [105, 149, 83, 127, 61], [138, 61, 105, 149, 83], [149, 83, 127, 61, 105]]


def main():
    img = Image.new('RGB', (W * SS, H * SS), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W * SS, 9 * SS], fill=GOLD)  # top accent bar

    draw_mark(d, 78, 58, 104)
    d.text((204 * SS, 82 * SS), 'WORLD OF WARCRAFT RAID PLANNER', font=font(BOLD, 27), fill=MUTED)
    d.text((76 * SS, 150 * SS), 'Raidsmith', font=font(BOLD, 150), fill=TEXT)
    d.text((80 * SS, 312 * SS), 'Forge optimal raid groups in one click.', font=font(REG, 44), fill=GOLD)
    d.text((80 * SS, 366 * SS), 'Buff coverage, one-click optimizer, live share links', font=font(REG, 36), fill=MUTED)

    label = font(BOLD, 21)
    for i in range(5):
        x0, y0 = 80 + i * 220, 450
        d.rectangle([x0 * SS, y0 * SS, (x0 + 200) * SS, (y0 + 140) * SS], fill=BG_DEEP, outline='#3a3d40', width=SS)
        d.text(((x0 + 12) * SS, (y0 + 9) * SS), f'GROUP {i + 1}', font=label, fill=MUTED)
        for row in range(5):
            ry = y0 + 36 + row * 20
            d.rectangle([(x0 + 12) * SS, ry * SS, (x0 + 15) * SS, (ry + 12) * SS], fill=CARDS[i][row])
            d.rectangle([(x0 + 24) * SS, ry * SS, (x0 + 24 + WIDTHS[i][row]) * SS, (ry + 12) * SS], fill='#34383b')

    img = img.resize((W, H), Image.LANCZOS)
    img.save(OUT, optimize=True)
    print('wrote', os.path.normpath(OUT), img.size)


if __name__ == '__main__':
    main()
