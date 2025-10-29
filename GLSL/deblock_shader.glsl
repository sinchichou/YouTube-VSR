#version 300 es
precision highp float;

// 從頂點著色器傳入的紋理座標
in vec2 v_texCoord;

// 輸出的最終像素顏色
out vec4 fragColor;

// Uniforms (由 JavaScript 傳入的變數)
uniform sampler2D u_frame;       // 原始輸入影像紋理
uniform vec2 u_texelSize;         // 單一像素的大小 (1.0 / 解析度)
uniform float u_deblockStrength;  // 去色塊強度

// 模擬一個雙邊去色塊濾波器
vec3 deblock(vec2 uv) {
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    vec3 center = texture(u_frame, uv).rgb;
    
    // 遍歷 3x3 的鄰近像素區域
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y)) * u_texelSize;
            vec3 sample = texture(u_frame, uv + offset).rgb;
            
            // 空間權重 (Spatial Weight): 根據距離計算，越遠的像素權重越小
            float ws = exp(-(float(x*x + y*y)) / (2.0 * 1.0 * 1.0));
            
            // 顏色權重 (Range Weight): 根據顏色差異計算，顏色差別越大的像素權重越小
            float wr = exp(-dot(sample - center, sample - center) / (2.0 * 0.1 * 0.1));
            
            float w = ws * wr;
            sum += sample * w;
            wsum += w;
        }
    }
    // 根據強度混合原始顏色和濾波後的顏色
    return mix(center, sum / wsum, u_deblockStrength * 0.1);
}

void main() {
    fragColor = vec4(deblock(v_texCoord), 1.0);
}