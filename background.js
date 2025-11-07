// 監聽來自 content scripts 或 popup 的訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 如果請求是獲取著色器文件列表
    if (request.command === 'getShaderFiles') {
        const knownShaders = [
            "effects_wgsl/Anime4K_Denoise_Bilateral_Median.wgsl"
            // "Sharpen/CAS.wgsl"
        ];

        // 返回著色器文件列表
        Promise.resolve(knownShaders).then(sendResponse);
        return true; // 表示將異步發送響應
    }
    // 如果請求是影片播放結束
    else if (request.command === 'videoEnded') {
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
