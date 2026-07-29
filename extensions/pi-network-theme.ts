import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { VERSION, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { MINTING_PANE_ART, STARTUP_ICON_ART } from "../generated/pi-network-art.ts";

const PURPLE = "\x1b[38;2;111;62;145m";
const GOLD = "\x1b[38;2;251;180;74m";
const ERROR_RED = "\x1b[38;2;239;92;92m";
const RESET_FOREGROUND = "\x1b[39m";
const FULL_HEADER_MIN_WIDTH = 72;
const COMPACT_HEADER_MIN_WIDTH = 24;
const STARTUP_ICON_INTERVAL_MS = 100;
const MINTING_INTERVAL_MS = 120;
const SUCCESS_PULSE_MS = 200;
const JAM_PULSE_MS = 350;
const COMPLETION_HOLD_MS = 500;
const PANE_WIDGET_KEY = "pi-coin-pane";
const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-network-theme.json");

interface PiCoinUiOptions {
  configPath?: string;
}

interface PaneConfigResult {
  paneEnabled: boolean;
  persisted: boolean;
  warning?: string;
}

function brand(text: string, color: string): string {
  return `${color}${text}${RESET_FOREGROUND}`;
}

/** Removes terminal instructions while preserving ordinary Unicode and path text. */
function sanitizeTerminalText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\|$)/gu, "")
    .replace(/\u009d[^\u0007\u009c]*(?:\u0007|\u009c|$)/gu, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[ -/]*[@-~]?/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ");
}

function fit(line: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(line, width, "");
}

function metadata(ctx: ExtensionContext, theme: Theme): string[] {
  const model = ctx.model
    ? sanitizeTerminalText(`${ctx.model.provider}/${ctx.model.id}`)
    : "not selected";
  const thinking = sanitizeTerminalText(ctx.thinkingLevel ?? "off");
  const cwd = sanitizeTerminalText(ctx.cwd);
  return [
    `${brand("PI COIN", GOLD)} ${theme.fg("muted", "unofficial community UI")}`,
    `${theme.fg("accent", `Pi v${VERSION}`)} ${theme.fg("dim", `• thinking ${thinking}`)}`,
    `${theme.fg("muted", "model")} ${model}`,
    `${theme.fg("muted", "cwd")} ${cwd}`,
  ];
}

function renderWideHeader(width: number, ctx: ExtensionContext, theme: Theme, artLines: readonly string[]): string[] {
  const art = STARTUP_ICON_ART.full;
  const gap = 3;
  const rightWidth = Math.max(1, width - art.columns - gap);
  const details = metadata(ctx, theme);
  const detailStart = 4;

  return artLines.map((artLine, index) => {
    const detail = details[index - detailStart];
    if (detail === undefined) return fit(artLine, width);
    const padding = " ".repeat(Math.max(0, art.columns - visibleWidth(artLine) + gap));
    return fit(`${artLine}${padding}${fit(detail, rightWidth)}`, width);
  });
}

function renderCompactHeader(
  width: number,
  ctx: ExtensionContext,
  theme: Theme,
  artLines: readonly string[],
): string[] {
  const details = metadata(ctx, theme);
  return [
    ...artLines.map((line) => fit(line, width)),
    fit(`${details[0]} ${theme.fg("dim", `• Pi v${VERSION}`)}`, width),
    fit(`${details[2]} ${theme.fg("dim", `• thinking ${sanitizeTerminalText(ctx.thinkingLevel ?? "off")}`)}`, width),
    fit(details[3] ?? "", width),
  ];
}

function renderTinyHeader(width: number): string[] {
  return [fit(`${brand("π", GOLD)} ${brand("PI COIN", PURPLE)}`, width)];
}

function createHeader(ctx: ExtensionContext, theme: Theme, tui: { requestRender(): void }): Component & { dispose(): void } {
  const finalFrameIndex = STARTUP_ICON_ART.full.frames.length - 1;
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    if (frameIndex >= finalFrameIndex) return;

    frameIndex = Math.min(frameIndex + 1, finalFrameIndex);
    tui.requestRender();
    if (frameIndex === finalFrameIndex) {
      clearInterval(timer);
      timer = undefined;
    }
  }, STARTUP_ICON_INTERVAL_MS);

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(0, Math.floor(width));
      if (safeWidth >= FULL_HEADER_MIN_WIDTH) {
        return renderWideHeader(safeWidth, ctx, theme, STARTUP_ICON_ART.full.frames[frameIndex]!);
      }
      if (safeWidth >= COMPACT_HEADER_MIN_WIDTH) {
        return renderCompactHeader(safeWidth, ctx, theme, STARTUP_ICON_ART.compact.frames[frameIndex]!);
      }
      return renderTinyHeader(safeWidth);
    },
    invalidate() {},
    dispose() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

