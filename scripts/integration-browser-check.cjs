/* Optional end-to-end QA. Uses an existing Playwright installation via PLAYWRIGHT_MODULE. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Never load a developer's real server/.env into this temporary production fixture.
require('dotenv').config = () => ({ parsed: {} });

async function run() {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'groundwork-integration-'));
  Object.assign(process.env, {
    NODE_ENV: 'production', DATABASE_PROVIDER: 'sqlite', DATABASE_URL: '', SUPABASE_DB_URL: '', BIND_HOST: '127.0.0.1', MASTER_KEY: randomBytes(32).toString('base64'),
    GROUNDWORK_DATA_DIR: temporary, PAYMENTS_MODE: 'live', MAIL_PROVIDER: 'smtp',
    GROUNDWORK_SERVER_ROLE: 'authority', GROUNDWORK_AUTHORITY_GATEWAY_MODE: 'direct',
    NATIVE_WORKER_ENABLED: 'false', NATIVE_ISOLATION_ACKNOWLEDGED: 'false',
  });
  for (const name of ['DB_PATH', 'PREVIOUS_MASTER_KEY', 'GROUNDWORK_AUTHORITY_URL', 'GROUNDWORK_DEV_OTP', 'GROUNDWORK_SEED_DEMO', 'AI_API_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'MAIL_HOST', 'MAIL_USER', 'MAIL_PASS', 'RESEND_API_KEY']) delete process.env[name];
  const file = (relative) => pathToFileURL(path.join(root, relative)).href;
  const [{ app }, { db, now }, { hashPassword }] = await Promise.all([
    import(file('server/dist/index.js')), import(file('server/dist/db.js')), import(file('server/dist/crypto.js')),
  ]);
  const password = `Synthetic-${randomBytes(18).toString('hex')}-1`;
  const { salt, hash } = hashPassword(password);
  const time = now();
  await db.prepare('INSERT INTO users (id,email,username,email_verified,password_salt,password_hash,country,account_type,password_changed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('browser-qa-user', 'browser-qa@example.invalid', 'browser-qa', 1, salt, hash, 'IN', 'individual', time, time, time);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const out = path.join(root, 'artifacts');
  fs.mkdirSync(out, { recursive: true });
  const errors = [];
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !/401 \(Unauthorized\)/.test(message.text())) errors.push(message.text()); });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#preloader')?.hidden);
    await page.waitForFunction(() => document.querySelectorAll('.scene-shell.is-ready').length === 2);
    assert.equal(await page.locator('.scene-shell.is-ready').count(), 2);
    assert.equal(await page.locator('#root').count(), 0, 'Studio uses its own document');
    assert.equal(await page.locator('.project-card').count(), 8);
    await page.screenshot({ path: path.join(out, 'integrated-studio-desktop.png') });
    results.push('Production studio entry, two working Three.js scenes and eight projects');
    await page.locator('.header-contact').click();
    await page.waitForURL('**/login');
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    assert.equal(await page.locator('#hero-canvas').count(), 0, 'Studio styling/runtime do not leak into workspace document');
    await page.getByLabel('Email or username', { exact: true }).fill('browser-qa@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('**/dashboard');
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.screenshot({ path: path.join(out, 'integrated-dashboard.png') });
    results.push('Enter studio → protected redirect → real password sign-in → dashboard, using production session cookies');
    const project = await page.evaluate(async () => {
      const session = await fetch('/api/auth/me').then((response) => response.json());
      const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify({ name: 'Integration verification', projectType: 'house' }) });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(project.status, 201, project.body.error || 'Project should be created');
    await page.goto(`${base}/editor/${project.body.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('canvas').first().waitFor();
    await page.waitForFunction(() => document.body.textContent.includes('Integration verification')
      || [...document.querySelectorAll('input')].some((input) => input.value === 'Integration verification'));
    results.push('CSRF-protected project creation → direct editor URL → interactive model canvas');
    const workspace = page.locator('.cad-workspace');
    const canvas = workspace.locator('.cad-viewport > canvas');
    const focusCanvas = workspace.getByRole('button', { name: 'Focus canvas', exact: true });
    await canvas.waitFor();
    await focusCanvas.focus();
    await page.keyboard.press('r');
    assert.equal(await workspace.getAttribute('data-tool'), 'select', 'character shortcuts ignore the toolbar');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.matches('.cad-viewport > canvas'));
    assert.equal(await canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2;
    }), true, 'keyboard focus on the canvas has a visible outline');
    await page.keyboard.press('m');
    assert.equal(await workspace.getAttribute('data-tool'), 'move');
    assert.equal(await canvas.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('v');
    assert.equal(await workspace.getAttribute('data-tool'), 'select');

    await workspace.getByRole('button', { name: 'Toggle model explorer' }).click();
    await workspace.getByRole('button', { name: 'Create starter frame' }).click();
    const dimension = workspace.locator('button[data-cad-dimension="x"]');
    await dimension.waitFor();
    await dimension.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Exact operation measurement');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.matches('.cad-viewport > canvas'));
    results.push('CAD keyboard focus is visible, character shortcuts are canvas-only, and cancelling exact entry returns to the canvas');

    if (process.argv.includes('--cad-only')) {
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ checkedAt: new Date().toISOString(), browser: await browser.version(), results, errors }, null, 2));
      return;
    }

    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#preloader')?.hidden);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'integrated-studio-mobile.png') });
    await page.locator('#process').scrollIntoViewIfNeeded();
    await page.locator('.process-steps [data-stage="4"]').click();
    await page.waitForTimeout(100);
    const points = await page.locator('.process-hotspots button').evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }));
    for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
      assert(Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y) >= 40, 'Mobile model controls do not overlap');
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    results.push('Mobile studio and five independently tappable process hotspots');

    await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Sync Ready', exact: true }).click();
    await page.getByRole('button', { name: 'Prepare offline files', exact: true }).click();
    await page.getByText(/^(Prepared; reopen app|Verified cache ready)$/).waitFor({ timeout: 45000 });
    await page.close();
    const offlinePage = await context.newPage();
    offlinePage.on('pageerror', error => errors.push(error.message));
    await context.setOffline(true);
    await offlinePage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await offlinePage.locator('#hero-heading').waitFor();
    assert.equal(await offlinePage.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
    await offlinePage.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await offlinePage.locator('#root').waitFor();
    results.push('Verified service worker serves the matching studio and application documents offline');
    await context.setOffline(false);
    // Offline API failures are expected; page exceptions and CSP errors are not.
    const unexpected = errors.filter((message) => !/ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to fetch|network.*error|401 \(Unauthorized\)/i.test(message));
    assert.deepEqual(unexpected, []);
    const report = { checkedAt: new Date().toISOString(), browser: await browser.version(), results, errors: unexpected };
    fs.writeFileSync(path.join(out, 'integration-browser-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    const canonical = fs.realpathSync(temporary);
    assert(path.dirname(canonical).toLowerCase() === fs.realpathSync(os.tmpdir()).toLowerCase() && path.basename(canonical).startsWith('groundwork-integration-'));
    fs.rmSync(canonical, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
