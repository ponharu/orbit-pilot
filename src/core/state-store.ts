import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config';
import type { RepoTarget, WorkspaceState } from './types';

export class StateStore {
  constructor(private readonly config: AppConfig) {}

  async readState(target: RepoTarget, issueNumber: number): Promise<WorkspaceState | null> {
    try {
      return JSON.parse(await readFile(this.statePath(target, issueNumber), 'utf8')) as WorkspaceState;
    } catch {
      return null;
    }
  }

  async writeState(target: RepoTarget, issueNumber: number, state: WorkspaceState) {
    await mkdir(this.config.stateRoot, { recursive: true });
    await writeFile(this.statePath(target, issueNumber), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async listStates(target: RepoTarget): Promise<WorkspaceState[]> {
    try {
      const entries = await readdir(this.config.stateRoot, { withFileTypes: true });
      const prefix = `${sanitize(target.owner)}__${sanitize(target.repo)}__issue-`;
      const states = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json'))
          .map(async (entry) => {
            try {
              return JSON.parse(await readFile(path.join(this.config.stateRoot, entry.name), 'utf8')) as WorkspaceState;
            } catch {
              return null;
            }
          }),
      );

      return states.flatMap((state) => (state ? [state] : []));
    } catch {
      return [];
    }
  }

  private statePath(target: RepoTarget, issueNumber: number) {
    return path.join(
      this.config.stateRoot,
      `${sanitize(target.owner)}__${sanitize(target.repo)}__issue-${issueNumber}.json`,
    );
  }
}

function sanitize(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
