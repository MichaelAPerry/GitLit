import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = path.join(os.tmpdir(), "gitlit-input-trust.html");

/**
 * A minimal page that exercises the same event surface the Composer uses.
 * The hook itself is TypeScript inside the Next bundle; what is verified here
 * is the browser behaviour it depends on — that real keystrokes and real
 * pastes arrive trusted, and script-driven insertion does not.
 */
const PAGE = `
<!doctype html><html><body>
<textarea id="editor"></textarea>
<script>
  window.observed = [];
  const editor = document.getElementById("editor");
  editor.addEventListener("keydown", (e) => window.observed.push({ kind: "keydown", trusted: e.isTrusted }));
  editor.addEventListener("paste", (e) => window.observed.push({ kind: "paste", trusted: e.isTrusted }));
  editor.addEventListener("beforeinput", (e) =>
    window.observed.push({ kind: "beforeinput", inputType: e.inputType, trusted: e.isTrusted }));
</script>
</body></html>`;

test.beforeAll(() => { fs.writeFileSync(fixture, PAGE); });

test("a real keystroke is trusted", async ({ page }) => {
  await page.goto(`file://${fixture}`);
  await page.locator("#editor").pressSequentially("The lighthouse", { delay: 5 });

  const observed = await page.evaluate(() => (window as never as { observed: { kind: string; trusted: boolean }[] }).observed);
  const keys = observed.filter((o) => o.kind === "keydown");
  expect(keys.length).toBeGreaterThan(5);
  expect(keys.every((k) => k.trusted)).toBe(true);
});

test("real typing reports inputType insertText, which jsdom cannot show", async ({ page }) => {
  await page.goto(`file://${fixture}`);
  await page.locator("#editor").pressSequentially("ab", { delay: 5 });

  const observed = await page.evaluate(() => (window as never as { observed: { kind: string; inputType?: string; trusted: boolean }[] }).observed);
  const inputs = observed.filter((o) => o.kind === "beforeinput");
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs[0]!.inputType).toBe("insertText");
  expect(inputs[0]!.trusted).toBe(true);
});

test("a real paste is trusted and reports insertFromPaste", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`file://${fixture}`);
  await page.evaluate(() => navigator.clipboard.writeText("Pasted prose from elsewhere."));
  await page.locator("#editor").focus();
  await page.keyboard.press("ControlOrMeta+V");

  const observed = await page.evaluate(() => (window as never as { observed: { kind: string; inputType?: string; trusted: boolean }[] }).observed);
  const paste = observed.find((o) => o.kind === "paste");
  expect(paste?.trusted).toBe(true);
  expect(observed.find((o) => o.inputType === "insertFromPaste")?.trusted).toBe(true);
});

test("SCRIPT-DRIVEN insertion is NOT trusted — the distinction the model relies on", async ({ page }) => {
  await page.goto(`file://${fixture}`);
  await page.evaluate(() => {
    const editor = document.getElementById("editor")!;
    editor.dispatchEvent(new InputEvent("beforeinput", {
      data: "injected by a script", inputType: "insertText", bubbles: true,
    }));
  });

  const observed = await page.evaluate(() => (window as never as { observed: { kind: string; trusted: boolean }[] }).observed);
  const injected = observed.find((o) => o.kind === "beforeinput");
  expect(injected).toBeDefined();
  expect(injected!.trusted).toBe(false);
});
