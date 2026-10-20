import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { Can, Permission, useAnyPermission } from '../permissions/permissions';
import { IMPORT_PERMISSIONS } from '../features/data-exchange/permissions';
import { CLAIM_VIEW_PERMISSIONS } from '../features/claims/ClaimPages';
import { ASSET_VIEW_PERMISSIONS } from '../features/assets/AssetPages';
import { INVENTORY_VIEW_PERMISSIONS } from '../features/inventory/InventoryPages';
import { CLINIC_PERMISSIONS } from '../features/clinic/ClinicPages';
import { useModules } from '../features/payroll/PayrollPages';
import { BANKING_VIEW_PERMISSIONS } from '../features/banking/BankingSection';
import { PURCHASES_VIEW_PERMISSIONS } from '../features/purchases/PurchasesSection';
import { SALES_VIEW_PERMISSIONS } from '../features/sales/SalesSection';
import { MfaGate } from '../features/security/MfaGate';
import { availableLocales, useLocale, useT } from '../i18n/i18n';
import { Alert } from '../shared/ui/Alert';
import { Button } from '../shared/ui/Button';
import { OrganizationSwitcher } from './OrganizationSwitcher';

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
  const canAccounting = useAnyPermission([Permission.JournalsView, Permission.PeriodsView]);
  const canImport = useAnyPermission(IMPORT_PERMISSIONS);
  const canSales = useAnyPermission(SALES_VIEW_PERMISSIONS);
  const canPurchases = useAnyPermission(PURCHASES_VIEW_PERMISSIONS);
  const canBanking = useAnyPermission(BANKING_VIEW_PERMISSIONS);
  const canInventory = useAnyPermission(INVENTORY_VIEW_PERMISSIONS);
  const modules = useModules();
  const canClinic = useAnyPermission(CLINIC_PERMISSIONS);
  const canAssets = useAnyPermission(ASSET_VIEW_PERMISSIONS);
  const canClaims = useAnyPermission(CLAIM_VIEW_PERMISSIONS);
  const remaining = session?.mfa.recoveryCodesRemaining;
  const lowRecoveryCodes =
    remaining === null || remaining === undefined
      ? null
      : remaining === 0
        ? 'none'
        : remaining <= 3
          ? 'low'
          : null;

  const signOut = async () => {
    await logout();
    void navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">{t('shell.brand')}</div>
        <OrganizationSwitcher />
        <nav className="nav" aria-label={t('shell.nav.label')}>
          <NavLink to="/" end>
            {t('shell.nav.overview')}
          </NavLink>
          <Can permission={Permission.MembersRead}>
            <NavLink to="/members">{t('shell.nav.members')}</NavLink>
            <NavLink to="/settings/branch-access">{t('shell.nav.branchAccess')}</NavLink>
          </Can>
          <Can permission={Permission.RolesRead}>
            <NavLink to="/roles">{t('shell.nav.roles')}</NavLink>
          </Can>
          <Can permission={Permission.AuditRead}>
            <NavLink to="/audit">{t('shell.nav.audit')}</NavLink>
          </Can>
          <Can permission={Permission.OrganizationRead}>
            <NavLink to="/settings/company-profile">{t('shell.nav.companyProfile')}</NavLink>
            <NavLink to="/settings/ownership">{t('shell.nav.ownership')}</NavLink>
            <NavLink to="/settings/groups">{t('shell.nav.entityGroups')}</NavLink>
            <NavLink to="/settings/modules">{t('shell.nav.modules')}</NavLink>
          </Can>
          <Can permission={Permission.ApiTokensView}>
            <NavLink to="/settings/integrations">{t('shell.nav.integrations')}</NavLink>
          </Can>
          <Can permission={Permission.WebhooksView}>
            <NavLink to="/settings/webhooks">{t('shell.nav.webhooks')}</NavLink>
          </Can>
          <Can permission={Permission.PartiesView}>
            <NavLink to="/parties">{t('shell.nav.contacts')}</NavLink>
          </Can>
          {canAccounting ? <NavLink to="/accounting">{t('shell.nav.accounting')}</NavLink> : null}
          {canSales ? <NavLink to="/sales">{t('shell.nav.sales')}</NavLink> : null}
          {canPurchases ? <NavLink to="/purchases">{t('shell.nav.purchases')}</NavLink> : null}
          {canBanking ? <NavLink to="/banking">{t('shell.nav.banking')}</NavLink> : null}
          {canInventory ? <NavLink to="/inventory">{t('shell.nav.inventory')}</NavLink> : null}
          {modules.data?.modules.payroll ? (
            <NavLink to="/payroll">{t('shell.nav.payroll')}</NavLink>
          ) : null}
          {modules.data?.modules.projects ? (
            <NavLink to="/projects">{t('shell.nav.projects')}</NavLink>
          ) : null}
          {modules.data?.modules.clinic && canClinic ? (
            <NavLink to="/clinic">{t('shell.nav.clinic')}</NavLink>
          ) : null}
          {canAssets ? <NavLink to="/assets">{t('shell.nav.fixedAssets')}</NavLink> : null}
          {canClaims ? <NavLink to="/claims">{t('shell.nav.claims')}</NavLink> : null}
          {canImport ? <NavLink to="/imports">{t('shell.nav.import')}</NavLink> : null}
          <NavLink to="/exports">{t('shell.nav.exports')}</NavLink>
          <Can permission={Permission.ApprovalsManage}>
            <NavLink to="/settings/approvals">{t('shell.nav.approvals')}</NavLink>
          </Can>
          <Can permission={Permission.MembersManage}>
            <NavLink to="/settings/security">{t('shell.nav.security')}</NavLink>
          </Can>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">
            {session?.activeOrganization?.name ?? t('shell.noOrganization')}
          </span>
          <div className="topbar__user">
            <span>{session?.user.displayName}</span>
            <LanguageSelect />
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
