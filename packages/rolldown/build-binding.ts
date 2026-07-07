import { readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBuildCommand, NapiCli } from '@napi-rs/cli';
import { globSync } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);

const napiCli = new NapiCli();
const buildCommand = createBuildCommand(args);

const argsOptions = buildCommand.getOptions();

const isRelease = argsOptions.release === true || argsOptions.profile === 'release';

// For published binaries, remap the absolute build-machine paths (cargo/rustup homes and
// the workspace root) that rustc embeds into panic locations and tracing callsite metadata.
// This shrinks the binary's string tables and keeps the build machine's filesystem layout
// out of the shipped artifact. Release-only so local dev backtraces keep clickable paths.
// Replace with cargo `-Ztrim-paths` once it stabilizes (rust-lang/cargo#12137).
//
// The flags are injected as a cargo `--config target.'cfg(all())'.rustflags=[…]` entry, NOT
// via RUSTFLAGS/CARGO_BUILD_RUSTFLAGS: config-level target rustflags are joined with the
// `.cargo/config.toml` target entries (windows crt-static, ucrt link-args), whereas the napi
// CLI promotes CARGO_BUILD_RUSTFLAGS to RUSTFLAGS, which would suppress those entries
// entirely (measured: it silently dropped crt-static from the windows binary).
// Known gap: napi-cli always sets RUSTFLAGS for musl targets (`-C target-feature=-crt-static`),
// which suppresses config-level rustflags there — musl artifacts keep unremapped paths.
let remapConfig: string | undefined;
if (isRelease) {
  const cargoHome = process.env.CARGO_HOME ?? resolve(homedir(), '.cargo');
  const rustupHome = process.env.RUSTUP_HOME ?? resolve(homedir(), '.rustup');
  const workspaceRoot = resolve(__dirname, '../..');
  const remaps = [
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${rustupHome}=/rustup`,
    `--remap-path-prefix=${workspaceRoot}=/rolldown`,
  ];
  // Collapse the long per-registry hash directory (`registry/src/index.crates.io-<hash>`)
  // too: rustc uses the last matching prefix, so these more-specific mappings go last.
  const registrySrc = resolve(cargoHome, 'registry', 'src');
  try {
    for (const dir of readdirSync(registrySrc)) {
      remaps.push(`--remap-path-prefix=${resolve(registrySrc, dir)}=/deps`);
    }
  } catch {
    // no registry dir (e.g. vendored deps) — nothing to collapse
  }
  // TOML literal strings cannot contain single quotes; such paths just skip the remap.
  if (remaps.every((flag) => !flag.includes("'"))) {
    remapConfig = `target.'cfg(all())'.rustflags=[${remaps.map((flag) => `'${flag}'`).join(',')}]`;
  }
}

// Rebuild std without its `backtrace` feature: the DWARF symbolizer (gimli/object/addr2line,
// ~350 KiB of the binary) is dead weight in a napi addon — panics are caught and converted to
// JS errors before anything would symbolize a backtrace. `panic-unwind` stays on, which napi
// requires. Opt-in via the release workflow because it needs `RUSTC_BOOTSTRAP=1` to unlock
// `-Z build-std` on the pinned stable toolchain, the `rust-src` component (installed by the
// release workflow), and an explicit `--target`. Scoped to the `release` profile so the
// wasi build (`release-wasi`), which shares this script and the workflow env, keeps its
// prebuilt std; wasm targets are also excluded explicitly because they are `panic=abort`
// targets where `std,panic_unwind` would be the wrong panic runtime. Behavior change in
// shipped binaries: `RUST_BACKTRACE=1` prints unsymbolized frames; panic message + source
// location are kept.
// Measured on aarch64-apple-darwin: −162 KiB stripped, unwinding machinery verified intact.
if (process.env.ROLLDOWN_BUILD_STD === '1' && isRelease) {
  if (!argsOptions.target) {
    console.warn(
      'ROLLDOWN_BUILD_STD=1 requires an explicit --target; building with prebuilt std instead',
    );
  } else if (!argsOptions.target.startsWith('wasm')) {
    process.env.RUSTC_BOOTSTRAP = '1';
    process.env.CARGO_UNSTABLE_BUILD_STD = 'std,panic_unwind';
    process.env.CARGO_UNSTABLE_BUILD_STD_FEATURES = 'panic-unwind';
  }
}

const napiArgs = {
  ...argsOptions,
  // `getOptions()` doesn't surface CLI rest args, so this doesn't overwrite anything.
  ...(remapConfig ? { cargoOptions: ['--config', remapConfig] } : {}),
  outputDir: './src',
  manifestPath: '../../crates/rolldown_binding/Cargo.toml',
  platform: true,
  package: 'rolldown_binding',
  jsBinding: 'binding.cjs',
  dts: 'binding.d.cts',
  constEnum: false,
};

console.info('args:', napiArgs);

try {
  const { task } = await napiCli.build(napiArgs);
  await task;
} catch (error) {
  // remove previous build artifacts
  console.error(error);
  globSync('src/rolldown-binding.*.node', {
    absolute: true,
    cwd: __dirname,
  }).forEach((file) => {
    rmSync(file, { force: true, recursive: true });
  });

  globSync('./src/rolldown-binding.*.wasm', {
    absolute: true,
    cwd: __dirname,
  }).forEach((file) => {
    rmSync(file, { recursive: true, force: true });
  });

  process.exit(1);
}
