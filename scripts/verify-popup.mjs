#!/usr/bin/env node
/**
 * verify-popup.mjs — 以程式化方式驗證「效果庫清單 + popup DOM 產出」
 * ---------------------------------------------------------------------------
 * Programmatic verification of the index-driven effect library and the popup UI.
 *
 * 為什麼需要這支腳本 / Why:
 *   驗收要求「background.js 回傳的清單與實際套件包一致(不再硬編碼)」與
 *   「popup.js 能列出套件包並加入管線」,但這兩者都在瀏覽器/擴充套件環境中執行。
 *   本腳本不需要開瀏覽器:它用最小 DOM/chrome stub 在 Node 裡**真的執行**
 *   `background.js` 與 `popup.js`,再檢查它們產出的 DOM 與訊息。
 *
 * 驗證內容 / What is checked:
 *   [A] background.js:讀取真實的 wgx/packages.json,回傳的清單與磁碟上的檔案一致
 *       (數量、欄位、每個 path 都真的存在、不再是舊版硬編碼清單)。
 *   [B] popup.js:效果庫 DOM(依 family 分組、每項含 name/中繼資訊/加入按鈕)、
 *       加入 .wgx 套件包(參數取自索引、不解壓)→ 管線 DOM/儲存/通知、
 *       加入 legacy .wgsl(參數解析檔案)、屬性面板的 range 控制項。
 *   [C] manifest.json:web_accessible_resources 涵蓋 wgx,且未放寬 MV3 CSP。
 *
 * 用法 / Usage:
 *   node scripts/verify-popup.mjs           # 全部檢查
 *   node scripts/verify-popup.mjs --quiet   # 只輸出失敗
 *
 * 結束碼:0 = 全部通過;1 = 有失敗。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, '..');
const QUIET = process.argv.includes('--quiet');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
    if (ok) { pass++; if (!QUIET) console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); }
    else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n=== ${t} ===`); };

// ===========================================================================
// 最小 DOM stub(只實作 popup.js 實際用到的 API)
// ===========================================================================

function createElement(tag) {
    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        parentNode: null,
        className: '',
        _classes: new Set(),
        textContent: '',
        _innerHTML: '',
        title: '',
        draggable: false,
        dataset: {},
        style: {},
        _handlers: {},
        onclick: null,
    };
    el.classList = {
        add: (...cs) => cs.forEach((c) => el._classes.add(c)),
        remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
        contains: (c) => el._classes.has(c),
        toString: () => [...el._classes].join(' '),
    };
    Object.defineProperty(el, 'innerHTML', {
        get: () => el._innerHTML,
        set: (v) => { el._innerHTML = String(v); el.children.length = 0; },
    });
    // className 與 classList 保持同步(popup.js 兩種都用)
    Object.defineProperty(el, 'className', {
        get: () => [...el._classes].join(' '),
        set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
    el.addEventListener = (type, fn) => { (el._handlers[type] = el._handlers[type] || []).push(fn); };
    el.removeEventListener = (type, fn) => {
        el._handlers[type] = (el._handlers[type] || []).filter((f) => f !== fn);
    };
    el.dispatch = (type, ev = {}) => {
        for (const fn of el._handlers[type] || []) fn({ target: el, ...ev });
    };
    el.querySelectorAll = (sel) => descendants(el).filter((d) => matches(d, sel));
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
    el.closest = (sel) => {
        let cur = el;
        while (cur) { if (matches(cur, sel)) return cur; cur = cur.parentNode; }
        return null;
    };
    return el;
}

function descendants(el, out = []) {
    for (const c of el.children) { out.push(c); descendants(c, out); }
    return out;
}

/** 單一簡單選擇器:.class、[data-x="v"]、tag */
function matchesSimple(el, sel) {
    const s = String(sel).trim();
    if (s.startsWith('.')) return el._classes.has(s.slice(1));
    const attr = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(s);
    if (attr) {
        const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase());
        const v = el.dataset ? el.dataset[key] : undefined;
        return attr[2] === undefined ? v !== undefined : String(v) === attr[2];
    }
    return el.tagName === s.toUpperCase();
}

