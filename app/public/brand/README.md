# TowConnect brand assets

The official logo is installed. Everything in this folder is a **crop of the
supplied artwork** — nothing here was redrawn, recoloured or re-lettered.

| File | What it is | Used by |
|---|---|---|
| `towconnect-logo.png` | full stacked lockup (symbol above word) | hero, auth screens, footer, Open Graph card |
| `towconnect-wordmark.png` | the word only | navbar, beside the mark |
| `towconnect-mark.png` | the pin only | navbar, and the source of every icon |

`src/components/BrandMark.tsx` is the only component that renders any of them.

## Regenerating from the master

The master supplied by the brand is a **1254 × 1254 RGBA WebP with a transparent
background**. These crop boxes were measured from its alpha channel; use them to
produce any other size without re-measuring:

| Asset | Crop box on the 1254² master |
|---|---|
| full lockup | `(57, 202) → (1200, 946)` |
| wordmark | `(57, 790) → (1200, 946)` |
| mark (pin) | `(442, 200) → (806, 648)`, then padded 6% into a square |

Keep the master archived outside `public/` — it is the source, not an asset the
site should serve.

## Icons

Generated from `towconnect-mark.png`, and living in `src/app/` because that is
where Next.js picks them up:

- `favicon.ico` — 16 + 32 + 48 px in one file
- `icon.png` — 256 px, transparent
- `apple-icon.png` — 180 px, flattened onto `#0d0d0d` (iOS composites onto an
  opaque tile regardless, so the brand picks the colour rather than the OS)

The **pin alone**, not the whole logo: the full symbol turns to mush below 48 px.

## Open Graph

`src/app/opengraph-image.jpg` and `twitter-image.jpg`, 1200 × 630. Composed from
the lockup plus two lines set in the site's own faces. Regenerate them if the
tagline or the service area changes.

## If a vector master turns up

An `.svg` or a larger render would sharpen the very large sizes. Drop it in,
re-cut with the boxes above, and nothing in the code has to change.
