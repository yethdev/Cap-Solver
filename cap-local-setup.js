const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const rootDir = __dirname;
const composePath = path.join(rootDir, "docker-compose.cap.yml");
const envPath = path.join(rootDir, ".env.cap");
const configPath = path.join(rootDir, "cap-local-config.json");
const base = "http://localhost:3010";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function loadOrCreateEnv() {
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
        const entry = lines.find((l) => l.startsWith("CAP_ADMIN_KEY="));
        if (entry) return entry.slice("CAP_ADMIN_KEY=".length);
    }
    const k = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(envPath, `CAP_ADMIN_KEY=${k}\n`);
    return k;
}

function startStack() {
    execFileSync("docker", ["compose", "--env-file", envPath, "-f", composePath, "up", "-d"], {
        cwd: rootDir,
        stdio: "inherit",
    });
}

async function waitReady() {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(base, { redirect: "manual" });
            if (resp.ok || resp.status === 302 || resp.status === 401) return;
        } catch { }
        await sleep(2000);
    }
    throw new Error("Cap did not become ready within 120 seconds.");
}

async function login(adminKey) {
    const resp = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin_key: adminKey }),
    });
    const data = await resp.json();
    if (!data.success || !data.session_token || !data.hashed_token) {
        throw new Error(`Cap login failed: ${JSON.stringify(data)}`);
    }
    const payload = Buffer.from(
        JSON.stringify({ token: data.session_token, hash: data.hashed_token }),
    ).toString("base64");
    return `Bearer ${payload}`;
}

async function apiReq(auth, method, route, body) {
    const resp = await fetch(`${base}/server${route}`, {
        method,
        headers: {
            Authorization: auth,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json();
    if (!resp.ok || data?.error) {
        throw new Error(`Cap API ${method} ${route} failed: ${JSON.stringify(data)}`);
    }
    return data;
}

async function ensureKey(auth) {
    const saved = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, "utf8"))
        : null;
    const keys = await apiReq(auth, "GET", "/keys");
    if (saved?.siteKey && saved?.secretKey) {
        const match = keys.find((e) => e.siteKey === saved.siteKey);
        if (match) return { siteKey: saved.siteKey, secretKey: saved.secretKey, reused: true };
    }
    const created = await apiReq(auth, "POST", "/keys", {
        name: "local-cap-matrix",
        instrumentation: true,
        blockAutomatedBrowsers: true,
    });
    return { siteKey: created.siteKey, secretKey: created.secretKey, reused: false };
}

async function main() {
    const adminKey = loadOrCreateEnv();
    console.log("starting stack...");
    startStack();
    console.log("waiting...");
    await waitReady();
    const auth = await login(adminKey);
    const key = await ensureKey(auth);
    const conf = {
        baseUrl: base,
        adminKey,
        siteKey: key.siteKey,
        secretKey: key.secretKey,
        widgetScriptUrl: `${base}/assets/widget.js`,
        wasmScriptUrl: `${base}/assets/cap_wasm.js`,
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(configPath, JSON.stringify(conf, null, 2));
    console.log(`ready: ${base}`);
    console.log(`site key: ${conf.siteKey}`);
    console.log(`secret: ${conf.secretKey}`);
    console.log(`saved ${configPath}`);
    console.log(key.reused ? "reused key" : "created key");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});