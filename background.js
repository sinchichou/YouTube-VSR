// YouTube VSR — background service worker (MV3)
//
// 職責 / Responsibilities:
//   1. 回應 popup 的「效果庫清單」請求。
//   2. 轉發導覽/播放事件與圖示狀態。
//
// 效果庫清單為什麼要讀索引 / Why the library is index-driven:
//   MV3 的 service worker **無法列舉**擴充套件內的檔案(沒有檔案系統 API,也沒有
//   「讀取目錄」的 API)。舊版於此硬編碼 6 條路徑,但實際上有 20 個 .wgsl +
//   127 個 .wgx 套件包 —— 清單必然與現實脫節。
//   因此改為讀取 `scripts/sync-wgfx.mjs` 在同步時產生的索引 `wgx/packages.json`:
//   那是同步當下就從每個套件包的 manifest.json 抽出的中繼資料
//   (id / name / family / description / parameters),清單永遠與實際檔案一致。
//
// 相關指令 / Messages:
//   getShaderFiles   → [{ kind, path, id, name, family, description, parameters, … }]
//   getLibraryStatus → { ok, error, counts, indexPath, … }(索引缺失時說明原因)
//   videoEnded       → 記錄用

/** 效果庫索引(由 scripts/sync-wgfx.mjs 產生) */
const INDEX_PATH = 'wgx/packages.json';
/** 雙語效果說明(人工維護;key = 去副檔名的基底名稱小寫,或完整 path) */
const DESC_PATH = 'effect-descriptions.json';
/** 允許出現在清單中的路徑前綴(白名單;避免索引被竄改後載入任意擴充套件資源) */
const ALLOWED_PREFIX = { wgx: 'wgx/', wgsl: 'effects_wgsl/' };

/** fetchResource 允許代抓的資源(僅限擴充套件自身的效果檔;不處理其他任何路徑) */
const RESOURCE_ALLOWLIST = [
    /^wgx\/[A-Za-z0-9_\-][A-Za-z0-9_\-./]*\.wgx$/i,
    /^effects_wgsl\/[A-Za-z0-9_\-][A-Za-z0-9_\-./]*\.wgsl$/i,
];

/** 單次代理回傳的位元組上限(保護訊息通道;現有套件包最大約 1 MB) */
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

/**
 * Uint8Array → base64(分塊組字串,避免 call stack / 參數數量上限)。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/**
 * 在背景(擴充套件自己的 origin)代抓擴充套件資源。
 * ---
 * 內容腳本直接 fetch chrome-extension:// 資源雖然因 web_accessible_resources
 * 而成功,但 Blink 會對頁面框架記「Unsafe attempt to load URL … Domains,
 * protocols and ports must match.」主控台錯誤。改由 service worker 取檔
 * (無頁面框架)即可消除該警告;內容腳本端在訊息失敗時仍可直接 fetch 後備。
 * @param {string} path 擴充套件相對路徑
 * @returns {Promise<{ok: boolean, data?: string, bytes?: number, error?: string}>}
 */
