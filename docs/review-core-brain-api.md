# Code Review: packages/core, packages/brain, apps/api

**Reviewer:** Claude (Senior Code Review)
**Date:** 2026-03-29
**Scope:** packages/core, packages/brain, apps/api
**Verdict:** Solid foundation with three real bugs and several structural gaps that must be resolved before this is beta-ready.

---

## Summary

The ClawTeam produced actual implementation — not stubs. All three areas have real, running code with proper TypeScript. The dist artifacts confirm everything compiled. The brain router is the strongest piece. The core types are clean. The API server is thin but correct. The problems are specific and fixable.

---

## packages/core

### What is solid

- All five type files (`brain.ts`, `connector.ts`, `tenant.ts`, `health.ts`, `user.ts`) are fully defined, not stubs.
- `BrainCapabilities`, `TenantConfig`, and `ConnectorProvider` are well-structured and properly exported through the barrel chain: `types/index.ts` → `src/index.ts` → dist.
- Cross-file imports use `.js` extensions correctly for NodeNext module resolution.
- Workspace symlink (`node_modules/@boss/core -> ../../packages/core`) is set up and the package has a built `dist/`.
- `tsconfig.json` sets `composite: true`, which is required for project references. The API tsconfig correctly references it.

### Critical issues

**1. `BrainCapabilities` is duplicated across packages.**

`packages/core/src/types/brain.ts` defines `BrainCapabilities`, `BrainRequest`, `BrainResponse`, and `BrainTool`.
`packages/brain/src/types.ts` redefines all of these with different shapes.

The two `BrainRequest` interfaces are structurally incompatible:

- Core version: `{ id, tenantId, userId, prompt, context?, tools?, stream? }` — `tenantId` and `userId` are top-level fields.
- Brain version: `{ id, type, prompt, context?, tools?, stream?, preferredAdapter? }` — `tenantId` and `userId` are inside `context`, and a required `type: BrainRequestType` field exists that core's version lacks entirely.

Similarly, `BrainResponse` differs:
- Core version has no `adapterId`, no `latencyMs`, no `error` field.
- Brain version has all three and omits nothing.

`BrainTool` in core vs `ToolDefinition` in brain — same concept, different names.

Any code that imports `BrainRequest` from `@boss/core` and passes it into the brain router will fail at runtime or compile time because the shapes do not match. This is the most dangerous issue in the codebase.

**Fix:** Either make `@boss/brain` extend and re-export the core types (preferred — single source of truth), or remove the brain types from core entirely and have everything import from `@boss/brain`. The brain package's types.ts is the richer, more correct definition. Core should keep only the thin, provider-agnostic types.

### Warnings

**2. `TenantConfig` has only one `brainProvider` and one `connectorProvider`.**

A tenant using both Microsoft and Google connectors simultaneously, or using multiple brain providers for different tasks, cannot be represented. The design document references multi-provider scenarios. This will hit you when implementing the connector layer.

**Suggested change:** `connectorProviders: ConnectorProvider[]` (plural array) and `brainProvider` can stay singular for now but document the constraint explicitly.

**3. `ConnectorAuth.expiresAt` is typed as `Date`.**

When this is serialized to/from Postgres or JSON (which it will be), it will arrive as a string. Every consumer will need defensive `new Date(expiresAt)` coercions. Consider typing it as `string` (ISO8601) at the persistence boundary and only constructing `Date` objects in the application layer, or add a Zod schema that handles the coercion automatically.

**4. The `@boss/core` package has no `exports` field in `package.json`.**

With `"module": "NodeNext"` in the base tsconfig, Node's module resolution will look for an `exports` map. Without it, deep imports like `@boss/core/types/brain` would fail. The current usage only imports from the package root (`@boss/core`), so this is not a runtime bug yet, but adding `exports: { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } }` now prevents future breakage.

---

## packages/brain

### What is solid

- The `BrainRouter` class is a complete, working implementation. Capability-based routing, fallback retry loop, timeout wrapping, streaming fallback — all present and correct.
- `CAPABILITY_REQUIREMENTS` map is clean and correctly connects request types to capability fields.
- `selectCandidates` correctly filters by status and sorts by priority with `ready` over `degraded`.
- The `preferredAdapter` override is a good design — moves preferred adapter to front of candidates rather than bypassing the eligibility filter.
- All five adapters implement the `BrainAdapter` interface. Each has a working `execute()`, `healthCheck()`, and (where declared) `stream()`. This is real code, not stubs.
- SSE streaming parsing is correct in all three streaming adapters (claude-code, openai, gemini). The buffer/split/pop pattern handles partial chunks correctly.
- `FallbackTracker` circuit breaker with cooldown is a solid addition — it will prevent hammering dead adapters.
- Response type mappings are correct: Anthropic `input_tokens`/`output_tokens`, OpenAI `prompt_tokens`/`completion_tokens`, Gemini `promptTokenCount`/`candidatesTokenCount` all mapped properly.

