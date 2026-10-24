import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' ');

/**
 * A data table inside a horizontally scrolling region. The wide table scrolls within its card
 * instead of widening the page, and the region is focusable and named so keyboard and
 * screen-reader users can scroll it. `label` is required and must already be translated.
 */
export function DataTable({
  label,
  className,
  children,
}: {
  label: string;
  /** Extra table classes, for example `table--editor`. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table className={join('table', className)}>{children}</table>
    </div>
  );
}

/** A right-aligned, tabular-figure column header (amounts, quantities). */
export function NumHeader({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...rest} className={join('num', className)} />;
}

/** A right-aligned, tabular-figure cell. Display only: callers format the value. */
export function NumCell({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} className={join('num', className)} />;
}

/** The actions in a table row, kept in a flex container inside a normal table cell. */
export function RowActions({ children, ...rest }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td {...rest}>
      <div className="actions">{children}</div>
    </td>
  );
}
