import { describe, expect, test } from 'vitest';
import { editFile, page, waitForBuildStable } from '~utils';

// Ports Vite's `hmr` dispose + `import.meta.hot.data` behavior: `dispose` runs before the
// module is replaced and stashes state on `data`, which persists across the update and is
// read back by the re-executed module.

const plantMarker = () =>
  page.evaluate(() => ((window as unknown as { __marker?: string }).__marker = 'alive'));
const readMarker = () =>
  page.evaluate(() => (window as unknown as { __marker?: string }).__marker ?? null);

describe('hmr-dispose-data', () => {
  test('first load has no persisted data', async () => {
    await waitForBuildStable();
    await expect.poll(() => page.textContent('.value')).toBe('dispose-v1');
    await expect.poll(() => page.textContent('.prev')).toBe('none');
  });

  test('dispose stashes state on `data`, read back after the update', async () => {
    await waitForBuildStable();
    await plantMarker();

    // The dispose callback saves the CURRENT value; the re-run reads it as `prev`.
    editFile('counter.js', (code) => code.replace("'dispose-v1'", "'dispose-v2'"));
    await expect.poll(() => page.textContent('.value')).toBe('dispose-v2');
    await expect.poll(() => page.textContent('.prev')).toBe('dispose-v1');

    expect(await readMarker()).toBe('alive');
    await waitForBuildStable();
  });
});
