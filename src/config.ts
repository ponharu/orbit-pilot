import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const codexSchema = z.object({
  model: z.string().min(1).optional(),
  approvalPolicy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']).optional(),
  modelReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
});

const configSchema = z.object({
  pollIntervalMs: z.number().int().positive().default(30_000),
  workspaceRoot: z.string().default('./workspaces'),
  maxConcurrentRunsPerRepo: z.number().int().positive().default(1),
  owners: z.array(z.string().min(1)).min(1),
  excludeRepos: z.array(z.string()).default([]),
  codex: codexSchema.default({}),
  repos: z.never().optional(),
});

export type AppConfig = z.infer<typeof configSchema> & {
  stateRoot: string;
};

export async function loadConfig(configPath?: string): Promise<{ config: AppConfig; path: string }> {
  const resolvedPath = path.resolve(process.cwd(), configPath ?? 'orbit-pilot.toml');
  const raw = await readFile(resolvedPath, 'utf8');
  const parsed = configSchema.parse(parseToml(raw));

  return {
    path: resolvedPath,
    config: {
      ...parsed,
      stateRoot: path.join(path.dirname(resolvedPath), '.orbit-pilot-state'),
      workspaceRoot: path.isAbsolute(parsed.workspaceRoot)
        ? parsed.workspaceRoot
        : path.resolve(path.dirname(resolvedPath), parsed.workspaceRoot),
      owners: normalizeValues(parsed.owners),
      excludeRepos: normalizeValues(parsed.excludeRepos),
    },
  };
}

function normalizeValues(values: string[]) {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}