type PanePhase = "idle" | "minting" | "success" | "jam" | "completion";

const PANE_FOOTER_LABELS: Record<PanePhase, string> = {
  idle: "π ready",
  minting: "π minting",
  success: "π minted",
  jam: "π jam",
  completion: "π complete",
};

interface PaneSnapshot {
  phase: PanePhase;
  frameIndex: number;
}

class PaneController {
  private phase: PanePhase = "idle";
  private frameIndex = 0;
  private agentActive = false;
  private loopTimer: ReturnType<typeof setInterval> | undefined;
  private effectTimer: ReturnType<typeof setTimeout> | undefined;
  private completionTimer: ReturnType<typeof setInterval> | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly onPhaseChange: (phase: PanePhase) => void;

  constructor(onPhaseChange: (phase: PanePhase) => void) {
    this.onPhaseChange = onPhaseChange;
  }

  snapshot(): PaneSnapshot {
    return { phase: this.phase, frameIndex: this.frameIndex };
  }

  attach(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enable(agentActive: boolean): void {
    this.stopTimers();
    this.agentActive = agentActive;
    this.phase = agentActive ? "minting" : "idle";
    this.frameIndex = 0;
    this.changed();
    if (agentActive) this.startMintingLoop();
  }

  disable(): void {
    this.stopTimers();
    this.agentActive = false;
    this.phase = "idle";
    this.frameIndex = 0;
    this.listeners.clear();
  }

  agentStarted(): void {
    if (this.agentActive) return;
    this.stopTimers();
    this.agentActive = true;
    this.phase = "minting";
    this.frameIndex = 0;
    this.changed();
    this.startMintingLoop();
  }

  toolEnded(isError: boolean): void {
    if (!this.agentActive) return;
    if (this.effectTimer !== undefined) clearTimeout(this.effectTimer);
    this.phase = isError ? "jam" : "success";
    this.changed();
    this.effectTimer = setTimeout(() => {
      this.effectTimer = undefined;
      this.phase = this.agentActive ? "minting" : "idle";
      this.changed();
    }, isError ? JAM_PULSE_MS : SUCCESS_PULSE_MS);
  }

  agentSettled(): void {
    if (!this.agentActive) return;
    this.agentActive = false;
    this.stopTimers();
    this.phase = "completion";
    this.frameIndex = MINTING_PANE_ART.wide.working.length;
    this.changed();
    this.completionTimer = setInterval(() => {
      if (this.frameIndex < MINTING_PANE_ART.wide.frames.length - 1) {
        this.frameIndex += 1;
        this.changed();
        return;
      }
      if (this.completionTimer !== undefined) {
        clearInterval(this.completionTimer);
        this.completionTimer = undefined;
      }
      this.holdTimer = setTimeout(() => {
        this.holdTimer = undefined;
        this.phase = "idle";
        this.frameIndex = 0;
        this.changed();
      }, COMPLETION_HOLD_MS);
    }, MINTING_INTERVAL_MS);
  }

  private changed(): void {
    this.onPhaseChange(this.phase);
    for (const listener of this.listeners) listener();
  }

  private startMintingLoop(): void {
    this.loopTimer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % MINTING_PANE_ART.wide.working.length;
      this.changed();
    }, MINTING_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.loopTimer !== undefined) clearInterval(this.loopTimer);
    if (this.effectTimer !== undefined) clearTimeout(this.effectTimer);
    if (this.completionTimer !== undefined) clearInterval(this.completionTimer);
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer);
    this.loopTimer = undefined;
    this.effectTimer = undefined;
    this.completionTimer = undefined;
    this.holdTimer = undefined;
  }
}

function centered(line: string, width: number): string {
  const padding = Math.floor((width - visibleWidth(line)) / 2);
  return `${" ".repeat(Math.max(0, padding))}${line}`;
}

