const fs = require("fs");
const http = require("http");
const path = require("path");
const puppeteer = require("puppeteer");

const rootDir = __dirname;
const outDir = path.join(rootDir, "results");
const cfgPath = path.join(rootDir, "cap-local-config.json");
const chromePath = process.env.BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const WASM_URL = `${cfg.baseUrl}/assets/cap_wasm_bg.wasm`;

function mkstamp() {
    return new Date().toISOString().replace(/[.:]/g, "-");
}

function buildHtml(endpoint) {
    return `<!doctype html>
<html><head><meta charset="UTF-8"></head><body>
<script>window.CAP_CUSTOM_WASM_URL = ${JSON.stringify(WASM_URL)};</script>
<script src=${JSON.stringify(cfg.widgetScriptUrl)}></script>
<script>
window.addEventListener('load', async function () {
  var capErr = null;
  try {
    var cap = new window.Cap({ apiEndpoint: ${JSON.stringify(endpoint)} });
    if (cap.widget) document.body.appendChild(cap.widget);
    cap.addEventListener('error', function (e) { capErr = e.detail || {}; });
    var result = await cap.solve();
    if (result && result.success) {
      document.body.dataset.result = JSON.stringify(result);
    } else {
      document.body.dataset.result = JSON.stringify({ blocked: true, capError: capErr });
    }
  } catch (e) {
    document.body.dataset.result = JSON.stringify({ error: e.message, capError: capErr });
  }
  document.body.dataset.done = 'true';
});
</script>
</body></html>`;
}

function servePage(endpoint) {
    const html = buildHtml(endpoint);
    return new Promise((resolve, reject) => {
        const srv = http.createServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        });
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            resolve({ server: srv, url: `http://127.0.0.1:${srv.address().port}/` });
        });
    });
}

function closeSrv(srv) {
    return new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

async function verify(token) {
    if (!token) return null;
    const r = await fetch(`${cfg.baseUrl}/${cfg.siteKey}/siteverify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: cfg.secretKey, response: token }),
    });
    return r.json();
}

async function main() {
    const endpoint = `${cfg.baseUrl}/${cfg.siteKey}/`;
    const { server, url } = await servePage(endpoint);
    const startedAt = new Date().toISOString();

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: chromePath,
        args: ["--no-first-run", "--no-default-browser-check"],
    });

    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.body.dataset.done === "true", { timeout: 120_000 });
        const raw = await page.evaluate(() => document.body.dataset.result);
        const solve = JSON.parse(raw);

        const vr = await verify(solve?.token ?? null).catch(() => null);
        const blocked = solve?.blocked === true;
        const success = vr?.success === true;

        const result = {
            framework: "puppeteer",
            mode: "headless",
            success,
            blocked,
            solve,
            verification: vr,
            startedAt,
            finishedAt: new Date().toISOString(),
        };

        if (success) {
            console.log(`PASS`);
        } else if (blocked) {
            console.log(`BLOCKED`);
        } else {
            console.log(`FAIL — ${solve?.error ?? "no token"}`);
        }

        fs.mkdirSync(outDir, { recursive: true });
        const stamp = mkstamp();
        const json = JSON.stringify(result, null, 2);
        const latestPath = path.join(outDir, "cap-live-latest.json");
        const stampedPath = path.join(outDir, `cap-live-${stamp}.json`);
        fs.writeFileSync(latestPath, json);
        fs.writeFileSync(stampedPath, json);
        console.log(`saved ${stampedPath}`);
    } finally {
        await browser.close();
        await closeSrv(server);
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});