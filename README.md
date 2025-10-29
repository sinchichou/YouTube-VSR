# **開發文件：YouTube 影片 GPU 後處理與彈性 FSR 2 增強模塊**

**版本：** 1.0
**作者：** Gemini AI
**日期：** 2025年10月29日

## 1. 專案總覽與目標

本專案旨在開發一個透過瀏覽器擴充功能運作的高性能、多模式即時影片後處理系統。此系統專為 YouTube 設計，透過在原始 `<video>` 元素上覆蓋一個 `<canvas>` 層，利用 WebGL 實現 GPU 加速的影像增強。

專案的核心目標是提供兩種可切換的處理模式，以平衡畫質與效能：

1.  **常規增強模式 (Standard Enhancement Mode)**：以最低的效能開銷，對原始 1080p 影片進行空間性（單幀）的去塊、降噪和銳化處理，提升基礎觀看體驗。
2.  **FSR 2 增強模式 (FSR 2 Mode)**：利用時間性數據（多幀），執行高級的時間性降噪或解析度升頻（最高至 4K）。此模式提供最卓越的畫質，但會顯著增加 GPU 負載。

系統的設計理念是**彈性**與**高效**，允許用戶根據其硬體能力和畫質偏好，在不同模式間無縫切換。

## 2. 核心架構與資源定義

系統架構的基石是將 **GPU 內部渲染解析度** 與 **最終螢幕顯示尺寸** 進行解耦，這為實現彈性升頻和高效渲染提供了可能。

### A. 關鍵解析度管理

| 參數 | 定義 | 數值 (示例) | 核心職責與備註 |
| :--- | :--- | :--- | :--- |
| $\mathbf{R_{\text{Input}}}$ | **輸入解析度** | $1920 \times 1080$ | 原始 `<video>` 紋理的尺寸。這是所有空間處理（Pass 1）和光流計算（Pass 0）的基準解析度。所有非升頻的中間 Framebuffer Objects (FBOs) 都使用此尺寸。 |
| $\mathbf{R_{\text{Display}}}$ | **顯示尺寸** | $1280 \times 720$ | `<canvas>` 元素在網頁上的 CSS 像素尺寸。此尺寸**必須**透過 `ResizeObserver` API 與 `<video>` 元素的 `clientWidth` 和 `clientHeight` 保持即時同步，以確保畫面無縫覆蓋。 |
| $\mathbf{R_{\text{Target}}}$ | **目標解析度** | $1920 \times 1080$ (降噪) <br> $3840 \times 2160$ (升頻) | GPU 最終渲染到 Canvas 後台緩衝區的內部解析度。此參數是決定最終輸出畫質的**關鍵變數**。當 $\mathbf{R_{\text{Target}}} = \mathbf{R_{\text{Input}}}$ 時，FSR 2 執行時間性降噪；當 $\mathbf{R_{\text{Target}}} > \mathbf{R_{\text{Input}}}$ 時，執行升頻。 |
| $\mathbf{R_{\text{Scale}}}$ | **升頻比例** | $1.0$ (降噪) <br> $2.0$ (4K 升頻) | 計算公式為 $ \frac{\mathbf{R_{\text{Target}}}.W}{\mathbf{R_{\text{Input}}}.W} $。這是 FSR 2 核心著色器（`Shader_FSR2Core`）的關鍵 `uniform` 輸入，用於驅動 EASU 演算法進行正確的像素採樣。 |

### B. WebGL 緩衝區與紋理 (Framebuffer & Textures)

下表定義了渲染管線中使用的主要 WebGL 資源：

