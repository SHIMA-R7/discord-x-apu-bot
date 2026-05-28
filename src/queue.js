import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir = path.resolve('data');
const queueFile = path.join(dataDir, 'queue.json');

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

export async function enqueuePost(text, authorId, mediaPaths = []) {
  const queue = await readQueue();
  const item = {
    id: randomUUID(),
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
