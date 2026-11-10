#!/usr/bin/env node
/**
 * sync-wgfx.mjs — 將 WGFX 的產物同步(攤銷)進擴充套件
 * ---------------------------------------------------------------------------
 * Vendor the WGFX artifacts into this extension.
 *
 * 同步兩類產物 / Two kinds of artifacts:
 *
 *   1. **核心庫 bundle** → `vendor/wgfx.browser.esm.js`(+ sourcemap)
 *      MV3 擴充套件無法在執行期 import 套件路徑(node_modules 不會被打包進擴充套件),
 *      而 content script 必須以 `chrome.runtime.getURL(...)` 載入
 *      web_accessible_resource。
 *
 *   2. **效果套件包 `.wgx`** → `wgx/<家族>/<效果>.wgx`(+ `wgx/packages.json` 索引)
 *      `.wgx` 是 WGFX 的「預編」套件包(zip:manifest.json + shaders/*.wgsl +
 *      textures/*.dds + weights/*.bin)。擴充套件不需要再把 `.wgsl` 交給解析器,
 *      而是直接載入套件包。
 *
 *      同步時會從每個套件包內**抽出 manifest.json**,把
 *      id / name / family / description / parameters 等中繼資料寫進
 *      `wgx/packages.json`。為什麼要這份索引(MV3 限制):
 *        * service worker **無法列舉**擴充套件內的檔案(沒有檔案系統 API),
 *          也沒有「讀取目錄」的 API —— 只有 `chrome.runtime.getURL`(已知路徑→URL)。
 *        * 硬編碼清單是舊版的痛點(6 個路徑 vs 實際 20 個 .wgsl,早就不同步)。
 *        * 索引是純資料 JSON,service worker(popup/內容腳本同理)一次 fetch 就能
 *          拿到完整且正確的清單,而且在同步時就已驗證過內容。
 *      索引同時收錄 `effects_wgsl/` 下既有的 `.wgsl`(legacy),讓舊效果仍可被列出。
 *
 * 冪等 / Idempotent:
 *   內容相同就不寫入(檔案逐一比對 sha256;索引比對時忽略 generatedAt)。
 *   `--check` 只檢查、不寫入,過期時 exit 1(供 CI)。
 *
 * 用法 / Usage:
 *   node scripts/sync-wgfx.mjs            # 同步(內容相同則不寫入)
 *   node scripts/sync-wgfx.mjs --check    # 只檢查是否為最新(CI 用;過期則 exit 1)
 *   node scripts/sync-wgfx.mjs --force    # 即使內容相同也重寫
 *   node scripts/sync-wgfx.mjs --quiet    # 只輸出錯誤
 *   node scripts/sync-wgfx.mjs --soft     # 找不到來源時只警告、不讓 npm install 失敗
 *
 * 來源解析順序 / Source resolution order:
 *   bundle:
 *     1. $WGFX_DIST(若設定,指向 WGFX 的 dist 目錄)
 *     2. ./node_modules/wgfx/dist        (以 `npm install` 安裝的套件 — 正式路徑)
 *     3. ../WGFX/dist                    (同層 checkout — 本機開發路徑)
 *   套件包(dist/wgx):
 *     1. $WGFX_PACKAGES(指向「內含 .wgx」的目錄;可為 dist/wgx 或其任一上層,會遞迴搜尋)
 *     2. 上述 bundle 來源目錄下的 wgx/   (即 ../WGFX/dist/wgx — `npm run pack` 的產物)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(EXT_ROOT, 'vendor');
const WGX_DIR = path.join(EXT_ROOT, 'wgx');
const INDEX_FILE = path.join(WGX_DIR, 'packages.json');
const STAMP_FILE = path.join(OUT_DIR, '.wgfx-sync.json');

/** 要同步的產物:主 bundle 為必要,sourcemap 為選用 */
const ARTIFACTS = [
    { name: 'wgfx.browser.esm.js', required: true },
    { name: 'wgfx.browser.esm.js.map', required: false }
];

/** 索引格式版本(欄位結構變動時遞增) */
const INDEX_VERSION = 1;

