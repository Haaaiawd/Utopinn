import process from 'node:process';
import { setConfigFilePath } from './src/util.js';

/**
 * Out-of-band account recovery / first-admin bootstrap CLI.
 *
 *   node recover.js [--configPath <file>] [--dataRoot <dir>] <handle> [password] [--admin]
 *
 * Argument rules (fixed after a review of the previous `argv.includes('--admin')`
 * parsing, which would silently swallow a literal password of `--admin` and
 * grant admin while clearing the password):
 *   - every `--xxx` token BEFORE a `--` separator is parsed as a flag, never as a
 *     positional — so `node recover.js user --admin` always means "grant admin",
 *     never "set password to '--admin'";
 *   - to pass a password that itself starts with '-', use the `--` separator:
 *     `node recover.js user -- --admin`;
 *   - any other leading-dash token is an unknown flag and aborts with usage,
 *     so a mistyped password can never be reinterpreted as an option.
 *
 * Targeting: the tool needs the same data root the live server uses. It reads
 * `dataRoot` from --configPath (default ./config.yaml); pass --dataRoot to
 * override it — same flag spelling as server.js, so the boot warning's printed
 * command is copy-pasteable.
 */

const argv = process.argv.slice(2);
let makeAdmin = false;
let dataRoot = null;
let configPath = './config.yaml';
const positional = [];
let endOfFlags = false;

function usage() {
    console.error('A tool for recovering lost Utopinn accounts.');
    console.error('Usage: node recover.js [--configPath <file>] [--dataRoot <dir>] <handle> [password] [--admin]');
    console.error('  --admin        also grant admin privileges (bootstrap the first admin on a multi-user install)');
    console.error('  --dataRoot     storage directory to operate on (overrides config.yaml dataRoot)');
    console.error('  --configPath   config file to read dataRoot from (default: ./config.yaml)');
    console.error('  --             end of flags; required before a password that starts with "-"');
    console.error('Example: node recover.js default-user password --admin');
    console.error('Example: node recover.js --dataRoot /srv/utopinn-data default-user password --admin');
    console.error('Example: node recover.js user -- "--password-that-looks-like-a-flag"');
}

function flagValue(i, flag) {
    const arg = argv[i];
    let value;
    let next = i;
    if (arg.startsWith(`${flag}=`)) {
        value = arg.slice(flag.length + 1);
    } else {
        value = argv[i + 1];
        next = i + 1;
    }
    // An empty or leading-dash value can only be a misparsed flag — a real
    // path never looks like that, so fail loudly instead of silently
    // falling back to config.yaml's dataRoot.
    if (!value || value.startsWith('-')) {
        console.error(`${flag} requires a non-empty path value.`);
        usage();
        process.exit(1);
    }
    return { value, next };
}

for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (endOfFlags) {
        positional.push(arg);
        continue;
    }
    if (arg === '--') {
        endOfFlags = true;
        continue;
    }
    if (arg === '--admin') {
        makeAdmin = true;
        continue;
    }
    if (arg === '--dataRoot' || arg.startsWith('--dataRoot=')) {
        const parsed = flagValue(i, '--dataRoot');
        dataRoot = parsed.value;
        i = parsed.next;
        continue;
    }
    if (arg === '--configPath' || arg.startsWith('--configPath=')) {
        const parsed = flagValue(i, '--configPath');
        configPath = parsed.value;
        i = parsed.next;
        continue;
    }
    if (arg.startsWith('-')) {
        console.error(`Unknown flag: ${arg}`);
        console.error('If this was meant to be the password, put it after a "--" separator:');
        console.error(`  node recover.js <handle> -- "${arg}"`);
        usage();
        process.exit(1);
    }
    positional.push(arg);
}

const [userAccount, userPassword] = positional;

if (!userAccount || positional.length > 2) {
    usage();
    process.exit(1);
}

async function main() {
    setConfigFilePath(configPath);
    const { recoverPassword } = await import('./src/recover-password.js');
    await recoverPassword(configPath, userAccount, userPassword, { admin: makeAdmin, dataRoot });
}

main();
