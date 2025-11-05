chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.command === 'getShaderFiles') {
        // 在 Chrome 擴充功能中，我們無法像在 Node.js 中那樣動態掃描檔案系統。
        // 檔案列表必須是預先知道的。作為一個解決方案，我們可以在建置時生成一個 manifest.json 或一個 JS 檔案來包含所有著色器的路徑。
        // 當您將 wgsl 檔案加入 effects_wgsl 後，請手動更新此列表。
        const knownShaders = [
            // "Filters/Deband.wgsl",
            // "Sharpen/CAS.wgsl"
        ];
        
        Promise.resolve(knownShaders).then(sendResponse);
        return true; // 表示我們將非同步地呼叫 sendResponse
    }
});

// 監聽擴充功能安裝事件
chrome.runtime.onInstalled.addListener(() => {
    console.log("YouTube VSR extension installed/updated.");
    // 設定初始儲存值
    chrome.storage.local.set({
        isEnabled: false,
        pipeline: []
    });
});

// --- 啟用/停用擴充功能圖示的核心邏輯 ---

// 當分頁更新時觸發
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 檢查分頁是否載入完成且有 URL
    if (changeInfo.status === 'complete' && tab.url) {
        updateActionState(tabId, tab.url);
    }
});

// 當切換到不同分頁時觸發
chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab.url) {
            updateActionState(tab.id, tab.url);
        }
    });
});

function updateActionState(tabId, url) {
    if (url.includes("youtube.com/watch")) {
        // 如果是 YouTube 影片頁面，啟用圖示
        chrome.action.enable(tabId);
        console.log(`VSR Action enabled for tab: ${tabId}`);
    } else {
        // 否則，禁用圖示
        chrome.action.disable(tabId);
        console.log(`VSR Action disabled for tab: ${tabId}`);
    }
}