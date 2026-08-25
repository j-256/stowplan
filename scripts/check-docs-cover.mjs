import { readFile } from 'node:fs/promises';

const COVER_PATH = new URL('../docs/screenshots/cover.png', import.meta.url);
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const cover = await readFile(COVER_PATH);
if (cover.length > MAX_COVER_BYTES) {
  throw new Error('Documentation cover exceeds the size limit');
}
if (cover.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((byte, index) => cover[index] !== byte)) {
  throw new Error('Documentation cover is not a PNG');
}

console.log('Documentation cover is a valid PNG');
