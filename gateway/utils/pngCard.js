import fs from 'fs';
import path from 'path';
import extract from 'png-chunks-extract';
import encode from 'png-chunks-encode';
import text from 'png-chunk-text';

const TRANSPARENT_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154010d0a0000000049454e44ae426082',
  'hex'
);

export function writeCardIntoPng(pngBuffer, json) {
  const chunks = extract(pngBuffer);
  const meta = text.encode('chara', JSON.stringify(json));
  // Insert before IEND
  const iendIndex = chunks.findIndex(c => c.name === 'IEND');
  const out = iendIndex >= 0
    ? [...chunks.slice(0, iendIndex), meta, ...chunks.slice(iendIndex)]
    : [...chunks, meta];
  return Buffer.from(encode(out));
}

export function makeCardPngFromFile(filePathOrNull, json) {
  try {
    const buf = filePathOrNull && fs.existsSync(filePathOrNull) ? fs.readFileSync(filePathOrNull) : TRANSPARENT_PNG;
    return writeCardIntoPng(buf, json);
  } catch {
    return writeCardIntoPng(TRANSPARENT_PNG, json);
  }
}

export function readCardFromPng(pngBuffer) {
  try {
    const chunks = extract(pngBuffer);
    for (const c of chunks) {
      if (c.name === 'tEXt' || c.name === 'iTXt') {
        try {
          const decoded = text.decode(c.data);
          if (decoded.keyword === 'chara') {
            return JSON.parse(decoded.text);
          }
        } catch { /* ignore */ }
      }
    }
    return null;
  } catch {
    return null;
  }
}
