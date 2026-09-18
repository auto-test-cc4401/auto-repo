#!/usr/bin/env node
import { Command } from 'commander';
import { apply, doctor, plan, report, rosterImport, status } from './commands.js';
import type { GlobalOptions } from './context.js';

const program = new Command();

program
  .name('auto-repo')
  .description('Create and provision CC4401 group repositories on GitHub, idempotently.')
  .version('2.0.0')
  .option('-c, --config <path>', 'course configuration file', './course.config.yaml')
  .option('-r, --roster <path>', 'roster file (overrides the config)')
  .option('--db <path>', 'SQLite database path (overrides the config)');

function globals(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

/** Every command resolves to an exit code; errors never leave a stack trace. */
function run(fn: (options: GlobalOptions & Record<string, unknown>) => Promise<number>) {
  return async (commandOptions: Record<string, unknown> = {}) => {
    try {
      process.exitCode = await fn({ ...globals(), ...commandOptions });
    } catch (error) {
      console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };
}

program
  .command('doctor')
  .description('Check Node, credentials, org access and rate-limit budget')
  .action(run(doctor));

program
  .command('roster')
  .description('Import and validate the roster, verifying every GitHub username')
  .command('import')
  .description('Import and validate the roster')
  .action(run(rosterImport));

program
  .command('plan')
  .description('Show what would change on GitHub. Read-only.')
  .action(run(plan));

program
  .command('apply')
  .description('Create teams and repos and provision members')
  .option('--allow-removals', 'also remove members who are no longer on the roster', false)
  .action(run(apply));

program
  .command('status')
  .description('Show teams, members, pending invitations and students with no account')
  .action(run(status));

program
  .command('report')
  .description('Write a Markdown and CSV report of the current plan')
  .action(run(report));

await program.parseAsync(process.argv);
