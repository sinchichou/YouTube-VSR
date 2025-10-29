// 使用 GLSL ES 1.0 語法
attribute vec4 position;

// 使用 varying 替代 out 關鍵字
varying vec2 v_texCoord;

void main() {
  // 直接將頂點位置傳遞給 gl_Position
  gl_Position = position;
  
  // 將頂點座標從 clip space (-1 to 1) 轉換為 texture space (0 to 1)
  v_texCoord = (position.xy * 0.5) + 0.5;
}