### Critical issues

**5. `packages/brain/src/index.ts` exports nothing.**

The file contains only `export {};`. The `BrainRouter`, all five adapters, all three middleware factories, and all types are built into `dist/` correctly but are inaccessible via the package's public API. Any consumer doing `import { BrainRouter } from '@boss/brain'` gets nothing.

This is a ship-blocker. The brain package cannot be used as a library until this is fixed.

**Fix:**
```typescript
// packages/brain/src/index.ts
export { BrainRouter } from './router.js';
export type {
  BrainAdapter,
  BrainAdapterInfo,
  BrainRequest,
  BrainResponse,
  BrainStreamChunk,
  BrainCapabilities,
  BrainMiddleware,
  BrainRouterConfig,
  AdapterStatus,
  TokenUsage,
  ToolDefinition,
  ToolCall,
} from './types.js';
export { ClaudeCodeAdapter } from './adapters/claude-code.js';
export { OpenAIAdapter } from './adapters/openai.js';
export { GeminiAdapter } from './adapters/gemini.js';
export { OpenClawAdapter } from './adapters/openclaw.js';
export { CustomAdapter } from './adapters/custom.js';
export { createContextMiddleware } from './middleware/context.js';
export { createLearningMiddleware } from './middleware/learning.js';
export { FallbackTracker, createFallbackMiddleware } from './middleware/fallback.js';
```

**6. `packages/brain/tsconfig.json` uses `"module": "Node16"` while the workspace base uses `"module": "NodeNext"`.**

`Node16` and `NodeNext` are functionally similar today, but they are not identical. The spec says `NodeNext` is the "always current" version of `Node16`. More importantly: this package does not extend `../../tsconfig.base.json` — it defines its own compiler options from scratch, meaning it does not inherit `"composite": true` or other workspace-level settings. This breaks TypeScript project references, meaning `tsc --build` at the workspace root will not correctly track incremental builds for this package.

**Fix:** Add `"extends": "../../tsconfig.base.json"` and remove the duplicate options from the brain tsconfig, keeping only `outDir`, `rootDir`, and `types`. Add `"composite": true` if project references are intended.

### Warnings

**7. `learning.ts` middleware fires with empty `tenantId`, `userId`, `requestType`, and `prompt`.**

Lines 46-50 populate the `InteractionEntry` with empty strings for those four fields. A comment says "Populated from the original request context by the router" but the router does not pass the original request to post-middleware — only the response. The middleware has no access to the original request at that point.

This means every learning capture entry will have empty tenant/user/request context, making the captured data useless for behavioral learning.

**Fix:** The `MiddlewareContext` (passed as `ctx`) should carry the original request, or the learning middleware should be redesigned as a wrapper around `execute()` rather than a post-middleware hook. The simpler fix is to add `originalRequest?: BrainRequest` to `MiddlewareContext` and populate it in the router before calling pre-middleware.

**8. `FallbackTracker` is implemented but never wired into the `BrainRouter`.**

`fallback.ts` exports `FallbackTracker` and `createFallbackMiddleware`. The middleware is a no-op pass-through (lines 108-109 just return `input`). The `BrainRouter` does its own inline degradation by setting `adapter.info.status = 'degraded'` on the `BrainAdapterInfo` object directly (router.ts line 114), bypassing the tracker entirely.

This means the circuit breaker with cooldown logic in `FallbackTracker` is dead code. The router's inline status mutation also has a problem: it mutates the shared `BrainAdapterInfo` object, so a transient failure permanently marks an adapter as degraded until a health check runs.

**Fix:** Either integrate `FallbackTracker` into `BrainRouter` (pass a tracker instance to the constructor, call `recordFailure`/`recordSuccess` in the catch/resolve paths, and consult `getStatus` in `selectCandidates`), or remove the tracker if the inline approach is intentional and document the manual health check requirement.

**9. `claude-code.ts` CLI mode uses `--system-prompt` and `--print` flags.**