| 資源 | 職責 | 解析度 | 數據格式 | 啟用條件 |
| :--- | :--- | :--- | :--- | :--- |
| $\mathbf{Texture_{Current}}$ | 儲存從 `<video>` 元素上傳的當前影格 $\mathbf{F_t}$。 | $\mathbf{R_{\text{Input}}}$ | `RGBA8` | **所有模式** |
| $\mathbf{FBO_A}$ | **Pass 1 (空間增強)** 的輸出目標。其附加的紋理儲存了去塊和銳化後的結果。 | $\mathbf{R_{\text{Input}}}$ | `RGBA8` | **所有模式** |
| $\mathbf{Texture_{History}}$ | 儲存**前一幀**的**最終增強結果** ($\mathbf{F_{t-1, \text{enhanced}}}$)。在 FSR 2 模式下，此紋理的內容會在每一幀結束時從 Canvas 後台緩衝區複製而來，用於下一幀的時間性比較。 | $\mathbf{R_{\text{Input}}}$ | `RGBA8` | **FSR 2 模式** |
| $\mathbf{FBO_M}$ | **Pass 0 (光流)** 的輸出目標。其附加的紋理用於儲存像素的運動向量 $\mathbf{M}$。 | $\mathbf{R_{\text{Input}}}$ | `RG32F` (高精度浮點) | **FSR 2 模式** |
| **Canvas Back Buffer** | 最終繪製到螢幕的目標，即 `<canvas>` 元素的默認 Framebuffer。 | $\mathbf{R_{\text{Target}}}$ | `RGBA8` | **所有模式** |

## 3. 渲染通道 (Render Pass) 結構與邏輯

渲染流程根據 `isFSR2Enabled` 標誌在兩個主要管線之間動態切換。

### 渲染流程圖

```mermaid
graph TD
    subgraph CoreLoop [每一幀 (processFrame)]
        A[上傳 Video Frame 至 Texture_Current] --> B{isFSR2Enabled?};
        
        B -- Yes --> C[Pass 1: 空間增強];
        C --> D[Pass 0: 光流計算];
        D --> E[Pass 2: FSR 2 核心];
        E --> F[繪製到 Canvas];

        B -- No --> G[Pass 1: 空間增強];
        G --> H[Pass 3: Passthrough 輸出];
        H --> F;

        F --> I[更新 Texture_History (僅 FSR 2 模式)];
    end

    subgraph Inputs
        Video[HTMLVideoElement];
        History[Texture_History (t-1)];
    end

    Inputs --> A;
```

### 通道詳解

| Pass | 模式 | 描述 | 輸入紋理 | 輸出緩衝 | Viewport 尺寸 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Pass 1** | **所有模式** | **空間性增強 (Spatial Enhancement)**：對當前輸入影格執行去塊、銳化和基本的空間降噪。此通道是所有後續處理的基礎，旨在提升輸入畫質。 | `Texture_Current` | `FBO_A` | $\mathbf{R_{\text{Input}}}$ |
| **Pass 0** | **FSR 2 專屬** | **光流計算 (Optical Flow)**：比較當前幀和歷史幀，計算每個像素的運動向量 $\mathbf{M}$，為 FSR 2 的運動補償提供數據。 | `Texture_Current`, `Texture_History` | `FBO_M` | $\mathbf{R_{\text{Input}}}$ |
| **Pass 2** | **FSR 2 專屬** | **FSR 2 核心 (FSR 2 Core)**：此通道是 FSR 2 技術的核心，整合時間性數據。它使用運動向量來對齊歷史幀，累積顏色數據，並透過 EASU 演算法執行高品質的升頻或時間性降噪，最後由 RCAS 進行銳化。 | `FBO_A` (的紋理), `FBO_M` (的紋理), `Texture_History` | **Canvas Back Buffer** | $\mathbf{R_{\text{Target}}}$ |
| **Pass 3** | **常規專屬** | **Passthrough 輸出**：一個簡單的直通繪製。直接將 Pass 1 處理後的結果繪製到 Canvas 上。此時 `R_Target` 應等於 `R_Input`。 | `FBO_A` (的紋理) | **Canvas Back Buffer** | $\mathbf{R_{\text{Input}}}$ |

## 4. 核心 JavaScript 邏輯 (Content Script)

此部分概述了在瀏覽器擴充功能 Content Script 中的關鍵 JavaScript 實現邏輯。

