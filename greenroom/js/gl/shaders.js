// GLSL ES 1.00 着色器（WebGL1 / WebGL2 通用）

export const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
uniform float uFlipY;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUv = aPos * 0.5 + 0.5;
  if (uFlipY > 0.5) vUv.y = 1.0 - vUv.y;
}`;

// 场景采集 / 直接拷贝（可用于任意纹理）
export const SCENE_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

// 色度键 + 溢色抑制 + 前景调色
export const KEY_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec3  uKeyColor;
uniform int   uMode;        // 0 RGB, 1 YUV, 2 HSV
uniform float uThreshold;
uniform float uSmooth;
uniform int   uSpill;       // 0 none, 1 green, 2 blue
uniform float uSpillStrength;
uniform float uEdgeColor;
// 调色
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
uniform float uTint;
uniform float uGamma;
uniform float uMatchExp;    // 光照/色彩匹配后的曝光系数
uniform vec3  uMatchTint;   // 色彩匹配通道系数

vec3 rgb2yuv(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float u = -0.168736*c.r - 0.331264*c.g + 0.5*c.b + 0.5;
  float v = 0.5*c.r - 0.418688*c.g - 0.081312*c.b + 0.5;
  return vec3(y, u, v);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  // 无色度（灰/白/黑）时色相与饱和度项必须归零，否则 epsilon 除法会产生垃圾值，
  // 与 CPU 端 rgb2hsv 的 d<0.5e-6 守卫保持一致
  float hue = abs(q.z + (q.w - q.y) / (6.0 * d + e));
  float sat = d / (q.x + e);
  if (d < 0.5e-6) { hue = 0.0; sat = 0.0; }
  return vec3(hue, sat, q.x);
}

float keyAlpha(vec3 c) {
  float dist;
  if (uMode == 1) {
    // YUV 色度平面距离（忽略亮度，抗光照不均）
    vec2 pu = rgb2yuv(c).gb;
    vec2 ku = rgb2yuv(uKeyColor).gb;
    dist = distance(pu, ku) * 1.8;
  } else if (uMode == 2) {
    // HSV 色相距离，叠加饱和度/亮度权重
    vec3 h = rgb2hsv(c);
    vec3 hk = rgb2hsv(uKeyColor);
    float dh = abs(h.x - hk.x);
    dh = min(dh, 1.0 - dh);
    dist = dh * 2.2 + max(hk.y - h.y, 0.0) * 0.25;
  } else {
    // RGB 加权色度距离
    vec3 d = c - uKeyColor;
    dist = length(d * vec3(1.2, 1.0, 1.2)) * 0.8;
  }
  // dist 越小越像背景 → 背景 alpha 取反
  float bg = smoothstep(uThreshold - uSmooth, uThreshold + uSmooth, dist);
  return clamp(bg, 0.0, 1.0);
}

// 边缘程度：alpha 梯度（用于边缘颜色校正）
float edgeFactor(float a) {
  return 1.0 - smoothstep(0.0, 0.25, abs(a - 0.5) * 2.0);
}

void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float a = keyAlpha(c);

  // ---------- 溢色抑制 ----------
  if (uSpill == 1) {
    // 绿色溢色：G 超过 R/B 的部分视为背景反射，压回并略带品红补偿
    float gx = max(c.g - max(c.r, c.b), 0.0);
    float wgt = uSpillStrength * (1.0 - a);
    vec3 suppressed = c;
    suppressed.g -= gx * uSpillStrength;
    suppressed.rb += gx * 0.12 * uSpillStrength;
    // 边缘区域进一步去绿（与抠像边缘联动）
    wgt = clamp(wgt + edgeFactor(a) * uEdgeColor * 0.6, 0.0, 1.0);
    c = mix(c, suppressed, wgt);
  } else if (uSpill == 2) {
    float bx = max(c.b - max(c.r, c.g), 0.0);
    float wgt = uSpillStrength * (1.0 - a);
    vec3 suppressed = c;
    suppressed.b -= bx * uSpillStrength;
    suppressed.rg += bx * 0.10 * uSpillStrength;
    wgt = clamp(wgt + edgeFactor(a) * uEdgeColor * 0.6, 0.0, 1.0);
    c = mix(c, suppressed, wgt);
  }

  // ---------- 前景调色 ----------
  // 色温：暖↔冷；色调：绿↔品红
  c.r += uTemperature * 0.08;
  c.b -= uTemperature * 0.08;
  c.g += uTint * 0.08;
  c.r -= uTint * 0.04;
  c.b -= uTint * 0.04;
  // 亮度 / 对比度
  c += uBrightness;
  float cc = 1.0 + uContrast;
  c = (c - 0.5) * cc + 0.5;
  // 饱和度
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSaturation);
  // 曲线（gamma）
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / max(uGamma, 0.05)));
  // 前背景光照/色彩匹配（与调色联动：在调色后统一曝光）
  c *= uMatchExp;
  c *= uMatchTint;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), a);
}`;

