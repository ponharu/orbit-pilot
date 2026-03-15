import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { loadRuntimeRules } from '../../src/core/runtime-rules-loader';

describe('loadRuntimeRules', () => {
  test('loads the bundled runtime rules', async () => {
    const rules = await loadRuntimeRules();

    expect(rules.path.endsWith(path.join('src', 'policy', 'default-rules.ts'))).toBe(true);
    expect(rules.text).toContain('You are the coding agent for this repository.');
    expect(rules.text).toContain('Runtime rule priority:');
  });
});
