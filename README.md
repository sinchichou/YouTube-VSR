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

---

## 修復記錄 / Fix Notes (2026-11)

### 1. 升頻後畫面異常(每幀 `CopyTextureToTexture` 驗證錯誤)

**症狀**:`copy range (3840x2160) touches outside of … (1920x1080)` + `[Invalid CommandBuffer]`,
畫面卡在原片/黑屏。

**根因**:`content.js` 以 `wgfx.runtime.resourceManager.getTexture('OUTPUT')` 取輸出尺寸,
但 `.wgx` 套件實例(`WGFXPackageInstance`)**沒有 `runtime` 屬性**(`resourceManager` 為直接屬性),
取值永遠落回影片尺寸(1080p),而升頻效果的 OUTPUT 實際是 2x(4K)→ Canvas 配 1080p、
每幀 copy 尺寸不符。

**修復**:`resolveOutputSize()` 同時支援兩種實例形狀
(`resourceManager` / `runtime.resourceManager` / `outWidth`+`outHeight`),
Canvas 依「實際 OUTPUT 尺寸」配置;`CanvasRenderer.render()` 另有尺寸自癒防線
(偵測不一致時自動重新配置 Canvas,不再每幀失敗)。

### 2. 「Unsafe attempt to load URL … Domains, protocols and ports must match.」

**根因**:內容腳本(隔離世界)從 youtube.com 框架直接 `fetch(chrome-extension://…/wgx/*.wgx)`,
雖因 `web_accessible_resources` 載入成功,但 Blink 會記此錯誤。

**修復**:`.wgx`/`.wgsl` 改由背景 service worker 代抓
(`chrome.runtime.sendMessage({command:'fetchResource'})` → base64 傳回 →
`WGFXPackage.fromBytes()`),路徑白名單限制於 `wgx/**`、`effects_wgsl/**`;
訊息失敗時自動退回直接 fetch,行為不劣化。

### 3. 其他強化

- **首幀才隱藏原影片**:編譯/首幀失敗時不再黑屏,至少看得到原片。
- **連續幀錯誤降級**:連續 120 幀失敗 → 自動還原原影片並進入 `ERROR` 狀態(可重啟)。
- **重啟競態修復**:rVFC 以對應的 `cancelVideoFrameCallback` 取消 + 迴圈代數(gen)隔離,
  `stop→start` 不再產生雙渲染迴圈。
- **解析度重啟條件修復**:只比對影片串流尺寸變化,不再拿 canvas 尺寸比對
  (升頻下兩者恆不相等,會造成 RO 初始回呼觸發無限重編譯)。
- **GPU 裝置遺失自動重啟**、`uncapturederror` 節流記錄、`debugVSR` 日誌開關確實生效、
  FPS 偵錯計數。
- **驗證腳本**:`npm run verify`(content/background 82 項 + popup 67 項檢查)。

### 多效果管線 / Multi-Effect Pipeline (2026-11)

popup 管線中的**每一個**效果現在都會生效,依序串接:

```
影片 → 效果1 → OUTPUT → blit → 效果2 → OUTPUT → … → Canvas
```

- **尺寸自動傳遞**:效果 i 的實際輸出(升頻效果的宣告尺寸)= 效果 i+1 的輸入;
  Canvas 內部解析度 = 管線尾端輸出,水印顯示整條鏈的總倍率。
- **鏈結 blit**:上下級格式不同(OUTPUT `rgba16float` / INPUT `rgba8unorm`),
  不能 `copyTextureToTexture`,以全螢幕三角取樣做格式轉換(bind group 只建一次)。
- **提交策略**:效果 1 的輸入上傳 + 所有效果 passes + 鏈結 blit + 畫布呈現
  全部錄進**同一個 encoder**,整幀僅 **1 次 queue submit**;scene buffer
  補寫含 `frame` 計數器(時間性效果不受影響)。
- **參數路由**:屬性面板改動經 `instanceId` 精準套用到對應效果
  (`VSR.status()` 的 `pipeline` 欄位現在是效果名稱陣列)。
- 上游 WGFX 改版若造成派發不相容,會在**編譯期**拋錯並降級回原影片(fail-fast);
  錯誤訊息會指名是哪個效果、缺哪個 API。

### 效能優化 / Performance (擴充功能端)

**幀熱路徑(每幀執行的事)**

