import { useRef } from 'react';
import { useT } from '../../i18n/i18n';
import { Button } from './Button';
import { Dialog } from './Dialog';

/**
 * Asks the user to confirm an action before it runs. It holds no business rules and no
 * authorization: the caller decides when to show it (only to users who may act) and what
 * `onConfirm` does.
 *
 * - Focus starts on Cancel, the safe choice. Escape, the Cancel button and a click outside all call
 *   `onCancel`; none of them ever confirms.
 * - `destructive` styles the confirm button as dangerous.
 * - While `busy` both buttons are disabled and the confirm button shows progress, so the action
 *   cannot be submitted twice and the dialog cannot be dismissed half-way.
 *
 * The dialog is open while `open` is true; the caller usually closes it in `onConfirm` and lets
 * the page's own button show the pending state, or keeps it open with `busy` until the request ends.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** Already translated. */
  title: string;
  /** Already translated. */
  message: string;
  /** Already translated; defaults to "Confirm". */
  confirmLabel?: string;
  /** Already translated; defaults to "Cancel". */
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  return (
    <Dialog
      title={title}
      description={message}
      dismissOnBackdrop
      initialFocus={cancel}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            busy={busy}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
          <button
            ref={cancel}
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
        </>
      }
    />
  );
}
