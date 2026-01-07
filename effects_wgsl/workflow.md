## Magpie HLSL → WGSL（WebGPU）移植規範（WGFX 適用）

基於 Anime4K 與 WGFX 實務移植經驗整理。
注意：WGFX **僅遵守本規範，不提供彈性行為**。

---

## 1. 檔案初始化指令（Global Configuration）

必須置於檔案最頂端，用於告知 WGFX 如何解析與初始化 Shader。

必要性與實務影響已排序。

指令一覽：

- //!VERSION
- //!CAPABILITY
- //!SORT_NAME
- //!AUTHOR
- //!DESCRIPTION

重點說明：

- //!VERSION
- 必填
- 目前固定使用 `1.0`

- //!CAPABILITY
- **關鍵指令**
- Anime4K 必須宣告 `FP16`，否則效能與精度不符預期

範例：

```text
//!VERSION 1.0
//!CAPABILITY FP16
//!SORT_NAME Anime4K_Restore
//!AUTHOR bloc97
//!DESCRIPTION CNN Upscaler
```

---

## 2. 通用型別別名（HLSL 相容層）

目的：
降低 HLSL → WGSL 的語法與心智負擔，**避免在每個 Pass 重寫數學結構**。

### 2.1 基礎向量別名

```wgsl
alias uint2 = vec2<u32>;
alias uint3 = vec3<u32>;
alias uint4 = vec4<u32>;

alias int2  = vec2<i32>;
alias int3  = vec3<i32>;
alias int4  = vec4<i32>;

alias MF2 = vec2<f32>;
alias MF3 = vec3<f32>;
alias MF4 = vec4<f32>;
```

---

### 2.2 矩陣別名（**關鍵：行列轉置**）

原則：

- HLSL：Row × Column
- WGSL：Column × Row

對應策略：

- HLSL 的 `float3x4`
- WGSL 必須定義為 `mat4x3<f32>`

對照（僅列供參考）：

```wgsl
alias MF2x2 = mat2x2<f32>;
alias MF2x3 = mat3x2<f32>;
alias MF2x4 = mat4x2<f32>;
```

注意：

- WGSL 不支援 `mat1xN`，需退化為向量。

---

## 3. Scene Uniform 與共用工具函式

### 3.1 SceneInfo 結構（固定）

```wgsl
struct SceneInfo {
    inputSize: uint2,
    inputPt: MF2,
    outputSize: uint2,
    outputPt: MF2,
    scale: MF2,
}
```

綁定位置（固定）：

```wgsl
@group(0) @binding(3) var<uniform> scene: SceneInfo;
```

---

### 3.2 HLSL 相容存取函式（必須存在）

```wgsl
fn GetInputSize() -> uint2 { return scene.inputSize; }
fn GetInputPt() -> MF2 { return scene.inputPt; }
fn GetOutputSize() -> uint2 { return scene.outputSize; }
fn GetOutputPt() -> MF2 { return scene.outputPt; }
fn GetScale() -> MF2 { return scene.scale; }
fn GetFrameCount() -> u32 { return 0u; }
```

---

### 3.3 Magpie 執行緒映射工具（強烈建議）

```wgsl
fn Rmp8x8(a: u32) -> uint2 {
    let x = a % 8u;
    let y = a / 8u;
    return uint2(x, y);
}
```

用途：

- 將 1D local invocation index 映射為 8×8 2D 區塊
- [詳細參考](workspace/common_code.wgsl)

---

## 4. 紋理定義（Magpie Header）

使用 `//!TEXTURE` 宣告中間緩衝資源。

規則：

- 必須指定 FORMAT
- 尺寸通常使用 INPUT_WIDTH / INPUT_HEIGHT
- 實際綁定由 PASS 的 IN / OUT 決定

Anime4K 建議：

- R16G16B16A16_FLOAT

範例：

```wgsl
//!TEXTURE
//!WIDTH INPUT_WIDTH
//!HEIGHT INPUT_HEIGHT
//!FORMAT R16G16B16A16_FLOAT
```

---

## 5. Pass 與 Compute Shader 規範

### 5.1 Pass Header

```text
//!PASS 1
//!DESC Pass Description
//!IN INPUT
//!OUT tex1_sampled, tex1_storaged
//!BLOCK_SIZE 16
//!NUM_THREADS 64
```

關係限制：

- NUM_THREADS = workgroup_size.x × y × z

---

### 5.2 Compute Entry 規範（固定結構）

```wgsl
@compute @workgroup_size(64, 1, 1)
fn Pass1(
    @builtin(workgroup_id) workgroup_id: uint3,
    @builtin(local_invocation_id) local_id: uint3
) {
    let gxy = Rmp8x8(local_id.x) + workgroup_id.xy * 16u;

    let size = scene.inputSize;
    if (gxy.x >= size.x || gxy.y >= size.y) {
        return;
    }

    // logic
}
```

要求：

- 邊界檢查不可省略
- 坐標一律使用 uint2 → 最後才轉型

---

## 6. 紋理操作對照（高風險區）

### 6.1 操作語義差異

| 類型     | WGSL API           | 座標    |
|--------|--------------------|-------|
| Sample | textureSampleLevel | 浮點 UV |
| Gather | textureGather      | 浮點 UV |
| Load   | textureLoad        | int2  |
| Store  | textureStore       | int2  |

---

### 6.2 坐標轉換公式（強制）

整數 → UV（採樣）：
[
uv = (gxy + 0.5) \times inputPt
]

WGSL：

```wgsl
var uv = (MF2(gxy) + MF2(0.5)) * scene.inputPt;
```

寫入座標：

```wgsl
var pos = vec2<i32>(gxy);
```

---

## 7. 數學與型別陷阱（實務重點）

- WGSL 無隱式轉型
- 所有字面量需明確型別
- max / min / clamp 參數型別必須完全一致

矩陣乘法：

- 使用轉置 alias
- 一律寫成 vector \* matrix
- 對應 HLSL 的 mul(vector, matrix)

---

## 8. 移植檢查清單（不可省）

- CAPABILITY 是否正確
- 矩陣 alias 是否轉置正確
- IN / OUT group 是否正確
- Sample / Store 座標型別是否混用
- 是否補 Alpha
- 是否做邊界檢查
- 是否誤用隱式轉型
