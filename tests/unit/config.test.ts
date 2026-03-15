import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadConfig', () => {
  test('resolves relative paths and normalizes owners and excluded repositories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orbit-pilot-config-'));
    tempDirs.push(tempDir);

    const configPath = path.join(tempDir, 'orbit-pilot.toml');
    await mkdir(path.join(tempDir, 'nested'), { recursive: true });
    await writeFile(
      configPath,
      [
        'workspaceRoot = "./nested/workspaces"',
        'owners = [" ExampleOrg ", "PersonalUser"]',
        'excludeRepos = [" ExampleOrg/SkipMe ", "personaluser/sandbox"]',
        '',
        '[codex]',
        'sandboxMode = "workspace-write"',
        '',
      ].join('\n'),
      'utf8',
    );

    const { config, path: resolvedPath } = await loadConfig(configPath);

    expect(resolvedPath).toBe(configPath);
    expect(config.workspaceRoot).toBe(path.join(tempDir, 'nested', 'workspaces'));
    expect(config.stateRoot).toBe(path.join(tempDir, '.orbit-pilot-state'));
    expect(config.owners).toEqual(['exampleorg', 'personaluser']);
    expect(config.excludeRepos).toEqual(['exampleorg/skipme', 'personaluser/sandbox']);
  });
});