async function handleFetchResource(path) {
    if (typeof path !== 'string' || !RESOURCE_ALLOWLIST.some((re) => re.test(path))) {
        return { ok: false, error: 'path not allowed' };
    }
    try {
        const url = chrome.runtime.getURL(path);
        const res = await fetch(url);
        if (!res.ok) {
            return { ok: false, error: `HTTP ${res.status}` };
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > MAX_RESOURCE_BYTES) {
            return { ok: false, error: `resource too large (${buf.byteLength} bytes)` };
        }
        return { ok: true, data: bytesToBase64(buf), bytes: buf.byteLength };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/** 索引快取(service worker 重啟後會自動重建) */
let indexCache = null;
/** 雙語說明快取:{ byName: {nameLower: {en, zh}}, byPath: {path: {en, zh}} } */
let descCache = null;

/**
 * 載入雙語效果說明(容忍檔案缺失 —— 缺失時退回索引自帶的 description)。
 * @returns {Promise<{byName: object, byPath: object}>}
 */
async function loadDescriptions() {
    if (descCache) return descCache;
    try {
        const res = await fetch(chrome.runtime.getURL(DESC_PATH), { cache: 'no-cache' });
        if (res.ok) {
            const json = await res.json();
            descCache = {
                byName: (json && json.byName) || {},
                byPath: (json && json.byPath) || {},
            };
        } else {
            console.warn(`[VSR] 效果說明檔 ${DESC_PATH} 不存在(HTTP ${res.status}),改用索引自帶描述。`);
            descCache = { byName: {}, byPath: {} };
        }
    } catch (e) {
        console.warn('[VSR] 效果說明檔載入失敗,改用索引自帶描述:', (e && e.message) || e);
        descCache = { byName: {}, byPath: {} };
    }
    return descCache;
}

/**
 * 查單一效果的雙語說明:先比對完整 path(byPath 覆寫),再比對基底名稱(byName)。
 * @param {string} path 清單項目路徑
 * @param {string} baseName 去副檔名的基底名稱
 * @returns {{en: string, zh: string}|null}
 */
function lookupDescription(path, baseName) {
    const d = descCache;
    if (!d) return null;
    return d.byPath[path] || d.byName[String(baseName).toLowerCase()] || null;
}

/**
 * 讀取並驗證效果庫索引。
 * @returns {Promise<{json: object, entries: object[]}>}
 */
async function loadLibraryIndex() {
    if (indexCache) return indexCache;

    // 雙語說明先載入(容忍缺失);合併進每個清單項目
    await loadDescriptions();

    const url = chrome.runtime.getURL(INDEX_PATH);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) {
        throw new Error(
            `找不到效果庫索引 ${INDEX_PATH}(HTTP ${res.status})。請在專案目錄執行 \`npm run sync:wgfx\` 產生它。`
        );
    }
    let json;
    try {
        json = await res.json();
    } catch (e) {
        throw new Error(`效果庫索引 ${INDEX_PATH} 不是合法 JSON:${e.message}`);
    }

    const rawPackages = Array.isArray(json.packages) ? json.packages : [];
    const rawLegacy = Array.isArray(json.legacy) ? json.legacy : [];
    const skipped = [];
    const entries = [];
    for (const raw of [...rawPackages, ...rawLegacy]) {
        const entry = toLibraryEntry(raw);
        if (entry) entries.push(entry);
        else skipped.push(raw && raw.path ? raw.path : String(raw));
    }
    if (skipped.length) {
        console.warn(`[VSR] 索引中有 ${skipped.length} 個項目的路徑不合法,已略過:`, skipped);
    }

    indexCache = { json, entries };
    console.log(`[VSR] 效果庫索引已載入:${entries.length} 個效果(${INDEX_PATH})`);
    return indexCache;
}

/**
 * 索引項目 → 傳給 UI 的清單項目(欄位形狀與 task 契約一致,並附加 UI 需要的資訊)。
 * @param {object} raw
 * @returns {object|null} 路徑不合法時回傳 null
 */
function toLibraryEntry(raw) {
    if (!raw || typeof raw.path !== 'string') return null;
    const kind = raw.kind === 'wgx' ? 'wgx' : 'wgsl';
    if (!raw.path.startsWith(ALLOWED_PREFIX[kind])) return null;

    const base = raw.path.split('/').pop().replace(/\.(wgx|wgsl)$/i, '');
    // 雙語說明:人工維護的 effect-descriptions.json 優先;
    // byName 未命中時以索引自帶的 description 作為 EN 後備。
    const desc = lookupDescription(raw.path, base);
    return {
        kind,
        path: raw.path,
        id: String(raw.id || raw.path),
        name: String(raw.name || base),
        family: String(raw.family || 'Other'),
        description: String(raw.description || ''),
        descEn: (desc && desc.en) || String(raw.description || ''),
        descZh: (desc && desc.zh) || '',
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        passCount: Number(raw.passCount || 0),
        source: String(raw.source || ''),
        // `.wgx` 由索引提供參數中繼資料;legacy `.wgsl` 為 null(由 popup 解析檔案)
        parameters: Array.isArray(raw.parameters) ? raw.parameters : null,
    };
}

/**
 * 效果庫清單(套件包優先,其次 legacy .wgsl)。
 * @returns {Promise<object[]>}
 */
async function getShaderFiles() {
    const { entries } = await loadLibraryIndex();
    return entries;
}

/**
 * 索引健康狀態 —— 供 popup 在清單為空時顯示「可採取行動」的訊息。
 * @returns {Promise<object>}
 */
async function getLibraryStatus() {
    try {
        const { json, entries } = await loadLibraryIndex();
        return {
            ok: true,
            error: '',
            indexPath: INDEX_PATH,
            generatedAt: json.generatedAt || '',
            wgfxVersion: json.wgfxVersion || '',
            staleBundles: !!json.staleBundles,
            counts: json.counts || {},
            families: json.families || {},
            packageCount: entries.filter((e) => e.kind === 'wgx').length,
            legacyCount: entries.filter((e) => e.kind === 'wgsl').length,
        };
    } catch (e) {
        return {
            ok: false,
            error: e && e.message ? e.message : String(e),
            indexPath: INDEX_PATH,
            counts: {},
            families: {},
        };
    }
}

/**
 * 主控台橋接(注入頁面 MAIN world 執行)。
 * ---
 * DevTools 主控台預設在頁面 context(MAIN world)執行,看不到內容腳本隔離世界
 * 的物件。本函式以 chrome.scripting.executeScript({world:'MAIN'}) 注入 ——
 * 由瀏覽器發起的注入可繞過頁面 CSP(<script src=chrome-extension://...> 會被
 * YouTube 的 script-src 擋下)。注入後頁面可用:
 *   VSR.status()                      → 狀態快照(Promise)
 *   VSR.watermark() / watermark(bool) → 查詢 / 開關淺色水印(Promise)
 *   VSR.enable() / disable() / toggle() → 開關 VSR 本體(Promise)
 * 通訊方式:CustomEvent('vsr-console-cmd')送往內容腳本,以
 * CustomEvent('vsr-console-res')帶回結果(跨隔離世界以 structured clone 傳遞)。
 *
 * 注意:本函式會被 chrome.scripting 序列化,**不得**參考任何外部變數。
 */
function vsrConsoleBridgeMain() {
    const CMD = 'vsr-console-cmd';
    const RES = 'vsr-console-res';
    let seq = 0;
    const pending = new Map();

    // 回應監聽只註冊一次(重複注入 executeScript 時冪等)
    if (!window.__vsrBridgeListenerInstalled) {
        window.addEventListener(RES, (ev) => {
            const d = ev && ev.detail;
            if (!d || typeof d.id === 'undefined') return;
            const p = pending.get(d.id);
            if (p) {
                pending.delete(d.id);
                if (d.ok) p.resolve(d.result);
                else p.reject(new Error(d.error || 'VSR 指令失敗'));
            }
        });
        window.__vsrBridgeListenerInstalled = true;
    }

    const send = (command, value) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        window.dispatchEvent(new CustomEvent(CMD, { detail: { id, command, value } }));
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error('VSR 未回應(內容腳本可能尚未注入;請重新整理分頁)'));
            }
        }, 3000);
    });

    const api = {
        watermark: (on) => send('watermark', on),
        enable: () => send('setEnable', true),
        disable: () => send('setEnable', false),
        toggle: () => send('toggle'),
        status: () => send('status'),
    };
    try {
        Object.defineProperty(window, 'VSR', {
            value: api, configurable: true, writable: false, enumerable: true
        });
    } catch (e) {
        window.VSR = api;
    }
    console.info('[VSR] 主控台控制已就緒 — VSR.status() / VSR.watermark(true|false) / VSR.enable() / VSR.disable() / VSR.toggle()');
}

