import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { MfaGate } from '../features/security/MfaGate';
import { availableLocales, useLocale, useT } from '../i18n/i18n';
import { NavIcon } from '../shared/nav-icons';
import { Alert } from '../shared/ui/Alert';
import { Button } from '../shared/ui/Button';
import { useCompactLayout } from './navigation';
import { OrganizationSwitcher } from './OrganizationSwitcher';
import { SidebarNav } from './SidebarNav';
import { ThemeToggle } from './ThemeToggle';

/** Offered only when more than one APPROVED language exists (none is shipped besides English). */
function LanguageSelect() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const options = availableLocales();
  if (options.length < 2) return null;
  return (
    <label className="language-select">
      <span className="visually-hidden">{t('shell.language')}</span>
      <select value={locale} onChange={(e) => setLocale(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AppLayout() {
  const t = useT();
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const compact = useCompactLayout();
  const remaining = session?.mfa.recoveryCodesRemaining;
  const lowRecoveryCodes =
    remaining === null || remaining === undefined
      ? null
      : remaining === 0
        ? 'none'
        : remaining <= 3
          ? 'low'
          : null;

  // The navigation drawer (tablet and mobile). It closes when the page changes and when the
  // viewport grows back to the desktop layout, where the sidebar is always shown.
  const [navOpen, setNavOpen] = useState(false);
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    setNavOpen(false);
  }
  if (!compact && navOpen) setNavOpen(false);
  const drawerOpen = compact && navOpen;
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // While the drawer is open: Escape closes it, the page behind does not scroll, and focus moves
  // into the drawer; on closing, focus returns to the menu button.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.setAttribute('data-nav-open', '');
    closeButton.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.removeAttribute('data-nav-open');
    };
  }, [drawerOpen]);
  useEffect(() => {
    if (wasOpen.current && !drawerOpen) menuButton.current?.focus();
    wasOpen.current = drawerOpen;
  }, [drawerOpen]);

  const signOut = async () => {
    await logout();
    void navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      {drawerOpen ? (
        <button
          type="button"
          className="nav-backdrop"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <aside
        id="app-sidebar"
        className={`sidebar${drawerOpen ? ' sidebar--open' : ''}`}
        {...(drawerOpen
          ? { role: 'dialog', 'aria-modal': true, 'aria-label': t('shell.nav.menu') }
          : {})}
      >
        <div className="sidebar__header">
          <div className="sidebar__brand">{t('shell.brand')}</div>
          <button
            type="button"
            ref={closeButton}
            className="sidebar__close"
            aria-label={t('shell.nav.close')}
            onClick={() => setNavOpen(false)}
          >
            <NavIcon name="close" />
          </button>
        </div>
        <OrganizationSwitcher />
        <SidebarNav onNavigate={() => setNavOpen(false)} />
      </aside>
      <div className="main" inert={drawerOpen}>
        <header className="topbar">
          <div className="topbar__context">
            <button
              type="button"
              ref={menuButton}
              className="topbar__menu"
              aria-label={t('shell.nav.open')}
              aria-expanded={drawerOpen}
              aria-controls="app-sidebar"
              onClick={() => setNavOpen(true)}
            >
              <NavIcon name="menu" />
            </button>
            <span className="muted">
              {session?.activeOrganization?.name ?? t('shell.noOrganization')}
            </span>
          </div>
          <div className="topbar__user">
            <span>{session?.user.displayName}</span>
            <LanguageSelect />
            <ThemeToggle />
            <NavLink to="/account/security">{t('shell.nav.accountSecurity')}</NavLink>
            <Button variant="secondary" onClick={() => void signOut()}>
              {t('shell.signOut')}
            </Button>
          </div>
        </header>
        <main className="content">
          {lowRecoveryCodes ? (
            <Alert tone="info">
              {lowRecoveryCodes === 'none' ? t('shell.recovery.none') : t('shell.recovery.low')}{' '}
              <NavLink to="/account/security">{t('shell.recovery.generate')}</NavLink>
            </Alert>
          ) : null}
          <MfaGate>
            <Outlet />
          </MfaGate>
        </main>
      </div>
    </div>
  );
}
