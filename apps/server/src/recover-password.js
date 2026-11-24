import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import storage from 'node-persist';
import {
    initUserStorage,
    getPasswordSalt,
    getPasswordHash,
    toKey,
} from './users.js';
import { getConfigEnvKeys, getConfigFilePath, setConfigFilePath } from './util.js';

// server.js chdir()s into the server directory before opening storage, so
// every relative dataRoot — whether it came from --dataRoot, the
// LUKER_DATA_ROOT env var, or config.yaml — lands relative to THIS file's
// parent directory. Resolving here keeps `node recover.js --dataRoot ./data`
// pointed at the same store no matter which cwd the operator runs it from.
const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Initializes the storage with the data root the caller resolved, mirroring
 * server.js's precedence: an explicit --dataRoot flag wins, then the
 * LUKER_DATA_ROOT-style env vars, then the dataRoot inside the PASSED
 * configPath — so the tool targets the same instance as a server started
 * with --dataRoot, --configPath, or env overrides.
 *
 * The file layer deliberately bypasses the process-global CONFIG_PATH /
 * CACHED_CONFIG: an in-process caller recovering a SECOND instance would
 * otherwise inherit the first one's dataRoot (the global path is pinned by
 * whichever config was set first, and getConfig() caches the parsed file).
 * Env vars are file-independent, so they are still resolved through the
 * same getConfigEnvKeys() spelling the server uses.
 * @param {string} configPath - The path to the config file.
 * @param {string} [dataRootOverride] - Explicit --dataRoot; wins over env and config.
 */
async function initStorage(configPath, dataRootOverride) {
    let resolved = dataRootOverride;

    if (!resolved) {
        // Env layer: identical presence-check semantics to getConfigValue —
        // a set-but-empty var still counts as "provided" (and fails below),
        // exactly like the server-side chain.
        for (const envKey of getConfigEnvKeys('dataRoot')) {
            if (envKey in process.env) {
                resolved = process.env[envKey];
                break;
            }
        }
    }

    // nullish (not falsy): an env var set to '' counts as provided and must
    // reach the error below instead of silently falling through to the file.
    if (resolved === undefined || resolved === null) {
        if (!fs.existsSync(configPath)) {
            console.error(`Config file not found: ${configPath}`);
            process.exit(1);
        }
        resolved = yaml.parse(fs.readFileSync(configPath, 'utf8'))?.dataRoot;
    }

    if (!resolved) {
        console.error(`No "dataRoot" setting found in ${configPath}, and no --dataRoot override or data-root env var was given.`);
        process.exit(1);
    }

    // Pin the global config chain to the recovered instance too, when
    // nothing else set it: later getConfigValue() reads (cookie-secret
    // migration, session timeout) must see the same file the tool targets.
    if (getConfigFilePath() === null) {
        setConfigFilePath(configPath);
    }

    // initUserStorage prints the resolved path ("Using data root: ...") so
    // the operator can verify the tool hit the same store as the server.
    const dataRoot = path.resolve(SERVER_ROOT, resolved);
    await initUserStorage(dataRoot);
}

/**
 * Recovers a user account by enabling it and optionally setting a new password.
 * @param {string} configPath - The path to the config file.
 * @param {string} userAccount - The username of the account to recover.
 * @param {string} [userPassword] - The new password for the account. If not provided, sets an empty password.
 * @param {object} [options] - Additional recovery options.
 * @param {boolean} [options.admin] - Also grant the account admin privileges.
 *   This is the out-of-band path for bootstrapping the first admin on a
 *   multi-user install (the seeded default-user is not admin).
 * @param {string} [options.dataRoot] - Explicit data root; wins over env and
 *   the config file's dataRoot so the tool can target a server started with
 *   `--dataRoot`.
 */
export async function recoverPassword(configPath, userAccount, userPassword, options = {}) {
    await initStorage(configPath, options.dataRoot);

    /**
     * @type {import('./users').User}
     */
    const user = await storage.get(toKey(userAccount));

    if (!user) {
        console.error(`User "${userAccount}" not found.`);
        process.exit(1);
    }

    if (!user.enabled) {
        console.log('User is disabled. Enabling...');
        user.enabled = true;
    }

    if (options.admin) {
        if (!user.admin) {
            console.log('Granting admin privileges...');
        }
        user.admin = true;
    }

    if (userPassword) {
        console.log('Setting new password...');
        const salt = getPasswordSalt();
        const passwordHash = getPasswordHash(userPassword, salt);
        user.password = passwordHash;
        user.salt = salt;
    } else {
        console.log('Setting an empty password...');
        user.password = '';
        user.salt = '';
        console.log('Note: an account without a password cannot sign in via the password login form.');
    }

    await storage.setItem(toKey(userAccount), user);
    console.log('User recovered. A program will exit now.');
}
