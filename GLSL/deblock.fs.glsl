precision highp float;
varying vec2 v_texCoord;

uniform sampler2D u_frame;
uniform vec2 u_texelSize;
uniform float u_deblockStrength;
uniform float u_deblockSigma; // 新增：顏色差異的敏感度 (建議範圍 0.0 to 1.0)

vec3 deblock(vec2 uv) {
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    vec3 center = texture2D(u_frame, uv).rgb;
    
    // 計算動態的顏色權重分母，避免除以零
    float sigma = u_deblockSigma * u_deblockSigma * 2.0;
    if (sigma < 1e-6) sigma = 1e-6; // 防止 sigma 為 0

    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y)) * u_texelSize;
            vec3 sample = texture2D(u_frame, uv + offset).rgb;
            
            float ws = exp(-(float(x*x + y*y)) / (2.0 * 1.0 * 1.0));
            // 使用 u_deblockSigma 來動態控制顏色權重
            float wr = exp(-dot(sample - center, sample - center) / sigma);
            
            float w = ws * wr;
            sum += sample * w;
            wsum += w;
        }
    }
    // 移除 * 0.1 的硬編碼，讓強度控制更直接 (0.0 - 1.0)
    return mix(center, sum / wsum, u_deblockStrength);
}

void main() {
    gl_FragColor = vec4(deblock(v_texCoord), 1.0);
}