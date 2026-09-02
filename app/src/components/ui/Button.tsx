import { type ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'green' | 'red';
type Size = 'md' | 'lg';

// CONTRAST, MEASURED RATHER THAN ASSUMED
// White on the brand orange (#ff5c1a) is 3.09:1 — below WCAG AA's 4.5:1 for
// text this size, and the button it applies to is the one somebody presses at
// night, at the roadside, on a phone screen turned down. So the FILLED button
// uses the darker orange already in the palette (#cc4400, 4.78:1) and gets
// darker still on hover (#b33c00, 5.90:1). The brand orange is unchanged
// everywhere it carries no white text: badges, borders, links and accents on
// the dark ground all measure 6.2:1 as they are.
const variantClasses: Record<Variant, string> = {
  primary: 'bg-orange-dark text-white hover:bg-orange-deep',
  secondary: 'bg-night-3 text-text-2 border border-steel hover:border-orange hover:text-orange',
  green: 'bg-green text-white hover:brightness-110',
  red: 'bg-red text-white hover:brightness-110',
};

const sizeClasses: Record<Size, string> = {
  md: 'px-6 py-3 text-[15px] rounded-xl',
  lg: 'px-8 py-4 text-[17px] rounded-xl',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', full, className = '', children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={[
        'inline-flex items-center justify-center gap-2 font-semibold transition-all duration-200',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        full ? 'w-full' : '',
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </button>
  );
});
