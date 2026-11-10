# YouTube VSR - Real-Time Video Shader Extension

This is a browser extension designed to apply real-time shaders and effects to online videos, primarily on platforms like YouTube. It allows users to select and customize various video processing filters, from simple color adjustments to complex upscaling and denoising algorithms.

## Features

- **Real-Time Processing**: Applies video effects on-the-fly without needing to download the video.
- **Extensive Shader Library**: Includes a wide variety of shaders from projects like Anime4K, FSR, CAS, and more.
- **Customizable Effects**: Each shader's parameters can be adjusted through a user-friendly interface.
- **wgsl Support**: Dynamically parses and applies shaders written in wgsl.
- **Modular Design**: Easily extendable with new shaders.
- **Video Playback Monitoring**: Detects when a video has ended playback.

---

## Key Modules Explanation

This is the core engine responsible for interpreting shader files (`.wgsl`) and managing WebGPU resources. It contains a PEG.js-based parser that reads the special comment-based header at the top of a shader file to understand its properties, parameters, and rendering passes. This allows the extension to dynamically build a UI and execute complex rendering pipelines with high performance.

#### API Usage

```ts
const wgfx = await WGFX.create({ device, effectCode, width, height });

// Process with default dimensions (input size)
const output = await wgfx.process(video);

// Process with dynamic output resizing (upscaling)
const output4k = await wgfx.process(video, { outWidth: 3840, outHeight: 2160 });
```

#### How It Works

The parser scans a shader file for special comment lines starting with `//!`. These lines are not standard code but act as metadata directives.

#### Parser Directives

- `//!EFFECT "Effect Name"`: **(Global)** Specifies the display name of the shader in the UI.
- `//!VERSION "1.0"`: **(Global)** Defines the version of the shader.

- `//!PARAMETER`: **(Block)** Declares the beginning of a shader parameter block. This is followed by the actual variable declaration in the code.

  - `//!LABEL "Parameter Name"`: The display name for this parameter in the UI.
  - `//!DEFAULT value`: The default numerical value for the parameter.
  - `//!MIN value`: The minimum allowed value (for sliders).
  - `//!MAX value`: The maximum allowed value (for sliders).
  - `//!STEP value`: The increment/decrement step for the UI control.
  - **Example**:
    ```wgsl
    //!PARAMETER
    //!LABEL "Sharpness"
    //!DEFAULT 0.8
    //!MIN 0.0
    //!MAX 1.0
    //!STEP 0.01
    float sharpness;
    ```

- `//!TEXTURE`: **(Block)** Declares a texture resource.

  - `//!WIDTH "1920"`: Specifies the width. Can also use variables like `VIDEO_WIDTH`.
  - `//!HEIGHT "1080"`: Specifies the height. Can also use variables like `VIDEO_HEIGHT`.
  - **Example**:
    ```wgsl
    //!TEXTURE
    //!WIDTH "VIDEO_WIDTH"
    //!HEIGHT "VIDEO_HEIGHT"
    Texture2D myTexture;
    ```

- `//!SAMPLER`: **(Block)** Declares a sampler resource.

  - `//!FILTER "LINEAR"`: Defines the filter mode (e.g., `LINEAR`, `POINT`).
  - **Example**:
    ```wgsl
    //!SAMPLER
    //!FILTER "LINEAR"
    SamplerState mySampler;
    ```

- `//!PASS <ID>`: **(Block)** Declares a rendering pass with a specific ID. Passes are executed in order of their ID.
  - `//!IN "ResourceName"`: Specifies an input resource for this pass (e.g., a texture).
  - `//!OUT "ResourceName"`: Specifies the output target for this pass.
  - `//!BLOCK_SIZE "16 16"`: Defines the compute shader block size.
  - **Example**:
    ```wgsl
    //!PASS 1
    //!IN "InputTexture"
    //!OUT "ProcessedTexture"
    //!BLOCK_SIZE "16 16"
    ```

### `effects_wgsl/` Directory

This directory is intended for shaders written in WGSL (WebGPU Shading Language). It signifies an experimental or future-proofed part of the project, allowing it to leverage the newer WebGPU API for potentially better performance.

It is the **legacy** effect path: effects are preferably shipped as pre-compiled `.wgx` packages
(see below). Existing `.wgsl` files keep working and stay listed in the library.