/** 支援後代選擇器(空白分隔),例如 '.shader-list li';其餘同 matchesSimple */
function matches(el, sel) {
    const parts = String(sel).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1) return matchesSimple(el, parts[0]);
    if (!matchesSimple(el, parts[parts.length - 1])) return false;
    let cur = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
        let found = false;
        while (cur) {
            if (matchesSimple(cur, parts[i])) { found = true; cur = cur.parentNode; break; }
            cur = cur.parentNode;
        }
        if (!found) return false;
    }
    return true;
}

/** 建立一份新的 document stub,並預先放好 popup.html 的四個節點 */
function createDocument() {
    const ids = ['library-content', 'pipeline-list', 'properties-content', 'master-toggle'];
    const byId = {};
    const doc = {
        _domReady: [],
        body: createElement('body'),
        getElementById: (id) => byId[id] || null,
        createElement,
        querySelectorAll: (sel) => descendants(doc.body).filter((d) => matches(d, sel)),
        querySelector: (sel) => doc.querySelectorAll(sel)[0] || null,
        addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') doc._domReady.push(fn); },
    };
    for (const id of ids) {
        const el = createElement(id === 'master-toggle' ? 'input' : 'div');
        el.id = id;
        byId[id] = el;
        doc.body.appendChild(el);
    }
    doc._byId = byId;
    return doc;
}

// ===========================================================================
// chrome / fetch stub
// ===========================================================================

const EXT_ORIGIN = 'https://extension.invalid/';
const fetchLog = [];

function diskFetch(url) {
    fetchLog.push(url);
    const rel = url.startsWith(EXT_ORIGIN) ? url.slice(EXT_ORIGIN.length) : url;
    const abs = path.join(EXT_ROOT, decodeURIComponent(rel));
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    return Promise.resolve({
        ok: exists,
        status: exists ? 200 : 404,
        url,
        text: async () => fs.readFileSync(abs, 'utf8'),
        json: async () => JSON.parse(fs.readFileSync(abs, 'utf8')),
    });
}

function createChrome({ storage = {}, sent = [] } = {}) {
    const runtimeListeners = [];
    const chrome = {
        runtime: {
            getURL: (rel) => EXT_ORIGIN + String(rel).replace(/^\//, ''),
            onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
            onInstalled: { addListener: (fn) => { chrome.runtime._installed = fn; } },
            lastError: null,
        },
        storage: {
            local: {
                get: async (keys) => {
                    if (keys == null) return { ...storage };
                    const list = Array.isArray(keys) ? keys : [keys];
                    const out = {};
                    for (const k of list) if (k in storage) out[k] = storage[k];
                    return out;
                },
                set: async (obj) => { Object.assign(storage, obj); },
            },
        },
        tabs: {
            query: (_q, cb) => { cb([{ id: 1, url: 'https://www.youtube.com/watch?v=x' }]); },
            get: (id, cb) => cb({ id, url: 'https://www.youtube.com/watch?v=x' }),
            sendMessage: (id, msg) => { sent.push({ id, msg }); return Promise.resolve(); },
            onUpdated: { addListener: () => {} },
            onActivated: { addListener: () => {} },
        },
        action: { enable: () => {}, disable: () => {} },
    };
    chrome.runtime._listeners = runtimeListeners;
    return chrome;
}

/** 把 sendMessage 接到已註冊的 onMessage 監聽器(模擬擴充套件內部訊息流) */
function wireSendMessage(chrome, senderChrome) {
    chrome.runtime.sendMessage = (msg) => new Promise((resolve) => {
        // 比照 MV3:監聽器回傳 true 代表「稍後以 sendResponse 非同步回應」,
        // 此時不可立刻 resolve(否則會拿到 undefined)。
        let willRespond = false;
        for (const fn of senderChrome.runtime._listeners) {
            const ret = fn(msg, {}, (resp) => resolve(resp));
            if (ret === true) willRespond = true;
        }
        if (!willRespond) resolve(undefined);
    });
}

// ===========================================================================
// 載入 background.js
// ===========================================================================

function loadBackground() {
    const chrome = createChrome();
    const sandbox = {
        chrome,
        console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
        fetch: diskFetch,
        setTimeout,
        clearTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(EXT_ROOT, 'background.js'), 'utf8'), sandbox,
        { filename: 'background.js' });
    return { chrome, sandbox };
}

