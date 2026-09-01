import Image from 'next/image';

/**
 * The one place TowConnect's logo is rendered.
 *
 * Navbar (desktop + mobile), homepage hero, footer and the auth screens all
 * go through this component, so installing the official asset is a one-line
 * change here rather than a hunt through the app — see public/brand/README.md.
 *
 * Until that asset is in the repo, this renders a *typographic wordmark*.
 * That is deliberate: an invented pictorial mark would be a second logo
 * competing with the real one, which is exactly what we were told not to
 * create. A wordmark is the brand's own name set in the brand's own display
 * face — it cannot conflict with the logo it is standing in for.
 */

interface LogoAsset {
  src: string;
  width: number;
  height: number;
}

/**
 * TO INSTALL THE OFFICIAL LOGO: drop the file in `public/brand/` and return
 * it here, e.g.
 *
 *   return { src: '/brand/towconnect-logo.svg', width: 160, height: 32 };
 */
function officialLogo(): LogoAsset | null {
  return null;
}

type Size = 'sm' | 'md' | 'lg';

const wordmarkSize: Record<Size, string> = {
  sm: 'text-[14px] min-[360px]:text-[15px] sm:text-[19px] tracking-[-0.02em]',
  md: 'text-[21px] sm:text-2xl tracking-[-0.025em]',
  lg: 'text-[28px] sm:text-[38px] tracking-[-0.03em]',
};

const assetHeight: Record<Size, number> = { sm: 28, md: 36, lg: 52 };

export function BrandMark({
  size = 'sm',
  className = '',
}: {
  size?: Size;
  className?: string;
}) {
  const asset = officialLogo();

  if (asset) {
    const height = assetHeight[size];
    return (
      <Image
        src={asset.src}
        alt="TowConnect"
        width={Math.round((asset.width / asset.height) * height)}
        height={height}
        priority={size !== 'sm'}
        className={className}
      />
    );
  }

  return (
    <span
      className={`font-display font-extrabold leading-none select-none ${wordmarkSize[size]} ${className}`}
    >
      Tow<span className="text-orange">Connect</span>
    </span>
  );
}
