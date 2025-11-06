chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.command === 'getShaderFiles') {
        const knownShaders = [
            "effects_wgsl/Anime4K_Denoise_Bilateral_Median.wgsl"
            // "Sharpen/CAS.wgsl"
        ];
        
        Promise.resolve(knownShaders).then(sendResponse);
        return true;
    }
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("YouTube VSR extension installed/updated.");
    chrome.storage.local.set({
        isEnabled: false,
        pipeline: []
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // *** KEY CHANGE: 偵測 URL 的實際變化 ***
    // 只有當 changeInfo.url 存在時，才表示分頁的 URL 發生了變化 (SPA 導航)
    if (tab.url && tab.url.includes("youtube.com/watch")) {
        // 如果是 URL 變化，就發送一個導航訊息
        if (changeInfo.url) {
            chrome.tabs.sendMessage(tabId, { command: "navigation" }).catch(err => {
                if (!err.message.includes("Could not establish connection. Receiving end does not exist.")) {
                    console.error("VSR SendMessage Error:", err);
                }
            });
        }
        // 無論如何，都要確保圖示狀態正確
        chrome.action.enable(tabId);
    } else if (tab.url) {
        chrome.action.disable(tabId);
    }
});


chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab && tab.url) {
            updateActionState(tab.id, tab.url);
        }
    });
});

function updateActionState(tabId, url) {
    if (url.includes("youtube.com/watch")) {
        chrome.action.enable(tabId);
    } else {
        chrome.action.disable(tabId);
    }
}