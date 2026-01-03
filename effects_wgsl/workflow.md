這是一份針對 **Magpie** 移植 **HLSL** 到 **WGSL** (WebGPU Shading Language) 的詳細規範總結。這份規範基於 Anime4K 的移植經驗整理，特別適用於圖像後處理濾鏡的開發。

---

### 1. 全局配置與元數據 (Global Configuration)

這些指令位於文件的最頂部，用於告知 Magpie 如何加載和配置特效。

| 指令             | 說明                                                                  | 範例                           |
| :--------------- | :-------------------------------------------------------------------- | :----------------------------- |
| `//!VERSION`     | **[必要]** 檔案格式版本。通常為 `1.0`。                               | `//!VERSION 1.0`               |
| `//!SORT_NAME`   | **[選填]** UI 顯示名稱。若省略則使用檔名。                            | `//!SORT_NAME Anime4K_Restore` |
| `//!CAPABILITY`  | **[關鍵]** 聲明硬體需求。**Anime4K 必須開啟 `FP16`** 以獲得最佳效能。 | `//!CAPABILITY FP16`           |
| `//!AUTHOR`      | **[選填]** 作者名稱。                                                 | `//!AUTHOR bloc97`             |
| `//!DESCRIPTION` | **[選填]** 特效描述。                                                 | `//!DESCRIPTION CNN Upscaler`  |

---

### 2. 通用類型定義與別名 (Common Type Aliasing)

為了降低從 HLSL 遷移的難度，建議在 `//! COMMON`區塊中定義類型別名，使其語法接近 HLSL。

#### 基礎與向量類型

| HLSL 類型 | WGSL 對應   | 建議別名 (Alias)           |
| :-------- | :---------- | :------------------------- |
| `float`   | `f32`       | `alias MF = f32;`          |
| `float2`  | `vec2<f32>` | `alias MF2 = vec2<f32>;`   |
| `float3`  | `vec3<f32>` | `alias MF3 = vec3<f32>;`   |
| `float4`  | `vec4<f32>` | `alias MF4 = vec4<f32>;`   |
| `uint`    | `u32`       | N/A                        |
| `uint2`   | `vec2<u32>` | `alias uint2 = vec2<u32>;` |

#### 矩陣類型 (關鍵差異)

HLSL 使用 `Rows x Cols`，WGSL 使用 `Cols x Rows` (欄主序)。為了保持數學運算邏輯（向量 \* 矩陣）一致，定義需反轉：

- **轉換規則：** HLSL `floatRxC` $\to$ WGSL `matCxR<f32>`
- **範例：**
  ```rust
  alias MF3x4 = mat4x3<f32>; // 對應 HLSL float3x4
  alias MF4x4 = mat4x4<f32>; // 對應 HLSL float4x4
  ```

---

### 3. 資源聲明與綁定 (Resource Declaration)

Magpie 會自動管理 BindGroup，Shader 內需宣告對應變數。

#### 綁定組 (Bind Groups) 邏輯

1.  **Group 0 (Global):** 全局資源（輸入、輸出、採樣器、Uniform）。
2.  **Group 1 (Sampled):** 由 `//!IN` 指定的中間紋理（唯讀）。
3.  **Group 2 (Storage):** 由 `//!OUT` 指定的中間紋理（可讀寫/寫入）。

#### 常用聲明模板

```rust
// 1. Uniforms (常量) - Group 0, Binding 4
struct SceneInfo {
    inputSize: uint2, // 紋理像素尺寸 (例如 1920, 1080)
    inputPt: MF2,     // 像素大小 (例如 1/1920, 1/1080)
}
@group(0) @binding(4) var<uniform> scene: SceneInfo;

// 2. 原始輸入 - Group 0, Binding 0
@group(0) @binding(0) var INPUT: texture_2d<f32>;

// 3. 最終輸出 - Group 0, Binding 1
@group(0) @binding(1) var OUTPUT: texture_storage_2d<rgba16float, write>;

// 4. 採樣器 - Group 0, Binding 3
@group(0) @binding(3) var sam: sampler;

// 5. 中間紋理 (雙重綁定技巧)
// 同一個紋理資源，宣告兩個變數分別用於"採樣"和"寫入"
@group(1) @binding(0) var tex1_sampled: texture_2d<f32>;
@group(2) @binding(0) var tex1_storaged: texture_storage_2d<rgba16float, read_write>;
```

---

### 4. 紋理定義 (Magpie Headers)

使用 `//!TEXTURE` 區塊定義中間緩衝區。

- **格式：** 必須包含 `//!FORMAT`。Anime4K 推薦 `R16G16B16A16_FLOAT`。
- **尺寸：** 使用 `INPUT_WIDTH` 和 `INPUT_HEIGHT`。
- **範例：**
  ```glsl
  //!TEXTURE
  //!WIDTH INPUT_WIDTH
  //!HEIGHT INPUT_HEIGHT
  //!FORMAT R16G16B16A16_FLOAT
  // 這會在 Shader 外部創建資源，具體綁定由 Pass 的 IN/OUT 決定
  ```

---

### 5. Pass 定義與計算著色器 (Pass & Compute Shader)

每個步驟使用 `//!PASS` 定義，對應一個 WGSL 入口函數。

#### 標頭定義

