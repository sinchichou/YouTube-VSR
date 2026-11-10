/**
 * @file YouTube VSR — popup UI
 * @description 效果庫(Effect Library)+ 管線(Pipeline)+ 屬性(Properties)面板。
 *
 * 效果庫資料來源 / Library source:
 *   popup 不自己掃描檔案(也做不到),而是向 background 要清單
 *   (`getShaderFiles`)。該清單由 `scripts/sync-wgfx.mjs` 產生於
 *   `wgx/packages.json`,內容包含:
 *     - `.wgx` 預編套件包(來自 WGFX 的 `npm run pack`),附帶 id / name /
 *       family / description / parameters 中繼資料;
 *     - legacy `.wgsl`(effects_wgsl/ 下既有檔案),仍可被列出與加入管線。
 *
 * 管線項目形狀 / Pipeline item shape(存進 chrome.storage.local):
 *   { instanceId, kind:'wgx'|'wgsl', path, id, name, family, params, parameterDefs }
 *   其中 `path` + `params` 與舊版相同 —— content.js 只需看這兩個欄位即可相容;
 *   `kind` / `id` / `name` / `parameterDefs` 供 UI 顯示與參數面板使用。
 */
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 元素 ---
    const libraryContent = document.getElementById('library-content');
    const pipelineList = document.getElementById('pipeline-list');
    const propertiesContent = document.getElementById('properties-content');
    const masterToggle = document.getElementById('master-toggle');

    // --- 狀態變數 ---
    let pipeline = []; // 渲染管線中的效果陣列
    let selectedItemId = null;
    let libraryEntries = []; // 效果庫(套件包 + legacy .wgsl)
    let libraryError = ''; // 效果庫為空時的原因說明
    let instanceCounter = 0;

    /** 拖曳中的項目(供「效果庫 → 管線」與「管線內排序」共用) */
    let dragPayload = null;

    //================================================================================
    // INITIALIZATION
    //================================================================================

    async function initialize() {
        await loadLibrary();
        buildShaderLibraryUI();
        await restoreSettings();
        setupEventListeners();
    }

    // 從儲存中恢復設定
    async function restoreSettings() {
        const result = await chrome.storage.local.get(['isEnabled', 'pipeline']);
        masterToggle.checked = !!result.isEnabled;
        if (result.pipeline && Array.isArray(result.pipeline)) {
            pipeline = result.pipeline;
        }
        renderPipelineUI();
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
                    kind: /\.wgx$/i.test(item) ? 'wgx' : 'wgsl',
                    path: item,
                    id: item,
                    name: baseName(item),
                    family: familyOf(item),
                    description: '',
                    parameters: null,
                    tags: [],
                    passCount: 0,
                });
                continue;
            }
            if (!item || typeof item !== 'object' || !item.path) continue;
            out.push({
                kind: item.kind === 'wgx' ? 'wgx' : 'wgsl',
                path: String(item.path),
                id: String(item.id || item.path),
                name: String(item.name || baseName(item.path)),
                family: String(item.family || familyOf(item.path)),
                description: String(item.description || ''),
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

    /** 建立單一效果庫項目(name + 中繼資訊 + 「+」按鈕,並支援拖曳到管線) */
    function buildLibraryItem(entry) {
        const li = document.createElement('li');
        li.title = entry.description ? `${entry.path}\n\n${entry.description}` : entry.path;
        li.draggable = true;
        li.dataset.entryPath = entry.path;
        li.dataset.entryKind = entry.kind;

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

    /** 項目下方的一行中繼資訊:.wgx/.wgsl、pass 數、參數數、描述 */
    function describeEntry(entry) {
        const bits = [entry.kind === 'wgx' ? '.wgx 套件包' : '.wgsl'];
        if (entry.kind === 'wgx' && entry.passCount > 0) bits.push(`${entry.passCount} pass`);
        if (entry.parameters && entry.parameters.length > 0) bits.push(`${entry.parameters.length} 參數`);
        if (entry.description) bits.push(entry.description);
        return bits.join(' · ');
    }

    //================================================================================
    // RENDER PIPELINE
    //================================================================================

    /**
     * 將效果加入管線。
     * 參數預設值:`.wgx` 取自索引中繼資料(不必解壓/解析),legacy `.wgsl` 則解析檔案。
     * @param {object} entry 效果庫項目
     */
    async function addToPipeline(entry) {
        const newItem = {
            instanceId: `inst_${Date.now()}_${(instanceCounter++).toString(36)}`,
            kind: entry.kind,
            path: entry.path,
            id: entry.id,
            name: entry.name,
            family: entry.family,
            params: {},
        };

        let defs = [];
        if (entry.kind === 'wgx' && Array.isArray(entry.parameters)) {
            defs = entry.parameters.map(normalizeParamDef);
        } else {
            defs = await readLegacyParamDefs(entry.path);
        }
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
            if (item.kind === 'wgsl') name.title = `${item.path}(legacy .wgsl)`;
            else name.title = item.id ? `${item.id}\n${item.path}` : item.path;
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
            // 優先用加入管線時保存的參數中繼資料(.wgx 由索引提供);
            // 舊版已存的管線項目沒有這個欄位 → 回頭解析 legacy .wgsl。
            let defs = Array.isArray(item.parameterDefs) ? item.parameterDefs : null;
            if (!defs) {
                defs = await readLegacyParamDefs(item.path);
                item.parameterDefs = defs; // 快取在項目上,避免重複抓檔
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

    /**
     * legacy `.wgsl`:抓檔並解析 `//!PARAMETER`(轉成與 .wgx 相同的 defs 形狀)。
     * legacy 由檔案本身的 codegen 註解提供 min/max/step/default。
     */
    async function readLegacyParamDefs(path) {
        const code = await loadShaderCode(path);
        const { uniforms } = parseUniforms(code);
        return Object.values(uniforms.properties).map(prop => ({
            name: prop.name,
            label: prop.name,
            type: prop.type,
            default: prop.value,
            min: prop.min,
            max: prop.max,
            step: prop.step,
        }));
    }

    // 載入著色器程式碼 (快取以避免重複載入)
    const shaderCodeCache = new Map();
    async function loadShaderCode(path) {
        if (shaderCodeCache.has(path)) {
            return shaderCodeCache.get(path);
        }
        // The path from background.js is already the full path relative to the extension root.
        const fullPath = chrome.runtime.getURL(path);
        const code = await fetch(fullPath).then(res => res.text());
        shaderCodeCache.set(path, code);
        return code;
    }

    // 解析 WGSL 中的 uniform 參數
    function parseUniforms(shaderCode) {
        const uniforms = { properties: {}, size: 0, binding: -1 };
        const uniformRegex = /@group\(0\)\s*@binding\((\d+)\)\s*var<uniform>\s*\w+\s*:\s*(\w+)\s*;/;
        const uniformMatch = shaderCode.match(uniformRegex);

        if (!uniformMatch) return { uniforms };

        uniforms.binding = parseInt(uniformMatch[1], 10);
        const structName = uniformMatch[2];

        const structRegex = new RegExp(`struct\s+${structName}\\\s*{([^}]+)}`, 's');
        const structMatch = shaderCode.match(structRegex);

        if (!structMatch) return { uniforms };

        const membersRegex = /([^;]+);\s*(\/\/.*)?/g;
        let memberMatch;
        let currentOffset = 0;

        while ((memberMatch = membersRegex.exec(structMatch[1])) !== null) {
            const memberLine = memberMatch[1].trim();
            const comment = memberMatch[2] || '';
            const parts = memberLine.split(':');
            if (parts.length < 2) continue;

            const name = parts[0].replace(/@.*/, '').trim();
            const type = parts[1].trim();

            if (type === 'f32') {
                const min = /ui_min=([0-9.-]+)/.exec(comment)?.[1] ?? 0.0;
                const max = /ui_max=([0-9.-]+)/.exec(comment)?.[1] ?? 1.0;
                const step = /ui_step=([0-9.-]+)/.exec(comment)?.[1] ?? 0.01;
                const def = /ui_default=([0-9.-]+)/.exec(comment)?.[1] ?? 0.5;

                uniforms.properties[name] = {
                    name: name, type: 'f32', offset: currentOffset,
                    value: parseFloat(def), min: parseFloat(min), max: parseFloat(max), step: parseFloat(step),
                };
                currentOffset += 4; // f32 is 4 bytes
            }
            //未來可擴充支援 vec2, vec3, i32 等
        }
        uniforms.size = Math.max(16, Math.ceil(currentOffset / 16) * 16); // 確保最小為 16 bytes 且為 16 的倍數
        return { uniforms };
    }

    //================================================================================
    // EVENT LISTENERS & NOTIFIERS
    //================================================================================

    function setupEventListeners() {
        masterToggle.addEventListener('change', async () => {
            await chrome.storage.local.set({ isEnabled: masterToggle.checked });
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                chrome.tabs.sendMessage(tabs[0].id, { command: "setEnable", isEnabled: masterToggle.checked });
            });
        });

        setupPipelineDragAndDrop();
    }

    // 儲存完整管線並通知 content.js
    async function saveAndNotifyPipelineChange() {
        await chrome.storage.local.set({ pipeline: pipeline });
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { command: "setPipeline", pipeline: pipeline });
            }
        });
    }

    // 儲存單一參數變更並通知 content.js
    async function saveAndNotifyParameterChange(instanceId, paramName, value) {
        // 僅更新 pipeline 陣列中的參數值並儲存
        await chrome.storage.local.set({ pipeline: pipeline });
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    command: "updateParameter",
                    instanceId: instanceId,
                    paramName: paramName,
                    value: value
                });
            }
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
            parseUniforms,
            readLegacyParamDefs,
            getState: () => ({ pipeline, libraryEntries, libraryError, selectedItemId }),
            setLibrary: (entries) => { libraryEntries = entries; },
            setPipeline: (items) => { pipeline = items; },
        };
    }

    // --- GO! ---
    initialize();
});
