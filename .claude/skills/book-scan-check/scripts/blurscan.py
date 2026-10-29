"""Find pages where some part of the text is blurrier than the rest of the page or the book,
then save full-resolution crops of each suspect's weakest area for checking by eye.

Usage: python3 blurscan.py BOOK_DIR OUT_DIR [--top 30]
Prints the ranked suspects; writes OUT_DIR/worst1.jpg, worst2.jpg, ... (10 crops each).
Section-heading bars and chapter design pages show up too: skip them when looking.
"""
import glob, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from concurrent.futures import ProcessPoolExecutor

def cells(f):
    g = np.asarray(Image.open(f).convert('L'), dtype=np.float32); H, W = g.shape
    y0, x0 = int(H * .08), int(W * .08); g = g[y0:int(H * .9), x0:int(W * .92)]
    lap = np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]); h, w = lap.shape
    out = []
    for cy in range(6):
        for cx in range(3):
            c = lap[cy * h // 6:(cy + 1) * h // 6, cx * w // 3:(cx + 1) * w // 3]
            gc = g[cy * h // 6:(cy + 1) * h // 6, cx * w // 3:(cx + 1) * w // 3]
            if (gc < gc.max() - 80).mean() < .02 or (c > 10).sum() <= 200: continue   # no text here
            out.append((float(np.percentile(c[c > 10], 97)), x0 + cx * w // 3, y0 + cy * h // 6, w // 3, h // 6))
    return f, out

if __name__ == '__main__':
    book, out = sys.argv[1], sys.argv[2]
    top = int(sys.argv[sys.argv.index('--top') + 1]) if '--top' in sys.argv else 30
    os.makedirs(out, exist_ok=True)
    with ProcessPoolExecutor() as ex: res = list(ex.map(cells, sorted(glob.glob(f'{book}/p*.jpg'))))
    rows = []
    for f, cs in res:
        if len(cs) < 4: continue
        s = sorted(c[0] for c in cs); med = float(np.median(s))
        rows.append((int(os.path.basename(f)[1:4]), s[0], med, min(cs), f))
    bookmed = float(np.median([r[2] for r in rows]))
    rows.sort(key=lambda r: min(r[1] / max(1, r[2]), r[1] / bookmed))
    try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 24)
    except OSError: font = ImageFont.load_default()
    sus = rows[:top]
    for k, lo, med, _, _ in sus: print(f'#{k}: weakest {lo:.0f}, page median {med:.0f}, book median {bookmed:.0f}')
    for s in range(0, len(sus), 10):
        tiles = []
        for k, _, _, (_, x, y, cw, ch), f in sus[s:s + 10]:
            tiles.append((k, Image.open(f).crop((x, y, x + cw, y + ch)).resize((620, int(ch * 620 / cw)))))
        th = max(t.height for _, t in tiles)
        S = Image.new('RGB', (1260, 5 * (th + 28)), 'white'); d = ImageDraw.Draw(S)
        for n, (k, t) in enumerate(tiles):
            x, y = (n % 2) * 630, (n // 2) * (th + 28); S.paste(t, (x, y + 26)); d.text((x + 4, y), f'#{k}', fill=(200, 0, 0), font=font)
        S.save(f'{out}/worst{s // 10 + 1}.jpg', quality=88)
