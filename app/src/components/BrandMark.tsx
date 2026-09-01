import Image from 'next/image';

/**
 * The one place TowConnect's logo is rendered.
 *
 * Navbar (desktop + mobile), footer and the auth screens all go through this
 * component. Everything below is a crop of the official artwork supplied by
 * the brand — nothing is redrawn, recoloured or re-lettered.
 *
 * WHY TWO ARRANGEMENTS
 * The official logo is a *stacked* lockup: the symbol above the word. Trimmed,
 * it is 1143x744 — roughly 1.5:1. Dropped into a 56px navbar at 28px tall it
 * would be 43px wide, and the word inside it about 6px tall: unreadable. So a
 * bar-height context gets the symbol and the word side by side, each at its own
 * natural proportions, and everywhere with vertical room gets the real stacked
 * lockup. Both are the supplied artwork; only the arrangement differs.
 */

const LOCKUP = { src: '/brand/towconnect-logo.png', width: 645, height: 420 };
const MARK = { src: '/brand/towconnect-mark.png', width: 256, height: 256 };
const WORDMARK = { src: '/brand/towconnect-wordmark.png', width: 703, height: 96 };

type Size = 'sm' | 'md' | 'lg';

export function BrandMark({
  size = 'sm',
  className = '',
}: {
  size?: Size;
  className?: string;
}) {
  if (size === 'sm') {
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        <Image
          {...MARK}
          alt=""
          aria-hidden
          priority
          className="h-[26px] w-auto min-[360px]:h-[28px] sm:h-[32px]"
        />
        <Image
          {...WORDMARK}
          alt="TowConnect"
          priority
          className="h-[13px] w-auto min-[360px]:h-[14px] sm:h-[16px]"
        />
      </span>
    );
  }

  return (
    <Image
      {...LOCKUP}
      alt="TowConnect"
      priority
      className={`w-auto ${size === 'lg' ? 'h-[84px] sm:h-[112px]' : 'h-[64px] sm:h-[76px]'} ${className}`}
    />
  );
}
