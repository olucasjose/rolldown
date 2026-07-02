# Async Runtime - Implementation

> The rationale and principles behind this live in [design.md](./design.md).

## Summary

The `async-runtime` Cargo feature installs a Rolldown scheduler into napi-rs,
routes Rolldown task creation through `rolldown_utils::futures`, and builds the
browser artifact for `wasm32-wasip1`. The `tokio-runtime` feature remains the
default.

## Components

### napi-rs runtime registration

The sibling napi-rs checkout adds the `async-runtime` feature and
`AsyncRuntime` registration interface in `crates/napi/src/tokio_runtime.rs`.
When the feature is enabled, registered-runtime execution takes precedence even
if another dependency enables `tokio_rt` through Cargo feature unification.
This is required because OXC's NAPI crates enable napi-rs async support.

Promise resolution and panic rejection remain owned by napi-rs. Runtime start,
shutdown, entry, spawn, block-on, and blocking-work operations delegate to the
registered implementation. The optional `AsyncRuntime::spawn_blocking` hook is
implemented so napi and transitive callers use Rolldown's bounded blocking lane
instead of napi's dedicated-thread fallback.

### Rolldown scheduler

`crates/rolldown_utils/src/async_runtime.rs` owns the lazy global controller.

- `CurrentThreadExecutor` uses a reentrancy-safe FIFO runnable queue. Wakes drain
  cooperatively on the calling thread. Blocking work executes inline.
- `MultiThreadExecutor` schedules bounded queue-drain jobs on a custom Rayon
  pool. The same pool is inherited by nested `par_iter` calls.
- A second FIFO holds blocking closures. `active_blocking` limits how many
  Rayon workers may block at once.
- `JoinHandle` normalizes async-task, blocking-job, and immediate results.
- Atomic metrics expose task, poll, queue-depth, active-worker, panic, and
  blocking-concurrency counters.

The binding adapter and JS-facing configuration live in
`crates/rolldown_binding/src/async_runtime.rs`. Configuration sources are:

- `ROLLDOWN_RUNTIME=single|current-thread|multi|multi-thread`
- `ROLLDOWN_WORKER_THREADS`
- `ROLLDOWN_MAX_BLOCKING_THREADS` (retained as the compatibility environment
  variable name; it now caps jobs within the fixed pool)
- `configureAsyncRuntime({ flavor, workerThreads, maxBlockingTasks })`, exported
  from `rolldown/experimental`

Configuration must happen before the first async binding call.

This API is feature-gated. `configureAsyncRuntime`, `getAsyncRuntimeConfig`, and
`getAsyncRuntimeMetrics` are exported on every build, but only the
`async-runtime` build honors them. On the default `tokio-runtime` build
`configureAsyncRuntime` throws a feature-disabled error (built without the
`async-runtime` feature), `getAsyncRuntimeConfig` reports values derived from the
environment variables and built-in defaults, and `getAsyncRuntimeMetrics` always
returns zeroed counters.

### Routed work

`rolldown_utils::futures` is the compatibility facade. The following work is
routed through the selected runtime:

- module-loader tasks
- blocking source reads
- asset/copy plugin reads
- dev and watch coordinator tasks
- binding close/flush blocking work

The native-magic-string sourcemap consumer deliberately uses one dedicated OS
thread in modes where threads are supported. It cannot occupy the bounded
blocking lane: its long-lived channel receive loop would monopolize a worker and
deadlock a one-worker runtime before module tasks could produce messages. The
consumer is disabled for current-thread mode, where the existing inline
sourcemap path remains active.

### Timers and native watch mode

`rolldown_utils::time::sleep_until` routes watcher debounce timers to Tokio on
the default build and to the shared runtime otherwise. `MultiThreadExecutor`
uses an executor-owned timer heap and timekeeper role. `CurrentThreadExecutor`
uses the host `TimerDriver` registered by `packages/rolldown/src/timer-host.ts`,
which delegates to `setTimeout` in each importing environment.

Native watch mode is supported on both runtime flavors. Binding dev mode is
still skipped on CurrentThread, and WASI watch remains unsupported because it
stalls during the initial build before debounce timers are involved.

### Non-threaded WASI

The browser build uses:

```text
wasm32-wasip1
--no-default-features
--features async-runtime
```

The napi-rs CLI changes from napi-rs#3353 link `libemnapi-basic.a`, emit
unshared `WebAssembly.Memory`, set `asyncWorkPoolSize: 0`, and omit Worker
imports and factories. `packages/rolldown` keeps the threaded WASI scripts and
adds `build-binding:wasi-single`; browser-package scripts select the
single-thread variant. Until those napi-rs CLI changes are published, the
single-thread build loads the pnpm-patched CLI source from the installed
package; other build variants use the normal package entry.

