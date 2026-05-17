"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { adminLogin, createKey, solveNodeless, getWasm } = require("./cap-solver-core");

const CFG_PATH = path.join(__dirname, "cap-local-config.json");
const NOAUTH_PATH = path.join(__dirname, "cap-noauth-config.json");
const RESULTS_DIR = path.join(__dirname, "results");


async function getNoAuthKey(base) {
    if (fs.existsSync(NOAUTH_PATH)) {
        const conf = JSON.parse(fs.readFileSync(NOAUTH_PATH, "utf8"));
        try {
            const r = await fetch(`${conf.baseUrl}/${conf.siteKey}/challenge`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            if (r.status !== 404) return conf;
        } catch {
            return conf;
        }
        console.log("no-auth key stale, recreating...");
        fs.unlinkSync(NOAUTH_PATH);
    }

    console.log("creating no-instr key...");
    const bearer = await adminLogin(base.baseUrl, base.adminKey);
    const key = await createKey(base.baseUrl, bearer, {
        name: "Node Solver (no instrumentation)",
        instrumentation: false,
        blockAutomatedBrowsers: false,
        difficulty: 4,
        challengeCount: 80,
    });

    const conf = { baseUrl: base.baseUrl, siteKey: key.siteKey, secretKey: key.secretKey };
    fs.writeFileSync(NOAUTH_PATH, JSON.stringify(conf, null, 2));
    console.log(`  created ${key.siteKey}\n`);
    return conf;
}


async function main() {
    const base = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    const conf = await getNoAuthKey(base);

    const wasm = getWasm();
    console.log(`wasm: ${wasm ? "on (SIMD SHA-256)" : "off"}`);
    console.log(`key: ${conf.siteKey} (no-instr)\n`);

    const N = 5;
    const results = [];

    for (let i = 1; i <= N; i++) {
        process.stdout.write(`  Run ${i}/${N}  `);
        try {
            const r = await solveNodeless(conf.baseUrl, conf.siteKey, conf.secretKey);
            const t = r.timings;
            const tag = r.success ? "PASS" : "FAIL";
            console.log(
                `${tag}  total=${t.totalMs}ms  ` +
                `(challenge=${t.challengeMs}ms  solve=${t.solveMs}ms  ` +
                `redeem=${t.redeemMs}ms  verify=${t.verifyMs}ms)  ` +
                `${r.challenges}×d${r.difficulty}`,
            );
            results.push({ run: i, ...r, error: null });
        } catch (e) {
            console.log(`ERROR  ${e.message}`);
            results.push({ run: i, success: false, error: e.message });
        }
    }

    const passed = results.filter((r) => r.success).length;
    const times = results.filter((r) => r.timings).map((r) => r.timings);
    if (times.length) {
        const avg = (k) => Math.round(times.reduce((a, t) => a + t[k], 0) / times.length);
        console.log(`\n${passed}/${N} passed  avg total=${avg("totalMs")}ms  avg solve=${avg("solveMs")}ms`);
    }

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const out = {
        tool: "cap-solve-node",
        timestamp: ts,
        key: conf.siteKey,
        wasmUsed: !!wasm,
        results,
    };
    const json = JSON.stringify(out, null, 2);
    const latestPath = path.join(RESULTS_DIR, "cap-node-latest.json");
    const stampPath = path.join(RESULTS_DIR, `cap-node-${ts.replace(/[.:]/g, "-")}.json`);
    fs.writeFileSync(latestPath, json);
    fs.writeFileSync(stampPath, json);
    console.log(`saved ${latestPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
