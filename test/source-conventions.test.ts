import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('source conventions', () => {
  /**
   * Import assertions (`assert { type: 'json' }`) and import attributes
   * (`with { type: 'json' }`) bind the source to a specific Node release line.
   * Data files are read at runtime instead, so the roster path is configurable
   * and the code does not depend on the syntax surviving.
   */
  it('reads data at runtime rather than via import attributes', async () => {
    const { stdout } = await run('git', [
      'grep', '-nE', "(assert|with)\\s*\\{\\s*type:", '--', 'src',
    ]).catch((error: { code: number; stdout: string }) => {
      // git grep exits 1 when nothing matches, which is the passing case.
      if (error.code === 1) return { stdout: '' };
      throw error;
    });

    expect(stdout.trim()).toBe('');
  });
});