/** 以 onMessage 監聽器呼叫一個指令並等待回應 */
function ask(chrome, msg) {
    return new Promise((resolve, reject) => {
        const listeners = chrome.runtime._listeners;
        if (listeners.length === 0) return reject(new Error('background.js 沒有註冊 onMessage 監聽器'));
        let answered = false;
        for (const fn of listeners) {
            const ret = fn(msg, {}, (resp) => { answered = true; resolve(resp); });
            if (ret !== true && !answered) { /* 同步指令 */ }
        }
        setTimeout(() => { if (!answered) reject(new Error(`指令 ${msg.command} 沒有回應`)); }, 2000);
    });
}

// ===========================================================================
// MAIN
// ===========================================================================

const indexAbs = path.join(EXT_ROOT, 'wgx', 'packages.json');
const index = fs.existsSync(indexAbs) ? JSON.parse(fs.readFileSync(indexAbs, 'utf8')) : null;

section('[A] background.js —索引驅動的效果庫清單');
if (!index) {
    check('wgx/packages.json 存在(請先執行 npm run sync:wgfx)', false);
} else {
    check('wgx/packages.json 存在', true, `${index.counts.packages} 套件包 / ${index.counts.legacy} legacy`);

    const bg = loadBackground();
    const files = await ask(bg.chrome, { command: 'getShaderFiles' });

    const expectedTotal = index.counts.packages + index.counts.legacy;
    check('getShaderFiles 回傳陣列', Array.isArray(files));
    check(`清單數量等於索引(${expectedTotal})`, Array.isArray(files) && files.length === expectedTotal,
        Array.isArray(files) ? `實得 ${files.length}` : 'not an array');

    const wgx = (files || []).filter((f) => f.kind === 'wgx');
    const wgsl = (files || []).filter((f) => f.kind === 'wgsl');
    check(`套件包 ${index.counts.packages} 個`, wgx.length === index.counts.packages, `實得 ${wgx.length}`);
    check(`legacy .wgsl ${index.counts.legacy} 個`, wgsl.length === index.counts.legacy, `實得 ${wgsl.length}`);

    const missingFields = (files || []).filter((f) =>
        !f.path || !f.id || !f.name || !f.family || typeof f.description !== 'string');
    check('每項都有 path/id/name/family/description', missingFields.length === 0,
        missingFields.slice(0, 3).map((f) => JSON.stringify(f)).join(' '));

    const notOnDisk = (files || []).filter((f) => !fs.existsSync(path.join(EXT_ROOT, f.path)));
    check('清單中每個 path 都真的存在於磁碟', notOnDisk.length === 0,
        notOnDisk.slice(0, 3).map((f) => f.path).join(', '));

    // 舊版硬編碼清單有 6 條,其中 Anime4K_Denoise_Bilateral_Median.wgsl 根本不存在
    // → 證明清單不再是硬編碼:應包含舊清單沒有的套件包,且不得含有不存在的路徑。
    const broken = 'effects_wgsl/Anime4K/Anime4K_Denoise_Bilateral_Median.wgsl';
    check('不再包含舊硬編碼清單中已損壞的路徑', !(files || []).some((f) => f.path === broken), broken);
    check('包含舊硬編碼清單沒有的套件包', (files || []).some((f) => f.path === 'wgx/SMAA/SMAA_Ultra.wgx'));

    const nis = (files || []).find((f) => f.path === 'wgx/NIS/NIS.wgx');
    check('套件包帶有參數中繼資料(NIS.sharpness)',
        !!nis && Array.isArray(nis.parameters) && nis.parameters.some((p) => p.name === 'sharpness'
            && p.label === 'Sharpness' && p.default === 0.5 && p.min === 0 && p.max === 1 && p.step === 0.01),
        nis ? JSON.stringify(nis.parameters) : 'NIS.wgx 不在清單中');
    check('套件包帶有 pass 數', !!nis && nis.passCount === 1, nis ? String(nis.passCount) : '');
    const smaa = (files || []).find((f) => f.path === 'wgx/SMAA/SMAA_Ultra.wgx');
    check('多 pass 套件包回報 pass 數(3)', !!smaa && smaa.passCount === 3, smaa ? String(smaa.passCount) : '');
    check('套件包帶有描述', !!smaa && smaa.description.length > 0, smaa ? smaa.description : '');

    const status = await ask(bg.chrome, { command: 'getLibraryStatus' });
    check('getLibraryStatus 回報 ok', !!status && status.ok === true, status ? status.error : '無回應');
    check('getLibraryStatus 回報正確數量',
        !!status && status.packageCount === index.counts.packages && status.legacyCount === index.counts.legacy,
        status ? `${status.packageCount}/${status.legacyCount}` : '');
}

