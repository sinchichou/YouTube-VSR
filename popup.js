/**
 * @file YouTube VSR — popup UI
 * @description 效果庫(Effect Library)+ 管線(Pipeline)+ 屬性(Properties)面板。
 *
 * 效果庫資料來源 / Library source:
 *   popup 不自己掃描檔案(也做不到),而是向 background 要清單
 *   (`getShaderFiles`)。該清單由 `scripts/sync-wgfx.mjs` 產生於
 *   `wgx/packages.json`,內容為 `.wgx` 預編套件包(來自 WGFX 的
 *   `npm run pack`),附帶 id / name / family / description / parameters 中繼資料。
 *   legacy `.wgsl` 路徑已移除:效果一律使用 `.wgx` 套件包。
 *
 * 管線項目形狀 / Pipeline item shape(存進 chrome.storage.local):
 *   { instanceId, kind:'wgx', path, id, name, family, params, parameterDefs }
 *   `path` + `params` 與舊版相同 —— content.js 只需看這兩個欄位即可相容;
 *   `kind` / `id` / `name` / `parameterDefs` 供 UI 顯示與參數面板使用。
 *   舊版儲存的 `kind:'wgsl'` 項目在 restoreSettings 時會被過濾掉(路徑已拔除)。
 */
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 元素 ---
    const libraryContent = document.getElementById('library-content');
    const pipelineList = document.getElementById('pipeline-list');
    const propertiesContent = document.getElementById('properties-content');
    const masterToggle = document.getElementById('master-toggle');
    const panelModeBtn = document.getElementById('panel-mode-btn');

    // --- 面板位置（選擇性功能：Chrome Side Panel）---
    //   * 以 `popup.html?panel=side` 被側邊欄載入時 → 縱向佈局 + 提供切回快顯
    //   * 一般快顯中 → 提供「釘到側邊欄」按鈕（寫入 panelMode，background 負責
    //     把工具列圖示行為切換成開側邊欄）
    //   * 不支援 chrome.sidePanel 的環境（舊瀏覽器 / 測試 stub）→ 按鈕隱藏
    const IS_SIDE_PANEL = new URLSearchParams(location.search).get('panel') === 'side';
    const HAS_SIDEPANEL = typeof chrome !== 'undefined' && !!chrome.sidePanel;

    // --- 狀態變數 ---
    let pipeline = []; // 渲染管線中的效果陣列
    let selectedItemId = null;
    let libraryEntries = []; // 效果庫(.wgx 套件包)
    let libraryError = ''; // 效果庫為空時的原因說明
    let instanceCounter = 0;

    /** 拖曳中的項目(供「效果庫 → 管線」與「管線內排序」共用) */
    let dragPayload = null;

    //================================================================================
    // INITIALIZATION
    //================================================================================

    async function initialize() {
        if (IS_SIDE_PANEL) document.body.classList.add('side-panel');
        await loadLibrary();
        buildShaderLibraryUI();
        await restoreSettings();
        setupEventListeners();
        setupPanelModeButton();
        setupConfigsUI();
        await loadConfigsState();
        renderConfigsUI();
    }

    // 從儲存中恢復設定
    async function restoreSettings() {
        const result = await chrome.storage.local.get(['isEnabled', 'pipeline']);
        masterToggle.checked = !!result.isEnabled;
        if (result.pipeline && Array.isArray(result.pipeline)) {
            // legacy `.wgsl` 路徑已拔除:過濾掉舊版儲存的 wgsl 管線項目
            const dropped = result.pipeline.filter((it) => it && it.kind === 'wgsl');
            if (dropped.length > 0) {
                console.info(`[VSR] 已移除 ${dropped.length} 個 legacy .wgsl 管線項目(效果一律使用 .wgx):`,
                    dropped.map((d) => d.path));
                await chrome.storage.local.set({ pipeline: result.pipeline.filter((it) => it && it.kind !== 'wgsl') });
            }
            pipeline = result.pipeline.filter((it) => it && it.kind !== 'wgsl');
        }
        renderPipelineUI();
    }

    //================================================================================
    // PANEL MODE（快顯 ⇄ 側邊欄；選擇性功能）
    //================================================================================

    /** 設定「面板位置」按鈕：不支援 sidePanel API 時隱藏；側邊欄模式中變成切回快顯 */
    function setupPanelModeButton() {
        if (!panelModeBtn) return;
        if (!HAS_SIDEPANEL) {
            panelModeBtn.style.display = 'none';
            return;
        }
        if (IS_SIDE_PANEL) {
            panelModeBtn.textContent = '快顯模式';
            panelModeBtn.title = '把預設面板位置切回快顯（工具列圖示點擊改開快顯；此側邊欄可直接關閉）';
        } else {
            panelModeBtn.textContent = '側邊欄';
            panelModeBtn.title = '把面板釘到瀏覽器側邊欄（之後點工具列圖示也會開在側邊欄）';
        }
        panelModeBtn.addEventListener('click', switchPanelMode);
    }

    /**
     * 切換預設面板位置。
     * 實際的圖示行為（setPopup / setPanelBehavior）由 background 監聽
     * storage.onChanged 統一套用；這裡只負責需要 user gesture 的部分：
     * 開啟側邊欄（open() 必須在手勢 context 內呼叫）與收起側邊欄。
     */
    async function switchPanelMode() {
        const next = IS_SIDE_PANEL ? 'popup' : 'side';
        await chrome.storage.local.set({ panelMode: next });
        if (next === 'side') {
            try {
                await chrome.sidePanel.setOptions({ path: 'popup.html?panel=side', enabled: true });
                const win = await chrome.windows.getCurrent();
                await chrome.sidePanel.open({ windowId: win.id });
                window.close(); // 讓側邊欄接手，收掉快顯
            } catch (e) {
                console.error('[VSR] 開啟側邊欄失敗:', e && e.message);
                panelModeBtn.textContent = '⚠ 側邊欄開啟失敗';
            }
        } else {
            try {
                await chrome.sidePanel.setOptions({ enabled: false }); // 收起側邊欄
            } catch (e) { /* 忽略：本來就沒開 */ }
            panelModeBtn.textContent = '✓ 已切回快顯模式';
        }
    }

    //================================================================================
    // CONFIGS（具名配置：儲存 / 套用 / 每部影片綁定自動切換）
    //================================================================================

    let configs = {};        // name → { pipeline, isEnabled, updatedAt }
    let videoConfigs = {};   // videoKey → config name（每部影片綁定）
    let currentVideo = null; // { key, url } | null（目前分頁的影片）

    /**
     * 從影片頁 URL 取出穩定的影片鍵。
     * YouTube: `yt:<videoId>`（/watch?v=…）；Twitch: `twitch:<頻道>`。
     * @param {string} url
     * @returns {string|null}
     */
    function videoKeyOf(url) {
        if (typeof url !== 'string') return null;
        try {
            const u = new URL(url);
            if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/watch') {
                const v = u.searchParams.get('v');
                return v ? `yt:${v}` : null;
            }
            if (/(^|\.)twitch\.tv$/.test(u.hostname)) {
                const seg = u.pathname.split('/').filter(Boolean)[0];
                return seg ? `twitch:${seg.toLowerCase()}` : null;
            }
        } catch { /* URL 解析失敗 */ }
        return null;
    }

    /** 載入配置狀態 + 偵測目前分頁影片；此影片有綁定配置時直接自動套用 */
    async function loadConfigsState() {
        const r = await chrome.storage.local.get(['configs', 'videoConfigs']);
        configs = (r.configs && typeof r.configs === 'object') ? r.configs : {};
        videoConfigs = (r.videoConfigs && typeof r.videoConfigs === 'object') ? r.videoConfigs : {};
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = Array.isArray(tabs) ? tabs[0] : null;
            const key = tab ? videoKeyOf(tab.url) : null;
            currentVideo = key ? { key, url: tab.url } : null;
        } catch {
            currentVideo = null;
        }

        // 「每部影片切換配置」的核心:此影片綁定了配置 → 開啟面板時自動套用
        const boundName = currentVideo ? videoConfigs[currentVideo.key] : null;
        if (boundName && configs[boundName]) {
            await applyConfig(boundName, { silent: true });
            setConfigStatus(`已自動套用此影片的配置「${boundName}」。`, true);
        }
    }

    /** 把目前的管線 + 開關狀態存成具名配置 */
    async function saveCurrentAsConfig(name) {
        const trimmed = String(name || '').trim();
        if (!trimmed) {
            setConfigStatus('請先輸入配置名稱。', false);
            return false;
        }
        configs[trimmed] = {
            pipeline: JSON.parse(JSON.stringify(pipeline)),
            isEnabled: !!masterToggle.checked,
            updatedAt: new Date().toISOString(),
        };
        await chrome.storage.local.set({ configs });
        renderConfigsUI();
        setConfigStatus(`已儲存配置「${trimmed}」（${pipeline.length} 個效果）。`, true);
        return true;
    }

    /** 套用配置:取代目前管線與開關,並通知 content.js */
    async function applyConfig(name, { silent = false } = {}) {
        const cfg = configs[name];
        if (!cfg || !Array.isArray(cfg.pipeline)) {
            setConfigStatus(`配置「${name}」不存在。`, false);
            return false;
        }
        pipeline = JSON.parse(JSON.stringify(cfg.pipeline));
        masterToggle.checked = !!cfg.isEnabled;
        selectedItemId = null;
        await chrome.storage.local.set({ pipeline, isEnabled: masterToggle.checked });
        await notifyContent({ command: 'setPipeline', pipeline });
        await notifyContent({ command: 'setEnable', isEnabled: masterToggle.checked });
        renderPipelineUI();
        renderConfigsUI();
        if (!silent) setConfigStatus(`已套用配置「${name}」（${pipeline.length} 個效果）。`, true);
        return true;
    }

    /** 刪除配置(同時清掉指向它的影片綁定) */
    async function deleteConfig(name) {
        if (!configs[name]) return false;
        delete configs[name];
        for (const k of Object.keys(videoConfigs)) {
            if (videoConfigs[k] === name) delete videoConfigs[k];
        }
        await chrome.storage.local.set({ configs, videoConfigs });
        renderConfigsUI();
        setConfigStatus(`已刪除配置「${name}」。`, true);
        return true;
    }

    /** 綁定 / 解除綁定目前影片的配置（name=null 解除；綁定後開啟影片自動套用） */
    async function bindVideoConfig(name) {
        if (!currentVideo) {
            setConfigStatus('目前分頁不是支援的影片頁。', false);
            return false;
        }
        if (!name || !configs[name]) {
            delete videoConfigs[currentVideo.key];
            setConfigStatus('已解除此影片的配置綁定。', true);
        } else {
            videoConfigs[currentVideo.key] = name;
            setConfigStatus(`此影片已綁定配置「${name}」— 之後開啟影片會自動套用。`, true);
        }
        await chrome.storage.local.set({ videoConfigs });
        renderConfigsUI();
        return true;
    }

    function setConfigStatus(msg, ok) {
        const el = document.getElementById('config-status');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('config-ok', ok === true);
    }

    /** 儲存列接線（名稱輸入 + 儲存鈕 / Enter） */
    function setupConfigsUI() {
        const saveBtn = document.getElementById('config-save-btn');
        const nameInput = document.getElementById('config-name-input');
        if (!saveBtn || !nameInput) return;
        const doSave = () => {
            saveCurrentAsConfig(nameInput.value);
            nameInput.value = '';
        };
        saveBtn.addEventListener('click', doSave);
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doSave();
        });
    }

    /** 渲染配置清單與「此影片」列（純 DOM API,測試 stub 相容） */
    function renderConfigsUI() {
        const list = document.getElementById('config-list');
        const videoRow = document.getElementById('config-video-row');
        if (!list) return;

        // ---- 此影片列 ----
        if (videoRow) {
            videoRow.textContent = '';
            if (currentVideo) {
                const bound = videoConfigs[currentVideo.key] || null;
                const label = document.createElement('span');
                label.textContent = '此影片：';
                const keySpan = document.createElement('span');
                keySpan.className = 'config-video-key';
                keySpan.textContent = currentVideo.key;
                videoRow.appendChild(label);
                videoRow.appendChild(keySpan);
                if (bound) {
                    const info = document.createElement('span');
                    info.textContent = ` — 綁定「${bound}」`;
                    videoRow.appendChild(info);
                    const unbindBtn = document.createElement('button');
                    unbindBtn.type = 'button';
                    unbindBtn.className = 'config-bind-btn';
                    unbindBtn.textContent = '解除綁定';
                    unbindBtn.addEventListener('click', () => bindVideoConfig(null));
                    videoRow.appendChild(unbindBtn);
                }
            } else {
                const hint = document.createElement('span');
                hint.textContent = '目前分頁不是支援的影片頁（YouTube /watch 或 Twitch）。';
                videoRow.appendChild(hint);
            }
        }

        // ---- 配置清單 ----
        list.textContent = '';
        const names = Object.keys(configs).sort(
            (a, b) => String(configs[b].updatedAt || '').localeCompare(String(configs[a].updatedAt || ''))
        );
        if (names.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'config-empty';
            empty.textContent = '還沒有配置 — 調好管線後取個名字按「儲存」。';
            list.appendChild(empty);
            return;
        }
        const currentJson = JSON.stringify(pipeline);
        for (const name of names) {
            const cfg = configs[name];
            const li = document.createElement('li');
            li.className = 'config-item';
            li.dataset.configName = name;
            // 內容與目前管線一致 → 標記為使用中
            if (JSON.stringify(cfg.pipeline) === currentJson) li.classList.add('active');

            const nameSpan = document.createElement('span');
            nameSpan.className = 'config-name';
            nameSpan.textContent = name;
            nameSpan.title = '點擊套用此配置';
            nameSpan.addEventListener('click', () => applyConfig(name));

            const meta = document.createElement('span');
            meta.className = 'config-meta';
            const count = Array.isArray(cfg.pipeline) ? cfg.pipeline.length : 0;
            meta.textContent = `${count} 效果`;

            const applyBtn = document.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'config-apply-btn';
            applyBtn.textContent = '套用';
            applyBtn.addEventListener('click', () => applyConfig(name));

            li.appendChild(nameSpan);
            li.appendChild(meta);
            li.appendChild(applyBtn);

            // 每部影片綁定（僅在影片頁顯示）
            if (currentVideo) {
                const isBound = videoConfigs[currentVideo.key] === name;
                const bindBtn = document.createElement('button');
                bindBtn.type = 'button';
                bindBtn.className = 'config-bind-btn' + (isBound ? ' bound' : '');
                bindBtn.textContent = isBound ? '已綁此影片' : '綁此影片';
                bindBtn.title = isBound
                    ? '點擊解除此影片的綁定'
                    : '此影片開啟時自動套用這個配置';
                bindBtn.addEventListener('click', () => bindVideoConfig(isBound ? null : name));
                li.appendChild(bindBtn);
            }

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'config-delete-btn';
            delBtn.textContent = '刪除';
            delBtn.title = '刪除此配置（同時解除相關影片綁定）';
            delBtn.addEventListener('click', () => deleteConfig(name));
            li.appendChild(delBtn);

            list.appendChild(li);
        }
    }

    //================================================================================
    // EFFECT LIBRARY
    //================================================================================

    /** 向 background 取得效果庫清單(並在失敗/為空時取得可採取行動的原因) */
    async function loadLibrary() {
        try {
            const raw = await chrome.runtime.sendMessage({ command: 'getShaderFiles' });
            libraryEntries = normalizeEntries(raw);
            if (libraryEntries.length === 0) {
                let status = null;
                try {
                    status = await chrome.runtime.sendMessage({ command: 'getLibraryStatus' });
                } catch (e) { /* 狀態查詢失敗時用預設訊息 */ }
                if (status && status.error) {
                    libraryError = `效果庫是空的。${status.error}`;
                } else if (status && status.ok) {
                    libraryError = '效果庫是空的:索引中沒有任何效果。請在 WGFX 執行 `npm run pack`,再於本專案執行 `npm run sync:wgfx`。';
                } else {
                    libraryError = '效果庫是空的。請執行 `npm run sync:wgfx` 產生 wgx/packages.json。';
                }
            }
        } catch (e) {
            libraryError = '載入效果庫失敗，請確認擴充功能權限。';
            console.error("YouTube VSR Error: Error loading library:", e);
        }
    }

    /**
     * 把 background 回傳的清單正規化。
     * 同時容忍舊版 background.js 回傳「純字串路徑陣列」的形式。
     * @param {any} raw
     * @returns {Array<object>}
     */
    function normalizeEntries(raw) {
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.files) ? raw.files : []);
        const out = [];
        for (const item of list) {
            if (typeof item === 'string') {
                out.push({
                    kind: 'wgx',
                    path: item,
                    id: item,
                    name: baseName(item),
                    family: familyOf(item),
                    description: '',
                    descEn: '',
                    descZh: '',
                    parameters: null,
                    tags: [],
                    passCount: 0,
                });
                continue;
            }
            if (!item || typeof item !== 'object' || !item.path) continue;
            if (item.kind === 'wgsl') continue; // legacy .wgsl 已移除
            out.push({
                kind: 'wgx',
                path: String(item.path),
                id: String(item.id || item.path),
                name: String(item.name || baseName(item.path)),
                family: String(item.family || familyOf(item.path)),
                description: String(item.description || ''),
                descEn: String(item.descEn || ''),
                descZh: String(item.descZh || ''),
                parameters: Array.isArray(item.parameters) ? item.parameters : null,
                tags: Array.isArray(item.tags) ? item.tags : [],
                passCount: Number(item.passCount || 0),
            });
        }
        return out;
    }

    function baseName(p) {
        return String(p).split('/').pop().replace(/\.(wgx|wgsl)$/i, '');
    }

    function familyOf(p) {
        const parts = String(p).split('/');
        return parts.length >= 2 ? parts[parts.length - 2] : 'Root';
    }

    /** 依 family 分組(套件包優先、其次 legacy;各自再依名稱排序) */
    function groupByFamily(entries) {
        const map = new Map();
        for (const entry of entries) {
            if (!map.has(entry.family)) map.set(entry.family, []);
            map.get(entry.family).push(entry);
        }
        return [...map.entries()]
            .map(([family, items]) => ({ family, items: items.slice().sort(compareEntries) }))
            .sort((a, b) => String(a.family).localeCompare(String(b.family), 'en'));
    }

    function compareEntries(a, b) {
        if (a.kind !== b.kind) return a.kind === 'wgx' ? -1 : 1;
        return a.name.localeCompare(b.name, 'en');
    }

    /** 建立效果庫 UI(依 family 分組;每項顯示 name / 中繼資訊 / 描述) */
    function buildShaderLibraryUI() {
        libraryContent.innerHTML = '';

        if (libraryEntries.length === 0) {
            const p = document.createElement('p');
            p.style.cssText = 'padding: 15px; font-style: italic; color: var(--text-secondary); line-height: 1.6;';
            p.textContent = libraryError || '找不到任何效果。';
            libraryContent.appendChild(p);
            return;
        }

        for (const { family, items } of groupByFamily(libraryEntries)) {
            const catDiv = document.createElement('div');
            catDiv.className = 'shader-category';

            const title = document.createElement('h4');
            title.textContent = `${family} (${items.length})`;

            const list = document.createElement('ul');
            list.className = 'shader-list';
            list.style.display = 'block'; // 預設展開

            title.onclick = () => { list.style.display = list.style.display === 'block' ? 'none' : 'block'; };

            for (const entry of items) list.appendChild(buildLibraryItem(entry));

            catDiv.appendChild(title);
            catDiv.appendChild(list);
            libraryContent.appendChild(catDiv);
        }
    }

    /** 建立單一效果庫項目(name + 中繼資訊 + 「+」按鈕,並支援拖曳到管線)
     *  說明以樣式化 tooltip 呈現(滑鼠移入/鍵盤 focus),不再用原生 title。 */
    function buildLibraryItem(entry) {
        const li = document.createElement('li');
        li.draggable = true;
        li.tabIndex = 0; // 鍵盤可達:focus 時也會顯示說明
        li.dataset.entryPath = entry.path;
        li.dataset.entryKind = entry.kind;
        li._vsrEntry = entry; // tooltip 測試與除錯用

        const main = document.createElement('div');
        main.style.cssText = 'min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column;';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'shader-name';
        nameSpan.textContent = entry.name;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'shader-meta';
        metaSpan.style.cssText = 'font-size: 11px; color: var(--text-secondary); opacity: 0.8; ' +
            'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        metaSpan.textContent = describeEntry(entry);

        main.appendChild(nameSpan);
        main.appendChild(metaSpan);

        const addButton = document.createElement('button');
        addButton.textContent = '+';
        addButton.className = 'add-btn';
        addButton.title = '加入管線';
        addButton.onclick = (e) => { e.stopPropagation(); addToPipeline(entry); };

        li.appendChild(main);
        li.appendChild(addButton);

        // tooltip 觸發(滑鼠 + 鍵盤)
        li.addEventListener('mouseenter', () => tooltip.show(entry, li));
        li.addEventListener('mouseleave', () => tooltip.hide());
        li.addEventListener('focus', () => tooltip.show(entry, li));
        li.addEventListener('blur', () => tooltip.hide());

        li.addEventListener('dragstart', (e) => {
            dragPayload = { kind: 'library', path: entry.path };
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'copy';
                try { e.dataTransfer.setData('text/plain', entry.path); } catch (err) { /* 非致命 */ }
            }
        });
        li.addEventListener('dragend', () => { dragPayload = null; });

        return li;
    }

    /** 項目下方的一行中繼資訊:.wgx、pass 數、參數數(完整說明在 tooltip) */
    function describeEntry(entry) {
        const bits = ['.wgx 套件包'];
        if (entry.passCount > 0) bits.push(`${entry.passCount} pass`);
        if (entry.parameters && entry.parameters.length > 0) bits.push(`${entry.parameters.length} 參數`);
        return bits.join(' · ');
    }

    //================================================================================
    // TOOLTIP — 樣式化雙語說明
    //================================================================================
    // 比照正規擴充功能的做法:不用原生 title(樣式不可控、延遲長、會與自訂框
    // 疊成雙重提示),改為自訂 tooltip:事件綁定在項目上(mouseenter/mouseleave/
    // focus/blur,鍵盤可達),定位夾限在 popup 視窗內,滑過清單時以短延遲防閃現。

    /** 安全取 rect(測試 stub 的元素沒有 getBoundingClientRect) */
    function safeRect(el) {
        if (el && typeof el.getBoundingClientRect === 'function') {
            return el.getBoundingClientRect();
        }
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    const tooltip = {
        el: null,
        timer: null,
        entry: null,
        _ensure() {
            if (this.el) return this.el;
            const el = document.createElement('div');
            el.id = 'vsr-tooltip';
            if (typeof el.setAttribute === 'function') el.setAttribute('role', 'tooltip');
            el.style.display = 'none';
            document.body.appendChild(el);
            this.el = el;
            return el;
        },
        _build(entry) {
            const t = this._ensure();
            t.innerHTML = '';
            const head = document.createElement('div');
            head.className = 'vsr-tip-name';
            head.textContent = entry.name || baseName(entry.path);
            const meta = document.createElement('div');
            meta.className = 'vsr-tip-meta';
            meta.textContent = describeEntry(entry);
            t.appendChild(head);
            t.appendChild(meta);
            if (entry.descZh) {
                const zh = document.createElement('div');
                zh.className = 'vsr-tip-zh';
                zh.textContent = entry.descZh;
                t.appendChild(zh);
            }
            if (entry.descEn) {
                const en = document.createElement('div');
                en.className = 'vsr-tip-en';
                en.textContent = entry.descEn;
                t.appendChild(en);
            }
            const pathEl = document.createElement('div');
            pathEl.className = 'vsr-tip-path';
            pathEl.textContent = entry.path;
            t.appendChild(pathEl);
            return t;
        },
        show(entry, anchor) {
            clearTimeout(this.timer);
            this.entry = entry;
            // 短延遲:滑鼠掃過清單時不閃現
            this.timer = setTimeout(() => {
                if (this.entry !== entry) return;
                const t = this._build(entry);
                const vw = (typeof window !== 'undefined' && window.innerWidth) || 800;
                const vh = (typeof window !== 'undefined' && window.innerHeight) || 600;
                const r = safeRect(anchor);
                t.style.display = 'block';
                const tw = t.offsetWidth || 320;
                const th = t.offsetHeight || 140;
                let left = (r.right || r.left) + 8;
                if (left + tw > vw - 8) left = Math.max(8, vw - tw - 8);
                let top = Math.max(8, (r.top || 0) - 6);
                if (top + th > vh - 8) top = Math.max(8, vh - th - 8);
                t.style.left = `${left}px`;
                t.style.top = `${top}px`;
                t.style.display = 'block';
            }, 120);
        },
        hide() {
            clearTimeout(this.timer);
            this.entry = null;
            if (this.el) this.el.style.display = 'none';
        },
    };

    //================================================================================
    // RENDER PIPELINE
    //================================================================================

    /**
     * 將效果加入管線。
     * 參數預設值取自索引中繼資料(不必解壓/解析 .wgx)。
     * @param {object} entry 效果庫項目
     */
    async function addToPipeline(entry) {
        const newItem = {
            instanceId: `inst_${Date.now()}_${(instanceCounter++).toString(36)}`,
            kind: 'wgx',
            path: entry.path,
            id: entry.id,
            name: entry.name,
            family: entry.family,
            params: {},
        };

        const defs = Array.isArray(entry.parameters) ? entry.parameters.map(normalizeParamDef) : [];
        newItem.parameterDefs = defs;
        for (const def of defs) newItem.params[def.name] = def.default;

        pipeline.push(newItem);
        await saveAndNotifyPipelineChange();
        renderPipelineUI();
    }

    /** 參數中繼資料正規化(索引欄位 → UI 需要的形狀) */
    function normalizeParamDef(p) {
        const name = String(p.name);
        return {
            name,
            label: String(p.label || name),
            type: String(p.type || 'float'),
            default: num(p.default, 0),
            min: num(p.min, 0),
            max: num(p.max, 1),
            step: num(p.step, 0.01),
        };
    }

    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d));

    /** 渲染管線 UI */
    function renderPipelineUI() {
        pipelineList.innerHTML = '';
        if (pipeline.length === 0) {
            pipelineList.innerHTML = `<p id="placeholder-text" style="padding:15px; text-align:center;">從左側拖曳或點擊 '+' 來加入效果。</p>`;
        }

        pipeline.forEach((item, index) => {
            const li = document.createElement('li');
            li.className = 'pipeline-item';
            li.dataset.instanceId = item.instanceId;
            li.draggable = true;

            const name = document.createElement('span');
            const label = item.name || baseName(item.path);
            name.textContent = `${index + 1}. ${label}`;
            name.title = item.id ? `${item.id}\n${item.path}` : item.path;
            li.appendChild(name);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.innerHTML = '&times;';
            removeBtn.onclick = async (e) => {
                e.stopPropagation();
                pipeline = pipeline.filter(p => p.instanceId !== item.instanceId);
                if (selectedItemId === item.instanceId) {
                    selectedItemId = null;
                    renderPropertiesUI(null);
                }
                await saveAndNotifyPipelineChange();
                renderPipelineUI();
            };
            li.appendChild(removeBtn);

            li.addEventListener('click', () => {
                selectedItemId = item.instanceId;
                document.querySelectorAll('.pipeline-item').forEach(el => el.classList.remove('selected'));
                li.classList.add('selected');
                renderPropertiesUI(item);
            });

            pipelineList.appendChild(li);
        });

        // 維護選中狀態
        if (selectedItemId) {
            const el = pipelineList.querySelector(`[data-instance-id="${selectedItemId}"]`);
            if (el) el.classList.add('selected');
            else selectedItemId = null; // 如果選擇的項目被刪除了, 清除ID
        }
        if (!selectedItemId) renderPropertiesUI(null); // 如果沒有選中的，清空屬性面板
    }

    // 設定管線的拖放事件監聽(管線內排序 + 從效果庫拖入)
    function setupPipelineDragAndDrop() {
        pipelineList.addEventListener('dragstart', (e) => {
            const item = e.target.closest ? e.target.closest('.pipeline-item') : null;
            if (!item) return;
            dragPayload = { kind: 'pipeline', instanceId: item.dataset.instanceId };
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        pipelineList.addEventListener('dragend', () => { dragPayload = null; });

        pipelineList.addEventListener('dragover', (e) => {
            e.preventDefault();
            const target = e.target.closest ? e.target.closest('.pipeline-item') : null;
            if (target) {
                document.querySelectorAll('.pipeline-item').forEach(el => el.classList.remove('drag-over'));
                target.classList.add('drag-over');
            }
        });

        pipelineList.addEventListener('dragleave', (e) => {
            const target = e.target.closest ? e.target.closest('.pipeline-item') : null;
            if (target) target.classList.remove('drag-over');
        });

        pipelineList.addEventListener('drop', async (e) => {
            e.preventDefault();
            document.querySelectorAll('.pipeline-item').forEach(el => el.classList.remove('drag-over'));

            // (1) 從效果庫拖入 → 加入管線
            const payload = readDragPayload(e);
            if (payload && payload.kind === 'library') {
                const entry = libraryEntries.find(x => x.path === payload.path);
                if (entry) await addToPipeline(entry);
                dragPayload = null;
                return;
            }

            // (2) 管線內重新排序
            const target = e.target.closest ? e.target.closest('.pipeline-item') : null;
            if (!target) return;
            const sourceId = (payload && payload.kind === 'pipeline' ? payload.instanceId : null);
            if (!sourceId || target.dataset.instanceId === sourceId) return;

            const sourceIndex = pipeline.findIndex(p => p.instanceId === sourceId);
            const targetIndex = pipeline.findIndex(p => p.instanceId === target.dataset.instanceId);
            if (sourceIndex < 0 || targetIndex < 0) return;

            const [movedItem] = pipeline.splice(sourceIndex, 1);
            pipeline.splice(targetIndex, 0, movedItem);

            await saveAndNotifyPipelineChange();
            renderPipelineUI();
        });
    }

    /** 取得本次拖放的目的資料(優先使用記憶體中的 payload,其次是 dataTransfer) */
    function readDragPayload(e) {
        if (dragPayload) return dragPayload;
        const dt = e && e.dataTransfer;
        if (dt && typeof dt.getData === 'function') {
            let path = '';
            try { path = dt.getData('text/plain') || ''; } catch (err) { path = ''; }
            if (path) return { kind: 'library', path };
        }
        return null;
    }

    //================================================================================
    // PROPERTIES PANEL
    //================================================================================

    /** 渲染屬性面板 UI */
    async function renderPropertiesUI(item) {
        if (!item) {
            propertiesContent.innerHTML = `<p id="placeholder-text">在管線中選擇一個效果以編輯其屬性。</p>`;
            return;
        }

        try {
            // 參數中繼資料在加入管線時由 .wgx 索引提供;
            // 舊版已存、缺少此欄位的項目 → 沒有可解析的來源,視為無參數。
            let defs = Array.isArray(item.parameterDefs) ? item.parameterDefs : [];
            if (!Array.isArray(item.parameterDefs)) {
                item.parameterDefs = defs; // 快取在項目上
            }

            if (defs.length === 0) {
                propertiesContent.innerHTML = `<p id="placeholder-text">此效果沒有可調整的參數。</p>`;
                return;
            }

            propertiesContent.innerHTML = '';
            for (const def of defs) {
                const propName = def.name;
                const currentValue = item.params[propName] !== undefined ? item.params[propName] : def.default;

                const group = document.createElement('div');
                group.className = 'control-group';

                const valueSpan = document.createElement('span');
                valueSpan.textContent = parseFloat(currentValue).toFixed(2);

                const label = document.createElement('label');
                label.textContent = def.label || propName;
                label.appendChild(valueSpan);

                const input = document.createElement('input');
                input.type = 'range';
                input.min = def.min;
                input.max = def.max;
                input.step = def.step;
                input.value = currentValue;

                input.addEventListener('input', (e) => {
                    const value = parseFloat(e.target.value);
                    valueSpan.textContent = value.toFixed(2);
                    item.params[propName] = value;
                });

                // 當拖曳結束時才儲存並通知，避免頻繁發送訊息
                input.addEventListener('change', () => {
                    saveAndNotifyParameterChange(item.instanceId, propName, item.params[propName]);
                });

                group.appendChild(label);
                group.appendChild(input);
                propertiesContent.appendChild(group);
            }
        } catch (e) {
            propertiesContent.innerHTML = `<p style="color:var(--danger-color); padding:15px;">讀取或解析效果屬性時發生錯誤。</p>`;
            console.error(`Error loading/parsing effect ${item.path} for properties:`, e);
        }
    }

    // legacy `.wgsl` 參數解析器(parseParamDirectives/parseUniforms/readLegacyParamDefs)
    // 已隨 legacy 路徑移除 —— 參數一律取自 .wgx 套件包的索引中繼資料。

    //================================================================================
    // EVENT LISTENERS & NOTIFIERS
    //================================================================================

    /**
     * 判斷分頁 URL 是否為 content script 注入的支援頁面(與 manifest.json 一致)。
     */
    function isSupportedVideoURL(url) {
        return typeof url === 'string' &&
            /^https:\/\/(www\.)?(youtube\.com\/watch|twitch\.tv\/)/i.test(url);
    }

    /**
     * 傳訊息給目前分頁的 content script。
     *
     * 「Could not establish connection. Receiving end does not exist.」的兩個來源:
     *   1. 作用分頁不是支援的影片頁(非 youtube.com/watch 或 twitch.tv);
     *   2. 擴充套件重載後,既有分頁的 content script 已孤兒化(監聽器失效),
     *      在頁面重新整理之前收不到任何訊息。
     * 對 (2) 以 chrome.scripting.executeScript 重新注入 content.js 後重試
     * (content.js 的監聽器在模組載入後才註冊,故以遞增延遲重試數次)。
     *
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async function sendToContent(message) {
        // callback 形式包成 Promise:真實 MV3 與 scripts/verify-popup.mjs 的 stub 都相容
        const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
        const tab = tabs && tabs[0];
        if (!tab) return { ok: false, reason: 'no-tab' };
        if (!isSupportedVideoURL(tab.url)) return { ok: false, reason: 'unsupported-page' };

        try {
            await chrome.tabs.sendMessage(tab.id, message);
            return { ok: true };
        } catch (err) {
            const msgText = String((err && err.message) || err);
            if (!/Receiving end does not exist|Could not establish connection/i.test(msgText)) {
                return { ok: false, reason: 'error', error: err };
            }
        }

        // 接收端不存在 → 重新注入 content.js 後重試(修復「重載擴充套件後舊分頁失聯」)
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        } catch (e2) {
            return { ok: false, reason: 'inject-failed', error: e2 };
        }
        for (const delay of [150, 400, 800]) {
            await new Promise((r) => setTimeout(r, delay));
            try {
                await chrome.tabs.sendMessage(tab.id, message);
                return { ok: true };
            } catch (e3) { /* 監聽器尚未就緒,繼續重試 */ }
        }
        return { ok: false, reason: 'no-receiver' };
    }

    /** 把失敗原因轉成使用者能採取行動的提示(popup 內浮現,數秒後消失) */
    function flashStatus(text) {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'position:fixed; left:12px; right:12px; bottom:12px; z-index:99;' +
            'padding:10px 12px; border-radius:8px; font-size:12px; line-height:1.5;' +
            'background:var(--bg-secondary, #2a2a2a); color:var(--text-primary, #eee);' +
            'border:1px solid var(--danger-color, #e53935); box-shadow:0 4px 14px rgba(0,0,0,.4);';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }

    /** 儲存後通知 content.js;失敗時在 popup 內給出可採取行動的提示(不再丟未處理 rejection) */
    async function notifyContent(message) {
        const res = await sendToContent(message);
        if (!res.ok) {
            const MESSAGES = {
                'unsupported-page': '這個分頁不是 YouTube/Twitch 影片頁 — 請開啟影片頁面再套用效果。',
                'no-tab': '找不到作用中的分頁。',
                'inject-failed': '無法在此頁面注入(VSP 僅支援 YouTube/Twitch 影片頁)。',
                'no-receiver': '與影片頁的連線中斷 — 請重新整理 YouTube 分頁後再試。',
            };
            flashStatus(MESSAGES[res.reason] || '通知影片頁失敗,請重新整理分頁。');
            console.warn('[VSR] notifyContent failed:', res);
        }
        return res;
    }

    function setupEventListeners() {
        masterToggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ isEnabled: masterToggle.checked });
            await notifyContent({ command: "setEnable", isEnabled: masterToggle.checked });
        });

        setupPipelineDragAndDrop();
    }

    // 儲存完整管線並通知 content.js
    async function saveAndNotifyPipelineChange() {
        await chrome.storage.local.set({ pipeline: pipeline });
        await notifyContent({ command: "setPipeline", pipeline: pipeline });
    }

    // 儲存單一參數變更並通知 content.js
    async function saveAndNotifyParameterChange(instanceId, paramName, value) {
        // 僅更新 pipeline 陣列中的參數值並儲存
        await chrome.storage.local.set({ pipeline: pipeline });
        await notifyContent({
            command: "updateParameter",
            instanceId: instanceId,
            paramName: paramName,
            value: value
        });
    }

    // --- 測試接縫 / Test seam ---
    // 只有在 scripts/verify-popup.mjs 明確設定旗標時才暴露內部函式,
    // 讓「DOM 產出」可以在 Node 中以假的 DOM/chrome 驗證,正式執行時不污染全域。
    if (globalThis.__VSR_POPUP_TEST__) {
        globalThis.__VSR_POPUP_HOOKS__ = {
            initialize,
            normalizeEntries,
            groupByFamily,
            buildShaderLibraryUI,
            buildLibraryItem,
            describeEntry,
            addToPipeline,
            normalizeParamDef,
            renderPipelineUI,
            renderPropertiesUI,
            getState: () => ({ pipeline, libraryEntries, libraryError, selectedItemId }),
            setLibrary: (entries) => { libraryEntries = entries; },
            setPipeline: (items) => { pipeline = items; },
            // configs 測試接縫
            videoKeyOf,
            loadConfigsState,
            saveCurrentAsConfig,
            applyConfig,
            deleteConfig,
            bindVideoConfig,
            renderConfigsUI,
            setMasterToggle: (v) => { masterToggle.checked = !!v; },
            getConfigsState: () => ({ configs, videoConfigs, currentVideo }),
            setConfigs: (c, v) => { configs = c || {}; videoConfigs = v || {}; },
            setCurrentVideo: (v) => { currentVideo = v; },
            showTooltip: (entry, anchor) => tooltip.show(entry, anchor),
            hideTooltip: () => tooltip.hide(),
            tooltipElement: () => tooltip.el,
        };
    }

    // --- GO! ---
    initialize();
});
