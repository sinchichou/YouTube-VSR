### **專案：WebGPU 即時影片效果引擎 (代號："Project Magpie-Web")**

**目標：** 建立一個基於瀏覽器的通用渲染框架，該框架能夠解析帶有自訂標頭的 WGSL 著色器檔案，動態建立 GPU 資源和渲染管線，並將其應用於網頁上的即時影片串流。最終目標是將其封裝成一個瀏覽器擴充功能。

---

### **第一階段：手動遷移與原型驗證**

**目標：** 快速驗證核心技術，確保單一、簡單的著色器效果可以在影片上成功運作。

#### **工作流程 (Checklist):**

1.  **[ ] 環境設定**:
    *   建立專案資料夾結構 (`index.html`, `main.js`, `shaders/`)。
    *   確保有本地 Web 伺服器環境（如 VS Code Live Server）以避免 CORS 問題。
    *   準備一段測試影片 (`test.mp4`)。

2.  **[ ] 選擇並遷移第一個著-色器**:
    *   **目標**: `Anime4K_Denoise_Bilateral_Mean.glsl`。
    *   **任務**: 建立 `shaders/denoise.wgsl` 檔案。
    *   **手動翻譯**:
        *   將 `//!` 標頭**原樣複製**到檔案頂部作為註解。
        *   將 HLSL/GLSL 的 `Pass 1` 函式主體**手動翻譯**成 WGSL 語法。
        *   **注意**: 暫時**不要**在 WGSL 中寫死 `@group @binding` 宣告。

3.  **[ ] 建立 HTML 介面 (`index.html`)**:
    *   加入 `<video>` 標籤並載入測試影片。
    *   加入 `<canvas>` 標籤用於顯示結果。
    *   加入 `<input type="range">` 滑桿，用於控制降噪強度。

4.  **[ ] 撰寫「寫死」的核心邏輯 (`main.js`)**:
    *   **初始化**: 取得 `GPUDevice`，設定 Canvas `context`。
    *   **資源建立**:
        *   手動建立一個 `GPUBuffer` 作為 Uniform Buffer，用於傳遞滑桿的強度值。
        *   手動建立一個 `GPUSampler`。
    *   **著色器處理**:
        *   使用 `fetch` 載入 `shaders/denoise.wgsl`。
        *   **手動**在 JavaScript 中拼接字串，為 WGSL 程式碼加上寫死的 `@group @binding` 宣告。
        *   使用拼接後的完整程式碼建立 `GPUComputePipeline`。
    *   **渲染迴圈 (`requestAnimationFrame`)**:
        *   從 `<video>` 匯入 `GPUExternalTexture`。
        *   從 `context` 獲取 `outputTexture`。
        *   讀取滑桿值並更新 Uniform Buffer (`queue.writeBuffer`)。
        *   **手動**建立 `GPUBindGroup`，將所有資源按寫死的順序綁定。
        *   執行 `dispatchWorkgroups`。

5.  **[ ] 測試與驗證**:
    *   在瀏覽器中開啟頁面，確認影片正常播放並被處理。
    *   拖動滑桿，確認效果強度有即時變化。

---

### **關鍵技術翻譯重點 (HLSL/GLSL -> WGSL)**

這是在第一階段手動翻譯時需要遵守的速查表。