The `claude` CLI does not have a `--system-prompt` flag. The correct flag is `--system`. Line 132 passes `'--system-prompt'` which will either be silently ignored or cause the CLI call to fail. The `--print` flag is correct.

**Fix:** Change `'--system-prompt'` to `'--system'` on line 132.

**10. OpenAI streaming does not yield a final `done: true` chunk.**

In `openai.ts`, the streaming loop yields `done: true` only when it sees `[DONE]` in the SSE stream (line 151). If the connection closes without a `[DONE]` token (e.g., network drop, timeout), the consumer's async iterator never sees a completion signal. Claude-code and Gemini adapters both handle this correctly — they yield a final `done: true` after the read loop exits.

**Fix:** Add `yield { requestId: request.id, adapterId: this.info.id, delta: '', done: true };` after the `finally` block in `openai.ts`, mirroring the Gemini adapter pattern.

### Suggestions

**11. `openclaw.ts` does not implement `stream()`.**

OpenClaw capabilities declare `canStream: false`, which is honest and will correctly prevent the router from calling `stream()`. However, the adapter interface allows `stream` as optional. If someone later enables `canStream` on OpenClaw without implementing the method, the router will silently fall back to non-streaming `execute()`. This is technically correct per the router's fallback logic, but worth noting for the next engineer.

**12. The `pino` dependency in `brain/package.json` is declared but never imported.**