/** legacy `.wgsl` 效果的掃描根目錄(相對擴充套件根) */
const LEGACY_ROOTS = ['effects_wgsl'];
/** 掃描 legacy 時要略過的目錄名(實作暫存/實驗區,不是可用的效果) */
const LEGACY_SKIP_DIRS = new Set(['workspace', 'node_modules', '.git']);

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const FORCE = argv.includes('--force');
const QUIET = argv.includes('--quiet');
/** --soft:供 postinstall 使用 — 來源不存在時只警告,不讓 npm install 失敗 */
const SOFT = argv.includes('--soft');

const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => { console.warn(...a); };
const fail = (msg) => {
    if (SOFT) {
        warn(`[sync-wgfx] 警告: ${msg}`);
        warn('[sync-wgfx] (--soft 模式:略過同步。準備好之後請執行 `npm run sync:wgfx`)');
        process.exit(0);
    }
    console.error(`[sync-wgfx] 錯誤: ${msg}`);
    process.exit(1);
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const short = (h) => String(h).slice(0, 12);
const relPosix = (p) => path.relative(EXT_ROOT, p).split(path.sep).join('/');

// ===========================================================================
// [A] bundle 同步(既有行為,保持不變)
// ===========================================================================

/** 依序嘗試各種來源,回傳第一個同時具備必要產物的目錄 */
function resolveSource() {
    const candidates = [];
    if (process.env.WGFX_DIST) {
        candidates.push({ label: 'WGFX_DIST 環境變數', dir: path.resolve(process.env.WGFX_DIST) });
    }
    candidates.push({
        label: '已安裝套件 node_modules/wgfx',
        dir: path.join(EXT_ROOT, 'node_modules', 'wgfx', 'dist')
    });
    candidates.push({
        label: '同層 checkout ../WGFX',
        dir: path.resolve(EXT_ROOT, '..', 'WGFX', 'dist')
    });

    const tried = [];
    for (const c of candidates) {
        const main = path.join(c.dir, 'wgfx.browser.esm.js');
        if (fs.existsSync(main)) return { ...c, main };
        tried.push(`  - ${c.label}: ${c.dir}`);
    }
    fail(
        '找不到 WGFX 的 dist/wgfx.browser.esm.js。已嘗試:\n' +
        tried.join('\n') +
        '\n請先在 WGFX 專案執行 `npm run build`,或在本專案執行 `npm install`(會建立 file: 依賴連結)。'
    );
}

/** 讀取來源套件版本(供記錄/除錯用) */
function readVersion(distDir) {
    for (const rel of ['../package.json', 'package.json']) {
        const p = path.join(distDir, rel);
        try {
            if (fs.existsSync(p)) {
                const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (pkg && pkg.name === 'wgfx' && pkg.version) return pkg.version;
            }
        } catch { /* 版本資訊非必要,忽略 */ }
    }
    return 'unknown';
}

/**
 * 健全性檢查:確保我們攤銷的是「可被 import 的 ESM 且真的有 WGFX 匯出」,
 * 避免把半成品或錯誤的 bundle 帶進擴充套件。
 */
function assertUsableBundle(code) {
    if (!/export\s*\{[^}]*\bWGFX\b[^}]*\}/.test(code)) {
        fail('來源 bundle 沒有匯出 WGFX — 拒絕同步(請確認 WGFX 建置產物是否正常)。');
    }
    if (/^\s*import\s[^;]*from\s*['"]/m.test(code)) {
        fail('來源 bundle 含未解析的裸 import — 它不是自足的瀏覽器 bundle,拒絕同步。');
    }
}

function readJSON(p) {
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* 損毀時視為不存在 */ }
    return null;
}

// ===========================================================================
// [B] .wgx 套件包:最小 zip 讀取器(只抽 manifest.json)
// ===========================================================================

/**
 * 從 zip bytes 取出單一檔案(僅支援 stored / deflate-raw,涵蓋 wgxp 的產物)。
 * 刻意不依賴外部套件:同步腳本必須在 `npm install` 之前就能跑(postinstall)。
 * @param {Buffer} buf
 * @param {string} wanted 套件包內的相對路徑(例如 'manifest.json')
 * @returns {Buffer|null}
 */
