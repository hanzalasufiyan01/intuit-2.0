import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
}

/**
 * An accessible tab strip with its panel (WAI-ARIA tabs pattern).
 *
 * - The strip is a `tablist` and each button a `tab` with `aria-selected`; only the tab that holds
 *   the tab stop is in the Tab order (roving tabindex), so Tab moves past the strip into the panel.
 * - Left/Right (mirrored in right-to-left layouts) move between tabs and wrap around; Home and End
 *   jump to the first and last. With `activation="auto"` the tab that receives focus is selected;
 *   with `"manual"` (for tabs that load data) arrows only move focus and Enter or Space selects.
 * - Every tab has `aria-controls` pointing at the panel, and the panel is a `tabpanel` labelled by
 *   the selected tab. Panel content is passed as children and rendered only for the selected tab.
 *
 * Tabs keep the look of the Button variants the app already used for them (btn--primary/ghost). The caller owns the selected
 * value, so URL, API and form state behave exactly as before.
 */
export function Tabs<V extends string>({
  label,
  tabs,
  value,
  onChange,
  activation = 'auto',
  children,
}: {
  /** Names the tab strip; already translated. */
  label: string;
  tabs: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  activation?: 'auto' | 'manual';
  children?: ReactNode;
}) {
  const base = useId();
  const tabId = (v: string) => `${base}-tab-${v}`;
  const panelId = `${base}-panel`;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  // The tab holding the tab stop while focus is inside the strip (manual activation can move it
  // away from the selected tab); null means "the selected tab".
  const [focused, setFocused] = useState<V | null>(null);
  const stop = focused ?? value;

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.value === stop);
    if (index < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = index + (rtl ? -1 : 1);
        break;
      case 'ArrowLeft':
        next = index + (rtl ? 1 : -1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length]!;
    setFocused(target.value);
    refs.current.get(target.value)?.focus();
    if (activation === 'auto') onChange(target.value);
  };

  return (
    <>
      <div
        className="tabs"
        role="tablist"
        aria-label={label}
        onKeyDown={move}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            ref={(node: HTMLButtonElement | null) => {
              if (node) refs.current.set(tab.value, node);
              else refs.current.delete(tab.value);
            }}
            id={tabId(tab.value)}
            role="tab"
            aria-selected={tab.value === value}
            aria-controls={panelId}
            tabIndex={tab.value === stop ? 0 : -1}
            className={`btn btn--${tab.value === value ? 'primary' : 'ghost'}`}
            onClick={() => {
              setFocused(null);
              onChange(tab.value);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {children !== undefined ? (
        <div role="tabpanel" id={panelId} aria-labelledby={tabId(value)}>
          {children}
        </div>
      ) : null}
    </>
  );
}
