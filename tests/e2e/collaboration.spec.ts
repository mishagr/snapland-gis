import { expect, test, type Page } from '@playwright/test';
import { areaByName, clickMap, drawAndSave, newUser, state, waitForLive } from './helpers';

/** Area names are unique per run so data from earlier runs can never be mistaken for ours. */
const run = Date.now().toString(36).slice(-5);
const n = (name: string) => `${name} ${run}`;

/** Every test works in its own random spot so data from other tests/runs rarely overlaps. */
function randomSpot(): [number, number] {
  return [34.85 + Math.random() * 0.5, 31.0 + Math.random() * 1.8];
}

async function goTo(page: Page, center: [number, number], resolution = 20) {
  await page.evaluate(
    ([c, r]) => (window as unknown as { __snapland: { controller: { engine: { setView(v: unknown): void } } } }).__snapland.controller.engine.setView({ center: c, resolution: r }),
    [center, resolution] as const,
  );
  await page.waitForTimeout(600); // viewport debounce + fetch
}

const quad: [number, number][] = [
  [0.4, 0.35],
  [0.6, 0.33],
  [0.62, 0.6],
  [0.42, 0.62],
];

test('register, draw an area with live geodesic area, save it', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const { page } = alice;
  await goTo(page, randomSpot());

  await page.getByRole('button', { name: /Draw area/ }).click();
  await clickMap(page, quad.slice(0, 3));
  await expect(page.locator('.live-area').first()).toContainText('3 pts');
  const live = await page.locator('.live-area').first().textContent();
  expect(live).toMatch(/(km²|m²)/);
  await clickMap(page, quad.slice(3));
  await page.keyboard.press('Enter');

  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('4 vertices');
  const estimate = (await dialog.locator('.muted').first().textContent())!;
  await dialog.locator('input[name=name]').fill(n('North field'));
  await dialog.locator('button[type=submit]').click();

  await expect(page.locator('.area-title')).toContainText(n('North field'));
  await expect(page.locator('.stats')).toContainText('You');
  const saved = await areaByName(page, n('North field'));
  // The server's PostGIS geography area equals the client's Karney estimate (same algorithm).
  expect(estimate).toMatch(/km²/);
  expect(Number.parseFloat(estimate.replace(/,/g, ''))).toBeCloseTo(saved!.areaSqKm, 2);
  await alice.context.close();
});

test('two users: presence, live sketch and saved areas appear without reload', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const bob = await newUser(browser, 'Bob');
  const spot = randomSpot();
  await goTo(alice.page, spot);
  await goTo(bob.page, spot);

  await expect(bob.page.locator('.presence-list')).toContainText(alice.name);
  await expect(alice.page.locator('.presence-list')).toContainText(bob.name);

  await alice.page.getByRole('button', { name: /Draw area/ }).click();
  await clickMap(alice.page, quad.slice(0, 3));
  await expect(bob.page.locator('.leaflet-tooltip.sketch-label')).toContainText(`${alice.name} is drawing`);
  await expect(bob.page.locator('.presence-list')).toContainText('drawing');

  await clickMap(alice.page, quad.slice(3));
  await alice.page.keyboard.press('Enter');
  await alice.page.fill('dialog[open] input[name=name]', n('Shared orchard'));
  await alice.page.click('dialog[open] button[type=submit]');

  await expect(bob.page.locator('.area-list')).toContainText(n('Shared orchard'));
  await expect(bob.page.locator('.leaflet-tooltip.sketch-label')).toHaveCount(0);
  await alice.context.close();
  await expect(bob.page.locator('.presence-list')).not.toContainText(alice.name);
  await bob.context.close();
});