### A. 初始化與尺寸同步 (`setup` function)

1.  **DOM 查詢**：在頁面加載完成後，找到目標 `HTMLVideoElement`。
2.  **Canvas 創建**：創建一個 `HTMLCanvasElement`，並透過 CSS 將其絕對定位，使其完美覆蓋在 `<video>` 元素之上。
3.  **WebGL Context 初始化**：從 `<canvas>` 獲取 `webgl2` 上下文，並啟用必要的擴展（如 `EXT_color_buffer_float`）。
4.  **資源創建**：編譯所有 GLSL 著色器，創建 WebGL Programs，並初始化所有 FBOs 和 Textures。
5.  **尺寸同步監聽**：
    ```javascript
    const video = document.querySelector('video');
    const canvas = document.getElementById('my-gl-canvas');
    
    // ResizeObserver確保Canvas CSS尺寸與Video完全同步
    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            const { width, height } = entry.contentRect;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            // 注意：這裡只改變CSS尺寸，不改變內部渲染尺寸
        }
    });
    
    resizeObserver.observe(video);
    ```

### B. 模式啟動與控制 (`setMode` function)

此函數負責處理用戶切換模式時的狀態變更。

```javascript
function setMode(isFSR2, targetWidth, targetHeight) {
    // 1. 更新全局狀態
    window.isFSR2Enabled = isFSR2;
    window.R_Target = { width: targetWidth, height: targetHeight };
    window.R_Scale = targetWidth / window.R_Input.width;

    // 2. 更新Canvas內部渲染尺寸
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    // 3. 重設歷史數據
    // 切換模式會導致時間序列中斷，必須重設歷史紋理
    window.needsHistoryReset = true;
}
```

### C. 核心幀處理迴圈 (`processFrame` function)

這是每一幀都被調用的核心渲染函數，由 `requestAnimationFrame` 驅動。

```javascript
function processFrame() {
    // 從 <video> 上傳當前幀到 GPU
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textureCurrent);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    // --- Pass 1: 空間增強 (所有模式共用) ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
    gl.viewport(0, 0, R_Input.width, R_Input.height);
    gl.useProgram(shaderProgram_SpatialEnhance);
    // ... 綁定紋理和 uniforms ...
    gl.drawArrays(gl.TRIANGLES, 0, 6); // 繪製全螢幕四邊形

    if (isFSR2Enabled) {
        // --- FSR 2 渲染管線 ---
        
        // --- Pass 0: 光流計算 ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboM);
        gl.viewport(0, 0, R_Input.width, R_Input.height);
        gl.useProgram(shaderProgram_OF);
        gl.uniform1i(..., needsHistoryReset); // 傳入重設標誌
        // ... 綁定 Texture_Current 和 Texture_History ...
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // --- Pass 2: FSR 2 核心 ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); // 輸出到 Canvas
        gl.viewport(0, 0, R_Target.width, R_Target.height);
        gl.useProgram(shaderProgram_FSR2Core);
        // ... 綁定 FBO_A, FBO_M, Texture_History 的紋理 ...
        gl.uniform1f(..., R_Scale); // 傳入升頻比例
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // --- 更新歷史紋理供下一幀使用 ---
        gl.activeTexture(gl.TEXTURE4); // 使用一個不衝突的紋理單元
        gl.bindTexture(gl.TEXTURE_2D, textureHistory);
        gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, R_Input.width, R_Input.height, 0);

        needsHistoryReset = false; // 重設標誌

    } else {
        // --- 常規渲染管線 ---
        
        // --- Pass 3: Passthrough 輸出 ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); // 輸出到 Canvas
        gl.viewport(0, 0, R_Input.width, R_Input.height);
        gl.useProgram(shaderProgram_Passthrough);
        // ... 綁定 FBO_A 的紋理 ...
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    
    requestAnimationFrame(processFrame);
}
```

## 5. GLSL Shader 核心概述

