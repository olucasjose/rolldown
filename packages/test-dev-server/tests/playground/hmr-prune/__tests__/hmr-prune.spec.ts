import { describe, expect, test } from 'vitest';
import { editFile, page, waitForBuildStable } from '~utils';

// Ports Vite's `hmr` prune behavior: when a module stops being imported, its
// `import.meta.hot.prune(cb)` callback fires. Here, removing `app`'s import of
// `prunable.js` should prune it.

describe('hmr-prune', () => {
  test('renders the prunable module', async () => {
    await waitForBuildStable();
    await expect.poll(() => page.textContent('.prunable')).toBe('present');
  });

  // KNOWN FBM GAP: the full-bundle-mode client never fires `prune` — prune was a
  // server-sent `vite:beforePrune` message, and FBM computes everything client-side without
  // that channel (see `packages/.../vite/src/client/fbmHmrClient.ts`, which handles boundaries
  // and dispose but not prune). Verified: removing the import does not fire the callback.
  // Unskip once FBM implements prune.
  test.skip('removing an import fires the prune callback', async () => {
    await waitForBuildStable();

    editFile('app.js', (code) => code.replace("import './prunable.js';\n", ''));
    await expect.poll(() => page.textContent('.prunable')).toBe('pruned');
    await waitForBuildStable();
  });
});
