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
/** 允許出現在清單中的路徑前綴(白名單;避免索引被竄改後載入任意擴充套件資源) */
const ALLOWED_PREFIX = { wgx: 'wgx/', wgsl: 'effects_wgsl/' };

/** 索引快取(service worker 重啟後會自動重建) */
let indexCache = null;

/**
 * 讀取並驗證效果庫索引。
 * @returns {Promise<{json: object, entries: object[]}>}
 */
async function loadLibraryIndex() {
    if (indexCache) return indexCache;

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
    return {
        kind,
        path: raw.path,
        id: String(raw.id || raw.path),
        name: String(raw.name || base),
        family: String(raw.family || 'Other'),
        description: String(raw.description || ''),
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
    // 如果請求是影片播放結束
    if (request.command === 'videoEnded') {
        console.log("背景腳本：分頁中的影片已播放完畢。");
    }
});

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