/**
 * 在指定分頁的 MAIN world 安裝主控台橋接。
 * @param {object} sender 來自 content script 的訊息 sender(含 tab.id)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function handleEnsureConsoleBridge(sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') {
        return { ok: false, error: 'no-tab' };
    }
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: vsrConsoleBridgeMain,
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

// 監聽來自 content scripts 或 popup 的訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 如果請求是獲取效果庫清單(套件包 + legacy .wgsl)
    if (request.command === 'getShaderFiles') {
        getShaderFiles()
            .then(sendResponse)
            .catch((err) => {
                console.error('[VSR] 讀取效果庫索引失敗:', err);
                sendResponse([]); // 契約是回傳陣列;錯誤細節由 getLibraryStatus 提供
            });
        return true; // 表示將異步發送響應
    }
    // 如果請求是取得索引狀態(供 UI 顯示精確的錯誤原因)
    if (request.command === 'getLibraryStatus') {
        getLibraryStatus().then(sendResponse);
        return true;
    }
    // 內容腳本請求代抓擴充套件資源(.wgx / .wgsl) — 在背景取檔可消除
    // 頁面框架的「Unsafe attempt to load URL」主控台錯誤
    if (request.command === 'fetchResource') {
        handleFetchResource(request.path).then(sendResponse);
        return true;
    }
    // 內容腳本請求在頁面 MAIN world 安裝主控台橋接(window.VSR)
    if (request.command === 'ensureConsoleBridge') {
        handleEnsureConsoleBridge(sender).then(sendResponse);
        return true;
    }
    // 如果請求是影片播放結束
    if (request.command === 'videoEnded') {
        console.log("背景腳本：分頁中的影片已播放完畢。");
    }
});

// ============================================================================
// 面板位置（快顯 ⇄ 側邊欄；選擇性功能）
// ---------------------------------------------------------------------------
// popup 的「面板位置」按鈕只寫 `panelMode` 到 storage；圖示行為由此處統一套用：
//   'popup'（預設）→ 點工具列圖示開快顯（manifest default_popup）
//   'side'         → 點工具列圖示開 Chrome 側邊欄（popup.html?panel=side）
// 切換側邊欄「內容/開關」需要 setOptions；把圖示點擊改成開側邊欄需要
// setPanelBehavior(openPanelOnActionClick) + 清空 action popup（空字串讓行為接手）。
// 開啟側邊欄本身（open()）需要 user gesture，由 popup 頁面直接呼叫 —— 不在此處。
// ============================================================================

/** 側邊欄載入的面板路徑（panel=side 讓 popup.js 套用縱向佈局） */
const PANEL_SIDEPATH = 'popup.html?panel=side';

