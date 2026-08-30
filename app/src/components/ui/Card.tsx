import type { HTMLAttributes } from 'react';

export function Card({
  className = '',
  orange = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { orange?: boolean }) {
  return (
    <div
      className={[
        'bg-night-2 border rounded-[20px] p-6',
        orange ? 'border-orange' : 'border-steel',
        className,
      ].join(' ')}
      {...props}
    />
  );
}

export function StatCard({
  label,
  value,
  change,
  changeTone = 'muted',
}: {
  label: string;
  value: string;
  change?: string;
  changeTone?: 'up' | 'down' | 'muted';
}) {
  const toneClass = { up: 'text-green', down: 'text-red', muted: 'text-text-2' }[changeTone];
  return (
    <div className="bg-night-3 border border-steel rounded-xl p-5 flex flex-col gap-2">
      <span className="text-xs uppercase tracking-wide text-muted font-medium">{label}</span>
      <span className="font-display text-[28px] font-bold">{value}</span>
      {change ? <span className={`text-xs ${toneClass}`}>{change}</span> : null}
    </div>
  );
}