function readZipEntry(buf, wanted) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // End of Central Directory(0x06054b50):註解最長 65535,從尾端往回找
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= minPos; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip:找不到 EOCD');

    const entryCount = dv.getUint16(eocd + 10, true);
    let ptr = dv.getUint32(eocd + 16, true);

    for (let i = 0; i < entryCount; i++) {
        if (dv.getUint32(ptr, true) !== 0x02014b50) {
            throw new Error(`zip central directory 損毀(entry ${i})`);
        }
        const method = dv.getUint16(ptr + 10, true);
        const compressedSize = dv.getUint32(ptr + 20, true);
        const uncompressedSize = dv.getUint32(ptr + 24, true);
        const nameLen = dv.getUint16(ptr + 28, true);
        const extraLen = dv.getUint16(ptr + 30, true);
        const commentLen = dv.getUint16(ptr + 32, true);
        const localOffset = dv.getUint32(ptr + 42, true);
        const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
        ptr += 46 + nameLen + extraLen + commentLen;

        if (name !== wanted) continue;

        if (dv.getUint32(localOffset, true) !== 0x04034b50) {
            throw new Error(`zip local header 損毀:${name}`);
        }
        const lNameLen = dv.getUint16(localOffset + 26, true);
        const lExtraLen = dv.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compressedSize);

        let out;
        if (method === 0) out = raw;
        else if (method === 8) out = zlib.inflateRawSync(raw);
        else throw new Error(`不支援的 zip 壓縮方法 ${method}:${name}`);

        if (uncompressedSize > 0 && out.length !== uncompressedSize) {
            throw new Error(`zip entry 大小不符:${name}`);
        }
        return Buffer.from(out);
    }
    return null;
}

/**
 * 讀出 `.wgx` 內的 manifest.json。
 * @param {string} file
 * @returns {{manifest: object, bytes: number, hash: string}}
 */
function readWgxManifest(file) {
    const buf = fs.readFileSync(file);
    const bytes = buf.length;
    const hash = sha256(buf);
    const raw = readZipEntry(buf, 'manifest.json');
    if (!raw) throw new Error(`套件包內找不到 manifest.json:${file}`);
    let manifest;
    try {
        manifest = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        throw new Error(`套件包 manifest.json 不是合法 JSON:${file}(${e.message})`);
    }
    if (!manifest || typeof manifest !== 'object' || !manifest.id) {
        throw new Error(`套件包 manifest 缺少 id:${file}`);
    }
    return { manifest, bytes, hash };
}

/** 目錄/檔名安全化:避免路徑跳脫,空字串則回退 */
function safeSegment(s, fallback) {
    const cleaned = String(s == null ? '' : s)
        .replace(/[\\/]+/g, '-')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return cleaned && cleaned !== '.' ? cleaned : fallback;
}

/** 遞迴收集 .wgx(回傳絕對路徑,已排序以便輸出穩定) */
function findWgxFiles(dir) {
    const out = [];
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            if (ent.name.startsWith('.')) continue;
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile() && ent.name.toLowerCase().endsWith('.wgx')) out.push(full);
        }
    };
    walk(dir);
    out.sort();
    return out;
}

/**
 * 解析套件包來源目錄。
 * @param {string} bundleDistDir bundle 所在的 dist 目錄(作為第二順位來源)
 * @returns {{label: string, dir: string}|null}
 */
function resolvePackagesSource(bundleDistDir) {
    const candidates = [];
    if (process.env.WGFX_PACKAGES) {
        candidates.push({ label: 'WGFX_PACKAGES 環境變數', dir: path.resolve(process.env.WGFX_PACKAGES) });
    }
    candidates.push({ label: 'WGFX dist/wgx', dir: path.join(bundleDistDir, 'wgx') });
    if (process.env.WGFX_DIST) {
        candidates.push({ label: 'WGFX_DIST 環境變數/wgx', dir: path.join(path.resolve(process.env.WGFX_DIST), 'wgx') });
    }
    candidates.push({ label: '已安裝套件 node_modules/wgfx/dist/wgx', dir: path.join(EXT_ROOT, 'node_modules', 'wgfx', 'dist', 'wgx') });
    candidates.push({ label: '同層 checkout ../WGFX/dist/wgx', dir: path.resolve(EXT_ROOT, '..', 'WGFX', 'dist', 'wgx') });

    const tried = [];
    for (const c of candidates) {
        if (fs.existsSync(c.dir) && findWgxFiles(c.dir).length > 0) return c;
        tried.push(`  - ${c.label}: ${c.dir}`);
    }
    log('[sync-wgfx] 找不到 .wgx 套件包來源。已嘗試:\n' + tried.join('\n'));
    log('[sync-wgfx] 提示:請先在 WGFX 專案執行 `npm run pack`(產物在 WGFX/dist/wgx),');
    log('[sync-wgfx]       或以 WGFX_PACKAGES=<含 .wgx 的目錄> 指定其他來源。');
    return null;
}

