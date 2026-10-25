import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, outermost first. Only the topmost one reacts to Escape and owns the focus trap. */
const openDialogs: { id: symbol; panel: HTMLElement }[] = [];

/** Page elements made inert by open dialogs: how many hold each, and whether it was inert already. */
const inertHolds = new Map<Element, { count: number; wasInert: boolean }>();

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[inert]') && !element.hasAttribute('hidden'),
  );
}

/** Where focus goes when the element that opened a dialog is gone: the page's main region. */
function focusFallback() {
  const main = document.querySelector<HTMLElement>('main');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
}

/**
 * A modal dialog. It is open while it is mounted: render it conditionally.
 *
 * - `role="dialog"` and `aria-modal`, named by its title (`aria-labelledby`) and, when given,
 *   described by `description`.
 * - Focus moves into the dialog (to `initialFocus`, else the first control, else the dialog), stays
 *   inside while Tab is pressed, and returns to the element that had it before. If that element has
 *   been removed, focus falls back to the page's main region.
 * - Everything else in the document is made `inert` while it is open (and restored afterwards, also
 *   when several dialogs stack), and the page behind does not scroll.
 * - Escape calls `onClose`. Clicking the backdrop calls it only with `dismissOnBackdrop`. The dialog
 *   never confirms anything by itself: closing is always a cancel.
 *
 * The dialog is portalled to the end of `document.body`.
 */
export function Dialog({
  title,
  description,
  onClose,
  dismissOnBackdrop = false,
  initialFocus,
  children,
  footer,
}: {
  /** Already translated. */
  title: string;
  description?: string;
  onClose: () => void;
  dismissOnBackdrop?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  // The element that had focus before the dialog rendered. Read during the first render, because a
  // child with `autoFocus` takes focus when the dialog commits, before any effect runs.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const titleId = useId();
  const descriptionId = useId();
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The latest onClose, without re-running the effect (and re-capturing focus) on every render.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const id = Symbol('dialog');
    const root = container.current!;
    openDialogs.push({ id, panel: panel.current! });

    // Everything else in the body becomes inert. Each element counts how many open dialogs hold it,
    // so it stays inert until the last of them closes, whichever closes first; one that was inert
    // before any dialog opened is never un-inerted.
    const held: Element[] = [];
    for (const child of document.body.children) {
      if (child === root) continue;
      const hold = inertHolds.get(child);
      if (hold) hold.count += 1;
      else inertHolds.set(child, { count: 1, wasInert: child.hasAttribute('inert') });
      child.setAttribute('inert', '');
      held.push(child);
    }
    document.body.setAttribute('data-dialog-open', '');

    const first = initialFocus?.current ?? focusables(panel.current!)[0] ?? panel.current!;
    first.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1]?.id !== id) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables(panel.current!);
      if (items.length === 0) {
        event.preventDefault();
        panel.current!.focus();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || active === panel.current)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      } else if (!panel.current!.contains(active)) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const index = openDialogs.findIndex((entry) => entry.id === id);
      if (index >= 0) openDialogs.splice(index, 1);
      for (const element of held) {
        const hold = inertHolds.get(element);
        if (!hold) continue;
        hold.count -= 1;
        if (hold.count > 0) continue;
        inertHolds.delete(element);
        if (!hold.wasInert) element.removeAttribute('inert');
      }
      if (openDialogs.length === 0) document.body.removeAttribute('data-dialog-open');
      const usable =
        opener !== null &&
        opener.isConnected &&
        !opener.closest('[inert]') &&
        !(opener as HTMLButtonElement).disabled;
      if (usable) opener.focus({ preventScroll: true });
      // Focus could not go back to the opener (removed, or disabled while a request ran). If a
      // dialog is still open, keep focus inside it; otherwise use the page's main region.
      const below = openDialogs[openDialogs.length - 1];
      if (!usable) {
        // Focus already inside a dialog that stays open (this one closed under it) is left alone.
        if (below?.panel.contains(document.activeElement)) return;
        if (below) (focusables(below.panel)[0] ?? below.panel).focus({ preventScroll: true });
        else focusFallback();
      }
    };
    // The dialog is open for exactly as long as it is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={container}
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={panel}
        className="modal dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description ? { 'aria-describedby': descriptionId } : {})}
        tabIndex={-1}
      >
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="dialog__description">
            {description}
          </p>
        ) : null}
        {children}
        {footer ? <div className="dialog__footer actions">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
