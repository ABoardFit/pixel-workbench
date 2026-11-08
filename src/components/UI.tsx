import { useEffect, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

export function PixelPreview({ pixels, width, height, className = '' }: { pixels: Uint8ClampedArray; width: number; height: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas) canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  }, [pixels, width, height]);
  return <canvas ref={ref} width={width} height={height} className={`pixel-preview ${className}`} aria-hidden="true" />;
}

export function Modal({ title, children, onClose, wide = false, error = '' }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; error?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const selectors = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"]';
    (dialog?.querySelector(selectors) as HTMLElement | null)?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !dialog) return;
      const nodes = [...dialog.querySelectorAll<HTMLElement>(selectors)].filter(node => node.offsetParent !== null);
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-shade" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-heading"><h2>{title}</h2><IconButton label="닫기" onClick={onClose}><X size={19} /></IconButton></div>
      {error && <p className="modal-error" role="alert">{error}</p>}
      {children}
    </div>
  </div>;
}

export function NumberField({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <label className="number-field"><span>{label}</span><input type="number" aria-label={label} value={value} min={min} max={max} step={step} onChange={event => {
    if (event.target.value === '') return;
    const parsed = Number(event.target.value);
    if (Number.isFinite(parsed)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed)));
  }} /></label>;
}
