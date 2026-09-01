# TowConnect brand assets

## Where the official logo goes

`src/components/BrandMark.tsx` is the **single** place the app renders the
TowConnect logo — navbar (desktop and mobile), homepage hero, footer and the
auth screens all go through it.

To install the official logo:

1. Drop the file here as `towconnect-logo.svg` (preferred) or
   `towconnect-logo.png` (min. 512 px tall, transparent background).
2. In `src/components/BrandMark.tsx`, set

   ```ts
   const OFFICIAL_LOGO: LogoAsset | null = {
     src: '/brand/towconnect-logo.svg',
     width: <intrinsic width>,
     height: <intrinsic height>,
   };
   ```

Nothing else has to change. Until that constant is set, `BrandMark` renders a
typographic wordmark — deliberately *not* an invented pictorial mark, so no
generated logo ever competes with the real one.

## Favicon

`src/app/favicon.ico` is still the Next.js starter icon. Replace it with an
icon derived from the official logo at the same time.