| Shader 名稱 | 模式 | 核心功能 | 關鍵 Uniforms |
| :--- | :--- | :--- | :--- |
| $\text{Shader}_{\text{SpatialEnhance}}$ | Pass 1 | **雙通道方案**：實現高效的雙邊濾波去塊、基於亮度的對比度自適應銳化（類似 CAS）以及空間高頻降噪。分為水平和垂直兩個 Pass，以提高快取效率。 | `u_InputTexture`, `u_InvResolution` ($1/\mathbf{R_{\text{Input}}}$), `u_Sharpness` |
| $\text{Shader}_{OF}$ | Pass 0 | **Lucas-Kanade 光流估計**：在一個小的鄰域內，對比當前幀和歷史幀的亮度差異，估計像素的運動方向和速度。當 `needsHistoryReset` 為 `true` 時，應直接輸出 `vec2(0.0)` 運動向量。 | `u_CurrentTexture`, `u_HistoryTexture`, `u_NeedsHistoryReset` |
| $\text{Shader}_{\text{FSR2Core}}$ | Pass 2 | 1.  **運動向量校正 (Warp)**：使用來自 `FBO_M` 的運動向量，對 `Texture_History` 進行採樣，將歷史像素「移動」到當前幀的對應位置。<br>2.  **時間性累積 (Accumulation)**：將校正後的歷史顏色與當前幀顏色進行混合。使用 Jitter（抖動）採樣和顏色裁剪（Clipping）技術來抑制鬼影。<br>3.  **EASU 升頻 (Edge-Adaptive Spatial Upsampling)**：根據 `u_ScaleRatio`，對累積後的顏色進行高品質、邊緣感知的彈性升頻。<br>4.  **RCAS 銳化 (Robust Contrast Adaptive Sharpening)**：在輸出前進行最後一次銳化，增強細節。 | `u_InputEnhanced` (來自 FBO_A), `u_MotionVectors` (來自 FBO_M), `u_HistoryTexture`, `u_ScaleRatio`, `u_JitterOffset` |
| $\text{Shader}_{\text{Passthrough}}$ | Pass 3 | **直通渲染**：一個極簡的著色器，僅負責將輸入的紋理（經過空間增強的結果）原封不動地繪製到輸出 Framebuffer。 | `u_InputTexture` |

## 6. 附錄：空間增強 Shader (Pass 1) 實作細節

為在 1080p@60FPS 環境下達成最低延遲，Pass 1 的設計至關重要。

-   **挑戰**：單一著色器內執行多種複雜濾波（去塊、銳化、降噪）需要大量的紋理採樣，容易造成紋理快取未命中和指令延遲，成為效能瓶頸。
-   **決策：雙通道 (Dual-Pass) 方案**：
    1.  **Pass 1A (水平)**：將 `Texture_Current` 作為輸入，執行所有水平方向的濾波操作，並將結果輸出到一個臨時的 FBO。
    2.  **Pass 1B (垂直)**：將 Pass 1A 的輸出紋理作為輸入，執行所有垂直方向的濾波操作，最終結果輸出到 `FBO_A`。
-   **優勢**：此方案顯著提高了 GPU 紋理快取的命中率。當處理水平像素時，所有採樣都集中在同一行；處理垂直像素時，則集中在同一列。這最大化了數據的局部性，是即時圖形處理中常用的高效能濾波技巧。

## 7. 實務執行：效能瓶頸與影音同步策略

### 總結：RTX 4060 等級 GPU 的影片即時處理與同步

#### 1. 效能瓶頸分析