### WGFX Core Library (ESM dependency)

The core engine is the separate [WGFX](https://github.com/sinchichou/WGFX) package — it is **no longer copied in by hand**.

```bash
npm install          # links wgfx (file:../WGFX) and runs the postinstall sync
npm run sync:wgfx    # re-vendor after updating the core library
npm run check:wgfx   # CI: fails if vendor/ is out of date
```

- `scripts/sync-wgfx.mjs` copies `node_modules/wgfx/dist/wgfx.browser.esm.js` into `vendor/`
  (falling back to a sibling `../WGFX/dist` checkout) and records the source version + hash in
  `vendor/.wgfx-sync.json`.
- `content.js` imports it as ESM: `await import(chrome.runtime.getURL('vendor/wgfx.browser.esm.js'))`.
- `vendor/` is generated and git-ignored — **never edit it by hand**.

### Pre-compiled effect packages (`.wgx`)

Effects are shipped as **pre-compiled packages** produced by the WGFX project's `npm run pack`.
A `.wgx` is a zip containing the pre-generated WGSL of every pass, the external textures (LUTs)
and a `manifest.json` with the effect's metadata — so the extension no longer has to parse
`.wgsl` at runtime.

```bash
npm run sync:wgfx    # vendor vendor/wgfx.browser.esm.js AND wgx/ (packages + index)
npm run check:wgfx   # CI: fails if vendor/ or wgx/ is out of date
node scripts/verify-popup.mjs   # programmatic check of the library/background/popup DOM
```

- Packages are copied to `wgx/<family>/<effect>.wgx`. The sync is idempotent (identical content
  is never rewritten) and deletes packages that vanished from the source; manually added
  packages are left alone. `--force` rewrites anyway, `--soft` only warns (used by
  `postinstall`). Set `WGFX_PACKAGES=<dir containing .wgx>` to sync from somewhere else.
- `scripts/sync-wgfx.mjs` also writes **`wgx/packages.json`**, an index carrying each package's
  `path / id / name / family / description / parameters` plus the list of legacy `.wgsl`
  effects. Why an index instead of scanning: an MV3 service worker **cannot enumerate**
  extension files (there is no directory API, only `chrome.runtime.getURL` for a known path).
  Generating the index at sync time means the library can never drift from the files on disk —
  the old hard-coded list of 6 paths was already stale (one of them did not even exist).
- `background.js` reads that index to answer `getShaderFiles`; `popup.js` renders it grouped by
  family and stores one entry per pipeline item: `{ kind, path, id, name, family, params }`.
  Parameters of a package come from the index, so the UI never unzips anything.
- `manifest.json` exposes `wgx/**/*.wgx` as web-accessible resources so the content script can
  `fetch(chrome.runtime.getURL('wgx/…'))` from the page. The MV3 default CSP is preserved
  (no `unsafe-eval`).

#### Adding an effect

1. In the **WGFX** project: add `effects/<Family>/<Name>.wgsl`, then run `npm run pack`.
2. Here: run `npm run sync:wgfx` — the package is copied to `wgx/<Family>/` and the index is
   updated (the sync script extracts the metadata straight from the package manifest).
3. Reload the extension. The effect shows up in the popup library, grouped by family with its
   pass count / parameter count / description, and can be added to the pipeline.

#### Relation to the WGFX core

Two halves of the same engine: `vendor/wgfx.browser.esm.js` is the runtime (it exports the
package runtime — `WGFXPackage`, `WGFXPackageInstance` — next to `WGFX`/`WGFXRuntime`), while
`wgx/*.wgx` are the content it runs. `content.js` turns a pipeline entry's `path` into a package
instance; the popup only ever reads `wgx/packages.json`.

---

# YouTube VSR - 即時影片著色器擴充功能

這是一個瀏覽器擴充功能，旨在為線上影片（主要是在 YouTube 等平台上）套用即時著色器和效果。它允許使用者選擇和自訂各種影片處理濾鏡，從簡單的色彩調整到複雜的升頻和降噪演算法。

## 功能

- **即時處理**：無需下載影片，即時套用各種影片效果。
- **豐富的著色器庫**：包含了來自 Anime4K、FSR、CAS 等專案的多種著色器。
- **可自訂的效果**：每個著色器的參數都可以透過使用者友好的介面進行調整。
- **支援 wgsl**：能夠動態解析和套用以 wgsl 編寫的著色器。
- **模組化設計**：可以輕鬆地透過添加新的著色器來擴充功能。
- **影片播放監測**：偵測影片播放結束。

---

## 關鍵模組說明

### WGFX 引擎

這是本專案的核心引擎，負責解讀著色器檔案（`.wgsl`）並管理 WebGPU 資源。它包含一個基於 PEG.js 的解析器，會讀取位於著色器檔案頂部的特殊註解標頭，以理解其屬性、參數和渲染通道。這使得擴充功能能夠動態建立 UI，並以高效能執行複雜的渲染管線。

### `content.js` - 架構優化與競態處理

`content.js` 經過重構，採用類別化的 `VSRController` 架構，並引入了 **Sequence ID** 機制與 **初始化鎖**。這能有效防止在快速切換影片或更動設定時產生的競態問題（Race Conditions），確保 WebGPU 資源的初始化與釋放流程穩定可靠。

#### 運作方式

解析器會掃描著色器檔案，尋找以 `//!` 開頭的特殊註解行。這些行不是標準程式碼，而是作為元數據指令。

#### 解析器指令

- `//!EFFECT "效果名稱"`：**(全域)** 指定著色器在 UI 中顯示的名稱。
- `//!VERSION "1.0"`：**(全域)** 定義著色器的版本。

- `//!PARAMETER`：**(區塊)** 宣告一個著色器參數區塊的開始。其後需要跟著實際的變數宣告程式碼。

  - `//!LABEL "參數名稱"`：此參數在 UI 中顯示的名稱。
  - `//!DEFAULT 數值`：參數的預設數值。
  - `//!MIN 數值`：允許的最小值（用於滑桿）。
  - `//!MAX 數值`：允許的最大值（用於滑桿）。
  - `//!STEP 數值`：UI 控制項的增減步長。
  - **範例**：
    ```wgsl
    //!PARAMETER
    //!LABEL "銳利度"
    //!DEFAULT 0.8
    //!MIN 0.0
    //!MAX 1.0
    //!STEP 0.01
    float sharpness;
    ```

- `//!TEXTURE`：**(區塊)** 宣告一個紋理資源。

  - `//!WIDTH "1920"`：指定寬度。也可以使用 `VIDEO_WIDTH` 等變數。
  - `//!HEIGHT "1080"`：指定高度。也可以使用 `VIDEO_HEIGHT` 等變數。
  - **範例**：
    ```wgsl
    //!TEXTURE
    //!WIDTH "VIDEO_WIDTH"
    //!HEIGHT "VIDEO_HEIGHT"
    Texture2D myTexture;
    ```

- `//!SAMPLER`：**(區塊)** 宣告一個採樣器資源。

  - `//!FILTER "LINEAR"`：定義濾波模式（例如 `LINEAR`、`POINT`）。
  - **範例**：
    ```wgsl
    //!SAMPLER
    //!FILTER "LINEAR"
    SamplerState mySampler;
    ```

- `//!PASS <ID>`：**(區塊)** 宣告一個帶有特定 ID 的渲染通道。通道會根據其 ID 順序執行。
  - `//!IN "資源名稱"`：指定此通道的輸入資源（例如一個紋理）。
  - `//!OUT "資源名稱"`：指定此通道的輸出目標。
  - `//!BLOCK_SIZE "16 16"`：定義計算著色器（Compute Shader）的區塊大小。
  - **範例**：
    ```wgsl
    //!PASS 1
    //!IN "InputTexture"
    //!OUT "ProcessedTexture"
    //!BLOCK_SIZE "16 16"
    ```

### `effects_wgsl/` 目錄

此目錄用於存放以 WGSL（WebGPU Shading Language）編寫的著色器。它代表了專案中實驗性或為未來做準備的部分，使其能夠利用更新的 WebGPU API 以獲得潛在的更佳效能。

這是**legacy** 效果路徑:效果現在建議以預編套件包 `.wgx` 供應(見下文)。既有的 `.wgsl`
仍可運作,也會繼續出現在效果庫清單中。

### WGFX 核心庫（ESM 相依）

核心引擎是獨立的 [WGFX](https://github.com/sinchichou/WGFX) 套件——**已不再手動複製檔案進本專案**。

```bash
npm install          # 建立 wgfx 相依（file:../WGFX）並自動執行同步
npm run sync:wgfx    # 更新核心庫後重新攤銷
npm run check:wgfx   # CI 用：若 vendor/ 與來源不同步則失敗
```

- `scripts/sync-wgfx.mjs` 會把 `node_modules/wgfx/dist/wgfx.browser.esm.js` 複製到 `vendor/`
  （找不到套件時退回同層的 `../WGFX/dist`），並將來源版本與雜湊記錄於 `vendor/.wgfx-sync.json`。
- `content.js` 以 ESM 匯入：`await import(chrome.runtime.getURL('vendor/wgfx.browser.esm.js'))`。
- `vendor/` 是產生物且已列入 gitignore——**請勿手動編輯**。

### 預編效果套件包（`.wgx`）

效果改以 **預編套件包**供應,由 WGFX 專案的 `npm run pack` 產生。`.wgx` 是一個 zip,內含每個
pass 的預生成 WGSL、外部紋理(LUT)與一份描述效果中繼資料的 `manifest.json`——擴充套件不再
需要在執行期解析 `.wgsl`。

```bash
npm run sync:wgfx    # 攤銷 vendor/wgfx.browser.esm.js 與 wgx/(套件包 + 索引)
npm run check:wgfx   # CI 用:vendor/ 或 wgx/ 過期即失敗
node scripts/verify-popup.mjs   # 以程式化方式驗證效果庫/background/popup 的 DOM 產出
```

- 套件包會被複製到 `wgx/<家族>/<效果>.wgx`。同步是冪等的(內容相同不重寫),並會刪除來源已
  移除的套件包;手動放入的套件包不會被動到。`--force` 強制重寫,`--soft` 只警告(供
  `postinstall` 使用)。可用 `WGFX_PACKAGES=<含 .wgx 的目錄>` 指定其他來源。
- `scripts/sync-wgfx.mjs` 也會產生 **`wgx/packages.json`**:內含每個套件包的
  `path / id / name / family / description / parameters`,以及 legacy `.wgsl` 效果清單。
  為什麼要索引而不用掃描:MV3 的 service worker **無法列舉**擴充套件內的檔案(沒有目錄
  API,只有已知路徑的 `chrome.runtime.getURL`)。索引在同步當下產生,因此清單永遠與磁碟上
  的檔案一致——舊版硬編碼的 6 條路徑早已過時(其中一條甚至不存在)。
- `background.js` 讀這份索引來回應 `getShaderFiles`;`popup.js` 依 family 分組呈現,並為每個
  管線項目儲存 `{ kind, path, id, name, family, params }`。套件包的參數來自索引,UI 完全不
  需要解壓。
- `manifest.json` 把 `wgx/**/*.wgx` 列為 web accessible resource,讓內容腳本能在頁面中
  `fetch(chrome.runtime.getURL('wgx/…'))`。維持 MV3 預設 CSP(沒有 `unsafe-eval`)。

#### 如何新增效果

1. 在 **WGFX** 專案:新增 `effects/<家族>/<名稱>.wgsl`,執行 `npm run pack`。
2. 在本專案:執行 `npm run sync:wgfx` —— 套件包會被複製到 `wgx/<家族>/` 並更新索引
   (同步腳本直接從套件包的 manifest 抽出中繼資料)。
3. 重新載入擴充功能。效果會出現在 popup 效果庫中(依家族分組,附 pass 數/參數數/描述),
   並可加入管線。

#### 與 WGFX 核心的關係

同一個引擎的兩半:`vendor/wgfx.browser.esm.js` 是執行期(除了 `WGFX`/`WGFXRuntime`,也匯出
套件執行期 `WGFXPackage`、`WGFXPackageInstance`),而 `wgx/*.wgx` 是它執行的內容。
`content.js` 把管線項目的 `path` 變成套件實例;popup 只讀 `wgx/packages.json`。

### 展示

#### 啟用後

![VSR_on](VSR_on.png)

#### 禁用後

![VSR_off](VSR_off.png)
