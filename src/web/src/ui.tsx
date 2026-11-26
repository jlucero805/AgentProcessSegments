import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export function cn(...values: Array<string | false | null | undefined>): string {
  return twMerge(clsx(values));
}

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-zinc-100 text-zinc-900 hover:bg-white',
  secondary: 'border border-zinc-700 bg-zinc-800/60 text-zinc-200 hover:bg-zinc-700/70',
  outline: 'border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white',
  ghost: 'border border-transparent text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200',
  danger: 'bg-red-600/90 text-white hover:bg-red-500',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-sm',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}

export function IconButton({
  className,
  label,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100',
        className,
      )}
      {...rest}
    />
  );
}

type Tone = 'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'purple';

const TONES: Record<Tone, string> = {
  neutral: 'border-zinc-700 bg-zinc-800/50 text-zinc-300',
  green: 'border-emerald-900 bg-emerald-950/50 text-emerald-300',
  blue: 'border-blue-900 bg-blue-950/50 text-blue-300',
  amber: 'border-amber-900 bg-amber-950/50 text-amber-300',
  red: 'border-red-900 bg-red-950/50 text-red-300',
  purple: 'border-purple-900 bg-purple-950/50 text-purple-300',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({
  className,
  children,
  testId,
}: {
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn('rounded-xl border border-zinc-800 bg-zinc-900/50', className)}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn('text-xs font-semibold uppercase tracking-widest text-zinc-500', className)}>
      {children}
    </h3>
  );
}

const inputClass =
  'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClass, 'resize-y leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputClass, 'appearance-none', className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </span>
        {hint ? <span className="text-[11px] text-zinc-600">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function Checkbox({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-2 text-sm text-zinc-300', className)}>
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 accent-zinc-300"
        {...rest}
      />
      {label}
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-4 w-4 animate-spin text-zinc-400', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-zinc-800 p-8 text-center">
      <p className="text-sm text-zinc-400">{title}</p>
      {hint ? <p className="text-xs text-zinc-600">{hint}</p> : null}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'w-full rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            ×
          </IconButton>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