// 形态学（作用于 alpha）：3x3 最小/最大
export const MORPH_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uPx;      // 1/纹理尺寸
uniform int  uMode;    // 0 erode(min), 1 dilate(max)
void main() {
  vec4 c = texture2D(uTex, vUv);
  float a = c.a;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float s = texture2D(uTex, vUv + vec2(float(x), float(y)) * uPx).a;
      if (uMode == 0) a = min(a, s);
      else a = max(a, s);
    }
  }
  gl_FragColor = vec4(c.rgb, a);
}`;

// 3x3 高斯：uAlphaOnly=1 时仅模糊 alpha（保留中心 RGB）
export const GAUSS_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uPx;
uniform int uAlphaOnly;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float aSum = 0.0;
  vec3 cSum = vec3(0.0);
  float wSum = 0.0;
  // 3x3 高斯权重
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float w = (x == 0 || y == 0) ? (x == 0 && y == 0 ? 4.0 : 2.0) : 1.0;
      vec4 s = texture2D(uTex, vUv + vec2(float(x), float(y)) * uPx);
      aSum += s.a * w;
      cSum += s.rgb * w;
      wSum += w;
    }
  }
  float a = aSum / wSum;
  vec3 rgb = (uAlphaOnly == 1) ? c.rgb : cSum / wSum;
  gl_FragColor = vec4(rgb, a);
}`;

// 遮罩精修：边缘羽化曲线 + 噪点抑制 + 半透明保留
export const POST_MASK_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uPx;
uniform float uFeatherW;  // 羽化半宽（0..0.5）
uniform float uDenoise;  // 0..1
uniform int   uPreserveSemi;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float a = c.a;

  if (uDenoise > 0.001) {
    float mean = 0.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++)
        mean += texture2D(uTex, vUv + vec2(float(x), float(y)) * uPx).a;
    mean /= 9.0;
    // 向邻域均值收缩，孤立杂点被吃掉，大面积边缘不受影响
    a = mix(a, mean, uDenoise * 0.55);
    float snap = uDenoise * 0.12;
    bool isSemi = a > 0.18 && a < 0.82;
    if (!(uPreserveSemi == 1 && isSemi)) {
      a = a < snap ? 0.0 : (a > 1.0 - snap ? 1.0 : a);
    }
  }

  if (uFeatherW > 0.001) {
    a = smoothstep(0.5 - uFeatherW, 0.5 + uFeatherW, a);
  }
  gl_FragColor = vec4(c.rgb, clamp(a, 0.0, 1.0));
}`;

// 合成
export const COMPOSITE_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uFg;         // 前景（rgb + a）
uniform sampler2D uBg;         // 背景（图片/视频/模糊场景）
uniform int   uBgMode;         // 0 solid 1 image 2 video 3 blur
uniform vec3  uBgColor;
uniform float uBgScale;
uniform vec2  uBgOffset;
uniform int   uShowAlpha;      // 直接输出 alpha 遮罩

vec2 bgUv() {
  vec2 uv = (vUv - 0.5) / max(uBgScale, 0.01) + 0.5 + uBgOffset;
  return uv;
}

void main() {
  vec4 fg = texture2D(uFg, vUv);
  if (uShowAlpha == 1) {
    gl_FragColor = vec4(vec3(fg.a), 1.0);
    return;
  }
  vec3 bg;
  if (uBgMode == 0) {
    bg = uBgColor;
  } else {
    vec2 uv = bgUv();
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      bg = uBgColor * 0.25; // 位移出界用深色兜底
    } else {
      bg = texture2D(uBg, uv).rgb;
    }
  }
  vec3 outc = fg.rgb * fg.a + bg * (1.0 - fg.a);
  gl_FragColor = vec4(outc, 1.0);
}`;

// 遮罩预览：alpha 灰度 + 棋盘底纹体现半透明
export const MASK_VIEW_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  float a = texture2D(uTex, vUv).a;
  vec2 cb = step(0.5, fract(vUv * vec2(40.0, 22.0)));
  float chk = mod(cb.x + cb.y, 2.0);
  vec3 base = mix(vec3(0.12), vec3(0.22), chk);
  gl_FragColor = vec4(mix(base, vec3(1.0), a), 1.0);
}`;