| HLSL/GLSL 概念 | WGSL 對應 | 範例 (WGSL) |
| :--- | :--- | :--- |
| `float`, `int`, `uint` | `f32`, `i32`, `u32` | `var my_float: f32 = 1.0;` |
| `float2`, `float4` | `vec2<f32>`, `vec4<f32>` | `let pos: vec2<f32> = vec2(x, y);` |
| `uint2` | `vec2<u32>` | `let pixel_coord: vec2<u32> = global_id.xy;` |
| `Texture2D` | `texture_2d<f32>` (讀取), `texture_storage_2d` (寫入) | `var tex: texture_2d<f32>;` |
| `SamplerState` | `sampler` | `var smp: sampler;` |
| `.Sample(sam, uv)` | `textureSample(tex, smp, uv)` | `let color = textureSample(my_tex, my_smp, uv);` |
| `texture[coord]` (寫入) | `textureStore(tex, coord, value)` | `textureStore(output_tex, coord, color);` |
| `MulAdd(a, b, c)` | `fma(a, b, c)` 或 `a * b + c` | `let result = fma(val_a, val_b, val_c);` |
| `saturate(x)` | `clamp(x, 0.0, 1.0)` | `let clamped_val = clamp(x, 0.0, 1.0);` |
| `lerp(a, b, t)` | `mix(a, b, t)` | `let final_color = mix(color_a, color_b, 0.5);` |
| `float4x4` | `mat4x4<f32>` | `var my_matrix: mat4x4<f32>;` |
| 全域 Uniform 變數 | `var<uniform>` 結構體 | `@group(0) @binding(0) var<uniform> params: Params;` |
| 函式 (`void main()`) | `@compute` 或 `@fragment` 入口函式 | `@compute @workgroup_size(8,8,1) fn main(...) {}` |

---

### **第二階段：研究與開發「解析引擎」**

**目標：** 將第一階段的寫死邏輯抽象化，建立一個可以動態解析帶標頭的 WGSL 檔案並執行渲染的通用引擎。

#### **研究與設計 (Action Plan):**

1.  **定義資料結構**:
    *   **任務**: 設計 `shaderInfo` JavaScript 物件的最終結構。它應該包含哪些欄位？
    *   **思考**:
        *   `name: string`
        *   `parameters: [{ name: string, type: string, default: number, ... }]`
        *   `textures: { [name: string]: { format: string, ... } }`
        *   `passes: [{ id: number, inputs: string[], outputs: string[], codeBody: string }]`
        *   如何處理 `SAMPLER`？

2.  **實作解析器 `parseWgsl(code: string): shaderInfo`**:
    *   **任務**: 撰寫核心的解析邏輯。
    *   **策略**:
        *   使用字串的 `split('\n')` 和 `startsWith('//!')` 進行逐行掃描。
        *   使用正規表示式 (Regular Expressions) 來提取更複雜的資訊，例如 `//!PASS 1` 中的數字，或 `//!PARAMETER` 後面幾行的參數名稱和類型。
        *   需要一個狀態機來區分當前正在解析的是 `PARAMETER`、`TEXTURE` 還是 `PASS`。
        *   找到第一個 `@compute` 或 `@fragment` 作為標頭結束和程式碼主體開始的分界線。
        *   將程式碼主體分割並儲存到 `shaderInfo.passes[i].codeBody` 中。

3.  **實作著色器生成器 `generateWgsl(passInfo, shaderInfo): string`**:
    *   **任務**: 撰寫一個函式，接收單個 `pass` 的資訊，動態生成完整的、可編譯的 WGSL 程式碼。
    *   **策略**:
        *   維護一個 `bindingIndex` 計數器。
        *   遍歷 `shaderInfo.parameters`，生成 `@group(0) @binding(X) var<uniform> ...` 字串。
        *   遍歷 `passInfo.inputs` 和 `passInfo.outputs`，根據紋理名稱生成對應的 `texture_external`, `texture_2d`, `texture_storage_2d` 綁定字串。
        *   將所有生成的綁定字串和 `passInfo.codeBody` 拼接起來。

4.  **重構 `main.js` 以使用引擎**:
    *   **任務**: 將第一階段的程式碼替換為對新引擎模組的呼叫。
    *   **流程**:
        1.  `fetch` WGSL 檔案。
        2.  `shaderInfo = parseWgsl(code)`。
        3.  `gpuResources = createResources(shaderInfo)` (根據解析結果建立紋理/緩衝區)。
        4.  `pipelines = createPipelines(shaderInfo)` (迴圈呼叫 `generateWgsl` 和 `createComputePipeline`)。
        5.  在渲染迴圈中，`runRenderer(shaderInfo, gpuResources, pipelines)` (動態組合綁定組並執行)。
