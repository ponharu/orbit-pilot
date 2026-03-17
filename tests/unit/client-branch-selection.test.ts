import { describe, expect, test } from 'bun:test';
import { selectManagedBranchName } from '../../src/github/client';

describe('selectManagedBranchName', () => {
  test('prefers the canonical managed branch when it is present', () => {
    expect(
      selectManagedBranchName(370, [{ headRefName: '370-feat-passkey-auth' }, { headRefName: '370-orbit-pilot' }]),
    ).toBe('370-orbit-pilot');
  });

  test('returns the only linked branch when there is exactly one open PR', () => {
    expect(selectManagedBranchName(370, [{ headRefName: 'feature/passkeys' }])).toBe('feature/passkeys');
  });

  test('returns the only managed branch match when multiple PRs exist', () => {
    expect(
      selectManagedBranchName(370, [{ headRefName: 'feature/passkeys' }, { headRefName: '370-orbit-pilot-legacy' }]),
    ).toBe('370-orbit-pilot-legacy');
  });

  test('throws when multiple linked PRs exist and no single managed branch can be chosen', () => {
    expect(() =>
      selectManagedBranchName(370, [{ headRefName: 'feature/one' }, { headRefName: 'feature/two' }]),
    ).toThrow('multiple linked open pull requests');
  });
});