/**
 * 依 panelMode 套用工具列圖示行為。
 * @param {string} mode 'popup' | 'side'
 */
async function applyPanelMode(mode) {
    if (!chrome.sidePanel) return; // 舊瀏覽器/測試環境：無此 API 即維持快顯
    try {
        if (mode === 'side') {
            await chrome.sidePanel.setOptions({ path: PANEL_SIDEPATH, enabled: true });
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
            await chrome.action.setPopup({ popup: '' });
        } else {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
            await chrome.action.setPopup({ popup: 'popup.html' });
        }
    } catch (e) {
        console.warn('[VSR] panelMode 套用失敗:', (e && e.message) || e);
    }
}

// panelMode 變更（來自 popup/側邊欄的按鈕）→ 立即套用
if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'panelMode')) {
            applyPanelMode(changes.panelMode.newValue || 'popup');
        }
    });
}

// 瀏覽器重啟後（service worker 冷啟動）恢復圖示行為
if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
        chrome.storage.local.get(['panelMode']).then((r) => applyPanelMode(r.panelMode));
    });
}

// 在擴充功能安裝或更新時觸發
chrome.runtime.onInstalled.addListener(() => {
    console.log("YouTube VSR 擴充功能已安裝/更新。");
    // 初始化存儲
    chrome.storage.local.set({
        isEnabled: false, // 預設為禁用
        pipeline: [] // 預設管線為空
    });
});

// 監聽分頁更新事件
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 檢查 URL 是否為 YouTube 觀看頁面
    if (tab.url && tab.url.includes("youtube.com/watch")) {
        // 如果 URL 發生變化 (例如，在同一個 YouTube 分頁中點擊另一個影片)
        if (changeInfo.url) {
            // 發送一個 "navigation" 指令到 content script，以重新初始化 VSR
            chrome.tabs.sendMessage(tabId, { command: "navigation" }).catch(err => {
                // 忽略連接錯誤，因為 content script 可能尚未注入
                if (!err.message.includes("Could not establish connection. Receiving end does not exist.")) {
                    console.error("VSR SendMessage 錯誤:", err);
                }
            });
        }
        // 啟用擴充功能的圖示
        chrome.action.enable(tabId);
    } else if (tab.url) {
        // 如果不是 YouTube 觀看頁面，則禁用圖示
        chrome.action.disable(tabId);
    }
});

// 監聽分頁切換事件
chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab && tab.url) {
            // 更新圖示狀態
            updateActionState(tab.id, tab.url);
        }
    });
});

/**
 * 根據 URL 更新擴充功能圖示的啟用/禁用狀態
 * @param {number} tabId - 分頁 ID
 * @param {string} url - 分頁的 URL
 */
function updateActionState(tabId, url) {
    if (url.includes("youtube.com/watch")) {
        chrome.action.enable(tabId);
    } else {
        chrome.action.disable(tabId);
    }
}
