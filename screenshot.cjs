const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (m) => {
    console.log('[BROWSER]', m.type(), m.text());
  });

  const PORT = process.env.PORT || '8080';
  const URL = `http://localhost:${PORT}/`;

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SHOTS, '01-dropzone.png') });
  console.log('Saved 01-dropzone.png');

  // Build a colorful test image, save to disk, upload via the file input.
  const buf = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 600, 400);
    grad.addColorStop(0, '#FFB37A');
    grad.addColorStop(0.5, '#E26B58');
    grad.addColorStop(1, '#5B2A4C');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 56px sans-serif';
    ctx.fillText('Test Image', 30, 220);
    return new Promise((resolve) => {
      c.toBlob(async (blob) => {
        const buf = await blob.arrayBuffer();
        resolve(Array.from(new Uint8Array(buf)));
      }, 'image/png');
    });
  });
  const pngPath = path.join(SHOTS, 'test-image.png');
  fs.writeFileSync(pngPath, Buffer.from(buf));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(pngPath);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(SHOTS, '02-editor.png') });
  console.log('Saved 02-editor.png');

  // Open Crop modal.
  const cropBtn = page.locator('button').filter({ hasText: /^Crop$/i }).first();
  if (await cropBtn.count()) {
    await cropBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, '03-crop-modal.png') });
    console.log('Saved 03-crop-modal.png');

    // Click the 4:5 ratio button.
    const ratio45 = page.locator('button').filter({ hasText: /^4:5$/ }).first();
    if (await ratio45.count()) {
      await ratio45.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, '04-crop-4x5.png') });
      console.log('Saved 04-crop-4x5.png');
    }
    // Apply the crop.
    const applyBtn = page.locator('button').filter({ hasText: /^Apply$/i }).first();
    if (await applyBtn.count()) {
      await applyBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  // Open Export Profile menu.
  const profileBtn = page.locator('button').filter({ hasText: /Custom|Instagram/i }).first();
  if (await profileBtn.count()) {
    await profileBtn.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, '05-profile-menu.png') });
    console.log('Saved 05-profile-menu.png');

    // Pick Instagram Feed.
    const igFeed = page.locator('button[aria-pressed]').filter({ hasText: 'Instagram Feed' }).first();
    if (await igFeed.count()) {
      await igFeed.click();
      await page.waitForTimeout(800);
    }
    // Close the menu by pressing Escape.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, '06-profile-applied.png') });
    console.log('Saved 06-profile-applied.png');
  }

  // Click the export button (the primary download button).
  const downloadBtn = page.locator('button').filter({
    has: page.locator('svg.lucide-download'),
  }).first();
  // Fall back to locating by text "Export"
  const exportBtn = (await downloadBtn.count())
    ? downloadBtn
    : page.locator('button').filter({ hasText: /^Export$/i }).first();
  console.log('=== Clicking export ===');
  await exportBtn.click();
  // The receipt toast should appear within 1s. Screenshot immediately
  // after a 1.2s wait so the toast is on-screen.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, '07-receipt-toast.png') });
  console.log('Saved 07-receipt-toast.png');

  // Wait for IDB write + storage-bus round-trip so the
  // history popover shows the new record.
  await page.waitForTimeout(1200);
  // Snapshot the exports button before opening the popover to see if the
  // count badge updated (proves the IDB write + bus notify succeeded).
  const exportsCount = await page.locator('button:has(svg.lucide-history)').first().textContent();
  console.log('Exports button text:', JSON.stringify(exportsCount));
  // Click the View action in the receipt toast.
  const viewAction = page.locator('button').filter({ hasText: /^View$/ }).first();
  if (await viewAction.count()) {
    await viewAction.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, '08-history-open.png') });
    console.log('Saved 08-history-open.png');
  } else {
    // Fall back to clicking the Exports menu trigger directly.
    const exportsBtn = page.locator('button').filter({ hasText: /Exports/i }).first();
    if (await exportsBtn.count()) {
      await exportsBtn.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(SHOTS, '08-history-open.png') });
      console.log('Saved 08-history-open.png');
    }
  }

  await browser.close();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Screenshot run failed:', err);
  process.exit(1);
});