test('switching to the ITM orthophoto layer re-projects without moving shapes, even mid-drawing', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const { page } = alice;
  await goTo(page, randomSpot(), 10);

  await page.getByRole('button', { name: /Draw area/ }).click();
  await clickMap(page, quad.slice(0, 2));
  // The first vertex as placed in Web Mercator, before the switch.
  const firstVertex = await state<[number, number]>(page, '(s) => s.ownSketch.points[0]');
  await page.selectOption('select[aria-label="Base layer"]', 'govmap-ortho');
  await expect(page.locator('img.leaflet-tile[src*="/api/dev/itm-tiles/"]').first()).toBeVisible();
  const crs = await page.evaluate(() => (window as unknown as { __snapland: { controller: { engine: { map: { options: { crs: { code: string } } } } } } }).__snapland.controller.engine.map.options.crs.code);
  expect(crs).toBe('EPSG:2039');
  await expect(page.locator('.live-area').first()).toContainText('2 pts'); // sketch survived the switch

  await clickMap(page, quad.slice(2));
  await page.keyboard.press('Enter');
  await page.fill('dialog[open] input[name=name]', n('Cross-projection'));
  await page.click('dialog[open] button[type=submit]');
  await expect(page.locator('.area-title')).toContainText(n('Cross-projection'));

  const saved = await areaByName(page, n('Cross-projection'));
  // Saved coordinates are rounded to 7 decimals (~1 cm).
  const first = saved!.ring.find((p) => Math.abs(p[0] - firstVertex[0]) < 1e-7 && Math.abs(p[1] - firstVertex[1]) < 1e-7);
  expect(first, 'vertex placed before the CRS switch keeps its exact ground position').toBeTruthy();

  // Rendered polygons are re-projected: cached pixel coordinates equal a fresh projection.
  const consistent = await page.evaluate(() => {
    const m = (window as unknown as { __snapland: { controller: { engine: { map: any } } } }).__snapland.controller.engine.map; // eslint-disable-line @typescript-eslint/no-explicit-any
    let ok = true;
    let checked = 0;
    m.eachLayer((l: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (l._rings?.[0]?.[0] && l.getLatLngs) {
        const p = m.latLngToLayerPoint(l.getLatLngs()[0][0]);
        ok &&= Math.abs(p.x - l._rings[0][0].x) < 1 && Math.abs(p.y - l._rings[0][0].y) < 1;
        checked++;
      }
    });
    return ok && checked > 0;
  });
  expect(consistent).toBe(true);

  await page.selectOption('select[aria-label="Base layer"]', 'osm');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __snapland: { controller: { engine: { map: { options: { crs: { code: string } } } } } } }).__snapland.controller.engine.map.options.crs.code)).toBe('EPSG:3857');
  await alice.context.close();
});

test('concurrent edits: the stale writer gets a conflict dialog and can re-apply on top', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const bob = await newUser(browser, 'Bob');
  const spot = randomSpot();
  await goTo(alice.page, spot);
  await goTo(bob.page, spot);
  await drawAndSave(alice.page, n('Contested plot'), quad);

  await bob.page.locator('.area-list').getByText(n('Contested plot')).click();
  await bob.page.getByRole('button', { name: 'Edit details' }).click();
  await alice.page.getByRole('button', { name: 'Edit details' }).click();

  await bob.page.fill('.details-form input[name=name]', n('Renamed by Bob'));
  await bob.page.click('.details-form button[type=submit]');
  await expect(bob.page.locator('.area-title')).toContainText(n('Renamed by Bob'));

  // Alice's form was opened on version 1; Bob saved version 2 meanwhile (her store
  // already shows it via WebSocket). Saving sends expectedVersion 1 → conflict.
  await alice.page.fill('.details-form input[name=name]', n('Renamed by Alice'));
  await alice.page.click('.details-form button[type=submit]');

  const dialog = alice.page.locator('dialog[open]');
  await expect(dialog).toContainText('Someone else changed this area');
  await expect(dialog).toContainText(n('Renamed by Bob'));
  await dialog.getByRole('button', { name: 'Apply my change on top' }).click();

  await expect(alice.page.locator('.area-title')).toContainText(n('Renamed by Alice'));
  await expect(bob.page.locator('.area-title')).toContainText(n('Renamed by Alice'));
  expect((await areaByName(bob.page, n('Renamed by Alice')))!.version).toBe(3);

  await bob.page.getByRole('button', { name: 'History' }).click();
  await expect(bob.page.locator('.history li')).toHaveCount(3);
  await alice.context.close();
  await bob.context.close();
});

test('only the owner can delete; deletion and undo propagate live', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const bob = await newUser(browser, 'Bob');
  const spot = randomSpot();
  await goTo(alice.page, spot);
  await goTo(bob.page, spot);
  await drawAndSave(alice.page, n('Owned by Alice'), quad);

  await bob.page.locator('.area-list').getByText(n('Owned by Alice')).click();
  await expect(bob.page.getByRole('button', { name: 'Edit shape' })).toBeVisible();
  await expect(bob.page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await bob.page.getByRole('button', { name: '← All areas' }).click();

  await alice.page.getByRole('button', { name: 'Delete' }).click();
  await alice.page.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(bob.page.locator('.area-list')).not.toContainText(n('Owned by Alice'));

  await alice.page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(bob.page.locator('.area-list')).toContainText(n('Owned by Alice'));
  await alice.context.close();
  await bob.context.close();
});

