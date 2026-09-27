# @intuit-2/api

Backend for Intuit 2.0: a **modular monolith** on Node.js, TypeScript, Fastify, Drizzle ORM, PostgreSQL and Zod.

## Layout

| Folder | Responsibility |
| --- | --- |
| `src/api` | HTTP layer: Fastify plugins, versioned routes (`/api/v1`), request validation, auth and authorization middleware, response and error formatting. No business logic. |
| `src/application` | Cross-module application services: authorization context, transaction/unit-of-work helpers, command/query conventions. |
| `src/domain` | Shared domain primitives (IDs, money/currency types, domain errors). No framework or database imports. |
| `src/infrastructure` | Technical adapters: database pool, logging, configuration, clock, provider abstractions (email, later storage/OCR/payments). |
| `src/modules` | Business modules. Each module owns its use cases, domain logic, persistence and public contract. Phase 1 modules: identity, organizations, access control, audit, outbox. |
| `src/shared` | Small utilities with no business meaning. |
| `src/database` | Drizzle configuration, SQL migrations, development seed data. |
| `test` | Integration tests against a real PostgreSQL database. |

## Module rule

A module may only be used through its public contract (application services, commands/queries, internal events). It must never read or write another module's tables directly.
