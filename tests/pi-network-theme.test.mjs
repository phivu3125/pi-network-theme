import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import piCoinUi from "../extensions/pi-network-theme.ts";
import { MINTING_PANE_ART } from "../generated/pi-network-art.ts";

const plainTheme = {
  fg: (_token, text) => text,
  bold: (text) => text,
};

const ALLOWED_SGR = /\x1b\[(?:(?:38|48);2;(?:\d{1,3};){2}\d{1,3}|0|39|49)m/gu;

let harnessId = 0;

function stripAllowedSgr(line) {
  const plain = line.replace(ALLOWED_SGR, "");
  assert.equal(plain.includes("\x1b"), false, "pane output contains unexpected terminal instructions");
  return plain;
}

function extractPaneArtRows(rendered, width, variant) {
  const panePrefixWidth = width - variant.columns - 2;
  return rendered.slice(1, variant.rows + 1).map((line) => {
    const plain = stripAllowedSgr(line);
    assert.equal(plain[panePrefixWidth], "│");
    assert.equal(plain[panePrefixWidth + variant.columns + 1], "│");
    return plain.slice(panePrefixWidth + 1, panePrefixWidth + variant.columns + 1);
  });
}

function paddedGeneratedRows(rows, columns, offset = 0) {
  const shift = " ".repeat(offset);
  return rows.map((line) => `${shift}${stripAllowedSgr(line)}`.slice(0, columns).padEnd(columns));
}

function createHarness(mode = "tui", configPath = join(tmpdir(), `pi-network-theme-${process.pid}-${++harnessId}`, "config.json")) {
  const handlers = new Map();
  let idle = true;
  const commands = new Map();
  const calls = { headers: [], indicators: [], widgets: [], statuses: [], notifications: [], renders: 0 };
  const tui = {
    requestRender() {
      calls.renders += 1;
    },
  };
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  const ctx = {
    mode,
    cwd: "C:\\work\\demo",
    isIdle() {
      return idle;
    },
    model: { id: "gpt-test", provider: "test-provider" },
    thinkingLevel: "high",
    ui: {
      theme: plainTheme,
      setHeader(value) {
        calls.headers.push(value);
      },
      setWorkingIndicator(value) {
        calls.indicators.push(value);
      },
      setWidget(key, value, options) {
        calls.widgets.push({ key, value, options });
      },
      setStatus(key, value) {
        calls.statuses.push({ key, value });
      },
      notify(message, level) {
        calls.notifications.push({ message, level });
      },
    },
  };

  piCoinUi(pi, { configPath });
  return {
    handlers,
    commands,
    calls,
    configPath,
    ctx,
    tui,
    setIdle(value) {
      idle = value;
    },
  };
}

test("interactive startup installs responsive bounded header and branded indicator", async () => {
  const { handlers, calls, ctx, tui } = createHarness();
  await handlers.get("session_start")({ reason: "startup" }, ctx);

  assert.equal(calls.headers.length, 1);
  assert.equal(calls.indicators.length, 1);
  assert.ok(calls.indicators[0].frames.length >= 4);
  assert.ok(calls.indicators[0].frames.some((frame) => frame.includes("38;2;111;62;145")));
  assert.ok(calls.indicators[0].frames.some((frame) => frame.includes("38;2;251;180;74")));

  const component = calls.headers[0](tui, plainTheme);
  for (const width of [1, 8, 12, 31, 40, 64, 80, 120]) {
    const lines = component.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `line exceeds supplied width ${width}`);
    }
  }

  assert.match(component.render(120).join("\n"), /Pi v\d/);
  assert.match(component.render(120).join("\n"), /test-provider\/gpt-test/);
  assert.match(component.render(120).join("\n"), /thinking high/);
  assert.match(component.render(120).join("\n"), /C:\\work\\demo/);
  const tinyText = component.render(8).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(tinyText, /π PI/);
  component.dispose();
});

