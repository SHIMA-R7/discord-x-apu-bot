import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from './config.js';
import { openXBrowserForLogin } from './xPoster.js';

const context = await openXBrowserForLogin();

const rl = readline.createInterface({ input, output });
await rl.question(`APU用XアカウントにログインできたらEnterを押してください (${config.xProfileDir}): `);
rl.close();

await context.close();
