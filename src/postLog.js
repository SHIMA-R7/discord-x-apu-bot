import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve('data');
const postLogFile = path.join(dataDir, 'postLog.json');

async function ensureFile() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(postLogFile);
  } catch {
    await fs.writeFile(postLogFile, '{}\n', 'utf8');
  }
}

async function readLog() {
  await ensureFile();

  const raw = await fs.readFile(postLogFile, 'utf8');

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeLog(log) {
  await ensureFile();

  await fs.writeFile(
    postLogFile,
    JSON.stringify(log, null, 2),
    'utf8'
  );
}

// 🌟 authorId と text を追加
export async function savePostLog(postNo, url, authorId, text, metadata = {}) {
  const log = await readLog();

  const entry = {
    url,
    authorId,
    text,
    ...metadata,
    postedAt: new Date().toISOString()
  };

  log[String(postNo)] = entry;

  if (metadata.sourceMessageId) {
    log.byMessageId ||= {};
    log.byMessageId[String(metadata.sourceMessageId)] = entry;
  }

  await writeLog(log);
}

export async function getPostUrl(postNo) {
  const log = await readLog();

  return log[String(postNo)]?.url || null;
}

export async function getPostUrlByMessageId(messageId) {
  const log = await readLog();

  return log.byMessageId?.[String(messageId)]?.url || null;
}