test('vertex editing updates the shape and its area', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const { page } = alice;
  await goTo(page, randomSpot());
  await drawAndSave(page, n('Editable'), quad);
  const before = (await areaByName(page, n('Editable')))!;

  await page.getByRole('button', { name: 'Edit shape' }).click();
  const handle = page.locator('.vertex-handle:not(.vertex-handle--mid)').first();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 60, hb.y - 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.edit-shape-box')).toContainText('New area');
  await page.getByRole('button', { name: 'Save shape' }).click();

  await expect.poll(async () => (await areaByName(page, n('Editable')))!.version).toBe(2);
  const after = (await areaByName(page, n('Editable')))!;
  expect(Math.abs(after.areaSqKm - before.areaSqKm)).toBeGreaterThan(0.01);
  await expect(page.locator('.stats')).toContainText('v2');
  await alice.context.close();
});

test('graceful degradation: polling keeps the map fresh while the WebSocket is down', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const bob = await newUser(browser, 'Bob');
  const spot = randomSpot();
  await goTo(alice.page, spot);
  await goTo(bob.page, spot);

  // Break Alice's socket and keep it broken.
  await alice.page.evaluate(() => {
    const rt = (window as unknown as { __snapland: { controller: { deps: { realtime: { opts: { url?: string }; ws: WebSocket | null } } } } }).__snapland.controller.deps.realtime;
    rt.opts.url = 'ws://127.0.0.1:9/ws';
    rt.ws?.close();
  });
  await expect(alice.page.locator('.connection-banner')).toBeVisible();
  await expect(alice.page.locator('.connection-pill')).toContainText('polling', { timeout: 15_000 });

  await drawAndSave(bob.page, n('Seen via polling'), quad);
  await bob.page.getByRole('button', { name: '← All areas' }).click();
  await expect(alice.page.locator('.area-list')).toContainText(n('Seen via polling'), { timeout: 30_000 });

  // Alice can still write over REST while offline.
  await drawAndSave(alice.page, n('Written offline'), [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3]]);
  await expect(bob.page.locator('.area-list')).toContainText(n('Written offline'));

  // Restore the socket: back to live, polling stops.
  await alice.page.evaluate(() => {
    const rt = (window as unknown as { __snapland: { controller: { deps: { realtime: { opts: { url?: string } } } } } }).__snapland.controller.deps.realtime;
    rt.opts.url = undefined;
  });
  await waitForLive(alice.page);
  await expect(alice.page.locator('.connection-banner')).toHaveCount(0);
  await alice.context.close();
  await bob.context.close();
});

test('govmap engine (mock): switch engines, draw with govmap, state carries over', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice');
  const { page } = alice;
  await goTo(page, randomSpot(), 13);
  await drawAndSave(page, n('Before switch'), quad);
  await page.getByRole('button', { name: '← All areas' }).click();

  await page.getByRole('radio', { name: /govmap/ }).click();
  const svg = page.locator('[data-testid=mock-govmap]');
  await expect(svg).toBeVisible();
  await expect(svg.locator('path[data-name^="area-"]').first()).toBeAttached();

  await page.getByRole('button', { name: /Draw area/ }).click();
  const box = (await svg.boundingBox())!;
  for (const [fx, fy] of [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3]] as const) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(350);
  }
  await expect(page.locator('.live-area').first()).toContainText('3 pts');
  await page.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await expect(page.locator('dialog[open]')).toBeVisible();
  await page.fill('dialog[open] input[name=name]', n('Drawn on govmap'));
  await page.click('dialog[open] button[type=submit]');
  await expect(page.locator('.area-title')).toContainText(n('Drawn on govmap'));
  expect((await areaByName(page, n('Drawn on govmap')))!.ring).toHaveLength(5);

  await page.getByRole('radio', { name: 'OpenStreetMap' }).click();
  await expect(page.locator('.leaflet-container')).toBeVisible();
  const names = JSON.stringify([n('Drawn on govmap'), n('Before switch')]);
  expect(await state<number>(page, `(s) => [...s.areas.values()].filter((a) => ${names}.includes(a.name)).length`)).toBe(2);
  await alice.context.close();
});
