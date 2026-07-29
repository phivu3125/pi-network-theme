import { deflateSync } from "node:zlib";

import { resizeRgbaNearest } from "./pi-pixel-renderer.mjs";

export const STARTUP_SHEET_WIDTH = 960;
export const STARTUP_SHEET_HEIGHT = 810;
export const STARTUP_CELL_WIDTH = 240;
export const STARTUP_CELL_HEIGHT = 270;
export const STARTUP_ARTWORK_SIZE = 240;
export const STARTUP_FRAME_SIZE = 30;
export const STARTUP_BACKGROUND_MAX_CHROMA = 12;
export const STARTUP_BACKGROUND_MIN_LUMINANCE = 190;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function assertRgbaImage(image, width, height, label) {
  if (image?.width !== width || image?.height !== height) {
    throw new Error(`${label} must be exactly ${width}×${height} RGBA`);
  }
  if (!(image.data instanceof Uint8ClampedArray) || image.data.length !== width * height * 4) {
    throw new Error(`${label} has invalid RGBA data`);
  }
}

function isCheckerPixel(data, offset) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  // Integer Rec. 709 weights document and stabilize the luminance boundary exactly.
  const luminanceTimes10_000 = 2126 * red + 7152 * green + 722 * blue;
  return chroma <= STARTUP_BACKGROUND_MAX_CHROMA
    && luminanceTimes10_000 >= STARTUP_BACKGROUND_MIN_LUMINANCE * 10_000;
}

function cropArtworkCell(sheet, frameIndex) {
  const cellColumn = frameIndex % 4;
  const cellRow = Math.floor(frameIndex / 4);
  const originX = cellColumn * STARTUP_CELL_WIDTH;
  const originY = cellRow * STARTUP_CELL_HEIGHT;
  const data = new Uint8ClampedArray(STARTUP_ARTWORK_SIZE * STARTUP_ARTWORK_SIZE * 4);

  for (let y = 0; y < STARTUP_ARTWORK_SIZE; y += 1) {
    const sourceStart = ((originY + y) * sheet.width + originX) * 4;
    const targetStart = y * STARTUP_ARTWORK_SIZE * 4;
    data.set(sheet.data.subarray(sourceStart, sourceStart + STARTUP_ARTWORK_SIZE * 4), targetStart);
  }
  return { width: STARTUP_ARTWORK_SIZE, height: STARTUP_ARTWORK_SIZE, data };
}

/** Clears only bright near-neutral pixels connected to a cell edge; enclosed glints survive. */
export function reconstructStartupTransparency(cell) {
  assertRgbaImage(cell, STARTUP_ARTWORK_SIZE, STARTUP_ARTWORK_SIZE, "startup artwork cell");
  const pixelCount = cell.width * cell.height;
  const background = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  let queueStart = 0;
  let queueEnd = 0;

  const enqueueIfChecker = (x, y) => {
    const pixelIndex = y * cell.width + x;
    if (background[pixelIndex] === 1 || !isCheckerPixel(cell.data, pixelIndex * 4)) return;
    background[pixelIndex] = 1;
    queue[queueEnd] = pixelIndex;
    queueEnd += 1;
  };

  for (let x = 0; x < cell.width; x += 1) {
    enqueueIfChecker(x, 0);
    enqueueIfChecker(x, cell.height - 1);
  }
  for (let y = 1; y < cell.height - 1; y += 1) {
    enqueueIfChecker(0, y);
    enqueueIfChecker(cell.width - 1, y);
  }

  while (queueStart < queueEnd) {
    const pixelIndex = queue[queueStart];
    queueStart += 1;
    const x = pixelIndex % cell.width;
    const y = Math.floor(pixelIndex / cell.width);
    if (x > 0) enqueueIfChecker(x - 1, y);
    if (x + 1 < cell.width) enqueueIfChecker(x + 1, y);
    if (y > 0) enqueueIfChecker(x, y - 1);
    if (y + 1 < cell.height) enqueueIfChecker(x, y + 1);
  }

  const data = new Uint8ClampedArray(cell.data);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (background[pixelIndex] === 1) data.fill(0, offset, offset + 4);
  }
  return { width: cell.width, height: cell.height, data };
}

export function normalizeStartupSheet(sheet) {
  assertRgbaImage(sheet, STARTUP_SHEET_WIDTH, STARTUP_SHEET_HEIGHT, "startup contact sheet");
  for (let offset = 3; offset < sheet.data.length; offset += 4) {
    if (sheet.data[offset] !== 255) throw new Error("startup contact sheet must be fully opaque");
  }

  return Object.freeze(Array.from({ length: 12 }, (_, frameIndex) => {
    const cleaned = reconstructStartupTransparency(cropArtworkCell(sheet, frameIndex));
    const normalized = resizeRgbaNearest(cleaned, STARTUP_FRAME_SIZE, STARTUP_FRAME_SIZE);
    // PNG readers may expose hidden RGB under alpha zero; canonicalize it for byte stability.
    for (let offset = 0; offset < normalized.data.length; offset += 4) {
      if (normalized.data[offset + 3] === 0) normalized.data.fill(0, offset, offset + 3);
    }
    return normalized;
  }));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

export function encodeRgbaPng(image) {
  assertRgbaImage(image, image?.width, image?.height, "normalized frame");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, filter, no interlace.
  const scanlines = Buffer.alloc(image.height * (1 + image.width * 4));
  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * (1 + image.width * 4);
    scanlines[rowStart] = 0;
    scanlines.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), rowStart + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
