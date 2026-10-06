// Drive the UI in plain Chromium with the JavaScript backend (what the Android app runs) and take screenshots.
//   node tools/web_driver.mjs OUT_DIR steps.json [width height]
// Steps: [{ "js": "...", "upload": ["samples/x.html"], "wait": ms, "shot": "name", "eval": "expr" }]
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch (_) {
  playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const [outDir, stepsFile, w = '412', h = '915'] = process.argv.slice(2);
const ROOT = resolve('flashcard_viewer/ui');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/ui\//, '/'));
  if (!p.startsWith(ROOT) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
mkdirSync(outDir, { recursive: true });

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const mobile = Number(w) < 800;
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
  colorScheme: process.env.SCHEME || 'light' });
const page = await ctx.newPage();
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`[js:${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${port}/ui/index.html`);
await page.waitForTimeout(2500);
const results = {};
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'));
for (const [i, st] of steps.entries()) {
  if (st.upload) {
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(st.js || "document.getElementById('fab-add').click()");
    await (await chooser).setFiles(st.upload);
  } else if (st.js) {
    try { await page.evaluate(st.js); } catch (e) { console.log(`[step ${i}] ${e.message}`); }
  }
  if (st.tap) await page.tap(st.tap).catch((e) => console.log(`[tap] ${e.message}`));
  await page.waitForTimeout(st.wait ?? 600);
  if (st.eval) results[st.shot || `step${i}`] = await page.evaluate(st.eval).catch((e) => 'ERR ' + e.message);
  if (st.shot) { await page.screenshot({ path: join(outDir, st.shot + '.png') }); console.log('shot', st.shot); }
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
await browser.close();
server.close();
