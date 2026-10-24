import { useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useT } from '../i18n/i18n';
import { NavIcon } from '../shared/nav-icons';
import {
  findActiveGroupId,
  NAV_DEFAULT_EXPANDED,
  useNavigationGroups,
  type NavGroup,
  type NavItem,
} from './navigation';

/**
 * The main navigation: a Workspace link, then collapsible groups. Each group header is a
 * disclosure button (aria-expanded, aria-controls) that shows or hides its list of links; a
 * collapsed list is hidden from sight and from assistive technology. The group holding the
 * current page opens when the user arrives on it, and can then be collapsed like any other.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const groups = useNavigationGroups();
  const { pathname } = useLocation();
  const activeId = findActiveGroupId(groups, pathname);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    ...NAV_DEFAULT_EXPANDED,
    ...(activeId ? { [activeId]: true } : {}),
  }));

  // On arriving at a page, open its group (adjusting state during render, not in an effect).
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    if (activeId && !expanded[activeId]) setExpanded({ ...expanded, [activeId]: true });
  }

  const toggle = (id: string) => setExpanded({ ...expanded, [id]: !expanded[id] });

  const links = (items: NavItem[]) =>
    items.map((item) => (
      <li key={item.to}>
        <NavLink to={item.to} end={item.end ?? false} onClick={onNavigate}>
          {t(item.label)}
        </NavLink>
      </li>
    ));

  const renderGroup = (group: NavGroup) => {
    if (group.label === null) {
      // The Workspace link stands alone, with its icon, like a top-level entry.
      return (
        <ul key={group.id} className="nav__list nav__list--flat">
          {group.items.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end ?? false} onClick={onNavigate}>
                <NavIcon name={group.icon} />
                {t(item.label)}
              </NavLink>
            </li>
          ))}
        </ul>
      );
    }
    const open = !!expanded[group.id];
    const panelId = `nav-group-${group.id}`;
    return (
      <div
        key={group.id}
        className={`nav__group${activeId === group.id ? ' nav__group--current' : ''}`}
      >
        <button
          type="button"
          className="nav__group-button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => toggle(group.id)}
        >
          <NavIcon name={group.icon} />
          <span className="nav__group-label">{t(group.label)}</span>
          <NavIcon name="chevron" size={16} className="nav__chevron" />
        </button>
        <ul id={panelId} className="nav__list" hidden={!open}>
          {links(group.items)}
        </ul>
      </div>
    );
  };

  return (
    <nav className="nav" aria-label={t('shell.nav.label')}>
      {groups.map(renderGroup)}
    </nav>
  );
}