/** manifest → 索引項目(供 background.js / popup.js 使用) */
function manifestToEntry(manifest, file, hash, bytes) {
    const base = path.basename(file, path.extname(file));
    const family = safeSegment(manifest.family || 'Other', 'Other');
    const name = String(manifest.name || manifest.id || base);
    // description 為選填:退回第一個 pass 的 //!DESC(套件包把它保留在 shaderInfo 內)
    const description = String(
        manifest.description ||
        (Array.isArray(manifest.shaderInfo?.passes) ? manifest.shaderInfo.passes[0]?.desc : '') ||
        ''
    );
    const parameters = (Array.isArray(manifest.parameters) ? manifest.parameters : []).map((p) => ({
        name: p.name,
        type: p.type || 'float',
        label: p.label || p.name,
        default: numOr(p.default, 0),
        min: numOr(p.min, 0),
        max: numOr(p.max, 1),
        step: numOr(p.step, 0.01),
    }));
    return {
        kind: 'wgx',
        path: `wgx/${family}/${safeSegment(path.basename(file), base)}`,
        id: String(manifest.id),
        name,
        family,
        description,
        source: String(manifest.source || ''),
        tags: Array.isArray(manifest.tags) ? manifest.tags : [],
        passCount: Array.isArray(manifest.passes) ? manifest.passes.length : 0,
        parameters,
        manifestVersion: manifest.version,
        hash,
        bytes,
        builtAt: manifest.builtAt || '',
    };
}

const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 掃描 legacy `.wgsl`(索引用;讓舊效果仍能被列出) */
function scanLegacyEffects() {
    const out = [];
    for (const root of LEGACY_ROOTS) {
        const abs = path.join(EXT_ROOT, root);
        if (!fs.existsSync(abs)) continue;
        const walk = (d) => {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const ent of entries) {
                if (ent.name.startsWith('.')) continue;
                const full = path.join(d, ent.name);
                if (ent.isDirectory()) {
                    if (!LEGACY_SKIP_DIRS.has(ent.name)) walk(full);
                    continue;
                }
                if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.wgsl')) continue;
                // 0 byte 的空檔(實作暫存)不是可用效果,排除以免加入管線後失敗
                if (fs.statSync(full).size === 0) continue;
                const rel = relPosix(full);
                const dir = path.posix.dirname(rel);
                const name = path.basename(rel, '.wgsl');
                out.push({
                    kind: 'wgsl',
                    path: rel,
                    id: `wgsl:${rel}`,
                    name,
                    family: dir && dir !== '.' ? dir.split('/').pop() : 'legacy',
                    description: '',
                    parameters: null, // legacy 由 popup 解析檔案內的 //!PARAMETER
                    hash: sha256(fs.readFileSync(full)),
                    bytes: fs.statSync(full).size,
                });
            }
        };
        walk(abs);
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
}

// ===========================================================================
// [C] 索引(packages.json)
// ===========================================================================

/** 組出索引物件(不含 generatedAt —— 它會沿用既有值以維持冪等) */
function buildIndex({ packages, legacy, wgfxVersion, bundleHash, pkgSource, staleBundles }) {
    const families = {};
    for (const p of packages) families[p.family] = (families[p.family] || 0) + 1;
    return {
        version: INDEX_VERSION,
        generatedAt: null, // 由呼叫端填入
        wgfxVersion,
        bundleHash,
        packagesSource: pkgSource ? { label: pkgSource.label, dir: pkgSource.dir } : null,
        staleBundles: !!staleBundles,
        counts: { packages: packages.length, legacy: legacy.length, families: Object.keys(families).length },
        families,
        packages,
        legacy,
    };
}

