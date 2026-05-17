"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

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

let _wasm = null;
let _tried = false;

function getWasm() {
    if (_tried) return _wasm;
    _tried = true;
    try {
        _wasm = require(path.join(__dirname, "cap-source/wasm/src/node/cap_wasm.js"));
    } catch { }
    return _wasm;
}

function bruteForce(salt, target) {
    for (let n = 0; ; n++) {
        const h = crypto.createHash("sha256").update(salt + n).digest("hex");
        if (h.startsWith(target)) return n;
    }
}

function solveOne(salt, target) {
    const w = getWasm();
    if (w) {
        try { return Number(w.solve_pow(salt, target)); } catch { }
    }
    return bruteForce(salt, target);
}

function computeSolutions(token, challenge) {
    const { c, s, d } = challenge;
    const out = [];
    for (let i = 1; i <= c; i++) {
        out.push(solveOne(prng(token + i, s), prng(token + i + "d", d)));
    }
    return out;
}

async function getChallenge(baseUrl, siteKey) {
    const r = await fetch(`${baseUrl}/${siteKey}/challenge`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        },
        body: "{}",
    });
    if (!r.ok) throw new Error(`/challenge returned ${r.status}: ${await r.text()}`);
    return r.json();
}

async function redeemChallenge(baseUrl, siteKey, token, solutions, extras) {
    const body = { token, solutions, ...extras };
    const r = await fetch(`${baseUrl}/${siteKey}/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`/redeem returned ${r.status}: ${JSON.stringify(json)}`);
    return json;
}

async function siteverify(baseUrl, siteKey, secretKey, capToken) {
    const r = await fetch(`${baseUrl}/${siteKey}/siteverify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: secretKey, response: capToken }),
    });
    return r.json();
}

async function adminLogin(baseUrl, adminKey) {
    const r = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin_key: adminKey }),
    });
    if (!r.ok) throw new Error(`Admin login failed: ${r.status}`);
    const data = await r.json();
    if (!data.success) throw new Error("Admin login failed: " + JSON.stringify(data));
    return Buffer.from(
        JSON.stringify({ token: data.session_token, hash: data.hashed_token }),
    ).toString("base64");
}

async function createKey(baseUrl, bearerToken, opts) {
    const r = await fetch(`${baseUrl}/server/keys`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify(opts),
    });
    if (!r.ok) throw new Error(`Create key failed: ${r.status}: ${await r.text()}`);
    return r.json();
}

async function solveNodeless(baseUrl, siteKey, secretKey) {
    const t0 = Date.now();
    const chResp = await getChallenge(baseUrl, siteKey);
    if (chResp.error) throw new Error("Challenge error: " + chResp.error);
    const { token, challenge } = chResp;
    const t1 = Date.now();
    const solutions = computeSolutions(token, challenge);
    const t2 = Date.now();
    const rdResp = await redeemChallenge(baseUrl, siteKey, token, solutions);
    if (!rdResp.success) throw new Error("Redeem failed: " + JSON.stringify(rdResp));
    const t3 = Date.now();
    const verification = await siteverify(baseUrl, siteKey, secretKey, rdResp.token);
    const t4 = Date.now();
    return {
        success: verification.success === true,
        capToken: rdResp.token,
        verification,
        challenges: challenge.c,
        difficulty: challenge.d,
        saltSize: challenge.s,
        timings: {
            challengeMs: t1 - t0,
            solveMs: t2 - t1,
            redeemMs: t3 - t2,
            verifyMs: t4 - t3,
            totalMs: t4 - t0,
        },
    };
}

module.exports = {
    fnv1a,
    prng,
    getWasm,
    solveOne,
    solveOnePure: bruteForce,
    computeSolutions,
    getChallenge,
    redeemChallenge,
    siteverify,
    adminLogin,
    createKey,
    solveNodeless,
};
