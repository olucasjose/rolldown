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

// For published binaries, remap the absolute build-machine paths (cargo/rustup homes and
// the workspace root) that rustc embeds into panic locations and tracing callsite metadata.
// This shrinks the binary's string tables and keeps the build machine's filesystem layout
// out of the shipped artifact. Release-only so local dev backtraces keep clickable paths.
// Caveat: cargo ignores `build.rustflags` (this env var) for targets that define
// `target.<triple>.rustflags`; such builds just keep unremapped paths.
if (argsOptions.release === true || argsOptions.profile === 'release') {
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
  try {
    for (const dir of readdirSync(resolve(cargoHome, 'registry', 'src'))) {
      remaps.push(
        `--remap-path-prefix=${resolve(cargoHome, 'registry', 'src', dir)}=/deps`,
      );
    }
  } catch {
    // no registry dir (e.g. vendored deps) — nothing to collapse
  }
  const remapFlags = remaps.join(' ');
  process.env.CARGO_BUILD_RUSTFLAGS = process.env.CARGO_BUILD_RUSTFLAGS
    ? `${process.env.CARGO_BUILD_RUSTFLAGS} ${remapFlags}`
    : remapFlags;
}

// Rebuild std without its `backtrace` feature: the DWARF symbolizer (gimli/object/addr2line,
// ~350 KiB of the binary) is dead weight in a napi addon — panics are caught and converted to
// JS errors before anything would symbolize a backtrace. `panic-unwind` stays on, which napi
// requires. Opt-in via the release workflow because it needs `RUSTC_BOOTSTRAP=1` to unlock
// `-Z build-std` on the pinned stable toolchain, the `rust-src` component (declared in
// rust-toolchain.toml), and an explicit `--target`. Behavior change in shipped binaries:
// `RUST_BACKTRACE=1` prints unsymbolized frames; panic message + source location are kept.
// Measured on aarch64-apple-darwin: −162 KiB stripped, unwinding machinery verified intact.
if (process.env.ROLLDOWN_BUILD_STD === '1') {
  if (argsOptions.target) {
    process.env.RUSTC_BOOTSTRAP = '1';
    process.env.CARGO_UNSTABLE_BUILD_STD = 'std,panic_unwind';
    process.env.CARGO_UNSTABLE_BUILD_STD_FEATURES = 'panic-unwind';
  } else {
    console.warn(
      'ROLLDOWN_BUILD_STD=1 requires an explicit --target; building with prebuilt std instead',
    );
  }
}

const napiArgs = {
  ...argsOptions,
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
