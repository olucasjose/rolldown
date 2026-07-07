import { describe, expect, test } from 'vitest';
import { editFile, page, waitForBuildStable } from '~utils';

// Same as `hmr-dynamic-import-self-accept`, but with `devMode.lazy: true`. Under lazy
// compilation the dynamically-imported `foo` compiles on demand behind a `?rolldown-lazy=1`
// proxy, so the importer walk sees the proxy chain instead of the real `app -> foo` dynamic
// edge and can't reach `app`'s self-accept boundary — the edit full-reloads.

/** Plant a marker on `window`; any full page reload wipes it. */
const plantMarker = () =>
  page.evaluate(() => ((window as unknown as { __marker?: string }).__marker = 'alive'));
const readMarker = () =>
  page.evaluate(() => (window as unknown as { __marker?: string }).__marker ?? null);

describe('hmr-lazy-dynamic-import-self-accept', () => {
  test('renders the dynamically-imported value', async () => {
    await waitForBuildStable();
    await expect.poll(() => page.textContent('.foo')).toBe('foo-v1');
  });

  // KNOWN LAZY GAP: lazy dynamic-import HMR bubbling is not implemented — a lazy dynamic
  // edge full-reloads today (`crates/rolldown_common/src/ecmascript/ecma_view.rs` excludes
  // `?rolldown-lazy=1` importers from the walkable set). Verified: this currently wipes the
  // marker (full reload). Unskip once lazy dynamic-import HMR lands.
  test.skip('editing the dynamically-imported module hot-updates via the importer self-accept', async () => {
    await waitForBuildStable();
    await plantMarker();

    editFile('foo.js', (code) => code.replace("'foo-v1'", "'foo-v2'"));
    await expect.poll(() => page.textContent('.foo')).toBe('foo-v2');

    // No full reload happened: the boundary walk crossed the lazy dynamic edge to `app`.
    expect(await readMarker()).toBe('alive');
    await waitForBuildStable();
  });
});