section('[B] popup.js —效果庫與管線 DOM 產出');
{
    const bg = loadBackground();
    const storage = {};
    const sent = [];
    const popupChrome = createChrome({ storage, sent });
    wireSendMessage(popupChrome, bg.chrome);

    // 先確認「popup → background」的訊息通道本身可用(sendMessage → onMessage → sendResponse)
    {
        const wired = await popupChrome.runtime.sendMessage({ command: 'getShaderFiles' });
        check('popup → background 訊息通道可用(getShaderFiles)',
            Array.isArray(wired) && wired.length === index.counts.packages + index.counts.legacy,
            Array.isArray(wired) ? `${wired.length} 項` : String(wired));
        const wiredStatus = await popupChrome.runtime.sendMessage({ command: 'getLibraryStatus' });
        check('popup → background 訊息通道可用(getLibraryStatus)',
            !!wiredStatus && wiredStatus.ok === true, JSON.stringify(wiredStatus));
    }

    const document = createDocument();
    const sandbox = {
        document,
        chrome: popupChrome,
        console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
        fetch: diskFetch,
        setTimeout,
        clearTimeout,
        __VSR_POPUP_TEST__: true,
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(EXT_ROOT, 'popup.js'), 'utf8'), sandbox,
        { filename: 'popup.js' });
    // 觸發 DOMContentLoaded(瀏覽器會做),再取測試接縫
    for (const fn of document._domReady) fn();
    const hooks = sandbox.__VSR_POPUP_HOOKS__;
    check('popup.js 暴露測試接縫', !!hooks && typeof hooks.addToPipeline === 'function');

    // 等 popup.js 內部的 initialize() 完成(輪詢效果庫 DOM 是否已建立)
    for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 10));
        const s = hooks.getState();
        if (s.libraryEntries.length > 0) break;
        if (s.libraryError) break;
    }
    {
        const s = hooks.getState();
        if (s.libraryEntries.length === 0 && !QUIET) {
            console.log(`  [DEBUG] libraryEntries=0;libraryError=${JSON.stringify(s.libraryError)}`);
            console.log(`  [DEBUG] storage 內已有 pipeline=${JSON.stringify(storage.pipeline)}`);
        }
    }

    const lib = document._byId['library-content'];
    const groups = lib.querySelectorAll('.shader-category');
    const items = lib.querySelectorAll('.shader-list li');
    // UI 的家族數 = 套件包與 legacy 的 family 聯集(索引的 counts.families 只算套件包)
    const expectedFamilies = new Set([
        ...index.packages.map((p) => p.family),
        ...index.legacy.map((l) => l.family || 'Other'),
    ]).size;
    check('效果庫依 family 分組', groups.length === expectedFamilies, `${groups.length} 組(預期 ${expectedFamilies})`);
    check('效果庫列出全部效果', items.length === index.counts.packages + index.counts.legacy,
        `${items.length} 項`);
    check('每個項目都有加入按鈕',
        items.every((li) => li.querySelectorAll('.add-btn').length === 1));
    check('每個項目都有名稱', items.every((li) => li.querySelectorAll('.shader-name').length === 1 && li.querySelector('.shader-name').textContent.length > 0));

    const nisItem = items.find((li) => li.dataset.entryPath === 'wgx/NIS/NIS.wgx');
    check('效果庫包含 NIS 套件包', !!nisItem);
    check('項目顯示套件包型別與參數數',
        !!nisItem && /\.wgx 套件包/.test(nisItem.children[0].children[1].textContent) &&
        /1 參數/.test(nisItem.children[0].children[1].textContent),
        nisItem ? nisItem.children[0].children[1].textContent : '');
    const legacyItem = items.find((li) => li.dataset.entryPath === 'effects_wgsl/CAS.wgsl');
    check('效果庫保留 legacy .wgsl', !!legacyItem);
    check('legacy 項目標示 .wgsl', !!legacyItem && legacyItem.children[0].children[1].textContent.startsWith('.wgsl'),
        legacyItem ? legacyItem.children[0].children[1].textContent : '');

    // ---- 加入 .wgx 套件包(參數取自索引;不應該去抓 .wgx 檔)----
    fetchLog.length = 0;
    const nisEntry = hooks.getState().libraryEntries.find((e) => e.path === 'wgx/NIS/NIS.wgx');
    await hooks.addToPipeline(nisEntry);

    const st = hooks.getState();
    const added = st.pipeline[st.pipeline.length - 1];
    check('加入套件包後管線有一項', st.pipeline.length === 1);
    check('管線項目 kind/path/name 正確',
        added.kind === 'wgx' && added.path === 'wgx/NIS/NIS.wgx' && added.name === 'NIS',
        JSON.stringify({ kind: added.kind, path: added.path, name: added.name }));
    check('參數預設值取自索引(sharpness=0.5)', added.params.sharpness === 0.5, String(added.params.sharpness));
    check('加入套件包不需要抓 .wgx 檔(不解壓)',
        fetchLog.filter((u) => u.endsWith('.wgx')).length === 0,
        fetchLog.join(' '));
    check('已寫入 chrome.storage.local', Array.isArray(storage.pipeline) && storage.pipeline.length === 1);
    check('已通知 content.js(setPipeline)',
        sent.some((m) => m.msg.command === 'setPipeline' && m.msg.pipeline.length === 1));

    const plist = document._byId['pipeline-list'];
    const pitems = plist.querySelectorAll('.pipeline-item');
    check('管線 DOM 產生 .pipeline-item', pitems.length === 1, `${pitems.length} 項`);
    check('管線 DOM 顯示效果名稱', pitems[0].textContent.includes('NIS') ||
        pitems[0].children[0].textContent.includes('NIS'), pitems[0].children[0].textContent);

    // ---- 屬性面板(以索引的 min/max/step 產生 range)----
    await hooks.renderPropertiesUI(added);
    const props = document._byId['properties-content'];
    const groups2 = props.querySelectorAll('.control-group');
    const range = props.querySelectorAll('input');
    check('屬性面板產生控制項', groups2.length === 1 && range.length === 1);
    check('range 使用索引的 min/max/step',
        range.length === 1 && String(range[0].min) === '0' && String(range[0].max) === '1' && String(range[0].step) === '0.01',
        range.length ? `${range[0].min}/${range[0].max}/${range[0].step}` : '');
    check('range 初始值為預設值', range.length === 1 && Number(range[0].value) === 0.5, range.length ? String(range[0].value) : '');

    // ---- 加入 legacy .wgsl(參數改由解析檔案取得)----
    // effects_wgsl/*.wgsl 有兩種指令變體,兩種都要能解析:
    //   (a) `//! PARAMETER <name>`(ImageAdjustment.wgsl)
    //   (b) `//! PARAMETER` + `//! VAR <name>`(Anime4K_*)
    const findEntry = (p) => hooks.getState().libraryEntries.find((e) => e.path === p);

    const iaEntry = findEntry('effects_wgsl/ImageAdjustment.wgsl');
    if (iaEntry) {
        await hooks.addToPipeline(iaEntry);
        const added2 = hooks.getState().pipeline[hooks.getState().pipeline.length - 1];
        check('加入 legacy .wgsl 成功', added2.kind === 'wgsl' && added2.path === 'effects_wgsl/ImageAdjustment.wgsl');
        const defs = added2.parameterDefs || [];
        // 該檔以 `//! PARAMETER <name>` 形式宣告 10 個參數
        check('legacy(a) 解析 //! PARAMETER <name> 形式的參數數(10)', defs.length === 10,
            `${defs.length}:${defs.map((d) => d.name).join(',')}`);
        const tg = defs.find((d) => d.name === 'targetGamma');
        check('legacy(a) 解析出 LABEL/MIN/MAX/DEFAULT/STEP',
            !!tg && tg.label === 'Target Gamma' && tg.min === 0.01 && tg.max === 5 &&
            tg.default === 2.2 && tg.step === 0.01,
            tg ? JSON.stringify(tg) : 'targetGamma 不存在');
    } else {
        check('效果庫含 legacy ImageAdjustment.wgsl', false);
    }

    const a4kEntry = findEntry('effects_wgsl/Anime4K/Anime4K_Denoise_Bilateral_Mode.wgsl');
    if (a4kEntry) {
        await hooks.addToPipeline(a4kEntry);
        const added3 = hooks.getState().pipeline[hooks.getState().pipeline.length - 1];
        const defs3 = added3.parameterDefs || [];
        const isig = defs3.find((d) => d.name === 'intensitySigma');
        check('legacy(b) 解析 //!PARAMETER + //!VAR 形式的參數',
            !!isig && isig.label === 'Strength' && isig.default === 0.1 && isig.min === 0.01 && isig.max === 5,
            defs3.length ? JSON.stringify(defs3) : '(0 個參數)');
    } else {
        check('效果庫含 legacy Anime4K_Denoise_Bilateral_Mode.wgsl', false);
    }

    const pitems2 = document._byId['pipeline-list'].querySelectorAll('.pipeline-item');
    check('管線 DOM 同時包含套件包與 legacy', pitems2.length === 3, `${pitems2.length} 項`);

    // 屬性面板對 legacy 也能產生控制項
    const legacyPropsItem = hooks.getState().pipeline.find((p) => p.path === 'effects_wgsl/ImageAdjustment.wgsl');
    await hooks.renderPropertiesUI(legacyPropsItem);
    const legacyRanges = document._byId['properties-content'].querySelectorAll('input');
    check('legacy 屬性面板產生 10 個 range', legacyRanges.length === 10, `${legacyRanges.length} 個`);

    // ---- 三個面板都在,且沒有拋錯----
    check('popup.js 在 DOM stub 中完整執行', true);
}

