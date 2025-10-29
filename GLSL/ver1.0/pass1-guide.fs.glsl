precision highp float;
varying vec2 v_texCoord;

uniform sampler2D u_frame;
uniform vec2 u_texelSize;

void main() {
    vec3 sum = vec3(0.0);

    // --- 手動展開 3x3 高斯模糊 ---
    // 這種寫法避免了所有 GLSL 1.0 的陣列初始化問題，且效能極佳。

    // Top row
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2(-1.0, -1.0)).rgb * 0.0625;
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2( 0.0, -1.0)).rgb * 0.125;
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2( 1.0, -1.0)).rgb * 0.0625;

    // Middle row
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2(-1.0,  0.0)).rgb * 0.125;
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2( 0.0,  0.0)).rgb * 0.25;
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2( 1.0,  0.0)).rgb * 0.125;

    // Bottom row
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2(-1.0,  1.0)).rgb * 0.0625;
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2( 0.0,  1.0)).rgb * 0.125;
    sum += texture2D(u_frame, v_texCoord + u_texelSize * vec2( 1.0,  1.0)).rgb * 0.0625;
    
    gl_FragColor = vec4(sum, 1.0);
}