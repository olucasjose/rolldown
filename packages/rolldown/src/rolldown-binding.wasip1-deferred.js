import {
  getDefaultContext as __emnapiGetDefaultContext,
  instantiateNapiModule as __emnapiInstantiateNapiModule,
  WASI as __WASI,
} from '@napi-rs/wasm-runtime'

/**
 * Deferred, workerd-safe instantiation: no top-level I/O, no compile-from-bytes.
 * Accepts ONLY a precompiled WebAssembly.Module, or a Promise resolving to one
 * (e.g. `import mod from './rolldown-binding.wasm32-wasip1.wasm'` under a CompiledWasm
 * module rule / wrangler module import). Byte buffers, URLs and Response
 * objects are rejected: they require dynamic Wasm compilation, which
 * Cloudflare Workers disallows.
 */
export async function instantiate(__wasmInput) {
  const __module = await __wasmInput
  // Brand check, not `instanceof`: `WebAssembly.Module.imports` throws unless
  // its argument is a genuine WebAssembly.Module, so prototype-spoofed byte
  // buffers are rejected while cross-realm Module instances are accepted.
  try {
    WebAssembly.Module.imports(__module)
  } catch {
    throw new TypeError(
      "instantiate() expects a precompiled WebAssembly.Module (or a Promise resolving to one), " +
        "e.g. import mod from './rolldown-binding.wasm32-wasip1.wasm' under a CompiledWasm module rule / wrangler module import. " +
        "Byte buffers, URLs and Response objects require dynamic Wasm compilation, which Cloudflare Workers disallows.",
    )
  }
  const __wasi = new __WASI({
    version: 'preview1',
  })
  const __emnapiContext = __emnapiGetDefaultContext()
  // The wasm module is linked with `--import-memory`, so a Memory must be
  // provided. It is allocated here in function scope (workerd bans global
  // scope allocation) and is not shared (no threads, no SharedArrayBuffer).
  const __wasmMemory = new WebAssembly.Memory({
    initial: 16384,
    maximum: 65536,
  })
  const { napiModule: __napiModule } = await __emnapiInstantiateNapiModule(__module, {
    context: __emnapiContext,
    asyncWorkPoolSize: 0,
    wasi: __wasi,
    overwriteImports(importObject) {
      importObject.env = {
        ...importObject.env,
        ...importObject.napi,
        ...importObject.emnapi,
        memory: __wasmMemory,
      }
      return importObject
    },
    beforeInit({ instance }) {
      for (const name of Object.keys(instance.exports)) {
        if (name.startsWith('__napi_register__')) {
          instance.exports[name]()
        }
      }
    },
  })
  return __napiModule.exports
}