`pino` appears in `dependencies` but no file in `packages/brain/src/` imports it. Either remove it or add logging where appropriate (the router's fallback path and adapter errors are good candidates).

---

## apps/api

### What is solid

- Fastify v5 setup is correct. Plugin registration order (cors, helmet, error handler, hooks, routes) is proper.
- `authMiddleware` is fail-closed: if `BOSS_API_KEY` is not set, it returns 503 rather than allowing unauthenticated access. This is the right default for a Phase 1 implementation.
- `tenantMiddleware` resolution order (header, subdomain, env, default) is sensible and covers all three deployment modes.
- The health route correctly returns 503 when the system is not fully healthy (line 39). Many implementations incorrectly return 200 always.
- The `buildServer` function is correctly async and testable — it returns the server instance without starting it.
- Import paths use `.js` extensions throughout, which is correct for NodeNext.

### Critical issues

**13. `authMiddleware` and `tenantMiddleware` run on all routes including `/health`.**

The skip-path check works for `/health` and `/health/full`, but both arrays are defined independently in two separate files and can drift. More importantly, the middleware are registered as global `onRequest` hooks. If someone adds a `/health/metrics` route later, they must remember to update both arrays in two files, or the new route will require auth and tenant resolution.

**Fix:** Register protected routes under a prefix (e.g., `/api`) and apply the hooks only to that scope using Fastify's plugin encapsulation model, rather than using global hooks with a denylist. This removes the parallel arrays entirely.

**14. `(request as any).auth` and `(request as any).tenant` type assertions are a compile-time hole.**

Both middleware attach properties via `(request as any).X = ...`. Any route handler that reads `request.auth` or `request.tenant` gets `any` back and loses all type safety. TypeScript will not catch missing or mistyped property accesses.

**Fix:** Extend the Fastify type declarations:

```typescript
// src/types/fastify.d.ts
import 'fastify';
import type { TenantContext } from '@boss/core';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { token: string; userId: string };
    tenant?: TenantContext;
  }
}
```

With this in place, remove all `(request as any)` casts and let the type system enforce correctness.

### Warnings

**15. `authMiddleware` assigns `userId: 'default'` for all authenticated requests.**

Line 51: `(request as any).auth = { token, userId: 'default' }`. In Phase 1 this is acknowledged as temporary, but `tenantMiddleware` immediately reads this `userId` to populate `TenantContext.userId`. Any learning or audit records captured during this phase will have incorrect user attribution that cannot be corrected after a real auth system is added — the historical records will show `'default'` for every action.

If there is no real user system yet, `userId: 'api-key-default'` or deriving a deterministic ID from the token hash would at least produce distinct values per API key, making data migration possible later.

**16. `healthRoutes` imports `HealthStatus` from `@boss/core` but does not import `ServiceName`.**

The `checkService` function signature uses `HealthCheckResult['service']` to type its parameter, which resolves to `ServiceName`. This works correctly at compile time because it accesses the type via index. But it means the constraint on valid service names is invisible at the call site — passing an arbitrary string to `checkService` would be a type error caught only because of the lookup, not a clear `ServiceName` type annotation. Minor, but makes the intent opaque.

**17. The `/health` route prefix registration uses `{ prefix: '/health' }` but routes within use `/` and `/full`.**

This produces `/health` and `/health/full` as expected. However, the skip-path arrays in both middleware files use exact string starts:
- `'/health'` matches `/health`, `/health/full`, `/healthz`, `/health/anything`.

This is correct for the intent (skip all health routes) but it is more permissive than documented. If a future `/healthadmin` route is added under a different plugin, it would accidentally skip auth. The check should use `request.url === '/health' || request.url.startsWith('/health/')` for precision.

### Suggestions

**18. No request ID propagation.**

Fastify generates a request ID automatically, but it is not attached to responses or forwarded to downstream brain calls. When the brain layer is wired up, correlating API logs with brain adapter logs will require adding `request.id` to the `BrainRequest.id` field. Wire this up at the route handler level before adding brain routes.

**19. `process.env.CORS_ORIGIN || '*'` defaults to wildcard.**

This is reasonable for development but should be documented as a required configuration for any production deployment. Consider failing fast at startup if `CORS_ORIGIN` is not set and `NODE_ENV === 'production'`.

---

## Cross-cutting issues

**20. `packages/brain` does not declare `@boss/core` as a dependency.**

`brain/package.json` has `pino` and TypeScript dev deps. It does not list `@boss/core`. Currently the brain package defines its own types and does not import from core, so this is not a build error. But once issue #1 (type duplication) is fixed by having brain import from core, this dependency must be added. Track it now to avoid a confusing future build failure.

**21. No tests anywhere in the reviewed scope.**

`package.json` root has a `test` script that delegates to workspaces, but none of the three packages have test files or test runner configuration. The brain router's routing logic (capability matching, priority ordering, fallback retry count) and the adapter response parsing are the highest-value test targets. The auth middleware's fail-closed behavior also needs a test. Without tests, refactoring any of the above is high-risk.

---

## Priority matrix

### Must fix before beta

| # | File | Issue |
|---|------|-------|
| 1 | `packages/core/src/types/brain.ts` + `packages/brain/src/types.ts` | Duplicate, incompatible `BrainRequest`/`BrainResponse` definitions |
| 5 | `packages/brain/src/index.ts` | Exports nothing — entire package is unusable as a library |
| 9 | `packages/brain/src/adapters/claude-code.ts:132` | `--system-prompt` flag does not exist in claude CLI |
| 13 | `apps/api/src/server.ts` | Auth/tenant middleware on all routes with drifting denylist arrays |
| 14 | `apps/api/src/middleware/auth.ts`, `tenant.ts` | `(request as any)` loses all type safety on auth/tenant properties |

### Should fix before beta

| # | File | Issue |
|---|------|-------|
| 6 | `packages/brain/tsconfig.json` | Does not extend base config, missing `composite: true`, module mismatch |
| 7 | `packages/brain/src/middleware/learning.ts:46-50` | Empty tenant/user/requestType/prompt in all captured entries |
| 8 | `packages/brain/src/middleware/fallback.ts` | FallbackTracker is dead code, router's inline mutation is permanent |
| 10 | `packages/brain/src/adapters/openai.ts` | Streaming never emits final `done: true` on connection close |
| 15 | `apps/api/src/middleware/auth.ts:51` | `userId: 'default'` poisons all audit/learning records permanently |

### Consider improving

| # | File | Issue |
|---|------|-------|
| 2 | `packages/core/src/types/tenant.ts` | Single connector provider cannot represent dual-provider tenants |
| 3 | `packages/core/src/types/connector.ts` | `expiresAt: Date` will break on JSON serialization boundary |
| 4 | `packages/core/package.json` | Missing `exports` field |
| 11 | `packages/brain/src/adapters/openclaw.ts` | `canStream: false` is correct but undocumented risk |
| 12 | `packages/brain/package.json` | `pino` dependency declared but never used |
| 16 | `apps/api/src/routes/health.ts` | `ServiceName` type obscured behind index access |
| 17 | `apps/api/src/middleware/auth.ts`, `tenant.ts` | Skip-path check is more permissive than intended |
| 18 | `apps/api/src/routes/health.ts` | No request ID propagation to brain layer |
| 19 | `apps/api/src/server.ts` | `CORS_ORIGIN` defaults to wildcard with no production guard |
| 20 | `packages/brain/package.json` | `@boss/core` not declared as dependency (will matter after type consolidation) |
| 21 | All packages | Zero test coverage |