function padToWidth(line: string, width: number): string {
  const clipped = fit(line, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function placePaneArt(line: string, width: number, offset: number): string {
  // Generated rows already encode x-coordinates in their leading spaces. Only a
  // whole-frame effect may add left padding; the fixed plane clips on the right.
  return padToWidth(`${" ".repeat(Math.max(0, offset))}${line}`, width);
}

function paneBorder(width: number, label: string, color: string, bottom = false): string {
  if (bottom) return brand(`└${"─".repeat(Math.max(0, width - 2))}┘`, color);
  const middle = `─ ${label} `;
  return brand(`┌${middle}${"─".repeat(Math.max(0, width - 2 - visibleWidth(middle)))}┐`, color);
}

function centerRows(lines: readonly string[], height: number): string[] {
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  return [
    ...Array.from({ length: top }, () => ""),
    ...lines.slice(0, height),
    ...Array.from({ length: Math.max(0, height - top - lines.length) }, () => ""),
  ];
}

function paneStatus(snapshot: PaneSnapshot, theme: Theme): string {
  switch (snapshot.phase) {
    case "idle": return theme.fg("dim", "idle");
    case "minting": return theme.fg("accent", "π minting");
    case "success": return theme.fg("success", "✦ tool minted");
    case "jam": return theme.fg("error", "jam • tool error");
    case "completion": return theme.fg("success", "complete");
  }
}

function createPane(theme: Theme, controller: PaneController, tui: { requestRender(): void }): Component & { dispose(): void } {
  const detach = controller.attach(() => tui.requestRender());
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(0, Math.floor(width));
      const snapshot = controller.snapshot();
      const status = paneStatus(snapshot, theme);
      if (safeWidth < 20) return [fit(`${theme.fg("accent", "π PI MINT")} ${status}`, safeWidth)];

      const compact = safeWidth < 32;
      const variant = compact ? MINTING_PANE_ART.compact : MINTING_PANE_ART.wide;
      const paneWidth = variant.columns + 2;
      const innerWidth = variant.columns;
      const artHeight = variant.rows;
      let art: readonly string[];
      if (snapshot.phase === "idle") {
        art = variant.idle;
      } else {
        art = variant.frames[snapshot.frameIndex] ?? variant.idle;
      }
      const color = snapshot.phase === "jam"
        ? ERROR_RED
        : snapshot.phase === "success" || snapshot.phase === "completion" ? GOLD : PURPLE;
      const prefix = " ".repeat(Math.max(0, safeWidth - paneWidth));
      const jamNudge = snapshot.phase === "jam" ? 1 + (snapshot.frameIndex % 2) : 0;
      const lines = [
        paneBorder(paneWidth, "PI MINT", color),
        ...centerRows(art, artHeight).map(
          (artLine) => `│${placePaneArt(artLine, innerWidth, jamNudge)}│`,
        ),
        `│${padToWidth(centered(status, innerWidth), innerWidth)}│`,
        paneBorder(paneWidth, "", color, true),
      ];
      return lines.map((line) => fit(`${prefix}${line}`, safeWidth));
    },
    invalidate() {},
    dispose: detach,
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readPaneConfig(configPath: string): Promise<PaneConfigResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("paneEnabled" in parsed) ||
      typeof parsed.paneEnabled !== "boolean"
    ) {
      return { paneEnabled: true, persisted: false, warning: "Pi Mint config is malformed; using pane enabled." };
    }
    return { paneEnabled: parsed.paneEnabled, persisted: true };
  } catch (error) {
    if (isMissingFile(error)) return { paneEnabled: true, persisted: false };
    return { paneEnabled: true, persisted: false, warning: "Pi Mint config is unreadable; using pane enabled." };
  }
}

async function writePaneConfig(configPath: string, paneEnabled: boolean): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ paneEnabled }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function createPaneConfigWriter(configPath: string) {
  let tail: Promise<void> = Promise.resolve();
  let pendingWrites = 0;

  return {
    hasPending(): boolean {
      return pendingWrites > 0;
    },
    async write(paneEnabled: boolean): Promise<void> {
      pendingWrites += 1;
      const operation = tail.then(() => writePaneConfig(configPath, paneEnabled));
      tail = operation.catch(() => {});
      return operation.finally(() => {
        pendingWrites -= 1;
      });
    },
  };
}

function isAgentBusy(ctx: ExtensionContext, eventFallback: boolean): boolean {
  try {
    return eventFallback || (typeof ctx.isIdle === "function" ? !ctx.isIdle() : false);
  } catch {
    return eventFallback;
  }
}

function workingIndicator() {
  const purple = (symbol: string) => brand(symbol, PURPLE);
  const gold = (symbol: string) => brand(symbol, GOLD);
  return {
    frames: [
      `${purple("◐")} ${gold("π")}`,
      `${gold("◓")} ${purple("π")}`,
      `${purple("◑")} ${gold("π")}`,
      `${gold("◒")} ${purple("π")}`,
    ],
    intervalMs: 110,
  };
}

