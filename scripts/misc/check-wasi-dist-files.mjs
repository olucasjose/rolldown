// Guard that a built dist contains EXACTLY the expected WASI artifact set for
// its flavor. The set is copied into dist by
// packages/rolldown/copy-addon-plugin.ts; if that list ever drops a file (as
// happened with the `wasip1-deferred` loader) the package silently
// ships without it while every build stays green. This check holds its OWN
// copy of the canonical per-flavor sets (the naming matrix in
// internal-docs/async-runtime/implementation.md) so drift in the plugin's
// list fails loudly here.
//
// NOTE on the `wasip1-deferred` loader: the single-flavor dists carry it for
// set-consistency only. `@rolldown/browser` deliberately exposes no `exports`
// entry for it (or for the wasm), so it is unreachable there by design; the
// supported workerd consumption path is the generated
// `@rolldown/binding-wasm32-wasip1` package, which has no `exports` field and
// therefore allows the deep imports the upstream workerd/miniflare test uses
// (`import { instantiate } from
// '@rolldown/binding-wasm32-wasip1/rolldown-binding.wasip1-deferred.js'`).
//
// Usage: node scripts/misc/check-wasi-dist-files.mjs <threaded|single> [distDir]
//   flavor   threaded = wasm32-wasip1-threads dist (legacy `wasi` names)
//            single   = wasm32-wasip1 dist (`wasip1` names, deferred loader,
//                       no worker scripts)
//   distDir  defaults to packages/rolldown/dist (repo-relative); pass
//            packages/browser/dist for the @rolldown/browser publish path.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Canonical per-flavor artifact sets. Keep in sync with the naming matrix in
// internal-docs/async-runtime/implementation.md — NOT with
// copy-addon-plugin.ts, whose drift this guard exists to catch.
const WASI_FILE_SETS = {
  threaded: [
    'rolldown-binding.wasm32-wasi.wasm',
    'rolldown-binding.wasi-browser.js',
    'rolldown-binding.wasi.cjs',
    'wasi-worker-browser.mjs',
    'wasi-worker.mjs',
  ],
  single: [
    'rolldown-binding.wasm32-wasip1.wasm',
    'rolldown-binding.wasip1-browser.js',
    'rolldown-binding.wasip1-deferred.js',
    'rolldown-binding.wasip1.cjs',
  ],
};

// WASI-artifact discriminator: a top-level dist entry belongs to the WASI
// artifact family when its basename
//   - starts with `rolldown-binding.` and contains `wasi` (loaders + wasm of
//     BOTH flavors, incl. `.debug.wasm` leftovers), or
//   - starts with `wasi-worker` (threaded worker scripts), or
//   - ends with `.wasm` (any wasm in these dists is a WASI artifact).
// Deliberately name-prefix-anchored so hashed chunk files (e.g.
// `constructors-<hash>.js` in the browser dist) can never false-positive.
// Canonical like the sets above — independent of copy-addon-plugin.ts.
const WASI_ARTIFACT_RE = /^rolldown-binding\..*wasi|^wasi-worker|\.wasm$/;

const [flavor, distDirArg] = process.argv.slice(2);
if (flavor !== 'threaded' && flavor !== 'single') {
  console.error('Usage: node scripts/misc/check-wasi-dist-files.mjs <threaded|single> [distDir]');
  process.exit(2);
}

const distDir = distDirArg
  ? path.resolve(process.cwd(), distDirArg)
  : path.join(REPO_ROOT, 'packages/rolldown/dist');

if (!fs.existsSync(distDir)) {
  console.error(`dist directory not found: ${distDir}`);
  process.exit(1);
}

const expected = WASI_FILE_SETS[flavor];

// Strict set-equality between the expected set and the ACTUAL WASI-family
// subset of the dist listing. Every build wipes dist first
// (packages/rolldown/build.ts), so anything extra — the other flavor's files,
// a debug wasm, a renamed leftover, an accidentally copied loader — is a
// packaging bug, and the release workflow uploads dist/** so it would ship.
const entries = fs.readdirSync(distDir, { withFileTypes: true });
const wasiEntries = entries.filter((e) => WASI_ARTIFACT_RE.test(e.name));
const nonFiles = wasiEntries.filter((e) => !e.isFile()).map((e) => e.name);
const actual = new Set(wasiEntries.filter((e) => e.isFile()).map((e) => e.name));

const missing = expected.filter((f) => !actual.has(f));
const unexpected = [...actual].filter((f) => !expected.includes(f)).sort();
// Zero-byte artifacts are truncated/failed copies, not artifacts.
const empty = expected.filter(
  (f) => actual.has(f) && fs.statSync(path.join(distDir, f)).size === 0,
);

if (missing.length > 0 || unexpected.length > 0 || nonFiles.length > 0 || empty.length > 0) {
  console.error(`WASI dist file set mismatch for flavor '${flavor}' in ${distDir}:`);
  console.error();
  for (const f of missing) {
    console.error(`  missing:    ${f}`);
  }
  for (const f of unexpected) {
    console.error(`  unexpected: ${f} (not part of the '${flavor}' set)`);
  }
  for (const f of nonFiles) {
    console.error(`  non-file:   ${f} (WASI-family name but not a regular file)`);
  }
  for (const f of empty) {
    console.error(`  empty:      ${f} (0 bytes — truncated copy)`);
  }
  console.error();
  console.error(
    'The packaged WASI artifact set must match the naming matrix in ' +
      'internal-docs/async-runtime/implementation.md. Check the ' +
      'WASM_FILE_LIST_* lists in packages/rolldown/copy-addon-plugin.ts and ' +
      'the TARGET wiring in packages/rolldown/build.ts.',
  );
  process.exit(1);
}

const packaged = expected.map((f) => {
  const { size } = fs.statSync(path.join(distDir, f));
  return `  ${f} (${size} bytes)`;
});
console.log(`OK: '${flavor}' WASI dist file set complete in ${distDir}:`);
console.log(packaged.join('\n'));
