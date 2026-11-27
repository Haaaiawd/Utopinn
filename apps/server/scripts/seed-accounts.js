#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// seed-accounts — backfill _seed pool content into existing accounts.
//
// New registrations get the pool automatically (POST /api/users/register);
// accounts that already exist — including the bootstrap `default-user`,
// which is created at first start and never passes through registration —
// get theirs here. Drop the content under <dataRoot>/_seed/<directory-key>/
// (e.g. _seed/card-apps/<app-name>/), then run:
//
//   node scripts/seed-accounts.js
//
// The pass is idempotent: an entry whose destination already exists is
// skipped, never overwritten — re-running to pick up a newly added seed
// card only fills what is missing.

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Argument parsing — kept import-free + side-effect-free (same rationale as
// storage-migrate.js: --help and bad args must not drag in node-persist or
// write anything).
// ---------------------------------------------------------------------------

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
    const args = { dataRoot: null, configPath: './config.yaml', handle: null, dryRun: false, help: false };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--dataRoot') args.dataRoot = argv[++i];
        else if (arg === '--configPath') args.configPath = argv[++i];
        else if (arg === '--handle') args.handle = argv[++i];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function printHelp() {
    console.log(`seed-accounts — backfill _seed pool content into existing accounts

Usage:
  node scripts/seed-accounts.js [options]

Options:
  --dataRoot <dir>       Storage directory to operate on (overrides config.yaml dataRoot)
  --configPath <file>    Config file to read dataRoot from (default: ./config.yaml)
  --handle <handle>      Seed only a specific user handle (default: all users)
  --dry-run              Report what would be copied without writing anything
  --help, -h             Show this message

Seed pool layout:
  <dataRoot>/_seed/<directory-key>/<entry>  →  <dataRoot>/<handle>/<directory-key>/<entry>
  Example: _seed/card-apps/我没想当掌门啊/  →  <handle>/card-apps/我没想当掌门啊/

Behavior:
  Existing destination entries are skipped (user content always wins), so the
  script is safe to re-run: it only fills what is missing.
`);
}

// ---------------------------------------------------------------------------
// Bootstrap — invoked only after arg validation passes (mirrors
// storage-migrate.js: standalone tools read ./config.yaml relative to CWD).
// ---------------------------------------------------------------------------

async function bootstrap(args) {
    const { initConfig } = await import('../src/config-init.js');
    initConfig(args.configPath);

    const { getConfigValue, getConfigEnvKeys } = await import('../src/util.js');

    // server.js precedence: --dataRoot flag > LUKER_/SILLYTAVERN_ env vars >
    // config.yaml dataRoot. Env presence (not truthiness) counts, same as
    // getConfigValue — an env var set to '' fails loudly below instead of
    // silently falling through to the config file.
    let dataRoot = args.dataRoot;
    if (!dataRoot) {
        for (const envKey of getConfigEnvKeys('dataRoot')) {
            if (envKey in process.env) {
                dataRoot = process.env[envKey];
                break;
            }
        }
    }
    if (dataRoot === undefined || dataRoot === null) {
        dataRoot = getConfigValue('dataRoot', './data');
    }
    if (!dataRoot) {
        console.error(`No "dataRoot" setting found in ${args.configPath}, and no --dataRoot override or data-root env var was given.`);
        process.exit(2);
    }

    // Relative roots resolve against the server directory — same anchor
    // recover-password.js uses — so cwd never changes which store is hit.
    const resolvedDataRoot = path.resolve(SERVER_ROOT, dataRoot);
    globalThis.DATA_ROOT = resolvedDataRoot;

    const { initUserStorage, getAllUserHandles, getUserDirectories } = await import('../src/users.js');
    await initUserStorage(resolvedDataRoot);

    const { seedUserDirectories, getSeedRoot } = await import('../src/services/seed-content.js');
    return { dataRoot: resolvedDataRoot, getAllUserHandles, getUserDirectories, seedUserDirectories, getSeedRoot };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    let args;
    try {
        args = parseArgs(process.argv);
    } catch (err) {
        console.error(`Argument error: ${err.message}\n`);
        printHelp();
        process.exit(2);
    }

    if (args.help) {
        printHelp();
        process.exit(0);
    }

    const { dataRoot, getAllUserHandles, getUserDirectories, seedUserDirectories, getSeedRoot } = await bootstrap(args);

    const allHandles = await getAllUserHandles();
    if (args.handle && !allHandles.includes(args.handle)) {
        console.error(`Handle "${args.handle}" not found. Known handles: ${allHandles.join(', ') || '(none)'}`);
        process.exit(2);
    }
    const handles = args.handle ? [args.handle] : allHandles;

    if (handles.length === 0) {
        console.log('No users found. Nothing to seed.');
        process.exit(0);
    }

    const seedRoot = getSeedRoot();
    console.log(`Seed pool: ${seedRoot}`);
    console.log(`Users: ${handles.join(', ')}`);
    console.log('');

    let errorCount = 0;
    for (const handle of handles) {
        const report = await seedUserDirectories(getUserDirectories(handle), { dryRun: args.dryRun });
        const rel = (p) => path.relative(dataRoot, p);
        console.log(`${handle}: ${report.copied.length} copied, ${report.skipped.length} already present, ${report.errors.length} failed`);
        for (const dest of report.copied) {
            console.log(`  ${args.dryRun ? 'would copy' : 'copied'}  ${rel(dest)}`);
        }
        for (const failure of report.errors) {
            errorCount++;
            console.error(`  FAILED   ${rel(failure.source)}: ${failure.error?.message || failure.error}`);
        }
    }

    console.log('');
    console.log(`Summary: ${errorCount === 0 ? 'ok' : `${errorCount} error(s)`}${args.dryRun ? ' (dry run — nothing was written)' : ''}`);
    process.exit(errorCount > 0 ? 1 : 0);
}

main();
