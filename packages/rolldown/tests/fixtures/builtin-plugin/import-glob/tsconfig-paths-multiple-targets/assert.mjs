import assert from 'node:assert';
import { modules } from './dist/main.js';

// The first target (`./a/*`) is used, so files come from `./a/dir`.
assert.deepStrictEqual(Object.keys(modules), ['/a/dir/a.js']);
assert.strictEqual(modules['/a/dir/a.js'].default, 'from-a');
