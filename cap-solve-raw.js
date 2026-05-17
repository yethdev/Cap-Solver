"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const NOAUTH_PATH = path.join(ROOT, "cap-noauth-config.json");
const LOCAL_PATH = path.join(ROOT, "cap-local-config.json");

function fnv1a(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return h >>> 0;
}

function prng(seed, len) {
    let st = fnv1a(seed);
    let buf = "";
    while (buf.length < len) {
        st ^= st << 13;
        st ^= st >>> 17;
        st ^= st << 5;
        st >>>= 0;
        buf += st.toString(16).padStart(8, "0");
    }
    return buf.slice(0, len);
}

function tryNonce(salt, target) {
    for (let n = 0; ; n++) {
        const h = crypto.createHash("sha256").update(salt + n).digest("hex");
        if (h.startsWith(target)) return n;
    }
}

async function getKey() {
    if (fs.existsSync(NOAUTH_PATH)) {
        const conf = JSON.parse(fs.readFileSync(NOAUTH_PATH, "utf8"));
        const r = await fetch(`${conf.baseUrl}/${conf.siteKey}/challenge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        }).catch(() => null);
        if (r && r.status !== 404) return conf;
    }

    if (!fs.existsSync(LOCAL_PATH)) {
        throw new Error("cap-local-config.json not found. Run: npm run cap-setup first.");
    }

    const base = JSON.parse(fs.readFileSync(LOCAL_PATH, "utf8"));
    console.log("creating key...");

    const loginResp = await fetch(`${base.baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin_key: base.adminKey }),
    }).then((r) => r.json());
    if (!loginResp.success) throw new Error("Admin login failed");

    const bearer = Buffer.from(
        JSON.stringify({ token: loginResp.session_token, hash: loginResp.hashed_token }),
    ).toString("base64");

    const keyResp = await fetch(`${base.baseUrl}/server/keys`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
            name: "Raw Node Solver",
            instrumentation: false,
            blockAutomatedBrowsers: false,
        }),
    }).then((r) => r.json());

    const conf = {
        baseUrl: base.baseUrl,
        siteKey: keyResp.siteKey,
        secretKey: keyResp.secretKey,
    };
    fs.writeFileSync(NOAUTH_PATH, JSON.stringify(conf, null, 2));
    console.log(`key ${conf.siteKey} ok\n`);
    return conf;
}

async function solve(conf) {
    const { baseUrl, siteKey, secretKey } = conf;

    const t0 = Date.now();
    const chResp = await fetch(`${baseUrl}/${siteKey}/challenge`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        body: "{}",
    }).then((r) => r.json());

    if (chResp.error) throw new Error("Challenge error: " + chResp.error);

    const { token, challenge: { c, s, d } } = chResp;
    console.log(`challenge: ${c}×d${d} s${s}`);

    const t1 = Date.now();
    const solutions = [];
    for (let i = 1; i <= c; i++) {
        solutions.push(tryNonce(prng(token + i, s), prng(token + i + "d", d)));
        if (i % 10 === 0) process.stdout.write(`  Solved ${i}/${c}\r`);
    }
    const t2 = Date.now();
    process.stdout.write(`  Solved ${c}/${c}\n`);
    console.log(`solved in ${t2 - t1}ms`);

    const rdResp = await fetch(`${baseUrl}/${siteKey}/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, solutions }),
    }).then((r) => r.json());

    if (!rdResp.success) throw new Error("Redeem failed: " + JSON.stringify(rdResp));
    const t3 = Date.now();
    console.log(`redeemed: ${rdResp.token}`);

    const vrResp = await fetch(`${baseUrl}/${siteKey}/siteverify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: secretKey, response: rdResp.token }),
    }).then((r) => r.json());
    const t4 = Date.now();

    console.log(`\nverify: ${vrResp.success ? "ok ✓" : "fail ✗"}`);
    console.log(`timing: challenge=${t1 - t0}ms solve=${t2 - t1}ms redeem=${t3 - t2}ms verify=${t4 - t3}ms total=${t4 - t0}ms`);

    return vrResp.success;
}

(async () => {
    console.log("cap-solve-raw\n");
    const conf = await getKey();
    console.log(`${conf.siteKey} @ ${conf.baseUrl}\n`);
    const ok = await solve(conf);
    process.exitCode = ok ? 0 : 1;
})().catch((e) => {
    console.error("\nFatal:", e.message);
    process.exitCode = 1;
});
