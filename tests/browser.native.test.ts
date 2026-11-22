import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, type App, type Page } from "@krate/app/driver";

let app: App;
let page: Page;

const home = 'button[aria-label="Home"]:not([disabled])';
const address = 'input[aria-label="Address"]';

before(async () => {
  app = await launch({ startTimeout: 180000, timeout: 30000 });
  page = app.page();
  await page.waitFor('a[href="/browser"]');
});

after(async () => {
  await app?.close();
});

test("the browser page opens a remote pane and follows its navigation", async () => {
  await page.click('a[href="/browser"]');
  await page.waitFor(home);
  const views = (await app.views()).map((v) => v.id);
  assert.equal(views.length, 2, "views: " + views.join(","));

  await page.fill(address, "example.com");
  await page.press("Enter", { selector: address });
  await page.waitFor(() => {
    const hint = document.querySelector(".field-hint.mono");
    return !!hint && !!hint.textContent && hint.textContent.includes("example.com");
  });
  assert.deepEqual(await page.errors(), []);
});

test("downloading from the browser page queues the current address", async () => {
  await page.waitFor(home);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent && b.textContent.trim() === "Download");
    if (button) (button as HTMLButtonElement).click();
  });
  await page.waitFor(() => [...document.querySelectorAll(".notice")].some((n) => !!n.textContent && n.textContent.includes("download queue")));
});

test("leaving the page removes the pane and returning opens a new one", async () => {
  await page.click('a[href="/library"]');
  await page.waitFor(() => location.pathname.includes("library"));
  await app.waitForViewCount(1);
  await page.click('a[href="/browser"]');
  await page.waitFor(home);
  await app.waitForViewCount(2);
  assert.equal(await page.count('.notice[data-tone="bad"]'), 0);
  assert.deepEqual(await page.errors(), []);
});
