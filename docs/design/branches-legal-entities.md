# Design: branches, legal entities and module enabling (FP-24)

Status: partly built (2026-10-19). Built: module switch (0065), branch-scoped members (0084), group of legal entities with a read-only side-by-side profit and loss (0085). Not built: consolidation. No ADR has been approved for consolidation; this proposal uses the safest additive approach.

## Terms

- **Organization** (exists): the tenant and the security boundary (RLS key). One organization has one chart of accounts, one base currency, one set of books.
- **Branch** (new): a location or cost centre inside one organization. It does not create a separate set of books.
- **Legal entity** (new, later): a separate set of books with its own tax registration. Proposed as a separate organization plus an optional **group** relation, because every table is already keyed by organization and RLS is the isolation guarantee. Consolidation is a read-only report across organizations the user belongs to.

## Proposal

1. **Branches reuse dimensions.** The accounting module already has dimension types and values, required-dimension rules and dimension-filtered reports. A branch is a system dimension type `branch` (seeded per organization when the feature is enabled). Documents already carry `dimensionValueIds`; reports already filter by them. This delivers "sales by branch", "P&L by branch" and per-branch stock views without schema changes to the posting engine.
2. **Branch scoping of permissions** (new): a membership role may be limited to a set of branch values. Enforced in the service layer (`withOrganization` context gains `branchIds`) and in list queries. Risk: every list/report must honour it; start with Sales, Purchases, Inventory lists and the dimension-filtered reports, and test with a cross-branch denial test per module.
3. **Per-organization module enabling**: table `organization_modules(organization_id, module_key, enabled, enabled_at, enabled_by)`; navigation and routes hide a disabled module, and services refuse when disabled. Default: all current modules enabled. Payroll, projects and clinic ship disabled.
4. **Inter-branch stock transfers** depend on warehouses (see `advanced-inventory.md`).

## Open decisions

- Are branches only labels (dimension) or also a security scope? (Proposed: both, in two steps.)
- Is a legal entity a separate organization with a group link? (Proposed: yes.)
- Consolidation: currency translation and intercompany eliminations are out of scope until requested.

## Tests required

Branch dimension seeded once; required-branch rule; cross-branch denial per module; module disabled refuses API and hides UI; audit of enabling.

## What was built (Completion 3)

- **Branch scope (migration 0084).** `membership_branch_scopes` links a member to dimension values. Row-level security on sales invoices, purchase bills and their lines shows a restricted session only documents whose header dimensions overlap its branches (`app.branch_scope`), and refuses writes outside them. A restricted member keeps only an allow-list of permissions (invoices, bills, customers, vendors, dimension list); reports, ledger, payments, inventory and payroll are removed for the duration. Owners cannot be limited, nobody limits themself, a restricted member cannot change scopes. Documents created by a restricted member must carry at least one of their branches (readable validation error). Audited as `member.branch_scope_set` / `_cleared`. Not covered: other document types (quotes, credit notes, receipts, payments) and reports are not branch-filtered, which is why those permissions are removed rather than narrowed.
- **Leak audit (2026-10-19, `branch-scopes.test.ts` 6/6).** Checked for a restricted member: list/get/create/edit of invoices and bills, global sales and purchases search, PDF/e-mail history/allocations of another branch's documents, exports of invoices and bills (run as the member), and files attached to another branch's invoice. One real leak was found and fixed: `GET /files/:id` and its download link checked only the permission of the linked document, not that the member could see the record, so a restricted member could read the metadata and download link of a file on another branch's invoice. File access now also requires the linked record to be visible. Known blind spot (deliberate): duplicate supplier-reference detection runs under the member's own row visibility, so a restricted member is not warned about an identical reference in another branch (warning them would reveal that bill). Branch scoping is NOT universal: only invoices, bills, their lines and files linked to them are row-filtered; every other module is protected by removing its permissions from restricted members.
- **Groups of legal entities (migration 0085).** `organization_groups` belong to a user (guarded by user, not tenant); `organization_group_members` link organizations. Only an Owner of an organization can add it; an organization is in at most one group; a stranger gets 404 for everything. Join/leave is audited inside the organization. The overview reads each organization's profit and loss under the caller's own permissions there and shows `no_access` where they have none. Figures stay in each base currency and are never added.
- **Consolidation is a decision, not a feature yet.** See `docs/open-decisions.md` for the exact choices needed.
