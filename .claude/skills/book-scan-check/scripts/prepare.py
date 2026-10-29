"""Turn one or more scanned-book PDFs (in reading order) into book/p001.jpg, p002.jpg, ...

A page repeated across a split (last page of one part == first page of the next) is kept once.
Usage: python3 prepare.py OUT_DIR part1.pdf [part2.pdf ...]
"""
import glob, os, subprocess, sys, tempfile
from PIL import Image, ImageChops, ImageStat

out, pdfs = sys.argv[1], sys.argv[2:]
os.makedirs(out, exist_ok=True)

def same(a, b):
    a, b = Image.open(a).convert('L').resize((300, 420)), Image.open(b).convert('L').resize((300, 420))
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0] < 1.0

pages = []
with tempfile.TemporaryDirectory() as tmp:
    for n, pdf in enumerate(pdfs):
        subprocess.run(['pdftoppm', '-scale-to', '2000', '-jpeg', '-jpegopt', 'quality=90', pdf, f'{tmp}/{n:02d}'], check=True)
        part = sorted(glob.glob(f'{tmp}/{n:02d}-*.jpg'))
        if pages and part and same(pages[-1], part[0]):
            print(f'{pdf}: first page repeats the previous part, dropped')
            os.remove(part[0]); part = part[1:]
        pages += part
    for k, f in enumerate(pages, 1):
        os.replace(f, f'{out}/p{k:03d}.jpg')
print(f'{len(pages)} pages in {out}')
