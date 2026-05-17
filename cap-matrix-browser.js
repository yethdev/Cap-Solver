"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "cap-local-config.json"), "utf8"),
);

const RESULTS_DIR = path.join(__dirname, "results");
const CHROME =
    process.env.BROWSER_PATH ||
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const WASM_URL = `${cfg.baseUrl}/assets/cap_wasm_bg.wasm`;

function buildHtml(apiEndpoint) {
    return `<!doctype html>
<html><head><meta charset="UTF-8"></head><body>
<script>window.CAP_CUSTOM_WASM_URL = ${JSON.stringify(WASM_URL)};</script>
<script src="${cfg.widgetScriptUrl}"></script>
<script>
window.addEventListener('load', async function () {
  var capErr = null;
  try {
    var cap = new window.Cap({ apiEndpoint: ${JSON.stringify(apiEndpoint)} });
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

function startServer(apiEndpoint) {
    return new Promise((resolve, reject) => {
        const html = buildHtml(apiEndpoint);
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
    return new Promise((res, rej) => srv.close((e) => (e ? rej(e) : res())));
}

async function verifyCap(token) {
    if (!token) return null;
    const r = await fetch(`${cfg.baseUrl}/${cfg.siteKey}/siteverify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: cfg.secretKey, response: token }),
    });
    return r.json();
}

async function runPwLike(pkgName, isHeadless, pageUrl) {
    const { chromium } = require(pkgName);
    const browser = await chromium.launch({
        headless: isHeadless,
        executablePath: CHROME,
        args: ["--no-first-run", "--no-default-browser-check"],
    });
    try {
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => document.body.dataset.done === "true",
            { timeout: 120_000 },
        );
        return JSON.parse(await page.evaluate(() => document.body.dataset.result));
    } finally {
        await browser.close();
    }
}

async function runPptr(isHeadless, pageUrl) {
    const pptr = require("puppeteer");
    const browser = await pptr.launch({
        headless: isHeadless,
        executablePath: CHROME,
        args: ["--no-first-run", "--no-default-browser-check"],
    });
    try {
        const page = await browser.newPage();
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => document.body.dataset.done === "true",
            { timeout: 120_000 },
        );
        return JSON.parse(await page.evaluate(() => document.body.dataset.result));
    } finally {
        await browser.close();
    }
}

async function runSel(isHeadless, pageUrl) {
    const { Builder } = require("selenium-webdriver");
    const chrome = require("selenium-webdriver/chrome");

    const opts = new chrome.Options().setBinaryPath(CHROME);
    if (isHeadless) {
        opts.addArguments("--headless=new");
    }

    const driver = await new Builder()
        .forBrowser("chrome")
        .setChromeOptions(opts)
        .build();

    try {
        await driver.get(pageUrl);
        await driver.wait(async () => {
            try {
                return await driver.executeScript(
                    "return document.body.dataset.done",
                ) === "true";
            } catch {
                return false;
            }
        }, 120_000);
        return JSON.parse(await driver.executeScript(
            "return document.body.dataset.result",
        ));
    } finally {
        await driver.quit();
    }
}

async function testCell(framework, mode, pageUrl) {
    const t0 = Date.now();
    const isHeadless = mode === "headless";
    let solve = null;
    let error = null;

    try {
        switch (framework) {
            case "playwright":
                solve = await runPwLike("playwright", isHeadless, pageUrl);
                break;
            case "patchright":
                solve = await runPwLike("patchright", isHeadless, pageUrl);
                break;
            case "puppeteer":
                solve = await runPptr(isHeadless, pageUrl);
                break;
            case "selenium":
                solve = await runSel(isHeadless, pageUrl);
                break;
        }
    } catch (e) {
        error = e.message;
    }

    const durationMs = Date.now() - t0;
    const token = solve?.token ?? null;
    const vr = await verifyCap(token).catch(() => null);

    return {
        framework,
        mode,
        success: vr?.success === true,
        blocked: solve?.blocked === true,
        solve,
        verification: vr,
        error,
        durationMs,
        finishedAt: new Date().toISOString(),
    };
}


const MATRIX = [
    { framework: "playwright", mode: "headless" },
    { framework: "playwright", mode: "headed" },
    { framework: "patchright", mode: "headless" },
    { framework: "patchright", mode: "headed" },
    { framework: "puppeteer", mode: "headless" },
    { framework: "puppeteer", mode: "headed" },
    { framework: "selenium", mode: "headless" },
    { framework: "selenium", mode: "headed" },
];


async function main() {
    const apiEndpoint = `${cfg.baseUrl}/${cfg.siteKey}/`;
    const { server, url: pageUrl } = await startServer(apiEndpoint);

    console.log(`page: ${pageUrl}`);
    console.log(`key: ${cfg.siteKey}\n`);

    const results = [];

    for (const { framework, mode } of MATRIX) {
        const label = `${framework}/${mode}`;
        process.stdout.write(`  ${label} ... `);

        const result = await testCell(framework, mode, pageUrl);
        results.push(result);

        let status;
        if (result.success) {
            status = `PASS (${result.durationMs}ms)`;
        } else if (result.blocked) {
            status = `BLOCKED (${result.durationMs}ms)`;
        } else if (result.error) {
            status = `ERROR: ${result.error}`;
        } else {
            status = `FAIL (${result.durationMs}ms)`;
        }
        console.log(status);
    }

    await stopServer(server);

    const passed = results.filter((r) => r.success).length;
    const blocked = results.filter((r) => r.blocked).length;
    const failed = results.filter((r) => !r.success && !r.blocked && !r.error).length;
    const errored = results.filter((r) => r.error).length;

    console.log(
        `\n${passed} passed, ${blocked} blocked, ${failed} failed, ${errored} errored`,
    );

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const out = {
        tool: "cap-matrix-browser",
        timestamp: ts,
        key: cfg.siteKey,
        instrumentation: true,
        blockAutomatedBrowsers: true,
        results,
    };
    const json = JSON.stringify(out, null, 2);
    const latestPath = path.join(RESULTS_DIR, "cap-matrix-browser-latest.json");
    const stampedPath = path.join(
        RESULTS_DIR,
        `cap-matrix-browser-${ts.replace(/[.:]/g, "-")}.json`,
    );
    fs.writeFileSync(latestPath, json);
    fs.writeFileSync(stampedPath, json);
    console.log(`\nsaved ${latestPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
