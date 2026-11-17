import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-head"><h2 id="modal-title">{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      {children}
    </section>
  </div>;
}