Each WASI flavor has its own artifact names end to end (napi CLI
`parseTriple`: non-threaded `wasm32-wasipX` triples get their own
`platformArchABI`, threaded flavors keep the legacy `wasm32-wasi` name for
back-compat):

| Artifact                  | threaded (`wasm32-wasip1-threads`)                  | single-thread (`wasm32-wasip1`)                         |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| wasm                      | `rolldown-binding.wasm32-wasi.wasm`                 | `rolldown-binding.wasm32-wasip1.wasm`                   |
| node loader               | `rolldown-binding.wasi.cjs`                         | `rolldown-binding.wasip1.cjs`                           |
| browser loader            | `rolldown-binding.wasi-browser.js`                  | `rolldown-binding.wasip1-browser.js`                    |
| deferred (workerd) loader | —                                                   | `rolldown-binding.wasip1-deferred.js`                   |
| worker scripts            | `wasi-worker.mjs`, `wasi-worker-browser.mjs`        | —                                                       |
| npm dir / package         | `npm/wasm32-wasi` → `@rolldown/binding-wasm32-wasi` | `npm/wasm32-wasip1` → `@rolldown/binding-wasm32-wasip1` |

Unshared memory growth detaches the previous JavaScript `ArrayBuffer`. The
emnapi fix in emnapi#220 refreshes TSFN atomic views after event-loop turns and
refreshes NAPI result DataViews after reentrant JavaScript calls. Rolldown
applies the equivalent published-package workaround through
`patches/@emnapi__core@1.11.2.patch`. emnapi 1.11.2 already includes the
separate bound-`setImmediate` fix from emnapi#221.

The two WASI flavors have distinct artifact sets:

- threaded `wasm32-wasip1-threads`: `rolldown-binding.wasm32-wasi.wasm`,
  `.wasi.cjs`, `.wasi-browser.js`, and worker scripts
- single-thread `wasm32-wasip1`: `rolldown-binding.wasm32-wasip1.wasm`,
  `.wasip1.cjs`, `.wasip1-browser.js`, and `.wasip1-deferred.js`, without
  worker scripts

### Committed WASI loaders and codegen checks

`packages/rolldown/src` commits BOTH flavors' loader sets side by side under
their per-flavor names (plus `browser.js`, which re-exports the single-thread
binding package — the browser story). Because the names are distinct, the old
name-collision guard lattice (restore steps in the justfile, the
`rolldown-binding.wasi.cjs` arm of the ci.yml drift allowlist, the wasi
build-order coupling in the WASI workflow) is gone:

- The vendored CLI patch (`patches/@napi-rs__cli@3.7.2.patch`) is a dist
  rebuild of the napi-rs fork branch (napi-rs#3353 + per-flavor naming): a
  build whose target is NOT wasi regenerates EVERY declared wasi flavor's
  loader set, each with `hasThreads` derived from its own triple, so loader
  regeneration is deterministic and byte-identical to the committed copies on
  every host and under every build variant. A wasi build regenerates only the
  flavor being built. No restore steps are needed; CI's "Check no diff" in
  `reusable-native-build.yml` has full coverage of all committed loaders.
- The Node Validation job in `ci.yml` still asserts a drift allowlist after
  `just build-browser`, but the allowlist is down to `binding.d.cts`
  (feature-gated doc-comment drift only).
- The threadless-ness of the single-thread loaders is guarded by
  `scripts/misc/check-wasi-threadless.mjs` in the WASI workflow (it inspects
  the committed/regenerated `rolldown-binding.wasip1.*` loaders); a wrong
  `hasThreads` resolution now additionally mis-NAMES the output, so imports
  fail loudly instead of silently swapping flavors.

Published artifacts never depend on the committed copies: every release
pipeline regenerates the loaders for its own target right before bundling,
and `napi artifacts` routes each flavor's wasm + loaders into its own npm dir
(`npm/wasm32-wasi`, `npm/wasm32-wasip1`) by exact-name match.

## Metrics And Baseline

Superseded: committed, reproducible measurements now live in
[benchmarks.md](./benchmarks.md) (harness:
`scripts/misc/bench-async-runtime/`). They confirm the earlier illustrative
observation — the Tokio-async + Tokio-blocking + Rayon thread population
collapses to a single shared pool (56 → 25 peak threads on the measured host)
— and add wall-time, instruction, RSS, and context-switch comparisons across
four fixtures, plus the blocking-cap A/B that validated keeping the
`max_blocking_tasks = worker_threads` default.

## Related

- [benchmarks.md](./benchmarks.md) - committed tokio-vs-shared measurements
- [design.md](./design.md) - goals and trade-offs
- [bundler-data-lifecycle](../bundler-data-lifecycle/implementation.md) -
  deferred-drop interaction with Rayon