/** 比對索引內容(忽略 generatedAt,以維持冪等) */
function sameIndex(a, b) {
    if (!a || !b) return false;
    const strip = (o) => { const c = { ...o }; delete c.generatedAt; return JSON.stringify(c); };
    return strip(a) === strip(b);
}

// ===========================================================================
// [D] 主流程
// ===========================================================================

function syncBundle(distDir, version) {
    const payload = [];
    for (const art of ARTIFACTS) {
        const p = path.join(distDir, art.name);
        if (!fs.existsSync(p)) {
            if (art.required) fail(`來源缺少必要產物 ${art.name}(${p})`);
            log(`[sync-wgfx] 略過選用產物 ${art.name}(來源無此檔)`);
            continue;
        }
        payload.push({ ...art, buf: fs.readFileSync(p) });
    }

    const mainArt = payload.find((a) => a.name === 'wgfx.browser.esm.js');
    assertUsableBundle(mainArt.buf.toString('utf8'));
    const srcHash = sha256(mainArt.buf);

    const stamp = readJSON(STAMP_FILE);
    const outMain = path.join(OUT_DIR, 'wgfx.browser.esm.js');
    const upToDate = stamp && stamp.hash === srcHash && fs.existsSync(outMain);

    if (upToDate && !CHECK_ONLY && !FORCE) {
        log(`[sync-wgfx] bundle 已是最新 (${short(srcHash)}, v${stamp.version})`);
    } else if (CHECK_ONLY && !upToDate) {
        const why = !stamp ? '缺少戳記' : (!fs.existsSync(outMain) ? '缺少 vendor 產物' : '內容已變更');
        return { ok: false, reason: `vendor/ 與來源不同步(${why})`, hash: srcHash, version };
    } else if (!CHECK_ONLY) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        for (const art of payload) {
            fs.writeFileSync(path.join(OUT_DIR, art.name), art.buf);
            log(`[sync-wgfx] 寫入 vendor/${art.name} (${(art.buf.length / 1024).toFixed(1)} KB)`);
        }
    }
    return { ok: true, hash: srcHash, version };
}

/**
 * 同步套件包並產生索引。
 * @returns {{ok: boolean, reason?: string, index: object, wrote: number, kept: number, removed: number, staleBundles: boolean}}
 */
