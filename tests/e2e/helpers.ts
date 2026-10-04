import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Tile hosts are often unreachable in CI; serve flat placeholder tiles instead. */
export async function stubTiles(context: BrowserContext) {
  const tile = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${fill}"/></svg>`;
  await context.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ contentType: 'image/svg+xml', body: tile('#eef0f2') }));
  await context.route(/arcgisonline\.com/, (r) => r.fulfill({ contentType: 'image/svg+xml', body: tile('#4b5842') }));
}

export interface Session {
  context: BrowserContext;
  page: Page;
  name: string;
}

let counter = 0;

/** Registers a brand-new user in a fresh browser context and opens the map. */
export async function newUser(browser: Browser, base: string): Promise<Session> {
  const context = await browser.newContext();
  await stubTiles(context);
  const page = await context.newPage();
  const name = `${base}${Date.now().toString(36).slice(-4)}${counter++}`;
  await page.goto('/register');
  await page.fill('input[name=displayName]', name);
  await page.fill('input[name=email]', `${name.toLowerCase()}@e2e.local`);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[type=submit]');
  await page.waitForURL('**/map');
  await waitForLive(page);
  return { context, page, name };
}

export async function waitForLive(page: Page) {
  await expect(page.locator('.connection-pill')).toContainText('Live', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __snapland?: { controller: { engine: unknown } } };
    return Boolean(w.__snapland?.controller.engine);
  });
}

/** Map-relative click positions (fractions of the map container). */
export async function clickMap(page: Page, points: [number, number][], delayMs = 120) {
  const box = (await page.locator('.map-container').boundingBox())!;
  for (const [fx, fy] of points) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(delayMs);
  }
}

export async function drawAndSave(page: Page, name: string, points: [number, number][]) {
  await page.getByRole('button', { name: /Draw area/ }).click();
  await clickMap(page, points);
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog[open]')).toBeVisible();
  const estimate = await page.locator('dialog[open] .muted').first().textContent();
  await page.fill('dialog[open] input[name=name]', name);
  await page.click('dialog[open] button[type=submit]');
  await expect(page.locator('.area-title')).toContainText(name);
  return estimate ?? '';
}

/** Reads app state through the dev-only debug hook. */
export function state<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const s = window.__snapland.store.getState(); return (${fn})(s); })()`) as Promise<T>;
}

export async function areaByName(page: Page, name: string) {
  return state<{ id: string; version: number; name: string; areaSqKm: number; ring: [number, number][] } | null>(
    page,
    `(s) => { const a = [...s.areas.values()].find((x) => x.name === ${JSON.stringify(name)}); return a ? { id: a.id, version: a.version, name: a.name, areaSqKm: a.areaSqKm, ring: a.geometry.coordinates[0] } : null; }`,
  );
}
