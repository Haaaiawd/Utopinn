import process from 'node:process';
import { setConfigFilePath } from './src/util.js';

const args = process.argv.slice(2);
const makeAdmin = args.includes('--admin');
const positional = args.filter(arg => arg !== '--admin');
const userAccount = positional[0];
const userPassword = positional[1];
const configPath = './config.yaml';

if (!userAccount) {
    console.error('A tool for recovering lost SillyTavern accounts. Uses a "dataRoot" setting from config.yaml file.');
    console.error('Usage: node recover.js [account] (password) (--admin)');
    console.error('Example: node recover.js admin password');
    console.error('Example: node recover.js default-user password --admin  # grant admin (bootstrap the first admin on a multi-user install)');
    process.exit(1);
}

async function main() {
    setConfigFilePath(configPath);
    const { recoverPassword } = await import('./src/recover-password.js');
    await recoverPassword(configPath, userAccount, userPassword, { admin: makeAdmin });
}

main();
