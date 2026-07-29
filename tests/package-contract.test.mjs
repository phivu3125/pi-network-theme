import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);
const execAsync = promisify(exec);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const extensionSource = await readFile(new URL("extensions/pi-network-theme.ts", root), "utf8");
const theme = JSON.parse(await readFile(new URL("themes/pi-coin.json", root), "utf8"));

const EXPECTED_PACKED_PATHS = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "assets/demo.png",
  "assets/preview.png",
  "extensions/pi-network-theme.ts",
  "generated/pi-network-art.ts",
  "package.json",
  "themes/pi-coin.json",
];

const REQUIRED_THEME_TOKENS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText",
  "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading",
  "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "thinkingMax", "bashMode",
];

function resolveColor(value) {
  const resolved = theme.vars[value] ?? value;
  assert.match(resolved, /^#[0-9a-f]{6}$/i, `expected an RGB color, got ${resolved}`);
  return resolved;
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((channel) => Number.parseInt(channel, 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

test("manifest exposes only the intended Pi resources and keeps Chafa build-only", () => {
  assert.equal(packageJson.name, "pi-network-theme");
  assert.equal(packageJson.version, "0.1.0");
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.deepEqual(packageJson.pi.extensions, ["./extensions/pi-network-theme.ts"]);
  assert.deepEqual(packageJson.pi.themes, ["./themes/pi-coin.json"]);
  assert.equal(packageJson.pi.image, "./assets/demo.png");
  assert.equal(
    packageJson.pi.video,
    "https://raw.githubusercontent.com/phivu3125/pi-network-theme/main/assets/demo.mp4",
  );
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/phivu3125/pi-network-theme.git",
  });
  assert.equal(packageJson.homepage, "https://github.com/phivu3125/pi-network-theme#readme");
  assert.deepEqual(packageJson.bugs, { url: "https://github.com/phivu3125/pi-network-theme/issues" });
  assert.equal(packageJson.author, "phivu3125");
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.equal(packageJson.devDependencies["chafa-wasm"], "0.3.3");
  assert.equal(packageJson.dependencies?.["chafa-wasm"], undefined);
  assert.equal(packageJson.bundledDependencies, undefined);
  assert.deepEqual(
    [...packageJson.files, "package.json"].sort(),
    [...EXPECTED_PACKED_PATHS].sort(),
    "the manifest allowlist exposes exactly the nine intended runtime files",
  );
  assert.equal(packageJson.files.some((entry) => entry.startsWith("scripts/")), false);
  assert.equal(packageJson.files.some((entry) => entry.startsWith("assets/source/")), false);
  assert.equal(packageJson.files.some((entry) => entry.startsWith("assets/frames/")), false);
  assert.equal(packageJson.files.includes("assets/demo.mp4"), false);
});

test("extension uses the release package config filename", () => {
  assert.match(extensionSource, /"pi-network-theme\.json"/u);
});

test("npm tarball excludes source frames, build tooling, and WebAssembly", async () => {
  const { stdout } = await execAsync("npm pack --dry-run --json", {
    cwd: fileURLToPath(root),
    maxBuffer: 1024 * 1024,
  });
  const [{ files }] = JSON.parse(stdout);
  const paths = files.map(({ path }) => path);

  assert.deepEqual(paths.sort(), [...EXPECTED_PACKED_PATHS].sort());
  assert.ok(paths.includes("assets/demo.png"));
  assert.ok(paths.includes("assets/preview.png"));
  assert.equal(paths.includes("assets/demo.mp4"), false);
  assert.equal(paths.some((path) => path.endsWith(".mp4")), false);
  assert.equal(
    paths.some((path) => path.endsWith(".png") && !["assets/demo.png", "assets/preview.png"].includes(path)),
    false,
  );
  assert.equal(paths.some((path) => /^assets\/frames\/(?:startup-icon|minting)\//u.test(path)), false);
  assert.equal(paths.some((path) => /^assets\/source\//u.test(path) || /contact-sheet/iu.test(path)), false);
  assert.equal(paths.some((path) => path.endsWith(".wasm")), false);
  assert.equal(paths.some((path) => /^(?:node_modules|scripts|tests)\//u.test(path)), false);
});

test("pi-coin theme defines every current token and readable dark surfaces", () => {
  assert.equal(theme.name, "pi-coin");
  assert.equal(theme.vars.purple.toUpperCase(), "#6F3E91");
  assert.equal(theme.vars.gold.toUpperCase(), "#FBB44A");
  assert.equal(theme.vars.white.toUpperCase(), "#FFFFFF");
  assert.equal(theme.vars.page.toUpperCase(), "#17151D");
  assert.equal(theme.vars.userSurface.toUpperCase(), "#321B40");
  assert.equal(theme.vars.muted.toUpperCase(), "#C8BBD1");
  assert.equal(theme.vars.borderMuted.toUpperCase(), "#665471");
  assert.deepEqual(Object.keys(theme.colors).sort(), [...REQUIRED_THEME_TOKENS].sort());

  for (const value of Object.values(theme.colors)) resolveColor(value);

  const contrastPairs = [
    ["text", "selectedBg"],
    ["userMessageText", "userMessageBg"],
    ["customMessageText", "customMessageBg"],
    ["toolOutput", "toolPendingBg"],
    ["toolOutput", "toolSuccessBg"],
    ["toolOutput", "toolErrorBg"],
  ];
  for (const [foregroundToken, backgroundToken] of contrastPairs) {
    const ratio = contrast(resolveColor(theme.colors[foregroundToken]), resolveColor(theme.colors[backgroundToken]));
    assert.ok(ratio >= 4.5, `${foregroundToken}/${backgroundToken} contrast ${ratio.toFixed(2)} is below 4.5`);
  }
});
