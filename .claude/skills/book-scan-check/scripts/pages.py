"""Side-by-side small views of whole pages, to check unnumbered pages, repeats, blanks.
Usage: python3 pages.py BOOK_DIR OUT.jpg 9 10 136 ...
"""
import sys
from PIL import Image, ImageDraw, ImageFont
book, out, ks = sys.argv[1], sys.argv[2], [int(k) for k in sys.argv[3:]]
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
except OSError: font = ImageFont.load_default()
cols = min(5, len(ks)); rows = (len(ks) + cols - 1) // cols
S = Image.new('RGB', (cols * 354, rows * 520), 'white'); d = ImageDraw.Draw(S)
for n, k in enumerate(ks):
    x, y = (n % cols) * 354, (n // cols) * 520
    S.paste(Image.open(f'{book}/p{k:03d}.jpg').resize((354, 500)), (x, y + 20)); d.text((x + 6, y - 2), f'#{k}', fill=(200, 0, 0), font=font)
S.save(out, quality=80)
