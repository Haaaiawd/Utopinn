// Out-of-band admin bootstrap for multi-user e2e scenarios.
//
// Since GH #38 the seeded `default-user` record is a plain, passwordless
// account: it cannot authenticate through /api/users/login at all and it
// carries no admin rights, so a spec that needs an admin session must
// grant one explicitly — the same thing an operator does on a fresh
// multi-account install. This drives the production recovery path
// (`recover.js <handle> <password> --admin`) in-process against the
// scenario's dataRoot; the running server picks the write up on its next
// read (node-persist getDatum re-reads the datum file per getItem).
//
// The scratch config.yaml exists only to keep getConfig() from exiting
// the worker when src modules initialize; the dataRoot inside it is what
// recoverPassword actually operates on, so one shared CONFIG_PATH across
// a worker's specs is harmless — every call passes its own cfgPath.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E_ADMIN_HANDLE = 'default-user';
export const E2E_ADMIN_PASSWORD = 'e2e-admin-pw';

/**
 * Grant the scenario's `default-user` (or another seeded handle) a real
 * password + admin rights via the recover.js path.
 * @param {{dataRoot: string}} server  a startServer() handle
 * @param {{handle?: string, password?: string}} [opts]
 */
export async function grantAdminAccess(server, { handle = E2E_ADMIN_HANDLE, password = E2E_ADMIN_PASSWORD } = {}) {
    const cfgDir = mkdtempSync(join(tmpdir(), 'uto-e2e-cfg-'));
    const cfgPath = join(cfgDir, 'config.yaml');
    writeFileSync(cfgPath, `enableUserAccounts: true\ndataRoot: ${JSON.stringify(server.dataRoot)}\n`);
    const { getConfigFilePath, setConfigFilePath } = await import('../../../src/util.js');
    if (!getConfigFilePath()) {
        setConfigFilePath(cfgPath);
    }
    const { recoverPassword } = await import('../../../src/recover-password.js');
    await recoverPassword(cfgPath, handle, password, { admin: true });
}
