import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

const fieldBase =
  'w-full px-3.5 py-3 bg-night-3 border border-steel rounded-xl text-text text-sm outline-none transition-colors focus:border-orange';

// `htmlFor` is passed through rather than dropped.
//
// Before Phase 10 this component accepted only children, so no label in the
// product could be associated with its field. Two consequences, both real:
// tapping the word "Destination" did not focus the box under it — on a phone,
// with cold hands, that is the difference between two taps and five — and a
// screen reader announced the input as unlabelled. Passing the attribute
// through costs nothing and fixes both.
export function Label({ children, className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label {...props} className={`block text-[13px] text-text-2 font-medium mb-1.5 ${className ?? ''}`}>
      {children}
    </label>
  );
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
