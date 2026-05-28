import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const mediaDir = path.resolve('data', 'media');
const supportedImageTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]);
const supportedImageExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp'
]);

function isSupportedImageAttachment(attachment) {
  if (supportedImageTypes.has(attachment.contentType)) return true;
  return supportedImageExtensions.has(path.extname(attachment.name || '').toLowerCase());
}

function extensionFor(contentType, fallbackName) {
  const ext = path.extname(fallbackName || '').toLowerCase();
  if (ext) return ext;

  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/gif') return '.gif';
  if (contentType === 'image/webp') return '.webp';
  return '';
}

export function extractImageAttachments(message) {
  return [...message.attachments.values()]
    .filter(isSupportedImageAttachment)
    .slice(0, 4);
}

export async function saveImageAttachments(message) {
  const attachments = extractImageAttachments(message);
  if (attachments.length === 0) return [];

  await fs.mkdir(mediaDir, { recursive: true });

  const savedPaths = [];
  for (const attachment of attachments) {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${attachment.url}`);
    }

    const contentType = attachment.contentType || response.headers.get('content-type') || '';
    const ext = extensionFor(contentType, attachment.name);
    const filePath = path.join(mediaDir, `${randomUUID()}${ext}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, buffer);
    savedPaths.push(filePath);
  }

  return savedPaths;
}

export async function cleanupMediaFiles(mediaPaths = []) {
  await Promise.all(mediaPaths.map(async (mediaPath) => {
    try {
      await fs.unlink(mediaPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Failed to remove media file ${mediaPath}:`, error);
      }
    }
  }));
}