test("malicious dynamic terminal metadata is sanitized before rendering", async () => {
  const maliciousPath = join(tmpdir(), `config-\x1b]0;owned\x07\r\n-${++harnessId}.json`);
  const harness = createHarness("tui", maliciousPath);
  harness.ctx.model = {
    provider: "provider\x1b[31m-red",
    id: "model\x1b]8;;https://evil.example\x07link\x1b]8;;\x07\r\nnext",
  };
  harness.ctx.thinkingLevel = "high\u009b31m\u2028forged";
  harness.ctx.cwd = "C:\\safe\x1b]0;title\x07\r\nFORGED";

  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const header = harness.calls.headers[0](harness.tui, plainTheme);
  const allowedStaticSgr = /\x1b\[(?:38;2;\d{1,3};\d{1,3};\d{1,3}|39)m/gu;
  for (const line of header.render(120)) {
    const dynamicSafeLine = line.replace(allowedStaticSgr, "");
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(dynamicSafeLine), false);
  }
  assert.doesNotMatch(header.render(120).join("\n"), /\x1b\[(?:31|0)m|\x1b\]/u);

  await harness.commands.get("picoin").handler("pane status", harness.ctx);
  const notification = harness.calls.notifications.at(-1).message;
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(notification), false);
  header.dispose();
});

test("default-on pane is aboveEditor, responsive, UI-only, and command controlled", async () => {
  const harness = createHarness();
  const { handlers, commands, calls, configPath, ctx, tui } = harness;
  await handlers.get("session_start")({ reason: "startup" }, ctx);

  assert.equal(commands.size, 1);
  const command = commands.get("picoin");
  assert.ok(command);
  assert.deepEqual(
    command.getArgumentCompletions("pane ").map(({ value }) => value),
    ["pane on", "pane off", "pane toggle", "pane status"],
  );

  const installed = calls.widgets.at(-1);
  assert.equal(installed.key, "pi-coin-pane");
  assert.deepEqual(installed.options, { placement: "aboveEditor" });
  const pane = installed.value(tui, plainTheme);
  for (const width of [1, 8, 20, 24, 31, 32, 40, 80]) {
    const lines = pane.render(width);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `pane exceeds width ${width}`);
  }
  assert.equal(pane.render(24).length, 12, "compact pane reserves nine pixel-art rows");
  assert.equal(pane.render(31).length, 12, "compact art remains selected below the wide breakpoint");
  assert.equal(pane.render(32).length, 17, "wide pane reserves fourteen pixel-art rows");
  assert.match(pane.render(80).join("\n"), /PI MINT/);
  const idleRender = pane.render(32).join("\n");
  const completedPiLine = MINTING_PANE_ART.wide.idle.find(
    (line) => line.length > 0 && !MINTING_PANE_ART.wide.frames[0].includes(line),
  );
  assert.ok(completedPiLine && idleRender.includes(completedPiLine), "idle pane uses the completed Pi reference frame");
  assert.match(pane.render(80).join("\n"), /idle/);
  assert.match(pane.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /[▀▄█]/u);

  await command.handler("pane off", ctx);
  assert.equal(calls.widgets.at(-1).key, "pi-coin-pane");
  assert.equal(calls.widgets.at(-1).value, undefined);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { paneEnabled: false });

  await command.handler("pane on", ctx);
  assert.equal(typeof calls.widgets.at(-1).value, "function");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { paneEnabled: true });

  await command.handler("pane toggle", ctx);
  assert.equal(calls.widgets.at(-1).value, undefined);
  await command.handler("pane status", ctx);
  assert.match(calls.notifications.at(-1).message, /disabled/);
  assert.match(calls.notifications.at(-1).message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("mint pane preserves source row coordinates and applies jam nudge to the whole frame", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const pane = harness.calls.widgets.at(-1).value(harness.tui, plainTheme);
  const width = 80;
  const variant = MINTING_PANE_ART.wide;

  assert.deepEqual(
    extractPaneArtRows(pane.render(width), width, variant),
    paddedGeneratedRows(variant.idle, variant.columns),
    "idle rows retain their generated x-coordinates and gain padding only on the right",
  );

  await harness.handlers.get("agent_start")({}, harness.ctx);
  const workingFrame = variant.frames[0];
  await harness.handlers.get("tool_execution_end")({ isError: false }, harness.ctx);
  const successRender = pane.render(width);
  assert.deepEqual(
    extractPaneArtRows(successRender, width, variant),
    paddedGeneratedRows(workingFrame, variant.columns),
    "success spark does not displace source pixels",
  );
  assert.match(successRender.join("\n"), /✦ tool minted/u);

  await harness.handlers.get("tool_execution_end")({ isError: true }, harness.ctx);
  assert.deepEqual(
    extractPaneArtRows(pane.render(width), width, variant),
    paddedGeneratedRows(workingFrame, variant.columns, 1),
    "jam shifts every source row by the same clipped one-column offset",
  );
});

