// Verify that the runtime dependencies of `@rolldown/browser` satisfy the
// version ranges declared by the generated WASI binding packages
// (`@rolldown/binding-wasm32-wasip1`, the single-thread flavor the browser
// package bundles, and `@rolldown/binding-wasm32-wasi`, the threaded flavor
// the WebContainer fallback downloads; both produced by
// `napi create-npm-dirs`). The bindings are the source of truth: their glue
// code was built against those exact runtime versions, so the browser
// package — which bundles the glue code — must resolve to versions
// compatible with what the bindings expect.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TRACKED = ['@napi-rs/wasm-runtime', '@emnapi/core', '@emnapi/runtime'];
const BINDING_PKGS = [
  path.join(REPO_ROOT, 'packages/rolldown/npm/wasm32-wasip1/package.json'),
  path.join(REPO_ROOT, 'packages/rolldown/npm/wasm32-wasi/package.json'),
];

function readBindingSpecifiers(bindingPkg) {
  const pkg = JSON.parse(fs.readFileSync(bindingPkg, 'utf8'));
  const out = {};
  for (const name of TRACKED) {
    const v = pkg.dependencies?.[name];
    if (!v) {
      console.error(`${name} is missing from ${path.relative(REPO_ROOT, bindingPkg)}`);
      process.exit(1);
    }
    out[name] = v;
  }
  return out;
}

function readBrowserResolved() {
  const stdout = execFileSync(
    'vp',
    ['pm', 'list', '--filter', '@rolldown/browser', '--json', '--', ...TRACKED],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  const parsed = JSON.parse(stdout);
  const deps = parsed[0]?.dependencies ?? {};
  const out = {};
  for (const name of TRACKED) {
    const entry = deps[name];
    if (!entry?.version) {
      console.error(`${name} is not installed under @rolldown/browser — did \`vp install\` run?`);
      process.exit(1);
    }
    out[name] = entry.version;
  }
  return out;
}

const browserResolved = readBrowserResolved();

let failed = false;
for (const bindingPkg of BINDING_PKGS) {
  const bindingName = JSON.parse(fs.readFileSync(bindingPkg, 'utf8')).name;
  const bindingSpecifiers = readBindingSpecifiers(bindingPkg);

  const mismatches = [];
  for (const name of TRACKED) {
    const range = bindingSpecifiers[name];
    const version = browserResolved[name];
    if (!semver.satisfies(version, range)) {
      mismatches.push({ name, range, version });
    }
  }

  if (mismatches.length > 0) {
    failed = true;
    console.error(`@rolldown/browser's installed runtime deps do not satisfy ${bindingName}:`);
    console.error();
    for (const { name, range, version } of mismatches) {
      console.error(`  ${name}`);
      console.error(`    binding declares: ${range}`);
      console.error(`    browser resolved: ${version}`);
    }
    console.error();
  }
}

if (failed) {
  console.error(
    'The generated bindings are the source of truth. Bump the corresponding entry in pnpm-workspace.yaml (if referenced via `catalog:`) or in packages/browser/package.json so the resolved version falls within the binding range.',
  );
  process.exit(1);
}

console.log(
  'OK: @rolldown/browser satisfies @rolldown/binding-wasm32-wasip1 and @rolldown/binding-wasm32-wasi on @napi-rs/wasm-runtime, @emnapi/core, @emnapi/runtime.',
);
