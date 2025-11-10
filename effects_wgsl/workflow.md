HLSL 與 WGSL 的型別對應相當直接。根據你提供的巨集名稱，我整理成簡潔對應表格。你定義的是抽象型別 MF… → float…，WGSL 需要明確寫成
`f32` 向量與矩陣。

表格如下（名稱、HLSL 型別、WGSL 型別）：

| 名稱    | HLSL       | WGSL          |
|-------|------------|---------------|
| MF    | `float`    | `f32`         |
| MF1   | `float1`   | `vec1<f32>`   |
| MF2   | `float2`   | `vec2<f32>`   |
| MF3   | `float3`   | `vec3<f32>`   |
| MF4   | `float4`   | `vec4<f32>`   |
| MF1x1 | `float1x1` | `mat1x1<f32>` |
| MF1x2 | `float1x2` | `mat1x2<f32>` |
| MF1x3 | `float1x3` | `mat1x3<f32>` |
| MF1x4 | `float1x4` | `mat1x4<f32>` |
| MF2x1 | `float2x1` | `mat2x1<f32>` |
| MF2x2 | `float2x2` | `mat2x2<f32>` |
| MF2x3 | `float2x3` | `mat2x3<f32>` |
| MF2x4 | `float2x4` | `mat2x4<f32>` |
| MF3x1 | `float3x1` | `mat3x1<f32>` |
| MF3x2 | `float3x2` | `mat3x2<f32>` |
| MF3x3 | `float3x3` | `mat3x3<f32>` |
| MF3x4 | `float3x4` | `mat3x4<f32>` |
| MF4x1 | `float4x1` | `mat4x1<f32>` |
| MF4x2 | `float4x2` | `mat4x2<f32>` |
| MF4x3 | `float4x3` | `mat4x3<f32>` |
| MF4x4 | `float4x4` | `mat4x4<f32>` |

補充：
HLSL 的 `mul(a, b)` 對應 WGSL 是明確使用矩陣乘法 `a * b`（必須遵守運算元順序與維度一致性）。
WGSL 沒有 `uint2`，需用 `vec2<u32>`。
像 `GetInputSize`, `GetOutputSize` 等回傳型別 WGSL 對應如下：

| 函式                   | HLSL 回傳  | WGSL 回傳     |
|----------------------|----------|-------------|
| uint2 Rmp8x8(uint a) | `uint2`  | `vec2<u32>` |
| GetInputSize         | `uint2`  | `vec2<u32>` |
| GetInputPt           | `float2` | `vec2<f32>` |
| GetOutputSize        | `uint2`  | `vec2<u32>` |
| GetOutputPt          | `float2` | `vec2<f32>` |
| GetScale             | `float2` | `vec2<f32>` |
| GetFrameCount        | `uint`   | `u32`       |