| 項目 | 預估耗時 | 狀態/瓶頸分析 |
| :--- | :--- | :--- |
| **GPU 運算 (GLSL)** | $\mathbf{0.5 \text{ ms} \sim 2 \text{ ms}}$ | **極度高效**。對於現代中階 GPU (如 RTX 4060)，處理 1080p 影片的雙 Pass 濾波或 FSR 2 計算負載極低，完全不是瓶頸所在。 |
| **CPU/GPU 數據傳輸** | $3 \text{ ms} \sim 8 \text{ ms}$ | **主要瓶頸**。`gl.texImage2D(..., video)` 這個操作是整個管線中延遲最高的部分。它涉及將解碼後的影片幀從 CPU 記憶體（或 GPU 的專用解碼硬體）複製到 WebGL 可讀取的紋理內存中。此延遲受驅動程式、瀏覽器實現和系統負載影響。 |
| **總處理延遲 ($\Delta t$)** | $\mathbf{3.5 \text{ ms} \sim 15 \text{ ms}}$ | 這是從音訊播放某個時間點的聲音，到我們在 Canvas 上顯示對應影像的總延遲。為確保同步穩定，我們設定一個**安全補償值 $\mathbf{\Delta t \approx 25 \text{ ms}}$**。 |
| **即時可行性** | **可行** | 總延遲遠低於 60 FPS 所需的 **16.67 ms** 影格時間，證明此方案在技術上完全可行。 |

#### 2. 影音同步核心策略：音訊驅動的強制跳幀

由於我們的視覺管線引入了固定的延遲 $\Delta t$，Canvas 上的畫面會永久性地落後於 `<video>` 元素內部的音訊播放。必須採取主動同步策略。

**核心思想**：將**音訊時脈 (`video.currentTime`)** 作為絕對的、不可動搖的「真理時間」，並強制我們的視覺管線去追趕它。

| 步驟 | 關鍵操作 | 目的與詳解 |
| :--- | :--- | :--- |
| **A. 準備** | 找到頁面上的 `<video>` 元素；創建 `<canvas>` 並覆蓋；`video.style.opacity = 0;`。 | 視覺上用 Canvas 替換 Video，但保留 Video 作為音訊播放器和數據源。 |
| **B. 讀取音訊時脈** | 在 `processFrame` 迴圈的開頭，讀取 `const T_audio = video.currentTime;`。 | 獲取當前音訊播放到的精確時間點（以秒為單位）。這是我們的同步基準。 |
| **C. 計算目標視覺時脈** | `const T_target = T_audio - 0.025;` (即 $T_{\text{audio}} - \Delta t$) | 考慮到我們的處理延遲 $\Delta t$，我們需要渲染的影格，實際上是音訊時脈之前的那個時間點的影格。 |
| **D. 核心：誤差修正與強制跳幀** | `if (Math.abs(video.currentTime - T_target) > 0.1) { video.currentTime = T_target; }` | **這是最關鍵的一步**。我們週期性地檢查 `<video>` 的當前數據源時間點是否與我們的目標時間點 `T_target` 相差過大（例如超過 100ms）。如果誤差累積，意味著影片解碼或系統卡頓導致數據源落後，此時我們必須**強制 video seek** 到我們需要的位置，**丟棄中間掉落的影格**，以防止影音失步。 |
| **E. 渲染** | `gl.texImage2D(..., video);` | 在 `video` 的時間點被校準後，執行此操作，確保我們上傳到 GPU 的是與音訊同步的正確影格。 |

#### 3. 實務執行要求

| 項目 | 說明 |
| :--- | :--- |
| **執行環境** | **必須是瀏覽器擴充功能的 Content Script**。只有 Content Script 才有權限直接存取和操作頁面 DOM 中的 `<video>` 元素，並繞過對影片紋理數據的跨域（CORS）讀取限制。 |
| **同步控制** | 對 `<video>` 元素的 `currentTime` 屬性進行讀取和寫入（Seek）是實現精確同步的**唯一可靠手段**。`requestVideoFrameCallback` 等 API 雖然能提供影片幀信息，但無法給予我們修正誤差所需的強制控制權。 |
| **用戶體驗考量** | 強制 Seek (`video.currentTime = ...`) 可能會導致極其短暫的播放停頓。因此，誤差容忍度（上例中的 `0.1` 秒）需要仔細調校。一個較大的容忍度可以減少 Seek 次數，但可能在某些情況下導致短暫的失步感。建議設置一個合理的閾值，並只在誤差超過該閾值時才進行校準，例如每秒檢查一次。 |