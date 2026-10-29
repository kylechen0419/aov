---
name: book-scan-check
description: Check a scanned book (vFlat or similar PDFs/images) for missing pages, repeated pages and pages too blurry to read, by looking at the pages yourself, and report what to delete or rescan. Use when someone sends scanned book PDFs or page images and asks to check them, or says to use "the checking method" from before.
---

# Checking a scanned book

The person scans thick books for a teacher (with the vFlat app on an iPhone) and hands the result in. What matters to them:
**every page is there, nothing is in twice, and every page can be read.** They want you to do the checking,
not to send pages back for them to confirm. Read the page numbers yourself; ask nothing about pages you can see.

Automatic page-number reading alone was not good enough on real scans (gray, thin running-head digits; footnotes full of
numbers). What worked is: scripts lay the pages out, **you read them by eye**, scripts point at blur suspects, **you look**.

## Steps

Scripts are in `scripts/` next to this file. Work in the scratchpad.

1. **Pages to images.** Uploads may come split in parts (the file is too big for one upload); pass the parts in order.
   A page repeated at a split is dropped automatically and is not a real repeat.
   `python3 scripts/prepare.py book part1.pdf part2.pdf`
   For image files instead of PDFs, copy them in name order to `book/p001.jpg …`.

2. **Look at the layout.** `python3 scripts/pages.py book look.jpg 1 5 11 12 50 51` and view it: where is the page
   number (top outer corner after the running head, foot of the page …), where does the numbered text start.

3. **Read every page number.** `python3 scripts/sheets.py book sheets` (add `--bottom` if numbers are at the foot),
   then view every sheet, 30 images each. For each image write down the number you read. Track the offset
   (image number − page number): it only changes at a missing page (offset drops), a repeat (offset rises), or front matter.
   Expect and accept without comment: cover/contents/preface before p.1, chapter title pages and the page after them
   with no printed number, blank pages at chapter ends, ads/back cover after the last page. They are fine as long as the
   offset around them works out.

4. **Confirm the doubtful ones by eye.** For every image without a readable number, and every suspected repeat or gap,
   view the whole pages: `python3 scripts/pages.py book check.jpg 9 10 136 16 18 …`. A repeat is the same content twice;
   if one copy has a finger or blur, say which to keep.

5. **Blur.** `python3 scripts/blurscan.py book blur` lists pages where part of the text is weaker than the rest of the
   page or the book, and saves full-resolution crops of each one's weakest area (`blur/worst*.jpg`). View them.
   Skip section-heading bars and chapter design pages (they rank high but are not blur). For real suspects, view the
   page large (crop the top/bottom half at ~0.75 scale) and decide: can every character be read? Half-page blur
   (one side out of focus) is the usual real problem.
   Uploads are often compressed, so the original is at least as sharp as what you see: soft-but-readable is fine.

6. **Report briefly, in plain Traditional Chinese.** Lead with the answer (all pages there or not), then only what to do:
   which image numbers to delete, which page numbers to rescan (with image number), optional soft pages. One line on
   what was normal (cover, chapter openers, blank pages). No tables of measurements, no long caveats.

## Example result (民法債編總論（上）, 447 images, p.1–434)

p.1–434 all present and in order. Images 18–19 repeated p.8–9 (delete them; image 17 has a finger in the margin only).
p.381 (image 391) right half out of focus → rescan. p.383 (image 393) slightly soft, readable. Images 1–8 front matter,
chapter openers unnumbered, p.126 and p.248 blank, 445–447 back matter.

## What not to do

- Don't build or push the person toward a web tool for this; on their phone it reloaded and lost progress, and it asked them
  to confirm too many pages. They gave up on it. Doing the check here is what they want.
- Don't trust automatic OCR results without looking: in the example run it reported 14 "missing" pages and 14 "repeats",
  only the p.8–9 repeat was real, the rest were misreads.
