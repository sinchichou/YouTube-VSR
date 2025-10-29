#version 300 es

// 輸入頂點位置 (-1.0 to 1.0)
in vec4 position;

// 輸出給片段著色器的紋理座標 (0.0 to 1.0)
out vec2 v_texCoord;

void main() {
  // 直接將頂點位置傳遞給 gl_Position
  gl_Position = position;
  
  // 將頂點座標從 clip space (-1 to 1) 轉換為 texture space (0 to 1)
  v_texCoord = (position.xy * 0.5) + 0.5;
}