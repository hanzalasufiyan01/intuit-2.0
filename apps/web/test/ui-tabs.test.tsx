import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from '../src/shared/ui/FilterBar';
import { CheckboxField } from '../src/shared/ui/CheckboxField';
import { SelectField } from '../src/shared/ui/SelectField';
import { TextareaField } from '../src/shared/ui/TextareaField';
import { Tabs } from '../src/shared/ui/Tabs';

/** UI phase 3, batch C: Tabs, FilterBar, and the aria-describedby follow-up on the field components. */

const TABS = [
  { value: 'low', label: 'Low stock' },
  { value: 'slow', label: 'Slow-moving' },
  { value: 'profit', label: 'Profitability' },
] as const;
type View = (typeof TABS)[number]['value'];

function Harness({
  activation,
  onChange,
}: {
  activation?: 'auto' | 'manual';
  onChange?: (value: View) => void;
}) {
  const [view, setView] = useState<View>('low');
  return (
    <>
      <button type="button">before</button>
      <Tabs
        label="Inventory report"
        tabs={TABS}
        value={view}
        onChange={(v) => {
          onChange?.(v);
          setView(v);
        }}
        {...(activation ? { activation } : {})}
      >
        <input aria-label={`content of ${view}`} />
      </Tabs>
    </>
  );
}

describe('Tabs ARIA structure', () => {
  it('has a named tablist, tabs with aria-selected and one tabpanel labelled by the selected tab', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist', { name: 'Inventory report' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(list.contains(tabs[0]!)).toBe(true);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
    for (const tab of tabs) expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.querySelector('input')!.getAttribute('aria-label')).toBe('content of low');
    expect(screen.getByRole('tabpanel', { name: 'Low stock' })).toBe(panel);
  });

  it('uses a roving tabindex: only the selected tab is in the Tab order', () => {
    render(<Harness />);
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('renders no panel when it has no children', () => {
    render(<Tabs label="Currencies" tabs={TABS} value="low" onChange={() => {}} />);
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });
});

describe('Tabs interaction', () => {
  it('selects a tab on click and relabels the panel', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: 'Slow-moving' }));
    expect(onChange).toHaveBeenCalledWith('slow');
    expect(screen.getByRole('tab', { name: 'Slow-moving' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tabpanel', { name: 'Slow-moving' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('moves focus and selection with Left/Right, wrapping at both ends', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'Low stock' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Slow-moving' }));
    expect(screen.getByRole('tab', { name: 'Slow-moving' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Low stock' }));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Profitability' }));
    expect(screen.getByRole('tabpanel', { name: 'Profitability' })).toBeTruthy();
  });

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'Low stock' }).focus();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Profitability' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Low stock' }));
  });

  it('Tab leaves the strip for the panel, then Shift+Tab returns to the selected tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab(); // the "before" button
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Low stock' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('content of low'));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Low stock' }));
  });

  it('with manual activation, arrows move focus only and Enter selects', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness activation="manual" onChange={onChange} />);
    screen.getByRole('tab', { name: 'Low stock' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Slow-moving' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Low stock' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    // The tab stop followed focus, so the next arrow continues from the focused tab.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Profitability' }));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('profit');
    expect(screen.getByRole('tabpanel', { name: 'Profitability' })).toBeTruthy();
  });

  it('returns the tab stop to the selected tab once focus leaves the strip', async () => {
    const user = userEvent.setup();
    render(<Harness activation="manual" />);
    screen.getByRole('tab', { name: 'Low stock' }).focus();
    await user.keyboard('{ArrowRight}');
    await user.tab({ shift: true }); // out of the strip
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('mirrors the arrow keys in a right-to-left layout', async () => {
    const user = userEvent.setup();
    render(
      <div dir="rtl" style={{ direction: 'rtl' }}>
        <Harness />
      </div>,
    );
    screen.getByRole('tab', { name: 'Low stock' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Slow-moving' }));
  });
});

describe('FilterBar', () => {
  it('is a labelled search form that submits on Enter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <FilterBar label="Filters" onSubmit={onSubmit}>
        <SelectField label="Status" defaultValue="all">
          <option value="all">All</option>
        </SelectField>
        <input aria-label="Search" />
        <button type="submit">Run</button>
      </FilterBar>,
    );
    const form = screen.getByRole('search', { name: 'Filters' });
    expect(form.tagName).toBe('FORM');
    expect(form.classList.contains('filters')).toBe(true);
    expect(screen.getByLabelText('Status')).toBeTruthy();
    await user.type(screen.getByLabelText('Search'), 'x{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('is a labelled group without a submit handler, and keeps its controls interactive', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterBar label="Date range">
        <input aria-label="From" onChange={(e) => onChange(e.target.value)} />
      </FilterBar>,
    );
    const group = screen.getByRole('group', { name: 'Date range' });
    expect(group.tagName).toBe('DIV');
    expect(group.classList.contains('filters')).toBe(true);
    await user.type(screen.getByLabelText('From'), '2');
    expect(onChange).toHaveBeenCalledWith('2');
  });
});

describe('field components keep caller aria-describedby', () => {
  it('SelectField: caller ids join the generated hint or error', () => {
    const { rerender } = render(
      <>
        <p id="extra">More help</p>
        <SelectField label="Currency" hint="Used on invoices" aria-describedby="extra">
          <option>MVR</option>
        </SelectField>
      </>,
    );
    const select = screen.getByLabelText('Currency');
    expect(select.getAttribute('aria-describedby')).toBe(
      `${screen.getByText('Used on invoices').id} extra`,
    );
    rerender(
      <>
        <p id="extra">More help</p>
        <SelectField
          label="Currency"
          hint="Used on invoices"
          error="Required"
          aria-describedby="extra"
        >
          <option>MVR</option>
        </SelectField>
      </>,
    );
    expect(select.getAttribute('aria-describedby')).toBe(`${screen.getByRole('alert').id} extra`);
  });

  it('TextareaField and CheckboxField: a caller id alone is preserved', () => {
    render(
      <>
        <p id="note">Note</p>
        <TextareaField label="Memo" aria-describedby="note" />
        <CheckboxField label="Default" aria-describedby="note" />
      </>,
    );
    expect(screen.getByLabelText('Memo').getAttribute('aria-describedby')).toBe('note');
    expect(screen.getByRole('checkbox', { name: 'Default' }).getAttribute('aria-describedby')).toBe(
      'note',
    );
  });
});
