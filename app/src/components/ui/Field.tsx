import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const fieldBase =
  'w-full px-3.5 py-3 bg-night-3 border border-steel rounded-xl text-text text-sm outline-none transition-colors focus:border-orange';

export function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-[13px] text-text-2 font-medium mb-1.5">{children}</label>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldBase} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${fieldBase} cursor-pointer ${props.className ?? ''}`}>
      {props.children}
    </select>
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${fieldBase} min-h-20 resize-y ${props.className ?? ''}`}
    />
  );
}