test("same-state pane commands preserve active UI and avoid duplicate widgets", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const pane = harness.calls.widgets.at(-1).value(harness.tui, plainTheme);
  await harness.handlers.get("agent_start")({}, harness.ctx);
  t.mock.timers.tick(120);
  const activeFrame = pane.render(80).join("\n");
  const widgetCalls = harness.calls.widgets.length;

  await harness.commands.get("picoin").handler("pane on", harness.ctx);
  assert.match(pane.render(80).join("\n"), /π minting/);
  assert.equal(pane.render(80).join("\n"), activeFrame);
  assert.equal(harness.calls.widgets.length, widgetCalls);

  await harness.handlers.get("agent_settled")({}, harness.ctx);
  t.mock.timers.tick(120);
  const completionFrame = pane.render(80).join("\n");
  await harness.commands.get("picoin").handler("pane on", harness.ctx);
  assert.equal(pane.render(80).join("\n"), completionFrame, "same-state on preserves completion");
  assert.equal(harness.calls.widgets.length, widgetCalls);

  await harness.commands.get("picoin").handler("pane off", harness.ctx);
  const callsAfterOff = harness.calls.widgets.length;
  await harness.commands.get("picoin").handler("pane off", harness.ctx);
  assert.equal(harness.calls.widgets.length, callsAfterOff);
});

test("enabling the pane while the agent is busy starts minting without duplicate widgets", async () => {
  const harness = createHarness();
  await mkdir(join(harness.configPath, ".."), { recursive: true });
  await writeFile(harness.configPath, JSON.stringify({ paneEnabled: false }), "utf8");
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  harness.setIdle(false);

  await harness.commands.get("picoin").handler("pane on", harness.ctx);
  const installed = harness.calls.widgets.at(-1);
  const pane = installed.value(harness.tui, plainTheme);
  assert.match(pane.render(80).join("\n"), /π minting/);

  const widgetCalls = harness.calls.widgets.length;
  await harness.commands.get("picoin").handler("pane on", harness.ctx);
  assert.equal(harness.calls.widgets.length, widgetCalls);
  await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);

  const fallback = createHarness();
  await mkdir(join(fallback.configPath, ".."), { recursive: true });
  await writeFile(fallback.configPath, JSON.stringify({ paneEnabled: false }), "utf8");
  delete fallback.ctx.isIdle;
  await fallback.handlers.get("session_start")({ reason: "startup" }, fallback.ctx);
  await fallback.handlers.get("agent_start")({}, fallback.ctx);
  await fallback.commands.get("picoin").handler("pane on", fallback.ctx);
  const fallbackPane = fallback.calls.widgets.at(-1).value(fallback.tui, plainTheme);
  assert.match(fallbackPane.render(80).join("\n"), /π minting/, "agent events provide a safe isIdle fallback");
  await fallback.handlers.get("session_shutdown")({ reason: "quit" }, fallback.ctx);
});

