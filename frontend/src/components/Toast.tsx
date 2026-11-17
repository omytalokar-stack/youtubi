import { useEffect } from 'react';
import { Check, X } from 'lucide-react';

export function Toast({ message, onClose, error = false }: { message: string; onClose: () => void; error?: boolean }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onClose, 4000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  if (!message) return null;
  return <div className={`toast ${error ? 'toast-error' : ''}`} role="status"><span className="toast-icon">{error ? <X size={15} /> : <Check size={15} />}</span>{message}<button onClick={onClose} aria-label="Dismiss"><X size={15} /></button></div>;
}