```glsl
//!PASS 1
//!DESC Pass Description
//!IN INPUT                 <-- 定義 Group 1 的內容
//!OUT tex1_sampled, tex1_storaged  <-- 定義 Group 2 的內容 (注意：這裡寫變數名主要用於 Magpie 識別依賴)
//!BLOCK_SIZE 16            <-- 定義工作組大小
//!NUM_THREADS 64           <-- 定義線程數 (通常是 Block Size 的平方)
```

#### WGSL 函數體規範

1.  **屬性：** `@compute @workgroup_size(x, y, z)`
    - `x * y * z` 應等於 `//!NUM_THREADS`。
2.  **參數：** 必須接收內建變數。
3.  **坐標映射：** 使用 `Rmp8x8` (Magpie 慣用優化) 將 1D 線程索引映射為 2D 坐標。

```rust
@compute @workgroup_size(64, 1, 1)
fn Pass1(@builtin(workgroup_id) workgroup_id: uint3, @builtin(local_invocation_id) local_id: uint3) {
    // 1. 計算當前像素整數坐標
    let gxy: uint2 = (Rmp8x8(local_id.x)) + (workgroup_id.xy * 16u);

    // 2. 邊界檢查 (強制)
    let inputSize = scene.inputSize;
    if gxy.x >= inputSize.x || gxy.y >= inputSize.y {
        return;
    }

    // ... 邏輯 ...
}
```

---

### 6. 紋理操作對照表 (HLSL vs WGSL)

這是遷移過程中最容易出錯的部分，需嚴格區分坐標系統。

| 操作類型          | HLSL 語法                     | WGSL 語法                               | 坐標系統                 | 注意事項                                                                     |
| :---------------- | :---------------------------- | :-------------------------------------- | :----------------------- | :--------------------------------------------------------------------------- |
| **採樣 (Sample)** | `tex.SampleLevel(sam, uv, 0)` | `textureSampleLevel(tex, sam, uv, 0.0)` | **歸一化浮點 (0.0~1.0)** | 必須指定 Level (通常為 0.0)。<br>坐標需位移半像素：`(pos + 0.5) * pt`        |
| **聚集 (Gather)** | `tex.GatherRed(sam, uv)`      | `textureGather(0, tex, sam, uv)`        | **歸一化浮點 (0.0~1.0)** | 第一個參數是通道索引 (0=R, 1=G...)，必須是**常數**。                         |
| **寫入 (Store)**  | `tex[coord] = val`            | `textureStore(tex, coord, val)`         | **整數坐標 (int2)**      | 坐標必須轉為 `vec2<i32>`。<br>寫入值必須包含所有通道 (例如補 Alpha 為 1.0)。 |
| **讀取 (Load)**   | `tex[coord]`                  | `textureLoad(tex, coord, 0)`            | **整數坐標 (int2)**      | 無採樣器直接讀取像素。                                                       |

#### 坐標轉換公式

- **整數轉浮點 UV (採樣用):**
  ```rust
  let inputPt = scene.inputPt;
  let uv: MF2 = (MF2(gxy) + MF2(0.5, 0.5)) * inputPt;
  ```
- **無符號整數轉有符號整數 (存儲用):**
  ```rust
  let storePos = vec2<i32>(gxy);
  ```

---

### 7. 數學運算注意事項

1.  **矩陣乘法順序:**
    - 若使用 `alias MF3x4 = mat4x3<f32>;` (轉置定義)。
    - WGSL 寫法：`result = vector * matrix`。
    - 這會產生與 HLSL `mul(vector, matrix)` 相同的結果。
2.  **類型嚴格性:**
    - WGSL 不允許隱式轉換。
    - `float` 與 `int` 不能直接運算。
    - 字面量需帶後綴 (`0u`, `1.0`) 或顯式構造 (`MF4(0.0)`).
    - `max(-a1, 0.0)` $\to$ `max(-a1, MF4(0.0))`。
3.  **Swizzle (向量分量):**
    - 與 HLSL 相同 (`.xyzw`, `.rgba`)。
    - Gather 操作的返回值順序需特別注意（通常對應矩陣卷積的順序，如 Pass 1 中的 `w z -> x z`）。

---

### 8. 移植檢查清單 (Migration Checklist)

1.  [ ] **檢查頭部**: 確認 `//!CAPABILITY FP16` 已添加。
2.  [ ] **定義別名**: 確認 `MF3x4` 等矩陣別名是否正確映射為 `mat4x3` (Cols x Rows)。
3.  [ ] **資源綁定**: 確認 `//!IN` 對應 `@group(1)`，`//!OUT` 對應 `@group(2)`。
4.  [ ] **區分變數**: 確認讀取用 `texture_2d`，寫入用 `texture_storage_2d`。
5.  [ ] **坐標系統**:
    - 採樣/Gather 是否使用了 `(pos + 0.5) * pt`？
    - 寫入是否使用了 `vec2<i32>`？
6.  [ ] **邊界檢查**: Compute Shader 開頭是否有 `if (out of bounds) return;`？
7.  [ ] **矩陣運算**: 確認乘法是用 `*` 且順序為 `向量 * 矩陣`。
8.  [ ] **類型匹配**: 檢查 `max`, `min`, `clamp` 參數類型是否一致。
