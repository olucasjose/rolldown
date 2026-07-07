import { describe, expect, test } from 'vitest';
import { editFile, page, waitForBuildStable } from '~utils';

// Ports Vite's `hmr` "nested dep propagation" case: `app` accepts `./dep`, and `dep`
// re-exports `./nested`. Editing the transitive `nested` must bubble nested -> dep -> app
// to the accept-dep boundary and hot-update, not full-reload.

const plantMarker = () =>
  page.evaluate(() => ((window as unknown as { __marker?: string }).__marker = 'alive'));
const readMarker = () =>
  page.evaluate(() => (window as unknown as { __marker?: string }).__marker ?? null);

describe('hmr-nested-dep-accept', () => {
  test('renders the nested value', async () => {
    await waitForBuildStable();
    await expect.poll(() => page.textContent('.nested')).toBe('nested-v1');
  });

  test('editing a transitive dep bubbles up to the accept-dep boundary', async () => {
    await waitForBuildStable();
    await plantMarker();

    editFile('nested.js', (code) => code.replace("'nested-v1'", "'nested-v2'"));
    await expect.poll(() => page.textContent('.nested')).toBe('nested-v2');

    expect(await readMarker()).toBe('alive');
    await waitForBuildStable();
  });
});
