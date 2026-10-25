import type { FormEventHandler, ReactNode } from 'react';

/**
 * The row of filter controls above a list or report. With `onSubmit` it is a search form (applying
 * the filters is a submit, so Enter works); without it, a labelled group of controls that apply as
 * they change. Fields wrap onto several lines on narrow screens. `label` names the region and must
 * already be translated.
 */
export function FilterBar({
  label,
  onSubmit,
  children,
}: {
  label: string;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
}) {
  return onSubmit ? (
    <form className="filters" role="search" aria-label={label} onSubmit={onSubmit}>
      {children}
    </form>
  ) : (
    <div className="filters" role="group" aria-label={label}>
      {children}
    </div>
  );
}
