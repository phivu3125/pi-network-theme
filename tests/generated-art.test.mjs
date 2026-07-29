import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import Chafa from "chafa-wasm";
import * as generatedArt from "../generated/pi-network-art.ts";
import {
  PI_PIXEL_ALPHA_THRESHOLD,
  PI_PIXEL_PALETTE,
  centeredNearestSourceIndex,
  renderPiPixelFrame,
} from "../scripts/pi-pixel-renderer.mjs";
import { normalizeStartupSheet } from "../scripts/startup-icon-normalizer.mjs";

const { MINTING_PANE_ART, PI_COIN_ART, REWARD_BURST_ART, STARTUP_ICON_ART } = generatedArt;
const MINT_RGB = new Set([
  "54;38;63",
  "75;45;96",
  "111;62;145",
  "161;108;196",
  "183;121;30",
  "251;180;74",
  "255;226;154",
  "255;255;255",
]);
const SGR = /\x1b\[([0-9;]+)m/g;
const TRUECOLOR_PARAMETERS = /^(38|48);2;(0|[1-9]\d{0,2});(0|[1-9]\d{0,2});(0|[1-9]\d{0,2})$/u;
const RESET_PARAMETERS = /^(39|49)$/u;
const PURPLE = "\x1b[38;2;111;62;145m";
const GOLD = "\x1b[38;2;251;180;74m";

function assertSafeLine(line, variantName, allowedRgb) {
  assert.equal(line.includes("\r"), false, `${variantName} contains a carriage return`);
  assert.equal(line.includes("\n"), false, `${variantName} embeds a newline`);
  assert.equal(line.includes("\x1b]"), false, `${variantName} contains OSC`);

  let foregroundActive = false;
  let backgroundActive = false;
  for (const [sgr, parameters] of line.matchAll(SGR)) {
    const truecolor = parameters.match(TRUECOLOR_PARAMETERS);
    assert.ok(truecolor || RESET_PARAMETERS.test(parameters), `${variantName} contains unsupported SGR ${sgr}`);
    if (truecolor) {
      const [, target, red, green, blue] = truecolor;
      const components = [red, green, blue].map(Number);
      assert.ok(components.every((component) => component <= 255), `${variantName} has out-of-range RGB in ${sgr}`);
      if (allowedRgb) {
        assert.ok(allowedRgb.has(`${red};${green};${blue}`), `${variantName} contains a non-brand color ${sgr}`);
      }
      if (target === "38") foregroundActive = true;
      if (target === "48") backgroundActive = true;
    }
    if (parameters === "39") foregroundActive = false;
    if (parameters === "49") backgroundActive = false;
  }

  const withoutAllowedSgr = line.replace(SGR, "");
  assert.equal(withoutAllowedSgr.includes("\x1b"), false, `${variantName} contains a non-SGR escape`);
  assert.equal(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(withoutAllowedSgr),
    false,
    `${variantName} contains a forbidden control character`,
  );
  assert.equal(foregroundActive, false, `${variantName} leaves the foreground color active`);
  assert.equal(backgroundActive, false, `${variantName} leaves the background color active`);
}

test("generated startup icon variants contain 12 safe bounded half-block frames", () => {
  assert.ok(STARTUP_ICON_ART, "coherent startup icon export exists");
  for (const variantName of ["full", "compact"]) {
    const variant = STARTUP_ICON_ART[variantName];
    assert.ok(variant, `${variantName} variant exists`);
    assert.equal(variant.frames.length, 12, `${variantName} has every Pi coin startup frame`);
    assert.equal(variant.final, variant.frames.at(-1), `${variantName} final frame is referenced, not duplicated`);
    assert.ok(variant.frames[0].every((line) => visibleWidth(line) === 0), `${variantName} frame 00 is empty`);
    assert.ok(
      variant.frames[1].some((line) => visibleWidth(line) > 0),
      `${variantName} preserves the visible scale-entrance frame`,
    );
    assert.notDeepEqual(variant.frames[1], variant.final, `${variantName} entrance and final frames differ`);

    const output = variant.frames.flat().join("\n");
    const startupColors = new Set(
      [...output.matchAll(SGR)]
        .map(([, parameters]) => parameters.match(TRUECOLOR_PARAMETERS))
        .filter(Boolean)
        .map((match) => `${match[2]};${match[3]};${match[4]}`),
    );
    assert.ok(startupColors.size > 1, `${variantName} retains multiple quantized coin colors`);
    assert.ok(
      [...startupColors].every((color) => MINT_RGB.has(color)),
      `${variantName} uses only the approved eight-color palette`,
    );
    assert.match(output, new RegExp(PURPLE.replace("[", "\\[")), `${variantName} includes Pi purple`);
    assert.match(output, new RegExp(GOLD.replace("[", "\\[")), `${variantName} includes Pi gold`);

    for (const [frameIndex, frame] of variant.frames.entries()) {
      assert.equal(frame.length, variant.rows, `${variantName} frame ${frameIndex} has its declared row count`);
      for (const line of frame) {
        const location = `${variantName} startup frame ${frameIndex}`;
        assertSafeLine(line, location, MINT_RGB);
        assert.match(line.replace(SGR, ""), /^[ ▀▄█]*$/u, `${location} uses only safe half-block cells`);
        assert.ok(visibleWidth(line) <= variant.columns, `${location} exceeds ${variant.columns} columns`);
      }
    }
  }
});

test("startup icon aliases reference one object and responsive variants differ", () => {
  assert.equal(PI_COIN_ART, STARTUP_ICON_ART, "Pi coin compatibility export references startup art");
  assert.equal(REWARD_BURST_ART, STARTUP_ICON_ART, "legacy reward export references startup art");
  assert.notDeepEqual(STARTUP_ICON_ART.full.final, STARTUP_ICON_ART.compact.final);
  assert.notEqual(STARTUP_ICON_ART.full.columns, STARTUP_ICON_ART.compact.columns);
  assert.notEqual(STARTUP_ICON_ART.full.rows, STARTUP_ICON_ART.compact.rows);
});

test("startup source frames are normalized and direct rendering reproduces both variants", async () => {
  const chafa = await Chafa();
  const decodeImage = promisify(chafa.decodeImage);
  const decodeFrame = async (index) => {
    const source = await readFile(new URL(`../assets/frames/startup-icon/frame-${index.toString().padStart(2, "0")}.png`, import.meta.url));
    return decodeImage(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  };
  const sheetSource = await readFile(new URL("../assets/source/pi-icon-pixel-contact-sheet.png", import.meta.url));
  const sheet = await decodeImage(sheetSource.buffer.slice(sheetSource.byteOffset, sheetSource.byteOffset + sheetSource.byteLength));
  assert.equal(sheet.width, 960);
  assert.equal(sheet.height, 810);
  const normalized = normalizeStartupSheet(sheet);
  const selectedFrames = [0, 1, 3, 7, 10, 11];
  const decoded = new Map();
  for (const index of selectedFrames) decoded.set(index, await decodeFrame(index));
  for (const index of selectedFrames) {
    const image = decoded.get(index);
    assert.equal(image.width, 30);
    assert.equal(image.height, 30);
    assert.deepEqual(image.data, normalized[index].data, `frame ${index.toString().padStart(2, "0")} matches deterministic sheet normalization`);
  }
  const empty = decoded.get(0);
  const representative = decoded.get(7);
  const final = decoded.get(11);
  assert.ok(empty.data.every((component) => component === 0), "frame 00 is deterministically transparent black");
  assert.ok(final.data.some((component, offset) => offset % 4 === 3 && component >= PI_PIXEL_ALPHA_THRESHOLD), "final coin remains visible");
  assert.deepEqual(renderPiPixelFrame(representative, 30, 30), STARTUP_ICON_ART.full.frames[7]);
  assert.deepEqual(renderPiPixelFrame(representative, 18, 18), STARTUP_ICON_ART.compact.frames[7]);
  assert.deepEqual(
    Array.from({ length: 18 }, (_, index) => centeredNearestSourceIndex(index, 30, 18)),
    [0, 2, 4, 5, 7, 9, 10, 12, 14, 15, 17, 19, 20, 22, 24, 25, 27, 29],
    "compact startup samples deterministic centered-nearest source coordinates",
  );
});

test("Mint direct renderer uses centered nearest-neighbor sampling and reproduces generated frame 06", async () => {
  assert.equal(PI_PIXEL_ALPHA_THRESHOLD, 80);
  assert.deepEqual(
    PI_PIXEL_PALETTE.map(({ rgb }) => rgb.join(";")),
    [...MINT_RGB],
    "renderer palette is the exact approved eight-color allowlist",
  );
  assert.deepEqual(
    Array.from({ length: 18 }, (_, index) => centeredNearestSourceIndex(index, 28, 18)),
    [0, 2, 3, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 21, 22, 24, 25, 27],
    "18-pixel compact centers select deterministic symmetric source coordinates",
  );

  const source = await readFile(new URL("../assets/frames/minting/frame-06.png", import.meta.url));
  const chafa = await Chafa();
  const decodeImage = promisify(chafa.decodeImage);
  const image = await decodeImage(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  assert.deepEqual(renderPiPixelFrame(image, 28, 28), MINTING_PANE_ART.wide.frames[6]);
  assert.deepEqual(renderPiPixelFrame(image, 18, 18), MINTING_PANE_ART.compact.frames[6]);
});

test("Mint direct renderer applies binary alpha and every half-block cell state", () => {
  const data = new Uint8ClampedArray(5 * 2 * 4);
  const setPixel = (x, y, [red, green, blue], alpha) => {
    const offset = (y * 5 + x) * 4;
    data.set([red, green, blue, alpha], offset);
  };
  setPixel(0, 0, [255, 255, 255], 79);
  setPixel(0, 1, [255, 255, 255], 79);
  setPixel(1, 0, [54, 38, 63], 80);
  setPixel(1, 1, [54, 38, 63], 80);
  setPixel(2, 0, [111, 62, 145], 255);
  setPixel(3, 1, [251, 180, 74], 255);
  setPixel(4, 0, [54, 38, 63], 255);
  setPixel(4, 1, [255, 255, 255], 255);

  const [line] = renderPiPixelFrame({ width: 5, height: 2, data }, 5, 2);
  assert.equal(line.replace(SGR, ""), " █▀▄▄", "transparent, full, upper, lower, and split cells map exactly");
  assert.match(line, /\x1b\[48;2;54;38;63m/u, "different opaque pixels use upper color as background");
  assert.ok(line.endsWith("\x1b[39m\x1b[49m"), "line restores foreground and background defaults");
});

test("generated mint pane variants contain 12 safe half-block frames at responsive dimensions", () => {
  const expectedDimensions = {
    wide: { columns: 28, rows: 14 },
    compact: { columns: 18, rows: 9 },
  };

  for (const variantName of ["wide", "compact"]) {
    const variant = MINTING_PANE_ART[variantName];
    assert.ok(variant, `${variantName} mint variant exists`);
    assert.equal(variant.columns, expectedDimensions[variantName].columns);
    assert.equal(variant.rows, expectedDimensions[variantName].rows);
    assert.equal(variant.frames.length, 12, `${variantName} has every mint frame`);
    assert.deepEqual(variant.working, variant.frames.slice(0, 8), `${variantName} working loop is frames 00..07`);
    assert.deepEqual(variant.completion, variant.frames.slice(8), `${variantName} completion is frames 08..11`);
    assert.equal(variant.idle, variant.frames[6], `${variantName} idle references completed-Pi frame 06`);
    assert.ok(variant.frames.every((frame) => frame.some((line) => visibleWidth(line) > 0)));
    assert.equal(new Set(variant.working.map(JSON.stringify)).size, 8, `${variantName} working frames visibly differ`);
    assert.equal(new Set(variant.completion.map(JSON.stringify)).size, 4, `${variantName} completion frames visibly differ`);

    const output = variant.frames.flat().join("\n");
    const mintColors = new Set(
      [...output.matchAll(SGR)]
        .map(([, parameters]) => parameters.match(TRUECOLOR_PARAMETERS))
        .filter(Boolean)
        .map((match) => `${match[2]};${match[3]};${match[4]}`),
    );
    assert.deepEqual(mintColors, MINT_RGB, `${variantName} uses exactly the direct renderer's eight-color palette`);
    assert.match(output, /\x1b\[48;2;/u, `${variantName} uses palette backgrounds for upper samples`);
    assert.match(output, /\x1b\[49m/u, `${variantName} resets palette backgrounds`);

    for (const [frameIndex, frame] of variant.frames.entries()) {
      assert.equal(frame.length, variant.rows, `${variantName} frame ${frameIndex} has its declared row count`);
      for (const line of frame) {
        const location = `${variantName} mint frame ${frameIndex}`;
        assertSafeLine(line, location, MINT_RGB);
        assert.match(line.replace(SGR, ""), /^[ ▀▄█]*$/u, `${location} uses only half-block cells`);
        assert.ok(visibleWidth(line) <= variant.columns, `${location} exceeds bounds`);
      }
    }
  }
});