section('[C] manifest.json —資源可見性與 CSP');
{
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'manifest.json'), 'utf8'));
    const war = (manifest.web_accessible_resources || []).flatMap((w) => w.resources || []);
    check('web_accessible_resources 涵蓋 wgx/**/*.wgx', war.includes('wgx/**/*.wgx'));
    check('web_accessible_resources 涵蓋 wgx/*/*.wgx', war.includes('wgx/*/*.wgx'));
    check('保留 legacy effects_wgsl 資源', war.some((r) => r.startsWith('effects_wgsl/')));
    check('保留 WGFX bundle 資源', war.includes('vendor/wgfx.browser.esm.js'));

    const csp = JSON.stringify(manifest.content_security_policy || {});
    check('未放寬 CSP(無 unsafe-eval/unsafe-inline)',
        !/unsafe-eval|unsafe-inline/.test(csp), csp);

    // WAR 中的具體路徑(無萬用字元者)必須存在
    const concrete = war.filter((r) => !r.includes('*'));
    const missing = concrete.filter((r) => !fs.existsSync(path.join(EXT_ROOT, r)));
    check('WAR 中具體路徑都存在', missing.length === 0, missing.join(', '));

    // 每個 .wgx 都必須真的被 WAR 樣式涵蓋(2 層深)
    const wgxFiles = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.wgx')) wgxFiles.push(path.relative(EXT_ROOT, full).split(path.sep).join('/'));
        }
    };
    if (fs.existsSync(path.join(EXT_ROOT, 'wgx'))) walk(path.join(EXT_ROOT, 'wgx'));
    const uncovered = wgxFiles.filter((p) => !/^wgx\/[^/]+\/[^/]+\.wgx$/.test(p));
    check(`${wgxFiles.length} 個 .wgx 都符合 WAR 樣式`, uncovered.length === 0, uncovered.slice(0, 3).join(', '));
}

console.log(`\n=== 總結: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'} (${pass} passed) ===`);
if (fail) {
    console.log('失敗項目:');
    for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
