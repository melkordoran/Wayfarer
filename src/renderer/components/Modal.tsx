import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let lastFocused: HTMLElement | null = null;
    let redirecting = false;
    // Only the topmost Wayfarer modal owns focus, including during nested or
    // overlapping React mount/unmount transitions.
    const ownsFocus = () => element.isConnected
      && Array.from(document.querySelectorAll('[data-wayfarer-modal]')).at(-1) === element;
    const available = (target: HTMLElement) => {
      if (!target.isConnected || target.matches(':disabled') || target.tabIndex < 0) return false;
      for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (ancestor === element) break;
      }
      return true;
    };
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>(
      'button, input:not([type="hidden"]), select, textarea, a[href], [tabindex], [contenteditable="true"]',
    )).filter(available);
    const focusInside = (edge?: 'first' | 'last') => {
      if (!ownsFocus() || redirecting) return;
      const targets = focusable();
      const remembered = lastFocused && element.contains(lastFocused) && available(lastFocused) ? lastFocused : null;
      const target = (edge ? edge === 'last' ? targets.at(-1) : targets[0] : remembered ?? targets[0]) ?? element;
      redirecting = true;
      try { target.focus({ preventScroll: true }); lastFocused = target; }
      finally { redirecting = false; }
    };
    const containFocus = (event: FocusEvent) => {
      if (!ownsFocus() || redirecting) return;
      if (event.target instanceof HTMLElement && element.contains(event.target)) lastFocused = event.target;
      else focusInside();
    };
    const fullscreenChanged = () => {
      // Electron may restore the former fullscreen button after the modal has
      // mounted. Focusin also catches restoration occurring after this event.
      if (!element.contains(document.activeElement)) focusInside();
    };
    const key = (event: KeyboardEvent) => {
      if (!ownsFocus()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab") return;
      const elements = focusable(), active = document.activeElement;
      if (!elements.length || !element.contains(active) || !elements.includes(active as HTMLElement)) {
        event.preventDefault();
        focusInside(event.shiftKey ? 'last' : 'first');
      } else if (event.shiftKey && active === elements[0]) {
        event.preventDefault();
        focusInside('last');
      } else if (!event.shiftKey && active === elements.at(-1)) {
        event.preventDefault();
        focusInside('first');
      }
    };
    document.addEventListener("keydown", key);
    document.addEventListener('focusin', containFocus, true);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    focusInside('first');
    return () => {
      const active = document.activeElement;
      const restore = !active || active === document.body || element.contains(active);
      document.removeEventListener("keydown", key);
      document.removeEventListener('focusin', containFocus, true);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      if (restore && previous?.isConnected && !previous.matches(':disabled') && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        ref={panel}
        data-wayfarer-modal=""
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          className="icon-button modal-close"
          title="Close dialog"
          onClick={onClose}
        >
          <X size={19} />
        </button>
        <div className="modal-heading">
          <span className="eyebrow">WAYFARER</span>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