function syncPackages(distDir, version, bundleHash) {
    const prevIndex = readJSON(INDEX_FILE);
    const prevPackages = new Map(
        (Array.isArray(prevIndex?.packages) ? prevIndex.packages : []).map((p) => [p.path, p])
    );
    const legacy = scanLegacyEffects();
    const pkgSource = resolvePackagesSource(distDir);

    if (!pkgSource) {
        if (CHECK_ONLY) {
            return {
                ok: false, staleBundles: true,
                reason: '找不到 .wgx 套件包來源(請先在 WGFX 執行 `npm run pack`,或設定 WGFX_PACKAGES)',
                index: prevIndex || buildIndex({ packages: [], legacy, wgfxVersion: version, bundleHash, pkgSource: null, staleBundles: true }),
                wrote: 0, kept: 0, removed: 0,
            };
        }
        warn('[sync-wgfx] 警告: 找不到 .wgx 套件包來源 — 保留現有 wgx/(若有),索引標記為 staleBundles。');
        const kept = [];
        for (const [rel, entry] of prevPackages) {
            if (fs.existsSync(path.join(EXT_ROOT, rel))) kept.push(entry);
        }
        const index = buildIndex({ packages: kept, legacy, wgfxVersion: version, bundleHash, pkgSource: null, staleBundles: true });
        return { ok: true, index, wrote: 0, kept: kept.length, removed: 0, staleBundles: true };
    }

    // ---- 讀取來源套件包 ----
    const srcFiles = findWgxFiles(pkgSource.dir);
    const entries = [];
    const destSeen = new Map(); // dest 相對路徑 → 來源檔(偵測碰撞)
    const srcErrors = [];

    for (const file of srcFiles) {
        let parsed;
        try {
            parsed = readWgxManifest(file);
        } catch (e) {
            srcErrors.push(`${relPosix(file)}: ${e.message}`);
            continue;
        }
        const entry = manifestToEntry(parsed.manifest, file, parsed.hash, parsed.bytes);
        if (destSeen.has(entry.path)) {
            fail(
                `套件包目標路徑碰撞:${entry.path}\n` +
                `  來自 ${relPosix(destSeen.get(entry.path))} 與 ${relPosix(file)}\n` +
                '  請確認 WGFX 端套件包的 family/name 是否重複。'
            );
        }
        destSeen.set(entry.path, file);
        entries.push({ entry, src: file });
    }
    if (srcErrors.length) {
        // 損毀的套件包是明確的錯誤訊號,不應該靜默跳過
        fail('來源中有無法解析的套件包:\n  ' + srcErrors.join('\n  '));
    }

    // ---- 寫入(.wgx;內容相同則不寫)----
    let wrote = 0;
    let kept = 0;
    const packages = [];
    const pending = [];

    for (const { entry, src } of entries) {
        const dest = path.join(EXT_ROOT, entry.path);
        const exists = fs.existsSync(dest);
        const same = exists && !FORCE && sha256(fs.readFileSync(dest)) === entry.hash;
        if (same) {
            kept++;
        } else {
            if (CHECK_ONLY) {
                packages.push(entry);
                pending.push({ entry, src, dest, stale: true });
                continue;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            wrote++;
            log(`[sync-wgfx] 寫入 ${entry.path} (${(entry.bytes / 1024).toFixed(1)} KB, ${entry.passCount} pass)`);
        }
        packages.push(entry);
    }

    // ---- 移除已不在來源中的套件包(只刪自己同步過的;使用者手動放入的保留)----
    const currentPaths = new Set(entries.map(({ entry }) => entry.path));
    const removed = [];
    const unknown = [];
    for (const [rel, prevEntry] of prevPackages) {
        if (currentPaths.has(rel)) continue;
        const abs = path.join(EXT_ROOT, rel);
        if (!fs.existsSync(abs)) continue;
        if (prevEntry?.kind === 'wgx' && String(rel).startsWith('wgx/')) {
            removed.push(rel);
            if (!CHECK_ONLY) {
                fs.rmSync(abs, { force: true });
                log(`[sync-wgfx] 移除已不存在的套件包 ${rel}`);
            }
        } else {
            unknown.push(rel);
        }
    }
    if (unknown.length) {
        log(`[sync-wgfx] 保留 ${unknown.length} 個不在來源索引中的項目(視為使用者自訂)。`);
    }
    if (!CHECK_ONLY) pruneEmptyDirs(WGX_DIR);

    // ---- 索引 ----
    packages.sort((a, b) => (a.family + '/' + a.name).localeCompare(b.family + '/' + b.name));
    const index = buildIndex({ packages, legacy, wgfxVersion: version, bundleHash, pkgSource, staleBundles: false });

    if (CHECK_ONLY) {
        const staleFiles = entries.filter(({ entry }) => {
            const dest = path.join(EXT_ROOT, entry.path);
            return !fs.existsSync(dest) || sha256(fs.readFileSync(dest)) !== entry.hash;
        });
        const legacyChanged = !prevIndex || JSON.stringify(prevIndex.legacy || []) !== JSON.stringify(legacy);
        if (staleFiles.length || removed.length || legacyChanged || !sameIndex(prevIndex, index)) {
            const bits = [];
            if (staleFiles.length) bits.push(`${staleFiles.length} 個套件包不是最新`);
            if (removed.length) bits.push(`${removed.length} 個套件包已從來源移除`);
            if (legacyChanged) bits.push('legacy 效果清單已變動');
            if (!prevIndex) bits.push('缺少索引 wgx/packages.json');
            return { ok: false, reason: `wgx/ 與來源不同步(${bits.join('、')})`, index, wrote, kept, removed: removed.length, staleBundles: false };
        }
        return { ok: true, index, wrote, kept, removed: 0, staleBundles: false };
    }

    const prev = prevIndex;
    if (prev && sameIndex(prev, index)) {
        log(`[sync-wgfx] 索引已是最新(${packages.length} 個套件包、${legacy.length} 個 legacy 效果)— 未寫入。`);
        return { ok: true, index: prev, wrote, kept, removed: removed.length, staleBundles: false, unchanged: true };
    }
    index.generatedAt = new Date().toISOString();
    fs.mkdirSync(WGX_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + '\n');
    log(`[sync-wgfx] 寫入 wgx/packages.json(${packages.length} 個套件包、${legacy.length} 個 legacy 效果)`);
    return { ok: true, index, wrote, kept, removed: removed.length, staleBundles: false };
}

/** 清掉 wgx/ 下的空目錄(同步移除後可能留下) */
function pruneEmptyDirs(root) {
    if (!fs.existsSync(root)) return;
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const full = path.join(root, ent.name);
        pruneEmptyDirs(full);
        try {
            if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch { /* 非致命 */ }
    }
}

function main() {
    const src = resolveSource();
    const distDir = path.dirname(src.main);
    const version = readVersion(distDir);

    log(`[sync-wgfx] 來源: ${src.label}\n[sync-wgfx]   目錄: ${distDir}\n[sync-wgfx]   版本: ${version}`);

    const bundle = syncBundle(distDir, version);
    const pkgs = bundle.ok
        ? syncPackages(distDir, version, bundle.hash)
        : { ok: true, index: readJSON(INDEX_FILE) || null, wrote: 0, kept: 0, removed: 0, staleBundles: false, skipped: true };

    if (CHECK_ONLY) {
        const problems = [];
        if (!bundle.ok) problems.push(bundle.reason);
        if (pkgs && pkgs.ok === false) problems.push(pkgs.reason);
        if (problems.length) {
            console.error('[sync-wgfx] 不同步:\n  - ' + problems.join('\n  - '));
            process.exit(1);
        }
        const c = pkgs.index?.counts || {};
        log(`[sync-wgfx] 已是最新:WGFX v${version} bundle ${short(bundle.hash)}、` +
            `套件包 ${c.packages ?? 0} 個、legacy 效果 ${c.legacy ?? 0} 個。`);
        return;
    }

    // ---- 更新戳記 ----
    const stamp = readJSON(STAMP_FILE) || {};
    const packages = pkgs.index?.packages || [];
    const newStamp = {
        source: src.label,
        sourceDir: distDir,
        version,
        hash: bundle.hash,
        wgx: {
            source: pkgs.index?.packagesSource ? pkgs.index.packagesSource.label : '(未同步)',
            sourceDir: pkgs.index?.packagesSource ? pkgs.index.packagesSource.dir : null,
            count: packages.length,
            legacyCount: pkgs.index?.legacy?.length ?? 0,
            // 聚合雜湊:只反映套件包內容(不含時間戳),供快速判斷是否過期
            indexHash: sha256(JSON.stringify(packages.map((p) => [p.path, p.hash]))),
            staleBundles: !!pkgs.staleBundles,
        },
        syncedAt: new Date().toISOString(),
    };
    const sameStamp = stamp.hash === newStamp.hash &&
        JSON.stringify(stamp.wgx || null) === JSON.stringify(newStamp.wgx);
    if (!sameStamp || FORCE) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(STAMP_FILE, JSON.stringify(newStamp, null, 2) + '\n');
    }

    const c = pkgs.index?.counts || {};
    log(
        `[sync-wgfx] 完成: WGFX v${version} ${short(bundle.hash)}` +
        `\n[sync-wgfx]   套件包: ${c.packages ?? 0} 個(${c.families ?? 0} 個家族)` +
        `｜寫入 ${pkgs.wrote ?? 0}、已是相同內容 ${pkgs.kept ?? 0}、移除 ${pkgs.removed ?? 0}` +
        `\n[sync-wgfx]   legacy: ${c.legacy ?? 0} 個 .wgsl` +
        (pkgs.staleBundles ? '\n[sync-wgfx]   注意: 這次沒有同步到套件包來源,索引已標記 staleBundles=true。' : '')
    );
}

main();
