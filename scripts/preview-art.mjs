import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { MINTING_PANE_ART, STARTUP_ICON_ART } from "../generated/pi-network-art.ts";

const selector = process.argv[2] ?? "startup";
const selections = {
  startup: { art: STARTUP_ICON_ART, variants: ["full", "compact"], phase: "startup" },
  reward: { art: STARTUP_ICON_ART, variants: ["full", "compact"], phase: "startup" },
  mint: { art: MINTING_PANE_ART, variants: ["wide", "compact"], phase: "mint" },
};
const selected = selections[selector];
if (!selected) throw new Error(`Unknown preview ${JSON.stringify(selector)}; use startup, reward, or mint`);

for (const variantName of selected.variants) {
  const variant = selected.art[variantName];
  for (const [frameIndex, frame] of variant.frames.entries()) {
    const phase = selected.phase === "mint" ? (frameIndex < 8 ? "working" : "completion") : "startup";
    console.log(`\n${variantName} ${phase} frame ${frameIndex.toString().padStart(2, "0")} (${variant.columns}×${variant.rows})`);
    for (const line of frame) {
      assert.ok(visibleWidth(line) <= variant.columns, `${variantName} output exceeds its declared width`);
      console.log(line);
    }
  }
}
