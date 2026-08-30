type Tone = 'green' | 'yellow' | 'red' | 'blue' | 'orange';

const toneClasses: Record<Tone, string> = {
  green: 'bg-green/15 text-green',
  yellow: 'bg-yellow/15 text-yellow',
  red: 'bg-red/15 text-red',
  blue: 'bg-blue/15 text-blue',
  orange: 'bg-orange/15 text-orange',
};

export function Badge({
  tone = 'orange',
  dot = true,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${toneClasses[tone]}`}
    >
      {dot ? <span className="w-1.5 h-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