test("pane config disables startup and malformed config falls back once", async () => {
  const disabled = createHarness();
  await mkdir(join(disabled.configPath, ".."), { recursive: true });
  await writeFile(disabled.configPath, JSON.stringify({ paneEnabled: false }), "utf8");
  await disabled.handlers.get("session_start")({ reason: "startup" }, disabled.ctx);
  assert.equal(disabled.calls.widgets.at(-1)?.value, undefined);

  const malformed = createHarness();
  await mkdir(join(malformed.configPath, ".."), { recursive: true });
  await writeFile(malformed.configPath, "{broken", "utf8");
  await malformed.handlers.get("session_start")({ reason: "startup" }, malformed.ctx);
  await malformed.handlers.get("session_start")({ reason: "reload" }, malformed.ctx);
  assert.equal(typeof malformed.calls.widgets.at(-1).value, "function");
  assert.equal(malformed.calls.notifications.filter(({ level }) => level === "warning").length, 1);
});

test("mint pane loops, pulses for tools, completes once, and returns idle", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { handlers, calls, ctx, tui } = createHarness();
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const pane = calls.widgets.at(-1).value(tui, plainTheme);

  const idle = pane.render(80).join("\n");
  await handlers.get("agent_start")({}, ctx);
  const working0 = pane.render(80).join("\n");
  assert.match(working0, /π minting/);
  assert.notEqual(working0, idle);
  t.mock.timers.tick(120);
  assert.notEqual(pane.render(80).join("\n"), working0, "working loop advances");

  await handlers.get("tool_execution_end")({ isError: false }, ctx);
  assert.match(pane.render(80).join("\n"), /tool minted/);
  assert.match(pane.render(80).join("\n"), /✦/, "success pulse keeps a visible spark in the status");
  t.mock.timers.tick(200);
  assert.match(pane.render(80).join("\n"), /π minting/);

  await handlers.get("tool_execution_end")({ isError: false }, ctx);
  await handlers.get("tool_execution_end")({ isError: true }, ctx);
  assert.match(pane.render(80).join("\n"), /jam/);
  assert.match(pane.render(80).join("\n"), /\x1b\[38;2;239;92;92m┌/u, "error pulse uses a red pane border");
  t.mock.timers.tick(200);
  assert.match(pane.render(80).join("\n"), /jam/, "newer error pulse supersedes success timer");
  t.mock.timers.tick(150);
  assert.match(pane.render(80).join("\n"), /π minting/);

  await handlers.get("agent_settled")({}, ctx);
  const completionStart = pane.render(80).join("\n");
  assert.match(completionStart, /complete/);
  await handlers.get("tool_execution_end")({ isError: true }, ctx);
  assert.equal(pane.render(80).join("\n"), completionStart, "completion ignores late tool pulses");
  const completionFrames = [completionStart];
  for (let index = 0; index < 3; index += 1) {
    t.mock.timers.tick(120);
    completionFrames.push(pane.render(80).join("\n"));
  }
  assert.equal(new Set(completionFrames).size, 4, "completion plays frames 08..11 exactly once");
  t.mock.timers.tick(120);
  t.mock.timers.tick(501);
  assert.match(pane.render(80).join("\n"), /idle/);
  assert.equal(pane.render(80).join("\n"), idle);
});

test("duplicate lifecycle events do not restart animations and a new start cancels completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const pane = harness.calls.widgets.at(-1).value(harness.tui, plainTheme);

  await harness.handlers.get("agent_start")({}, harness.ctx);
  t.mock.timers.tick(120);
  const advancedMintFrame = pane.render(80).join("\n");
  await harness.handlers.get("agent_start")({}, harness.ctx);
  assert.equal(pane.render(80).join("\n"), advancedMintFrame, "duplicate start preserves the mint loop");

  await harness.handlers.get("agent_settled")({}, harness.ctx);
  t.mock.timers.tick(120);
  const advancedCompletionFrame = pane.render(80).join("\n");
  await harness.handlers.get("agent_settled")({}, harness.ctx);
  assert.equal(pane.render(80).join("\n"), advancedCompletionFrame, "duplicate settled preserves completion");

  await harness.handlers.get("agent_start")({}, harness.ctx);
  assert.match(pane.render(80).join("\n"), /π minting/);
  t.mock.timers.tick(1_000);
  assert.match(pane.render(80).join("\n"), /π minting/, "stale completion timers were cancelled");
});

