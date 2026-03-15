export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runShell(
  command: string,
  options: {
    cwd: string;
    env?: Record<string, string>;
    stdin?: string;
    signal?: AbortSignal;
  },
): Promise<ShellResult> {
  const subprocess = Bun.spawn(['sh', '-lc', command], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdin: options.stdin ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: options.signal,
  });

  if (options.stdin && subprocess.stdin) {
    subprocess.stdin.write(new TextEncoder().encode(options.stdin));
    await subprocess.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout, stderr };
}
