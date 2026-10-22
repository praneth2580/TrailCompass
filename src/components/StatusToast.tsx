export type ToastTone = 'info' | 'loading' | 'success' | 'error';

interface StatusToastProps {
  message: string;
  tone?: ToastTone;
}

export function StatusToast({ message, tone = 'info' }: StatusToastProps) {
  return (
    <p className={`tc-toast tc-toast-${tone}`} role="status" aria-live="polite">
      {tone === 'loading' ? (
        <span className="tc-spinner tc-spinner-sm" aria-hidden />
      ) : null}
      {tone === 'success' ? (
        <span className="tc-toast-icon" aria-hidden>
          ✓
        </span>
      ) : null}
      {tone === 'error' ? (
        <span className="tc-toast-icon" aria-hidden>
          !
        </span>
      ) : null}
      <span>{message}</span>
    </p>
  );
}
