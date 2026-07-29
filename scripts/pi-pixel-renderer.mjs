const RESET_FOREGROUND = "\x1b[39m";
const RESET_BACKGROUND = "\x1b[49m";

export const PI_PIXEL_ALPHA_THRESHOLD = 80;

export const PI_PIXEL_PALETTE = Object.freeze([
  Object.freeze({ name: "outline", rgb: Object.freeze([54, 38, 63]) }),
  Object.freeze({ name: "deepPurple", rgb: Object.freeze([75, 45, 96]) }),
  Object.freeze({ name: "piPurple", rgb: Object.freeze([111, 62, 145]) }),
  Object.freeze({ name: "purpleHighlight", rgb: Object.freeze([161, 108, 196]) }),
  Object.freeze({ name: "darkGold", rgb: Object.freeze([183, 121, 30]) }),
  Object.freeze({ name: "piGold", rgb: Object.freeze([251, 180, 74]) }),
  Object.freeze({ name: "paleGold", rgb: Object.freeze([255, 226, 154]) }),
  Object.freeze({ name: "white", rgb: Object.freeze([255, 255, 255]) }),
]);

function assertDimension(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertImage(image) {
  assertDimension(image?.width, "image width");
  assertDimension(image?.height, "image height");
  if (!(image.data instanceof Uint8ClampedArray)) {
    throw new Error("image data must be a Uint8ClampedArray");
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error("image data length does not match its RGBA dimensions");
  }
}

/** Maps a target pixel center to the nearest source pixel center, with symmetric endpoint coverage. */
export function centeredNearestSourceIndex(targetIndex, sourceSize, targetSize) {
  assertDimension(sourceSize, "source size");
  assertDimension(targetSize, "target size");
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= targetSize) {
    throw new Error("target index is outside the target dimension");
  }
  return Math.min(sourceSize - 1, Math.floor(((targetIndex + 0.5) * sourceSize) / targetSize));
}

export function resizeRgbaNearest(image, targetWidth, targetHeight) {
  assertImage(image);
  assertDimension(targetWidth, "target width");
  assertDimension(targetHeight, "target height");
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = centeredNearestSourceIndex(targetY, image.height, targetHeight);
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = centeredNearestSourceIndex(targetX, image.width, targetWidth);
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const targetOffset = (targetY * targetWidth + targetX) * 4;
      data[targetOffset] = image.data[sourceOffset];
      data[targetOffset + 1] = image.data[sourceOffset + 1];
      data[targetOffset + 2] = image.data[sourceOffset + 2];
      data[targetOffset + 3] = image.data[sourceOffset + 3];
    }
  }

  return { width: targetWidth, height: targetHeight, data };
}

function nearestPaletteColor(red, green, blue) {
  let nearest = PI_PIXEL_PALETTE[0];
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of PI_PIXEL_PALETTE) {
    const [candidateRed, candidateGreen, candidateBlue] = candidate.rgb;
    // Rec. 709 channel weights make green differences count most and blue differences least.
    const distance =
      0.2126 * (red - candidateRed) ** 2 +
      0.7152 * (green - candidateGreen) ** 2 +
      0.0722 * (blue - candidateBlue) ** 2;
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function palettePixel(data, offset) {
  if (data[offset + 3] < PI_PIXEL_ALPHA_THRESHOLD) return undefined;
  return nearestPaletteColor(data[offset], data[offset + 1], data[offset + 2]);
}

function serializeHalfBlockRow(upperPixels, lowerPixels) {
  let activeForeground;
  let activeBackground;
  let line = "";

  const setForeground = (color) => {
    if (activeForeground === color) return;
    line += color === undefined ? RESET_FOREGROUND : `\x1b[38;2;${color.rgb.join(";")}m`;
    activeForeground = color;
  };
  const setBackground = (color) => {
    if (activeBackground === color) return;
    line += color === undefined ? RESET_BACKGROUND : `\x1b[48;2;${color.rgb.join(";")}m`;
    activeBackground = color;
  };

  for (let column = 0; column < upperPixels.length; column += 1) {
    const upper = upperPixels[column];
    const lower = lowerPixels[column];
    let glyph = " ";
    let foreground;
    let background;

    if (upper !== undefined && lower !== undefined && upper === lower) {
      glyph = "█";
      foreground = upper;
    } else if (upper !== undefined && lower !== undefined) {
      glyph = "▄";
      foreground = lower;
      background = upper;
    } else if (upper !== undefined) {
      glyph = "▀";
      foreground = upper;
    } else if (lower !== undefined) {
      glyph = "▄";
      foreground = lower;
    }

    setForeground(foreground);
    setBackground(background);
    line += glyph;
  }

  if (activeForeground !== undefined) line += RESET_FOREGROUND;
  if (activeBackground !== undefined) line += RESET_BACKGROUND;
  return line.replace(/ +$/u, "");
}

export function renderPiPixelFrame(image, targetWidth, targetHeight) {
  assertImage(image);
  assertDimension(targetWidth, "target width");
  assertDimension(targetHeight, "target height");
  if (targetHeight % 2 !== 0) throw new Error("target pixel height must be even for half-block pairing");

  // Native-size variants use decoded bytes directly; responsive variants take the centered-nearest path.
  const target = image.width === targetWidth && image.height === targetHeight
    ? image
    : resizeRgbaNearest(image, targetWidth, targetHeight);
  const rows = [];

  for (let upperY = 0; upperY < target.height; upperY += 2) {
    const upperPixels = [];
    const lowerPixels = [];
    for (let column = 0; column < target.width; column += 1) {
      upperPixels.push(palettePixel(target.data, (upperY * target.width + column) * 4));
      lowerPixels.push(palettePixel(target.data, ((upperY + 1) * target.width + column) * 4));
    }
    rows.push(serializeHalfBlockRow(upperPixels, lowerPixels));
  }

  return rows;
}