test("rapid concurrent pane commands persist the last requested state", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  const command = harness.commands.get("picoin");
  const requests = ["pane off", "pane on", "pane off", "pane on", "pane off"];

  await Promise.all(requests.map((request) => command.handler(request, harness.ctx)));

  assert.deepEqual(JSON.parse(await readFile(harness.configPath, "utf8")), { paneEnabled: false });
  assert.equal(harness.calls.notifications.some(({ level }) => level === "error"), false);
});

test("save failure keeps the runtime state changed and reports the unsaved config", async () => {
  const root = join(tmpdir(), `pi-network-theme-save-failure-${process.pid}-${++harnessId}`);
  await mkdir(root, { recursive: true });
  const configDirectory = join(root, "config.json");
  await mkdir(configDirectory);
  const harness = createHarness("tui", configDirectory);
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

  await assert.doesNotReject(harness.commands.get("picoin").handler("pane off", harness.ctx));
  assert.equal(harness.calls.widgets.at(-1).value, undefined, "runtime remains disabled after save failure");
  assert.match(harness.calls.notifications.at(-1).message, /changed, but config could not be saved/);
  assert.equal(harness.calls.notifications.at(-1).level, "error");
  assert.deepEqual(await readdir(root), ["config.json"], "failed atomic save cleans up its temporary file");
});

test("command off and shutdown dispose pane animation timers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const harness = createHarness();
  await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  harness.calls.widgets.at(-1).value(harness.tui, plainTheme);
  await harness.handlers.get("agent_start")({}, harness.ctx);
  t.mock.timers.tick(120);

  await harness.commands.get("picoin").handler("pane off", harness.ctx);
  const rendersAfterOff = harness.calls.renders;
  t.mock.timers.tick(1_000);
  assert.equal(harness.calls.renders, rendersAfterOff);
  assert.equal(harness.calls.widgets.at(-1).value, undefined);

  await harness.commands.get("picoin").handler("pane on", harness.ctx);
  harness.calls.widgets.at(-1).value(harness.tui, plainTheme);
  await harness.handlers.get("agent_start")({}, harness.ctx);
  await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
  const rendersAfterShutdown = harness.calls.renders;
  t.mock.timers.tick(1_000);
  assert.equal(harness.calls.renders, rendersAfterShutdown);
  assert.equal(harness.calls.widgets.at(-1).value, undefined);
  assert.equal(harness.calls.statuses.at(-1).value, undefined);
});

test("Pi coin startup animation runs once and holds its final frame", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { handlers, calls, ctx, tui } = createHarness();
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const component = calls.headers[0](tui, plainTheme);

  const entrance = component.render(120).join("\n");
  t.mock.timers.tick(1_320);
  const final = component.render(120).join("\n");
  const rendersAtFinal = calls.renders;
  t.mock.timers.tick(1_000);

  assert.notEqual(entrance, final);
  assert.equal(component.render(120).join("\n"), final);
  assert.equal(calls.renders, rendersAtFinal, "the animation interval stops at the final frame");
  component.dispose();
});

test("disposing the header cancels its startup icon timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { handlers, calls, ctx, tui } = createHarness();
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const component = calls.headers[0](tui, plainTheme);

  component.dispose();
  t.mock.timers.tick(1_000);

  assert.equal(calls.renders, 0);
});

test("shutdown restores defaults only after this instance installed them", async () => {
  const active = createHarness();
  await active.handlers.get("session_start")({ reason: "startup" }, active.ctx);
  await active.handlers.get("session_shutdown")({ reason: "reload" }, active.ctx);
  assert.equal(active.calls.headers.at(-1), undefined);
  assert.equal(active.calls.indicators.at(-1), undefined);

  const inactive = createHarness("print");
  await inactive.handlers.get("session_start")({ reason: "startup" }, inactive.ctx);
  await inactive.handlers.get("session_shutdown")({ reason: "quit" }, inactive.ctx);
  assert.equal(inactive.calls.headers.length, 0);
  assert.equal(inactive.calls.indicators.length, 0);
});
