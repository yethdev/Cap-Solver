"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium: patchrightChromium } = require("patchright");
const { chromium: playwrightChromium } = require("playwright");
const puppeteer = require("puppeteer");
const { Builder } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cap-local-config.json"), "utf8"),
);

const OUT_DIR = path.join(__dirname, "results");
const ARGS = ["--no-first-run", "--no-default-browser-check"];
const BROWSERS = [
    process.env.BROWSER_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function buildHtml(apiEndpoint) {
    const wasmUrl = `${cfg.baseUrl}/assets/cap_wasm_bg.wasm`;
    return `<!doctype html>
<html><head><meta charset="UTF-8"></head><body>
<script>window.CAP_CUSTOM_WASM_URL = ${JSON.stringify(wasmUrl)};</script>
<script src=${JSON.stringify(cfg.widgetScriptUrl)}></script>
<script>
window.addEventListener('load', async function () {
  var capErr = null;
  try {
    var cap = new window.Cap({ apiEndpoint: ${JSON.stringify(apiEndpoint)} });
    if (cap.widget) document.body.appendChild(cap.widget);
    cap.addEventListener('error', function (e) { capErr = e.detail || {}; });
    var result = await cap.solve();
    var nav = {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver ?? null,
      language: navigator.language ?? null,
      languages: Array.from(navigator.languages ?? []),
      platform: navigator.platform ?? null,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
    };
    if (result && result.success) {
      document.body.dataset.result = JSON.stringify({ ...result, navigator: nav });
    } else {
      document.body.dataset.result = JSON.stringify({ blocked: true, capError: capErr, navigator: nav });
    }
  } catch (e) {
    var nav2 = { userAgent: navigator.userAgent, webdriver: navigator.webdriver ?? null, platform: navigator.platform ?? null };
    document.body.dataset.result = JSON.stringify({ error: e.message, capError: capErr, navigator: nav2 });
  }
  document.body.dataset.done = 'true';
});
</script>
</body></html>`;
}

function startServer(apiEndpoint) {
    const html = buildHtml(apiEndpoint);
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

function stopServer(srv) {
    return new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

function resolveBrowserPath() {
    for (const candidate of BROWSERS) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error("No Chrome or Edge executable found. Set BROWSER_PATH env var.");
}

function mkstamp() {
    return new Date().toISOString().replace(/[.:]/g, "-");
}

function errObj(err) {
    return {
        name: err?.name || "Error",
        message: err?.message || String(err),
        stack: err?.stack || null,
    };
}

async function siteverify(token) {
    if (!token) return null;
    const r = await fetch(`${cfg.baseUrl}/${cfg.siteKey}/siteverify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: cfg.secretKey, response: token }),
    });
    return r.json();
}

async function grabWithPw(chromium, browserPath, headless, pageUrl) {
    const browser = await chromium.launch({
        headless,
        executablePath: browserPath,
        args: ARGS,
    });
    try {
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
        if (!headless) await page.bringToFront();
        await page.waitForFunction(() => document.body.dataset.done === "true", { timeout: 120_000 });
        const raw = await page.evaluate(() => document.body.dataset.result);
        return JSON.parse(raw);
    } finally {
        await browser.close();
    }
}

async function grabPptr(browserPath, headless, pageUrl) {
    const browser = await puppeteer.launch({
        headless,
        executablePath: browserPath,
        args: ARGS,
    });
    try {
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
        if (!headless) await page.bringToFront();
        await page.waitForFunction(() => document.body.dataset.done === "true", { timeout: 120_000 });
        const raw = await page.evaluate(() => document.body.dataset.result);
        return JSON.parse(raw);
    } finally {
        await browser.close();
    }
}

async function grabSel(browserPath, headless, pageUrl) {
    const options = new chrome.Options();
    if (typeof options.setChromeBinaryPath === "function") {
        options.setChromeBinaryPath(browserPath);
    } else {
        options.setBinaryPath(browserPath);
    }
    options.addArguments(...ARGS);
    if (headless) options.addArguments("--headless=new");

    const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
    try {
        await driver.get(pageUrl);
        await driver.wait(
            async () => Boolean(await driver.executeScript("return document.body.dataset.done === 'true'")),
            120_000,
        );
        const raw = await driver.executeScript("return document.body.dataset.result");
        return JSON.parse(raw);
    } finally {
        await driver.quit();
    }
}

async function main() {
    const browserPath = resolveBrowserPath();
    const apiEndpoint = `${cfg.baseUrl}/${cfg.siteKey}/`;
    const { server, url: pageUrl } = await startServer(apiEndpoint);
    const startedAt = new Date().toISOString();

    console.log(`server: ${cfg.baseUrl}`);
    console.log(`key: ${cfg.siteKey}`);
    console.log(`page: ${pageUrl}\n`);

    const matrix = [
        { framework: "patchright", headless: true, run: (p) => grabWithPw(patchrightChromium, browserPath, true, p) },
        { framework: "patchright", headless: false, run: (p) => grabWithPw(patchrightChromium, browserPath, false, p) },
        { framework: "playwright", headless: true, run: (p) => grabWithPw(playwrightChromium, browserPath, true, p) },
        { framework: "playwright", headless: false, run: (p) => grabWithPw(playwrightChromium, browserPath, false, p) },
        { framework: "puppeteer", headless: true, run: (p) => grabPptr(browserPath, true, p) },
        { framework: "puppeteer", headless: false, run: (p) => grabPptr(browserPath, false, p) },
        { framework: "selenium", headless: true, run: (p) => grabSel(browserPath, true, p) },
        { framework: "selenium", headless: false, run: (p) => grabSel(browserPath, false, p) },
    ];

    const runs = [];

    for (const entry of matrix) {
        const mode = entry.headless ? "headless" : "headed";
        const runStartedAt = Date.now();
        console.log(`[${entry.framework}/${mode}] running`);

        let solve = null;
        let error = null;
        let verification = null;

        try {
            solve = await entry.run(pageUrl);
            verification = await siteverify(solve?.token ?? null).catch(() => null);
        } catch (err) {
            error = errObj(err);
        }

        const durationMs = Date.now() - runStartedAt;
        const blocked = solve?.blocked === true || solve?.instr_error === true;
        const success = verification?.success === true;

        runs.push({
            framework: entry.framework,
            mode,
            headless: entry.headless,
            success,
            blocked,
            durationMs,
            browserPath,
            solve,
            verification,
            error,
        });

        const label = `[${entry.framework}/${mode}]`;
        if (success) {
            console.log(`${label} PASS (${durationMs}ms)`);
        } else if (blocked) {
            console.log(`${label} BLOCKED (${durationMs}ms)`);
        } else if (error) {
            console.error(`${label} ERROR: ${error.message}`);
        } else {
            console.log(`${label} FAIL (${durationMs}ms)`);
        }
    }

    await stopServer(server);

    const payload = {
        capBaseUrl: cfg.baseUrl,
        siteKey: cfg.siteKey,
        browserPath,
        startedAt,
        completedAt: new Date().toISOString(),
        runs,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const latestPath = path.join(OUT_DIR, "traffic-detector-latest.json");
    const stampedPath = path.join(OUT_DIR, `traffic-detector-${mkstamp()}.json`);
    const json = JSON.stringify(payload, null, 2);

    fs.writeFileSync(latestPath, json);
    fs.writeFileSync(stampedPath, json);

    console.log(`\nsaved ${stampedPath}`);
    console.log(`updated ${latestPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});