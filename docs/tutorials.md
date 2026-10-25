# Tutorial catalogue

The Help centre (**Help > Help centre**) offers ten step-by-step tutorials. Each has an objective, prerequisites, numbered steps with the exact menu names, and **Back**, **Next**, **Skip tutorial** and **Exit** controls. Progress is saved per member and per organization, so you can leave and **Resume**, or **Repeat** a finished tutorial. A tutorial or step that needs a permission you do not have, or a module that is switched off, is shown as unavailable or left out rather than described as if it worked. Steps can link to the page they are about.

| #   | Id                       | Tutorial                             | Needs                                                       | Steps |
| --- | ------------------------ | ------------------------------------ | ----------------------------------------------------------- | ----- |
| 1   | `welcome`                | Welcome and first sign-in            | Everyone (the accounting step needs `accounting.setup`)     | 5     |
| 2   | `dashboard`              | Dashboard overview                   | Everyone (the reports step needs `accounting.reports.view`) | 3     |
| 3   | `business-settings`      | Business and financial settings      | Organization, accounting setup or periods access            | 5     |
| 4   | `customers-suppliers`    | Customers and suppliers              | View access to customers or vendors                         | 5     |
| 5   | `invoices`               | Creating and managing invoices       | Sales access                                                | 6     |
| 6   | `expenses-payments`      | Recording expenses and payments      | Purchases access                                            | 5     |
| 7   | `reports`                | Understanding accounting reports     | Any report view permission                                  | 7     |
| 8   | `banking`                | Banking and reconciliation           | Banking access                                              | 5     |
| 9   | `inventory-appointments` | Inventory and appointments           | Inventory access, or the Clinic module with clinic access   | 6     |
| 10  | `roles-security`         | User roles, permissions and security | Everyone (steps for pages you cannot open are left out)     | 6     |

Banking, inventory and appointments exist in the application, so their tutorials are included; they describe only what is implemented (statement files, not bank feeds; administrative clinic data, not clinical notes).

## Where the pieces are

- Catalogue structure and availability rules: `apps/web/src/features/help/tutorials.ts`.
- Text: `apps/web/src/i18n/messages.help.en.ts`, keys `help.t.<id>.title`, `.summary`, `.objective`, `.prereq<N>`, `.s<N>.title`, `.s<N>.body`. A test checks that every tutorial, prerequisite and step has text and that no text is orphaned.
- Progress: `GET /tutorials/progress`, `PUT` and `DELETE /tutorials/progress/:tutorialId`; table `tutorial_progress` (migration 0096, not yet applied to any database).
- Contextual help: the top bar shows **Help for this page** where a tutorial covers the page (`contextPrefixes`). The Overview page offers the welcome tutorial until the member starts, skips or finishes it.

## Adding or changing a tutorial

1. Add the definition to `TUTORIALS` (id, steps with optional `route` and `requires`, `prerequisites`, `contextPrefixes`). The id must match `^[a-z0-9][a-z0-9-]{0,59}$`.
2. Add the text keys. Use the labels the application shows. Describe only features that exist.
3. If a help topic should link to it, set `tutorialId` on the topic in `apps/api/src/application/assistant/knowledge.ts`.
4. Run the web tests: they fail on missing text, orphaned text and routes that do not exist.
