document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 元素 ---
    const libraryContent = document.getElementById('library-content');
    const pipelineList = document.getElementById('pipeline-list');
    const propertiesContent = document.getElementById('properties-content');
    const masterToggle = document.getElementById('master-toggle');

    // --- 狀態變數 ---
    let pipeline = []; // 渲染管線中的著色器陣列
    let selectedItemId = null;
    let shaderFiles = []; // 從 glob 獲取的著色器檔案列表

    //================================================================================
    // INITIALIZATION
    //================================================================================

    async function initialize() {
        await loadShaderFiles();
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
    // SHADER LIBRARY
    //================================================================================

    // 透過 background script 獲取 wgsl 檔案列表
    async function loadShaderFiles() {
        try {
            shaderFiles = await chrome.runtime.sendMessage({ command: 'getShaderFiles' });
            if (!shaderFiles || shaderFiles.length === 0) {
                 libraryContent.innerHTML = `<p style="padding: 15px; font-style: italic;">在 effects_wgsl 目錄中找不到 .wgsl 檔案。</p>`;
            }
        } catch (e) {
            libraryContent.innerHTML = `<p style="padding: 15px; color: var(--danger-color);">載入著色器列表失敗，請確認擴充功能權限。</p>`;
            console.error("YouTube VSR Error: Error loading shader files:", e);
        }
    }

    // 建立著色器庫 UI
    function buildShaderLibraryUI() {
        if (!shaderFiles || shaderFiles.length === 0) return;

        const categories = shaderFiles.reduce((acc, path) => {
            const parts = path.split('/');
            const fileName = parts.pop();
            const category = parts.length > 0 ? parts.join('/') : 'Root';
            if (!acc[category]) acc[category] = [];
            acc[category].push({ path, fileName });
            return acc;
        }, {});

        libraryContent.innerHTML = '';
        for (const category in categories) {
            const catDiv = document.createElement('div');
            catDiv.className = 'shader-category';
            const title = document.createElement('h4');
            title.textContent = category;
            const list = document.createElement('ul');
            list.className = 'shader-list';
            list.style.display = 'block'; // 預設展開

            title.onclick = () => { list.style.display = list.style.display === 'block' ? 'none' : 'block'; };

            categories[category].forEach(({ path, fileName }) => {
                const item = document.createElement('li');
                item.title = path;
                const nameSpan = document.createElement('span');
                nameSpan.className = 'shader-name';
                nameSpan.textContent = fileName.replace('.wgsl', '');
                
                const addButton = document.createElement('button');
                addButton.textContent = '+';
                addButton.className = 'add-btn';
                addButton.onclick = (e) => { e.stopPropagation(); addShaderToPipeline(path); };

                item.appendChild(nameSpan);
                item.appendChild(addButton);
                list.appendChild(item);
            });

            catDiv.appendChild(title);
            catDiv.appendChild(list);
            libraryContent.appendChild(catDiv);
        }
    }

    //================================================================================
    // RENDER PIPELINE
    //================================================================================
    
    // 將著色器加入管線
    async function addShaderToPipeline(path) {
        // 每個著色器在管線中都有一個唯一的實例ID
        const newItem = {
            instanceId: `inst_${Date.now()}`,
            path: path,
            params: {} // 參數的當前值將儲存在這裡
        };
        
        // 預先解析參數以儲存預設值
        const code = await loadShaderCode(path);
        const { uniforms } = parseUniforms(code);
        Object.values(uniforms.properties).forEach(prop => {
            newItem.params[prop.name] = prop.value;
        });

        pipeline.push(newItem);
        await saveAndNotifyPipelineChange();
        renderPipelineUI();
    }

    // 渲染管線 UI
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
            name.textContent = `${index + 1}. ${item.path.split('/').pop().replace('.wgsl', '')}`;
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
        if(!selectedItemId) renderPropertiesUI(null); // 如果沒有選中的，清空屬性面板
    }

    // 設定管線的拖放事件監聽
    function setupPipelineDragAndDrop() {
        let dragSourceId = null;
        pipelineList.addEventListener('dragstart', (e) => {
            dragSourceId = e.target.dataset.instanceId;
            e.dataTransfer.effectAllowed = 'move';
        });

        pipelineList.addEventListener('dragover', (e) => {
            e.preventDefault();
            const target = e.target.closest('.pipeline-item');
            if (target) {
                document.querySelectorAll('.pipeline-item').forEach(el => el.classList.remove('drag-over'));
                target.classList.add('drag-over');
            }
        });

        pipelineList.addEventListener('dragleave', (e) => {
            const target = e.target.closest('.pipeline-item');
            if (target) target.classList.remove('drag-over');
        });

        pipelineList.addEventListener('drop', async (e) => {
            e.preventDefault();
            document.querySelectorAll('.pipeline-item').forEach(el => el.classList.remove('drag-over'));
            const target = e.target.closest('.pipeline-item');
            if (!target || target.dataset.instanceId === dragSourceId) return;

            const sourceIndex = pipeline.findIndex(p => p.instanceId === dragSourceId);
            let targetIndex = pipeline.findIndex(p => p.instanceId === target.dataset.instanceId);

            const [movedItem] = pipeline.splice(sourceIndex, 1);
            pipeline.splice(targetIndex, 0, movedItem);
            
            await saveAndNotifyPipelineChange();
            renderPipelineUI();
        });
    }

    //================================================================================
    // PROPERTIES PANEL
    //================================================================================

    // 渲染屬性面板 UI
    async function renderPropertiesUI(item) {
        if (!item) {
            propertiesContent.innerHTML = `<p id="placeholder-text">在管線中選擇一個效果以編輯其屬性。</p>`;
            return;
        }

        try {
            const code = await loadShaderCode(item.path);
            const { uniforms } = parseUniforms(code);
            
            if (Object.keys(uniforms.properties).length === 0) {
                propertiesContent.innerHTML = `<p id="placeholder-text">此效果沒有可調整的參數。</p>`;
                return;
            }
            
            propertiesContent.innerHTML = '';
            Object.values(uniforms.properties).forEach(prop => {
                // 如果 storage 中有儲存的值，就用它，否則用預設值
                const currentValue = item.params[prop.name] !== undefined ? item.params[prop.name] : prop.value;

                const group = document.createElement('div');
                group.className = 'control-group';
                
                const valueSpan = document.createElement('span');
                valueSpan.textContent = parseFloat(currentValue).toFixed(2);
                
                const label = document.createElement('label');
                label.textContent = prop.name;
                label.appendChild(valueSpan);
                
                const input = document.createElement('input');
                input.type = 'range';
                input.min = prop.min;
                input.max = prop.max;
                input.step = prop.step;
                input.value = currentValue;
                
                input.addEventListener('input', (e) => {
                    const value = parseFloat(e.target.value);
                    valueSpan.textContent = value.toFixed(2);
                    item.params[prop.name] = value;
                });

                // 當拖曳結束時才儲存並通知，避免頻繁發送訊息
                input.addEventListener('change', () => {
                    saveAndNotifyParameterChange(item.instanceId, prop.name, item.params[prop.name]);
                });

                group.appendChild(label);
                group.appendChild(input);
                propertiesContent.appendChild(group);
            });
        } catch (e) {
            propertiesContent.innerHTML = `<p style="color:var(--danger-color); padding:15px;">讀取或解析著色器屬性時發生錯誤。</p>`;
            console.error(`Error loading/parsing shader ${item.path} for properties:`, e);
        }
    }

    // 載入著色器程式碼 (快取以避免重複載入)
    const shaderCodeCache = new Map();
    async function loadShaderCode(path) {
        if (shaderCodeCache.has(path)) {
            return shaderCodeCache.get(path);
        }
        const fullPath = chrome.runtime.getURL(`effects_wgsl/${path}`);
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

    // --- GO! ---
    initialize();
});