import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir = path.resolve('data');
const queueFile = path.join(dataDir, 'queue.json');
const postNoFile = path.join(dataDir, 'postNo.json');
const postLogFile = path.join(dataDir, 'postLog.json');

async function ensureQueueFile() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(queueFile);
  } catch {
    await fs.writeFile(queueFile, '[]\n', 'utf8');
  }
}

export async function readQueue() {
  await ensureQueueFile();
  const raw = await fs.readFile(queueFile, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeQueue(queue) {
  await ensureQueueFile();
  await fs.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

async function nextPostNo() {
  await fs.mkdir(dataDir, { recursive: true });
  let lastPostNo = 0;

  try {
    const raw = await fs.readFile(postNoFile, 'utf8');
    lastPostNo = Number(JSON.parse(raw).lastPostNo || 0);
  } catch {}

  try {
    const queue = await readQueue();
    lastPostNo = Math.max(lastPostNo, ...queue.map((item) => Number(item.postNo || 0)));
  } catch {}

  try {
    const raw = await fs.readFile(postLogFile, 'utf8');
    const log = JSON.parse(raw);
    lastPostNo = Math.max(lastPostNo, ...Object.keys(log).map((key) => Number(key) || 0));
  } catch {}

  const value = lastPostNo + 1;
  await fs.writeFile(postNoFile, `${JSON.stringify({ lastPostNo: value }, null, 2)}\n`, 'utf8');
  return value;
}

export async function enqueuePost(text, authorId, mediaPaths = []) {
  const queue = await readQueue();
  const item = {
    id: randomUUID(),
    postNo: await nextPostNo(),
    text,
    mediaPaths,
    authorId,
    createdAt: new Date().toISOString()
  };
  queue.push(item);
  await writeQueue(queue);
  return { item, position: queue.length };
}

export async function shiftPost() {
  const queue = await readQueue();
  const item = queue.shift();
  await writeQueue(queue);
  return item || null;
}

export async function peekPost() {
  const queue = await readQueue();
  return queue[0] || null;
}

export async function removePost(id) {
  const queue = await readQueue();
  const nextQueue = queue.filter((item) => item.id !== id);
  await writeQueue(nextQueue);
}

export async function removePostAtPosition(position) {
  const queue = await readQueue();
  const index = position - 1;
  if (index < 0 || index >= queue.length) {
    return { item: null, queueLength: queue.length };
  }

  const [item] = queue.splice(index, 1);
  await writeQueue(queue);
  return { item, queueLength: queue.length };
}
