import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from './config.js';
import { openXBrowserForLogin } from './xPoster.js';

const context = await openXBrowserForLogin();

const rl = readline.createInterface({ input, output });

await rl.question(
  `APU用XアカウントにログインできたらEnterを押してください (${config.xProfileDir}): `
);

rl.close();

// Cookie保存待ち
console.log('セッション保存待機中...');
await new Promise(resolve => setTimeout(resolve, 5000));

await context.close();

console.log('ログインセッションを保持しました。');
