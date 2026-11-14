(() => {
    // =========================================================================
    // 1. 面板可收合 / 可拖動調大小 / 可拖動交換順序
    // =========================================================================
    const mainContainer = document.getElementById('main-container');
    if (mainContainer) {
        const DEFAULT_ORDER = ['shader-library', 'pipeline-container', 'properties-panel'];
        const DEFAULT_WEIGHTS = {
            popup: { 'shader-library': 288, 'pipeline-container': 280, 'properties-panel': 232 },
            side:  { 'shader-library': 38,  'pipeline-container': 34,  'properties-panel': 28  }
        };

        const isSidePanel = () => document.body.classList.contains('side-panel');
        const modeKey = () => (isSidePanel() ? 'side' : 'popup');
        const storageKey = () => `vsr_panel_layout_${modeKey()}`;

        const panels = Array.from(mainContainer.querySelectorAll(':scope > .panel'));
        if (panels.length > 0) {
            const panelMap = new Map(panels.map((p) => [p.id, p]));
            const resizers = [];
            let state = loadState();

            function getDefaultState() {
                return {
                    order: [...DEFAULT_ORDER],
                    collapsed: {},
                    weights: { ...DEFAULT_WEIGHTS[modeKey()] }
                };
            }

            function loadState() {
                const def = getDefaultState();
                try {
                    const raw = localStorage.getItem(storageKey());
                    if (!raw) return def;
                    const parsed = JSON.parse(raw);
                    const validOrder = Array.isArray(parsed.order)
                        ? parsed.order.filter((id) => panelMap.has(id))
                        : [];
                    for (const id of DEFAULT_ORDER) {
                        if (!validOrder.includes(id) && panelMap.has(id)) validOrder.push(id);
                    }
                    return {
                        order: validOrder,
                        collapsed: parsed.collapsed && typeof parsed.collapsed === 'object' ? parsed.collapsed : {},
                        weights: { ...def.weights, ...(parsed.weights || {}) }
                    };
                } catch {
                    return def;
                }
            }

            function saveState() {
                try {
                    localStorage.setItem(storageKey(), JSON.stringify(state));
                } catch {
                    // 忽略儲存例外
                }
            }

            function createChevronSvg() {
                const ns = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(ns, 'svg');
                svg.setAttribute('viewBox', '0 0 12 12');
                svg.setAttribute('fill', 'none');
                const path = document.createElementNS(ns, 'path');
                path.setAttribute('d', 'M2.5 4.25L6 7.75L9.5 4.25');
                path.setAttribute('stroke', 'currentColor');
                path.setAttribute('stroke-width', '1.6');
                path.setAttribute('stroke-linecap', 'round');
                path.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(path);
                return svg;
            }

            function enhancePanelHeaders() {
                for (const panel of panels) {
                    const header = panel.querySelector(':scope > h3');
                    if (!header || header.classList.contains('panel-header')) continue;

                    const titleText = header.textContent.trim();
                    header.textContent = '';
                    header.classList.add('panel-header');

                    const dragHandle = document.createElement('span');
                    dragHandle.className = 'panel-drag-handle';
                    dragHandle.textContent = '⋮⋮';
                    dragHandle.title = '拖動調整面板順序';

                    const titleSpan = document.createElement('span');
                    titleSpan.className = 'panel-title';
                    titleSpan.textContent = titleText;

                    const collapseBtn = document.createElement('button');
                    collapseBtn.type = 'button';
                    collapseBtn.className = 'panel-collapse-btn';
                    collapseBtn.title = '收合 / 展開';
                    collapseBtn.setAttribute('aria-expanded', 'true');
                    collapseBtn.appendChild(createChevronSvg());

                    header.append(dragHandle, titleSpan, collapseBtn);

                    collapseBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        toggleCollapse(panel);
                    });

                    setupHeaderReorderDrag(panel, header);
                }
            }

            function createResizers() {
                for (let i = 0; i < panels.length - 1; i++) {
                    const resizer = document.createElement('div');
                    resizer.className = 'panel-resizer';
                    resizer.title = '拖曳調整大小（雙擊重設比例）';
                    setupResizerDrag(resizer);
                    resizer.addEventListener('dblclick', () => {
                        state.weights = { ...DEFAULT_WEIGHTS[modeKey()] };
                        applySizes();
                        saveState();
                    });
                    resizers.push(resizer);
                }
            }

            function syncDomOrder() {
                const ordered = state.order.map((id) => panelMap.get(id)).filter(Boolean);
                const scrollTargets = mainContainer.querySelectorAll('#library-content, #pipeline-list, #properties-content');
                const savedScrolls = Array.from(scrollTargets).map((el) => [el, el.scrollTop]);

                ordered.forEach((panel, idx) => {
                    mainContainer.appendChild(panel);
                    if (idx < resizers.length) {
                        mainContainer.appendChild(resizers[idx]);
                    }
                });

                for (const [el, top] of savedScrolls) {
                    el.scrollTop = top;
                }
            }

            function applyCollapsedAndSizes() {
                for (const panel of panels) {
                    const isCollapsed = Boolean(state.collapsed[panel.id]);
                    panel.classList.toggle('collapsed', isCollapsed);
                    const btn = panel.querySelector('.panel-collapse-btn');
                    if (btn) btn.setAttribute('aria-expanded', String(!isCollapsed));
                }
                applySizes();
                updateResizerStates();
            }

            function applySizes() {
                for (const panel of panels) {
                    if (panel.classList.contains('collapsed')) {
                        panel.style.flex = '';
                    } else {
                        const w = Number(state.weights[panel.id]) || 1;
                        panel.style.flex = `${w} 1 0px`;
                    }
                }
            }

            function findExpandedPanel(resizer, dir) {
                let node = dir < 0 ? resizer.previousElementSibling : resizer.nextElementSibling;
                while (node) {
                    if (node.classList.contains('panel') && !node.classList.contains('collapsed')) {
                        return node;
                    }
                    node = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
                }
                return null;
            }

            function updateResizerStates() {
                for (const resizer of resizers) {
                    const nextImmediate = resizer.nextElementSibling;
                    const prevExpanded = findExpandedPanel(resizer, -1);
                    const active = Boolean(
                        nextImmediate &&
                        nextImmediate.classList.contains('panel') &&
                        !nextImmediate.classList.contains('collapsed') &&
                        prevExpanded
                    );
                    resizer.classList.toggle('disabled', !active);
                }
            }

            function toggleCollapse(panel) {
                state.collapsed[panel.id] = !state.collapsed[panel.id];
                applyCollapsedAndSizes();
                saveState();
            }

            function setupResizerDrag(resizer) {
                resizer.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0 || resizer.classList.contains('disabled')) return;

                    const prevPanel = findExpandedPanel(resizer, -1);
                    const nextPanel = findExpandedPanel(resizer, 1);
                    if (!prevPanel || !nextPanel) return;

                    e.preventDefault();
                    const vertical = isSidePanel();
                    const startPos = vertical ? e.clientY : e.clientX;
                    const minSize = vertical ? 84 : 145;

                    const expandedPanels = Array.from(mainContainer.querySelectorAll(':scope > .panel:not(.collapsed)'));
                    const startSizes = new Map();
                    for (const p of expandedPanels) {
                        const rect = p.getBoundingClientRect();
                        startSizes.set(p.id, vertical ? rect.height : rect.width);
                    }

                    const prevStart = startSizes.get(prevPanel.id) || minSize;
                    const nextStart = startSizes.get(nextPanel.id) || minSize;

                    resizer.classList.add('active');
                    resizer.setPointerCapture(e.pointerId);

                    const onMove = (ev) => {
                        const currentPos = vertical ? ev.clientY : ev.clientX;
                        const rawDelta = currentPos - startPos;
                        const minDelta = -(prevStart - minSize);
                        const maxDelta = nextStart - minSize;
                        const delta = minDelta > maxDelta ? 0 : Math.max(minDelta, Math.min(maxDelta, rawDelta));

                        for (const p of expandedPanels) {
                            if (p === prevPanel) {
                                state.weights[p.id] = prevStart + delta;
                            } else if (p === nextPanel) {
                                state.weights[p.id] = nextStart - delta;
                            } else {
                                state.weights[p.id] = startSizes.get(p.id);
                            }
                        }
                        applySizes();
                    };

                    const onEnd = () => {
                        resizer.classList.remove('active');
                        resizer.removeEventListener('pointermove', onMove);
                        resizer.removeEventListener('pointerup', onEnd);
                        resizer.removeEventListener('pointercancel', onEnd);
                        saveState();
                    };

                    resizer.addEventListener('pointermove', onMove);
                    resizer.addEventListener('pointerup', onEnd);
                    resizer.addEventListener('pointercancel', onEnd);
                });
            }

            function setupHeaderReorderDrag(panel, header) {
                header.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0 || e.target.closest('.panel-collapse-btn')) return;

                    const startX = e.clientX;
                    const startY = e.clientY;
                    let dragging = false;
                    let ghost = null;
                    let targetPanel = null;
                    let insertPos = null;

                    header.setPointerCapture(e.pointerId);

                    const clearDropIndicators = () => {
                        for (const p of panels) {
                            p.classList.remove('drop-before', 'drop-after');
                        }
                    };

                    const startDrag = () => {
                        dragging = true;
                        document.body.classList.add('panel-reordering');
                        panel.classList.add('is-dragging');

                        ghost = document.createElement('div');
                        ghost.className = 'panel-drag-ghost';
                        const title = header.querySelector('.panel-title')?.textContent || '';
                        ghost.textContent = `⋮⋮ ${title}`;
                        document.body.appendChild(ghost);
                    };

                    const updateDropTarget = (clientX, clientY) => {
                        const vertical = isSidePanel();
                        const pos = vertical ? clientY : clientX;
                        const currentOrder = Array.from(mainContainer.querySelectorAll(':scope > .panel'));
                        const dragIdx = currentOrder.indexOf(panel);

                        let hoveredIdx = -1;
                        for (let i = 0; i < currentOrder.length; i++) {
                            const rect = currentOrder[i].getBoundingClientRect();
                            const start = vertical ? rect.top : rect.left;
                            const end = vertical ? rect.bottom : rect.right;
                            if (pos >= start && pos <= end) {
                                hoveredIdx = i;
                                break;
                            }
                        }

                        if (hoveredIdx === -1) {
                            const firstRect = currentOrder[0].getBoundingClientRect();
                            const firstEdge = vertical ? firstRect.top : firstRect.left;
                            hoveredIdx = pos < firstEdge ? 0 : currentOrder.length - 1;
                        }

                        clearDropIndicators();
                        if (hoveredIdx === dragIdx || hoveredIdx === -1) {
                            targetPanel = null;
                            insertPos = null;
                            return;
                        }

                        targetPanel = currentOrder[hoveredIdx];
                        insertPos = hoveredIdx < dragIdx ? 'before' : 'after';
                        targetPanel.classList.add(insertPos === 'before' ? 'drop-before' : 'drop-after');
                    };

                    const onMove = (ev) => {
                        if (!dragging) {
                            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
                            startDrag();
                        }
                        if (ghost) {
                            ghost.style.left = `${ev.clientX}px`;
                            ghost.style.top = `${ev.clientY}px`;
                        }
                        updateDropTarget(ev.clientX, ev.clientY);
                    };

                    const cleanup = () => {
                        header.removeEventListener('pointermove', onMove);
                        header.removeEventListener('pointerup', onUp);
                        header.removeEventListener('pointercancel', onCancel);
                        clearDropIndicators();
                        panel.classList.remove('is-dragging');
                        document.body.classList.remove('panel-reordering');
                        if (ghost) {
                            ghost.remove();
                            ghost = null;
                        }
                    };

                    const onUp = () => {
                        if (!dragging) {
                            if (!e.target.closest('.panel-drag-handle')) {
                                toggleCollapse(panel);
                            }
                            cleanup();
                            return;
                        }

                        if (targetPanel && insertPos) {
                            const newOrder = state.order.filter((id) => id !== panel.id);
                            const targetIdx = newOrder.indexOf(targetPanel.id);
                            if (targetIdx !== -1) {
                                const spliceIdx = insertPos === 'before' ? targetIdx : targetIdx + 1;
                                newOrder.splice(spliceIdx, 0, panel.id);
                                state.order = newOrder;
                                syncDomOrder();
                                updateResizerStates();
                                saveState();
                            }
                        }
                        cleanup();
                    };

                    const onCancel = () => cleanup();

                    header.addEventListener('pointermove', onMove);
                    header.addEventListener('pointerup', onUp);
                    header.addEventListener('pointercancel', onCancel);
                });
            }

            let lastMode = modeKey();
            const modeObserver = new MutationObserver(() => {
                const currentMode = modeKey();
                if (currentMode !== lastMode) {
                    lastMode = currentMode;
                    state = loadState();
                    syncDomOrder();
                    applyCollapsedAndSizes();
                }
            });
            modeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

            enhancePanelHeaders();
            createResizers();
            syncDomOrder();
            applyCollapsedAndSizes();
        }
    }

    // =========================================================================
    // 2. Tooltip 防遮擋智慧定位（不蓋住目標列與 '+' / '×' 按鈕）
    // =========================================================================
    let lastPointerX = 0;
    let lastPointerY = 0;
    let activeAnchor = null;
    let observedTip = null;
    let tipObserver = null;

    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

    function getCurrentAnchor() {
        const hovered = document.querySelector('.shader-list li:hover, .pipeline-item:hover');
        if (hovered) return hovered;
        const focused = document.querySelector('.shader-list li:focus-within, .pipeline-item:focus-within');
        if (focused) return focused;
        return activeAnchor && activeAnchor.isConnected ? activeAnchor : null;
    }

    function repositionTooltip() {
        const tip = document.getElementById('vsr-tooltip');
        if (!tip) return;

        const cs = getComputedStyle(tip);
        if (tip.hidden || cs.display === 'none' || cs.visibility === 'hidden') return;

        const anchor = getCurrentAnchor();
        if (!anchor) return;

        if (!tip.classList.contains('vsr-smart-pos')) {
            tip.classList.add('vsr-smart-pos');
        }

        const tipRect = tip.getBoundingClientRect();
        if (tipRect.width === 0 || tipRect.height === 0) return;

        const anchorRect = anchor.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 8;
        const gap = 8;

        let left;
        let top;

        // 快顯多欄模式：優先放在該欄右方或左方，不遮住清單與按鈕
        const isSide = document.body.classList.contains('side-panel');
        if (!isSide && anchorRect.width <= vw * 0.55) {
            const rightSide = anchorRect.right + 10;
            const leftSide = anchorRect.left - tipRect.width - 10;
            if (rightSide + tipRect.width <= vw - margin) {
                left = rightSide;
                top = clamp(anchorRect.top, margin, vh - tipRect.height - margin);
            } else if (leftSide >= margin) {
                left = leftSide;
                top = clamp(anchorRect.top, margin, vh - tipRect.height - margin);
            }
        }

        // 側邊欄（單欄）或左右空間不足時：嚴格放在目標列「正下方」或「正上方」
        if (left === undefined || top === undefined) {
            const preferX = lastPointerX > 0 ? lastPointerX - tipRect.width * 0.45 : anchorRect.left + 12;
            left = clamp(preferX, margin, Math.max(margin, vw - tipRect.width - margin));

            const spaceBelow = vh - anchorRect.bottom - gap - margin;
            const spaceAbove = anchorRect.top - gap - margin;

            if (spaceBelow >= tipRect.height) {
                top = anchorRect.bottom + gap;
            } else if (spaceAbove >= tipRect.height) {
                top = anchorRect.top - tipRect.height - gap;
            } else if (spaceBelow >= spaceAbove) {
                top = Math.min(anchorRect.bottom + gap, Math.max(margin, vh - tipRect.height - margin));
            } else {
                top = Math.max(margin, anchorRect.top - tipRect.height - gap);
            }
        }

        // 寫在 :root 變數上，避免觸發 #vsr-tooltip 自己的 MutationObserver
        document.documentElement.style.setProperty('--vsr-tip-left', `${Math.round(left)}px`);
        document.documentElement.style.setProperty('--vsr-tip-top', `${Math.round(top)}px`);
    }

    function attachTipObserver(tip) {
        if (!tip || tip === observedTip) return;
        observedTip = tip;
        if (tipObserver) tipObserver.disconnect();
        tipObserver = new MutationObserver(() => {
            repositionTooltip();
        });
        tipObserver.observe(tip, {
            attributes: true,
            attributeFilter: ['style', 'hidden', 'class'],
            childList: true,
            subtree: true
        });
        repositionTooltip();
    }

    document.addEventListener('pointermove', (e) => {
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
    }, { passive: true });

    document.addEventListener('pointerover', (e) => {
        const item = e.target.closest('.shader-list li, .pipeline-item');
        if (item) {
            activeAnchor = item;
            requestAnimationFrame(repositionTooltip);
        }
    }, { passive: true });

    document.addEventListener('focusin', (e) => {
        const item = e.target.closest('.shader-list li, .pipeline-item');
        if (item) {
            activeAnchor = item;
            requestAnimationFrame(repositionTooltip);
        }
    }, { passive: true });

    const bodyObserver = new MutationObserver(() => {
        const tip = document.getElementById('vsr-tooltip');
        if (tip) attachTipObserver(tip);
    });
    bodyObserver.observe(document.body, { childList: true });

    const existingTip = document.getElementById('vsr-tooltip');
    if (existingTip) attachTipObserver(existingTip);
})();