- **整幀 1 次 queue submit**:`processFrame()` 把「輸入上傳 → 效果 1 passes → 鏈結
  blit+passes → 呈現 blit」全部錄進**同一個 encoder** 一次提交(先前單效果 2 次、
  多效果 3 次 submit);單/多效果共用同一條路徑。
- **呈現走取樣 blit + 畫布偏好格式**:畫布從 `rgba16float` copy 改為
  `getPreferredCanvasFormat()`(通常 `bgra8unorm`)的渲染目標 —— 4K@60 的呈現頻寬
  約省一半(每像素 8B vs 16B),並走瀏覽器合成器的最快路徑;float→8bit 轉換
  由 GPU 上的 blit 順帶完成,畫布不再需要 COPY_DST。
- **直接以 `<video>` 元素為輸入**:`copyExternalImageToTexture` 原生支援,
  免每幀 VideoFrame 物件配置與 close。
- **pass metadata 編譯期預解析**(`entry.passes`):熱路徑不再對 manifest 做
  `metas.find`;鏈結 blit 的 render-pass 描述器(`link.passDesc`)與 bind group
  只建一次。
- **畫布 view 按紋理身分快取**:swapchain 紋理未換即不重建 view;
  `prepareRenderTarget()` 內含畫布尺寸自癒(取代每幀 copy 驗證)。
- **熱路徑零 DOM 往返**:覆蓋層位置由 ResizeObserver(影片 + 播放器容器)驅動
  髒旗標,變更時才 `getBoundingClientRect` ×2 與寫 style。
- **熱路徑零 JS 物件垃圾**:encoder 描述器與 clear 色碼為模組常數
  (`ENCODER_DESC`/`CLEAR_BLACK`);`processFrame` 為同步函式(無 async 開銷)。
- 影片暫停或分頁隱藏時 rVFC 不觸發,處理循環自然停止。

### 效果庫雙語說明與 Tooltip(2026-11)

- **每個效果都有中英說明**(`effect-descriptions.json`,人工維護):說明該效果**做什麼**、
  如何運作(例如「去除色帶 — 以細緻抖動雜訊撫平漸層」「CNN 線條修復器,規模 UL — 修復壓縮失真」)、
  是否改變尺寸,以及型號字尾的意義(S/M/L/VL/UL = 網路規模、R2-R4 = 半徑、-DN = 含降噪…)。
  覆蓋全部 127 個 `.wgx` 套件包 + 20 個 legacy `.wgsl`(同名效果共用說明,byPath 可覆寫)。
- **樣式化 tooltip**(比照正規擴充功能做法,不用原生 title):
  - 滑鼠移入效果庫項目約 120ms 後浮出;顯示**名稱、型別/pass/參數摘要、中文說明、英文說明、檔案路徑**;
  - 鍵盤可達:項目 `tabindex=0`,Tab 聚焦即顯示、失焦隱藏;
  - 定位夾限在 popup 視窗內(右側優先,溢出自動收回);
  - 說明由 background 合併進效果清單(`getShaderFiles` → `descEn`/`descZh`),popup 無需額外請求。
- 維護方式:編輯 `effect-descriptions.json` 的 `byName`(key = 去副檔名的基底名稱小寫)即可,
  重新載入擴充功能生效;同步 WGFX 套件不會覆寫此檔。

### 淺色水印 / Watermark

VSR 啟用中會在影片右下角顯示淺色徽章(例:`VSR ×2.0`,白 42% + 黑 30% 膠囊底,
零 GPU 成本)。預設開啟,狀態保存於 `chrome.storage.local` 的 `watermark`。

### 主控台控制 / Console Control

在 **DevTools 主控台**(Console 面板,預設 context 即可用)提供 `window.VSR` API:

| 指令 | 說明 |
| --- | --- |
| `VSR.status()` | 狀態快照(state / pipeline / video / output / fps / watermark) |
| `VSR.watermark()` / `VSR.watermark(false)` | 查詢 / 開關水印(永久保存) |
| `VSR.enable()` / `VSR.disable()` / `VSR.toggle()` | 開關 VSR 本體 |

實作:背景以 `chrome.scripting.executeScript({world:'MAIN'})` 注入橋接
(繞過頁面 CSP;`manifest.json` 因此新增 `host_permissions`),
經 `CustomEvent('vsr-console-cmd' / 'vsr-console-res')` 與內容腳本通訊。
在 DevTools context 下拉選單切到本擴充套件時,也可直接使用隔離世界的同名 `VSR` API。
