import { type ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'green' | 'red';
type Size = 'md' | 'lg';

const variantClasses: Record<Variant, string> = {
  primary: 'bg-orange text-white hover:bg-orange-dark',
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
