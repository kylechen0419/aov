"""Contact sheets of the page-number areas, 30 images per sheet, for reading page numbers by eye.

Each row: image number | top-left corner | top-right corner. Use --bottom for books numbered at the foot.
Usage: python3 sheets.py BOOK_DIR OUT_DIR [--bottom] [--band 0.09]
"""
import glob, os, sys
from PIL import Image, ImageDraw, ImageFont

book, out = sys.argv[1], sys.argv[2]
bottom = '--bottom' in sys.argv
band = float(sys.argv[sys.argv.index('--band') + 1]) if '--band' in sys.argv else 0.09
os.makedirs(out, exist_ok=True)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
except OSError: font = ImageFont.load_default()
files = sorted(glob.glob(f'{book}/p*.jpg'))

def tile(k, f):
    im = Image.open(f).convert('L'); W, H = im.size
    b = im.crop((0, int(H * (1 - band)), W, H) if bottom else (0, 0, W, int(H * band)))
    h = int(b.height * 300 / (W * .36))
    l = b.crop((0, 0, int(W * .36), b.height)).resize((300, h))
    r = b.crop((int(W * .64), 0, W, b.height)).resize((300, h))
    t = Image.new('L', (680, h), 255); t.paste(l, (70, 0)); t.paste(r, (380, 0))
    d = ImageDraw.Draw(t); d.text((4, h // 2 - 12), str(k), fill=0, font=font); d.line((375, 0, 375, h), fill=128)
    return t

for s in range(0, len(files), 30):
    ts = [tile(k, f) for k, f in enumerate(files[s:s + 30], s + 1)]
    rows = (len(ts) + 1) // 2; h = ts[0].height
    S = Image.new('L', (2 * 680 + 20, rows * (h + 4)), 200)
    for n, t in enumerate(ts): S.paste(t, ((n // rows) * 700, (n % rows) * (h + 4)))
    S.save(f'{out}/s{s // 30 + 1:02d}.jpg', quality=85)
print(f'{(len(files) + 29) // 30} sheets in {out}')
