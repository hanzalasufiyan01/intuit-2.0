/**
 * English text of the Help centre: tutorials, the welcome prompt and the assistant panel. Merged
 * into the main catalog (`messages.en.ts`). Tutorial text follows the convention
 * `help.t.<tutorial id>.<part>` that `features/help/tutorials.ts` relies on; a test checks that the
 * two agree. Menu names and buttons are the labels the application shows.
 */
export const helpMessages = {
  'help.nav.group': 'Help',
  'help.nav.centre': 'Help centre',

  'help.centre.title': 'Help centre',
  'help.centre.description':
    'Step-by-step tutorials for the parts of Intuit 2.0 you can use, and an assistant for questions.',
  'help.centre.assistantTitle': 'Assistant',
  'help.centre.assistantText':
    'Ask how something works in Intuit 2.0. The assistant explains the application and can quote figures from your own reports when you have access to them. It cannot change anything.',
  'help.centre.openAssistant': 'Ask the assistant',
  'help.centre.tutorials': 'Tutorials',
  'help.centre.progress': '{done} of {total} tutorials completed',
  'help.centre.loadFailed': 'Your tutorial progress could not be loaded.',
  'help.status.notStarted': 'Not started',
  'help.status.inProgress': 'In progress, step {step} of {total}',
  'help.status.completed': 'Completed',
  'help.status.skipped': 'Skipped',
  'help.status.unavailable': 'Not available to you',
  'help.action.start': 'Start',
  'help.action.resume': 'Resume',
  'help.action.repeat': 'Repeat',
  'help.action.startFor': 'Start the tutorial: {title}',
  'help.action.resumeFor': 'Resume the tutorial: {title}',
  'help.action.repeatFor': 'Repeat the tutorial: {title}',
  'help.unavailable.reason':
    'This tutorial covers features your role cannot use, or a feature that is switched off for this organization. Ask an administrator if you need access.',

  'help.player.notFound': 'There is no tutorial with that name.',
  'help.player.objective': 'Objective',
  'help.player.prerequisites': 'Before you start',
  'help.player.stepOf': 'Step {step} of {total}',
  'help.player.progressLabel': 'Tutorial progress',
  'help.player.back': 'Back',
  'help.player.next': 'Next',
  'help.player.finish': 'Finish',
  'help.player.skip': 'Skip tutorial',
  'help.player.exit': 'Exit',
  'help.player.openPage': 'Open this page',
  'help.player.openPageHint':
    'The page opens in the application. Your place is saved, so you can come back and resume.',
  'help.player.limited':
    'Some steps are left out because your role cannot use those features or they are switched off.',
  'help.player.saveFailed':
    'Your progress could not be saved. You can keep going and try again later.',
  'help.player.doneTitle': 'Tutorial complete',
  'help.player.doneText': 'You finished “{title}”. You can repeat it at any time.',
  'help.player.skippedTitle': 'Tutorial skipped',
  'help.player.skippedText': 'You skipped “{title}”. Start it again whenever you like.',
  'help.player.repeat': 'Repeat the tutorial',
  'help.player.backToCentre': 'Back to the Help centre',

  'help.welcome.title': 'New to Intuit 2.0?',
  'help.welcome.text': 'Take the welcome tutorial to find your way around.',
  'help.welcome.start': 'Start the welcome tutorial',
  'help.welcome.skip': 'Not now',
  'help.context.link': 'Help for this page',
  'help.context.linkFor': 'Open the tutorial: {title}',

  'help.assistant.open': 'Assistant',
  'help.assistant.openLabel': 'Open the assistant',
  'help.assistant.title': 'Assistant',
  'help.assistant.description':
    'Ask how Intuit 2.0 works. The assistant explains the application; it cannot post, change, pay or delete anything.',
  'help.assistant.guidance':
    'Guidance comes from the Intuit 2.0 help catalogue. Numbers appear only in a “From your books” block, read from your reports just now. Do not type passwords or card numbers.',
  'help.assistant.modeDocs': 'Built-in help',
  'help.assistant.modeAi': 'AI-assisted wording',
  'help.assistant.noticeDocs':
    'AI wording is not enabled on this server. Replies come from the built-in help catalogue.',
  'help.assistant.noticeDegraded':
    'The AI service could not answer just now, so this reply comes from the built-in help catalogue.',
  'help.assistant.suggestions': 'Try asking',
  'help.assistant.empty': 'No questions yet.',
  'help.assistant.you': 'You',
  'help.assistant.assistant': 'Assistant',
  'help.assistant.conversation': 'Conversation',
  'help.assistant.question': 'Your question',
  'help.assistant.questionHint': 'Press Ctrl+Enter to send.',
  'help.assistant.counter': '{used} of {max} characters',
  'help.assistant.send': 'Send',
  'help.assistant.clear': 'Clear conversation',
  'help.assistant.close': 'Close',
  'help.assistant.thinking': 'The assistant is working on your question',
  'help.assistant.retry': 'Try again',
  'help.assistant.errorGeneric': 'The assistant could not answer. Your question was kept.',
  'help.assistant.errorRateLimited': 'You are asking too quickly. Try again in {seconds} seconds.',
  'help.assistant.errorStatus': 'The assistant is not available right now.',
  'help.assistant.figures': 'From your books',
  'help.assistant.figuresNote':
    'Read from your reports just now, under your permissions. Everything else in the reply is guidance.',
  'help.assistant.sources': 'Related help',
  'help.assistant.sourceTutorial': 'Tutorial: {title}',

  // Tutorials. Each has title, summary, objective, prereq<N>, and s<N>.title / s<N>.body.
  'help.t.welcome.title': 'Welcome and first sign-in',
  'help.t.welcome.summary': 'Find your way around Intuit 2.0 after you first sign in.',
  'help.t.welcome.objective': 'Know where things are and what to set up first.',
  'help.t.welcome.prereq1': 'You have signed in to an organization.',
  'help.t.welcome.s1.title': 'Start on Overview',
  'help.t.welcome.s1.body':
    'After you sign in you arrive on Overview. It shows who is signed in, whether you are an owner or a member of the active organization, and the organizations you belong to.',
  'help.t.welcome.s2.title': 'Use the menu',
  'help.t.welcome.s2.body':
    'The menu groups everything you can use: Finance, Commerce, People & projects, Data, Organization, Integrations, Security & audit and Help. On a small screen, open it with the menu button at the top. A group only appears when you have access to something in it.',
  'help.t.welcome.s3.title': 'Get help any time',
  'help.t.welcome.s3.body':
    'Help > Help centre lists the tutorials, and the Assistant button at the top opens a panel where you can ask how something works. The assistant explains the application; it cannot change anything.',
  'help.t.welcome.s4.title': 'Set up accounting first',
  'help.t.welcome.s4.body':
    'Accounting needs to be set up before you record documents. Open Accounting > Setup and choose the chart of accounts template, the base currency and the first fiscal year.',
  'help.t.welcome.s5.title': 'Protect your account',
  'help.t.welcome.s5.body':
    'Open Account security at the top of the page to manage your two-step verification and trusted devices. Two-step verification protects owners and privileged roles.',

  'help.t.dashboard.title': 'Dashboard overview',
  'help.t.dashboard.summary': 'What the Overview page shows and where to find your numbers.',
  'help.t.dashboard.objective': 'Understand Overview and know which pages hold financial figures.',
  'help.t.dashboard.prereq1': 'You have signed in to an organization.',
  'help.t.dashboard.s1.title': 'What Overview shows',
  'help.t.dashboard.s1.body':
    'Overview shows who is signed in, whether you are the owner or a member of the active organization, and the organizations you belong to. The active one is marked.',
  'help.t.dashboard.s2.title': 'Switch organization',
  'help.t.dashboard.s2.body':
    'If you belong to more than one organization, use the organization switcher at the top of the menu to change the active one. Everything you see, and every figure, belongs to the active organization only.',
  'help.t.dashboard.s3.title': 'Find your numbers',
  'help.t.dashboard.s3.body':
    'Overview does not show financial figures. They are in the reports: Accounting > Trial Balance, Profit & Loss and Balance Sheet, and the reports under Sales and Purchases. You see the ones your role allows.',

  'help.t.business-settings.title': 'Business and financial settings',
  'help.t.business-settings.summary':
    'Company details, accounting setup, control accounts and periods.',
  'help.t.business-settings.objective':
    'Know where the company and financial settings are and what each one controls.',
  'help.t.business-settings.prereq1':
    'You can open the settings pages below. Steps for pages you cannot open are left out.',
  'help.t.business-settings.prereq2':
    'Accounting settings affect every document, so change them together with the person responsible for your books.',
  'help.t.business-settings.s1.title': 'Company profile',
  'help.t.business-settings.s1.body':
    'Open Organization > Company profile to review and update the company details.',
  'help.t.business-settings.s2.title': 'Accounting setup',
  'help.t.business-settings.s2.body':
    'Open Accounting > Setup to choose the chart of accounts template, the base currency and the first fiscal year.',
  'help.t.business-settings.s3.title': 'Sales settings',
  'help.t.business-settings.s3.body':
    'Open Sales > Settings to choose the receivables account and the defaults for new invoices, such as the payment terms.',
  'help.t.business-settings.s4.title': 'Purchases settings',
  'help.t.business-settings.s4.body':
    'Open Purchases > Settings to choose the control accounts and the defaults for bills and payments.',
  'help.t.business-settings.s5.title': 'Fiscal years and periods',
  'help.t.business-settings.s5.body':
    'Open Accounting > Periods (and Fiscal Years) to see the accounting periods. A closed period cannot receive new postings until someone with permission reopens it, and a posted journal cannot be edited.',

  'help.t.customers-suppliers.title': 'Customers and suppliers',
  'help.t.customers-suppliers.summary':
    'Add and manage the customers you sell to and the vendors you buy from.',
  'help.t.customers-suppliers.objective':
    'Add a customer and a vendor, and know how to retire one safely.',
  'help.t.customers-suppliers.prereq1':
    'You can view customers or vendors. Adding one needs its own permission.',
  'help.t.customers-suppliers.s1.title': 'Open Customers',
  'help.t.customers-suppliers.s1.body': 'Open Sales > Customers to see your customers.',
  'help.t.customers-suppliers.s2.title': 'Add a customer',
  'help.t.customers-suppliers.s2.body':
    'Choose New customer, fill in the name, currency and terms, and save. The customer can then be chosen on invoices.',
  'help.t.customers-suppliers.s3.title': 'Open Vendors',
  'help.t.customers-suppliers.s3.body':
    'Open Purchases > Vendors. Suppliers are called vendors in Intuit 2.0.',
  'help.t.customers-suppliers.s4.title': 'Add a vendor',
  'help.t.customers-suppliers.s4.body':
    'Choose New vendor, fill in the name, currency and terms, and save. The vendor can then be chosen on bills.',
  'help.t.customers-suppliers.s5.title': 'Archive instead of delete',
  'help.t.customers-suppliers.s5.body':
    'A customer or vendor you no longer use can be archived instead of removed, so past documents keep their history.',

  'help.t.invoices.title': 'Creating and managing invoices',
  'help.t.invoices.summary': 'Create, issue, collect and correct an invoice.',
  'help.t.invoices.objective':
    'Create an invoice, issue it, record the payment, and know how to correct it.',
  'help.t.invoices.prereq1': 'Accounting is set up and Sales > Settings has a receivables account.',
  'help.t.invoices.prereq2': 'You have at least one customer.',
  'help.t.invoices.s1.title': 'Open Invoices',
  'help.t.invoices.s1.body': 'Open Sales > Invoices to see your invoices and their status.',
  'help.t.invoices.s2.title': 'Start a new invoice',
  'help.t.invoices.s2.body': 'Choose New invoice, then choose the customer and the dates.',
  'help.t.invoices.s3.title': 'Add lines and check the totals',
  'help.t.invoices.s3.body':
    'Add lines with items or descriptions, quantities, prices and tax. Save the draft and check the totals. A draft can still be changed.',
  'help.t.invoices.s4.title': 'Issue the invoice',
  'help.t.invoices.s4.body':
    'Choose Issue, then Confirm and issue, to post it. If an approval policy applies, choose Submit for approval instead. An issued invoice cannot be edited.',
  'help.t.invoices.s5.title': 'Record the payment',
  'help.t.invoices.s5.body':
    'Open Sales > Receipts and choose Record receipt. Choose the customer, the date, the bank or cash account and the amount, then allocate it to the open invoices. Any amount you do not allocate stays as customer credit.',
  'help.t.invoices.s6.title': 'Correct a mistake',
  'help.t.invoices.s6.body':
    'To correct an issued invoice, Void it if it has no payments or credits, or create a credit note under Sales > Credit notes. A credit note can be applied to an invoice or refunded from Sales > Refunds.',

  'help.t.expenses-payments.title': 'Recording expenses and payments',
  'help.t.expenses-payments.summary': 'Record bills and direct expenses, and pay them.',
  'help.t.expenses-payments.objective': 'Record a bill and an expense, and pay what you owe.',
  'help.t.expenses-payments.prereq1':
    'Accounting is set up and Purchases > Settings has its control accounts.',
  'help.t.expenses-payments.prereq2': 'You have at least one vendor for bills.',
  'help.t.expenses-payments.s1.title': 'Open Bills',
  'help.t.expenses-payments.s1.body':
    'Open Purchases > Bills. A bill records what you owe a vendor.',
  'help.t.expenses-payments.s2.title': 'Enter a bill',
  'help.t.expenses-payments.s2.body':
    'Choose New bill, choose the vendor, add the lines, save, and then Post it. A posted bill cannot be edited.',
  'help.t.expenses-payments.s3.title': 'Record a direct expense',
  'help.t.expenses-payments.s3.body':
    'Open Purchases > Expenses and choose New expense for a cost paid directly. An administrator can set expense policies that warn about, or block, certain expenses when they are posted.',
  'help.t.expenses-payments.s4.title': 'Pay a bill',
  'help.t.expenses-payments.s4.body':
    'Open Purchases > Payments and choose New payment to settle a bill.',
  'help.t.expenses-payments.s5.title': 'Pay several bills',
  'help.t.expenses-payments.s5.body': 'Open Purchases > Pay bills to pay several bills at once.',

  'help.t.reports.title': 'Understanding accounting reports',
  'help.t.reports.summary': 'Read the main financial reports and see where each number comes from.',
  'help.t.reports.objective':
    'Read the Trial Balance, Profit & Loss, Balance Sheet and the aging reports.',
  'help.t.reports.prereq1':
    'Reports need the matching view permission. Steps for reports you cannot open are left out.',
  'help.t.reports.s1.title': 'Open Accounting',
  'help.t.reports.s1.body':
    'Open Accounting. Its menu lists the reports: Trial Balance, Profit & Loss, Balance Sheet, Cash Flow and Changes in Equity.',
  'help.t.reports.s2.title': 'Trial Balance',
  'help.t.reports.s2.body':
    'Open Accounting > Trial Balance. It lists every account with its debits and credits, and the totals must balance. Choose the period or dates and run it.',
  'help.t.reports.s3.title': 'Profit & Loss',
  'help.t.reports.s3.body':
    'Open Accounting > Profit & Loss. It shows revenue and expenses for a period and the resulting net profit or loss.',
  'help.t.reports.s4.title': 'Balance Sheet',
  'help.t.reports.s4.body':
    'Open Accounting > Balance Sheet. It shows assets, liabilities and equity at a date.',
  'help.t.reports.s5.title': 'Receivables aging',
  'help.t.reports.s5.body':
    'Open Sales > Reports to see what customers owe you, grouped by how overdue it is.',
  'help.t.reports.s6.title': 'Payables aging',
  'help.t.reports.s6.body':
    'Open Purchases > Reports to see what you owe vendors, grouped by how overdue it is.',
  'help.t.reports.s7.title': 'What the reports include',
  'help.t.reports.s7.body':
    'Reports read posted entries only, so a draft journal appears in no report. Use the General Ledger to trace a figure to its entries, and export when you need a file.',

  'help.t.banking.title': 'Banking and reconciliation',
  'help.t.banking.summary': 'Import a bank statement, match it to your books and reconcile.',
  'help.t.banking.objective': 'Import a statement, match its lines and reconcile the account.',
  'help.t.banking.prereq1': 'You can open Banking and have at least one bank account there.',
  'help.t.banking.prereq2': 'You have a statement file from your bank, in CSV or OFX format.',
  'help.t.banking.s1.title': 'Open Banking',
  'help.t.banking.s1.body': 'Open Banking and choose a bank account.',
  'help.t.banking.s2.title': 'Import a statement',
  'help.t.banking.s2.body':
    'Import a statement file: a CSV file (you map its columns) or an OFX file.',
  'help.t.banking.s3.title': 'Match the lines',
  'help.t.banking.s3.body':
    'Match each statement line to a posted entry, or categorize it into a bank entry.',
  'help.t.banking.s4.title': 'Reconcile',
  'help.t.banking.s4.body':
    'When the lines are matched, reconcile the account. Reconciling needs its own permission.',
  'help.t.banking.s5.title': 'Know the limits',
  'help.t.banking.s5.body':
    'Statements are imported from files. Live bank feeds are not implemented, so nothing is fetched from your bank automatically.',

  'help.t.inventory-appointments.title': 'Inventory and appointments',
  'help.t.inventory-appointments.summary':
    'Track stock and, when the Clinic module is on, book appointments.',
  'help.t.inventory-appointments.objective': 'Know how stock is tracked and how appointments work.',
  'help.t.inventory-appointments.prereq1':
    'Inventory needs the inventory permission. Appointments need the Clinic module, which an administrator switches on.',
  'help.t.inventory-appointments.s1.title': 'Open Inventory',
  'help.t.inventory-appointments.s1.body':
    'Open Inventory to see the items tracked in stock with their quantities and values. Stock is valued at weighted-average cost.',
  'help.t.inventory-appointments.s2.title': 'How stock moves',
  'help.t.inventory-appointments.s2.body':
    'Stock comes in when a bill containing the item is posted and goes out when an invoice containing it is issued.',
  'help.t.inventory-appointments.s3.title': 'Adjustments and counts',
  'help.t.inventory-appointments.s3.body':
    'Use Inventory for stock adjustments, stock counts and warehouses.',
  'help.t.inventory-appointments.s4.title': 'Switch on Clinic',
  'help.t.inventory-appointments.s4.body':
    'Appointments belong to the optional Clinic module. An administrator switches it on under Organization > Modules.',
  'help.t.inventory-appointments.s5.title': 'Set up the clinic',
  'help.t.inventory-appointments.s5.body':
    'In Clinic, set up services and practitioners, then add patients.',
  'help.t.inventory-appointments.s6.title': 'Book appointments',
  'help.t.inventory-appointments.s6.body':
    'Book appointments for patients with a practitioner and a service. A completed appointment can be turned into an invoice. Clinic holds administrative and billing data only; there are no clinical notes.',

  'help.t.roles-security.title': 'User roles, permissions and security',
  'help.t.roles-security.summary': 'Who can do what, and how the organization is protected.',
  'help.t.roles-security.objective':
    'Understand roles, permissions, two-step verification and the audit log.',
  'help.t.roles-security.prereq1': 'Steps for pages you cannot open are left out of this tutorial.',
  'help.t.roles-security.s1.title': 'Members',
  'help.t.roles-security.s1.body': 'Open Members to invite people and give them roles.',
  'help.t.roles-security.s2.title': 'Roles',
  'help.t.roles-security.s2.body':
    'Open Roles to see what each role may do. Custom roles can be created.',
  'help.t.roles-security.s3.title': 'Permissions are enforced by the server',
  'help.t.roles-security.s3.body':
    'A role is a set of permissions. Hiding a menu entry is only a convenience: the server checks the permission on every request.',
  'help.t.roles-security.s4.title': 'Audit log',
  'help.t.roles-security.s4.body':
    'Open Security & audit > Audit log to review who did what. It records sensitive actions.',
  'help.t.roles-security.s5.title': 'Organization security',
  'help.t.roles-security.s5.body':
    'Open Security & audit > Security to see the organization security policy, including two-step verification.',
  'help.t.roles-security.s6.title': 'Your own account',
  'help.t.roles-security.s6.body':
    'Open Account security at the top of the page to manage your two-step verification and trusted devices.',
} as const;
