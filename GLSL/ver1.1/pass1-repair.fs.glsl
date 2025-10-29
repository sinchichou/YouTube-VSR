precision highp float;
varying vec2 v_texCoord;

uniform sampler2D u_frame;
uniform vec2 u_texelSize;

// --- 修復濾波器參數 ---
// 半徑 (Radius): 控制採樣範圍，1.0 = 3x3, 2.0 = 5x5。建議從 1.0 開始。
uniform float u_repairRadius;
// 強度 (Strength): 混合原始影像和濾波結果的比例。
uniform float u_repairStrength;
// 邊緣敏感度 (Edge Sensitivity): 數值越小，對邊緣越敏感（保護得越好），但去色塊能力越弱。
uniform float u_edgeSensitivity;

void main() {
    vec3 center_color = texture2D(u_frame, v_texCoord).rgb;
    
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    
    // 計算採樣範圍，floor確保我們處理的是整數像素偏移
    float radius = floor(u_repairRadius);
    
    // 遍歷採樣區域 (3x3 或 5x5 等)
    for (float y = -radius; y <= radius; y++) {
        for (float x = -radius; x <= radius; x++) {
            vec2 offset = vec2(x, y) * u_texelSize;
            vec3 sample_color = texture2D(u_frame, v_texCoord + offset).rgb;
            
            // --- 智慧權重計算 ---
            // 1. 空間權重: 離中心越遠，權重越低。
            float dist = dot(offset, offset);
            float w_spatial = exp(-dist / (2.0 * radius * radius));
            
            // 2. 顏色權重 (關鍵): 計算顏色差異的平方和
            vec3 diff = center_color - sample_color;
            float w_color = exp(-dot(diff, diff) / u_edgeSensitivity);
            
            float weight = w_spatial * w_color;
            
            sum += sample_color * weight;
            wsum += weight;
        }
    }
    
    vec3 final_color = mix(center_color, sum / wsum, u_repairStrength);
    
    gl_FragColor = vec4(final_color, 1.0);
}