export default function piCoinUi(pi: ExtensionAPI, options: PiCoinUiOptions = {}): void {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const displayConfigPath = sanitizeTerminalText(configPath);
  const configWriter = createPaneConfigWriter(configPath);
  let ownsHeader = false;
  let ownsIndicator = false;
  let ownsPane = false;
  let paneController: PaneController | undefined;
  let paneEnabled = true;
  let sessionActive = false;
  let agentRunActive = false;
  let persistedPaneEnabled: boolean | undefined;
  let warnedAboutConfig = false;

  const clearPane = (ctx: ExtensionContext) => {
    paneController?.disable();
    if (!ownsPane) return;
    ctx.ui.setWidget(PANE_WIDGET_KEY, undefined);
    ctx.ui.setStatus(PANE_WIDGET_KEY, undefined);
    ownsPane = false;
  };

  const showPane = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || ownsPane) return;
    const controller = paneController ?? new PaneController((phase) => {
      ctx.ui.setStatus(PANE_WIDGET_KEY, brand(PANE_FOOTER_LABELS[phase], phase === "jam" ? ERROR_RED : GOLD));
    });
    paneController = controller;
    controller.enable(isAgentBusy(ctx, agentRunActive));
    ctx.ui.setWidget(
      PANE_WIDGET_KEY,
      (tui, theme) => createPane(theme, controller, tui),
      { placement: "aboveEditor" },
    );
    ownsPane = true;
  };

  const applyPaneSetting = async (enabled: boolean, ctx: ExtensionContext) => {
    const stateChanged = paneEnabled !== enabled;
    paneEnabled = enabled;
    if (stateChanged) {
      if (enabled) showPane(ctx);
      else clearPane(ctx);
    }

    const shouldPersist = stateChanged || persistedPaneEnabled !== enabled || configWriter.hasPending();
    if (!shouldPersist) {
      ctx.ui.notify(`Pi Mint pane is already ${enabled ? "enabled" : "disabled"}.`, "info");
      return;
    }

    try {
      await configWriter.write(enabled);
      persistedPaneEnabled = enabled;
      ctx.ui.notify(`Pi Mint pane ${enabled ? "enabled" : "disabled"}.`, "info");
    } catch {
      // Runtime state remains changed; the error explicitly reports that persistence did not.
      persistedPaneEnabled = undefined;
      ctx.ui.notify(`Pi Mint pane changed, but config could not be saved: ${displayConfigPath}`, "error");
    }
  };

  pi.registerCommand("picoin", {
    description: "Control the persistent Pi Mint pane",
    getArgumentCompletions(prefix) {
      const values = ["pane on", "pane off", "pane toggle", "pane status"];
      const matches = values.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    async handler(args, ctx) {
      const command = args.trim().replace(/\s+/gu, " ");
      if (command === "pane status") {
        ctx.ui.notify(`Pi Mint pane is ${paneEnabled ? "enabled" : "disabled"}. Config: ${displayConfigPath}`, "info");
        return;
      }
      if (command === "pane on") {
        await applyPaneSetting(true, ctx);
        return;
      }
      if (command === "pane off") {
        await applyPaneSetting(false, ctx);
        return;
      }
      if (command === "pane toggle") {
        await applyPaneSetting(!paneEnabled, ctx);
        return;
      }
      ctx.ui.notify("Usage: /picoin pane on|off|toggle|status", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = await readPaneConfig(configPath);
    paneEnabled = config.paneEnabled;
    persistedPaneEnabled = config.persisted ? config.paneEnabled : undefined;
    sessionActive = true;
    if (config.warning && !warnedAboutConfig) {
      ctx.ui.notify(config.warning, "warning");
      warnedAboutConfig = true;
    }
    if (ctx.mode !== "tui") return;

    if (!ownsHeader) {
      ctx.ui.setHeader((tui, theme) => createHeader(ctx, theme, tui));
      ownsHeader = true;
    }
    if (!ownsIndicator) {
      ctx.ui.setWorkingIndicator(workingIndicator());
      ownsIndicator = true;
    }
    if (paneEnabled) showPane(ctx);
  });

  pi.on("agent_start", (_event, _ctx) => {
    if (!sessionActive) return;
    agentRunActive = true;
    if (paneEnabled) paneController?.agentStarted();
  });

  pi.on("tool_execution_end", (event, _ctx) => {
    if (sessionActive && paneEnabled) paneController?.toolEnded(event.isError);
  });

  pi.on("agent_settled", (_event, _ctx) => {
    if (!sessionActive) return;
    agentRunActive = false;
    if (paneEnabled) paneController?.agentSettled();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionActive = false;
    agentRunActive = false;
    if (ctx.mode !== "tui") return;

    // Pi has setters but no getter/ownership token for these singleton UI slots.
    // These flags ensure this instance only restores slots it installed in this session.
    if (ownsHeader) {
      ctx.ui.setHeader(undefined);
      ownsHeader = false;
    }
    if (ownsIndicator) {
      ctx.ui.setWorkingIndicator();
      ownsIndicator = false;
    }
    clearPane(ctx);
  });
}
