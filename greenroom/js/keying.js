// 色度键与 alpha 遮罩管线的共享算法核心。
//
// WebGL 着色器（js/gl/shaders.js）把下方 KEY 常量插值进 GLSL 源码；
// CPU 回退（js/cpu/CPUEngine.js）直接调用本模块的逐像素函数。
// 两侧共用同一份公式定义 —— 修改本文件会同时改变两个引擎；
// 对照测试 tests/keying-parity.test.mjs 验证两边输出一致。
//
// 约定：颜色与距离都在 0..1 空间计算（CPU 读到的字节先 /255）；
// 各 pass 之间 alpha 以字节（Uint8ClampedArray）量化，模拟 GPU 的 RGBA8 纹理。

export const KEY = {
  // RGB 加权色度距离：length(d * RGB_W) * RGB_SCALE
  RGB_W: [1.2, 1.0, 1.2],
  RGB_SCALE: 0.8,
  // YUV：色度平面 (u, v) 欧氏距离的放大系数（忽略亮度，抗光照不均）
  YUV_SCALE: 1.8,
  // HSV：环形色相距离系数 + “饱和度低于键色”惩罚系数
  HSV_DH: 2.2,
  HSV_DS: 0.25,
  // 距离 → alpha 的 smoothstep 最小半宽（避免 smoothness = 0 时 0/0）
  SMOOTH_EPS: 0.0005,
  // 遮罩精修
  FEATHER_SCALE: 0.045,  // 羽化 px → 0..1 半宽
  DENOISE_MIX: 0.55,     // 降噪：向 3x3 邻域均值收缩的比例
  DENOISE_SNAP: 0.12,    // 降噪：接近 0 / 1 时的吸附阈值
  SEMI_LO: 0.18,         // “半透明保留”区间
  SEMI_HI: 0.82,
  // 溢色边缘校正
  EDGE_HALF_WIDTH: 0.25, // edgeFactor 的 smoothstep 半宽
  SPILL_EDGE_MIX: 0.6,   // 边缘校正并入溢色权重的系数
};

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// 与 GLSL smoothstep 相同：三次埃尔米特插值，区间外取 0/1
export function smoothstep01(e0, e1, x) {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// BT.601 色度（与 GLSL rgb2yuv 相同），输入输出均为 0..1，返回 [y, u, v]
export function rgbToYuv01(r, g, b) {
  return [
    0.299 * r + 0.587 * g + 0.114 * b,
    -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5,
    0.5 * r - 0.418688 * g - 0.081312 * b + 0.5,
  ];
}

// 与 GLSL 分支版 rgb2hsv 等价（标准教材版），h/s/v ∈ 0..1
export function rgbToHsv01(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}

// 预计算键色在三个色彩空间的表示（每帧一次，避免逐像素重复转换）
export function prepareKey(color01) {
  const [r, g, b] = color01;
  return {
    rgb: [r, g, b],
    yuv: rgbToYuv01(r, g, b),
    hsv: rgbToHsv01(r, g, b),
  };
}

// 色度距离（0..1 空间），mode: 'RGB' | 'YUV' | 'HSV' —— 与 GLSL keyAlpha 的距离分支一致
export function keyDistance01(mode, r, g, b, key) {
  if (mode === 'YUV') {
    const [, u, v] = rgbToYuv01(r, g, b);
    return Math.hypot(u - key.yuv[1], v - key.yuv[2]) * KEY.YUV_SCALE;
  }
  if (mode === 'HSV') {
    const [h, s] = rgbToHsv01(r, g, b);
    let dh = Math.abs(h - key.hsv[0]);
    dh = Math.min(dh, 1 - dh);
    return dh * KEY.HSV_DH + Math.max(key.hsv[1] - s, 0) * KEY.HSV_DS;
  }
  const dr = (r - key.rgb[0]) * KEY.RGB_W[0];
  const dg = (g - key.rgb[1]) * KEY.RGB_W[1];
  const db = (b - key.rgb[2]) * KEY.RGB_W[2];
  return Math.hypot(dr, dg, db) * KEY.RGB_SCALE;
}

// 距离 → 前景 alpha（0..1），与 GLSL keyAlpha 末尾的 smoothstep 相同
export function alphaFromDist01(dist, threshold, smoothness) {
  const sm = Math.max(smoothness, KEY.SMOOTH_EPS);
  return smoothstep01(threshold - sm, threshold + sm, dist);
}

// ---- 以下为 CPU 回退使用的逐像素 pass（纯函数，可在 Node 中直接测试）----

// Pass: 色度键。输入 RGBA 字节，输出 alpha 字节 —— 对应 KEY_FRAG 的 alpha 分支
export function keyAlphaPass(data, w, h, keyParams) {
  const key = prepareKey(keyParams.color);
  const { mode, threshold, smoothness } = keyParams;
  const out = new Uint8ClampedArray(w * h);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const dist = keyDistance01(mode, data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, key);
    out[p] = alphaFromDist01(dist, threshold, smoothness) * 255;
  }
  return out;
}

// Pass: 3x3 形态学（mode 0 腐蚀 min / 1 膨胀 max），边界 clamp
// —— 对应 MORPH_FRAG + CLAMP_TO_EDGE
export function morphAlpha3x3(src, w, h, mode) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let val = src[idx];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          const v = src[yy * w + xx];
          val = mode === 0 ? Math.min(val, v) : Math.max(val, v);
        }
      }
      out[idx] = val;
    }
  }
  return out;
}

// Pass: 3x3 二项式高斯（权重 1-2-1 × 1-2-1，和 16，仅 alpha）—— 对应 GAUSS_FRAG
export function gaussAlpha3x3(src, w, h) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        const wy = dy === 0 ? 2 : 1;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          sum += src[yy * w + xx] * wy * (dx === 0 ? 2 : 1);
        }
      }
      out[y * w + x] = sum / 16;
    }
  }
  return out;
}

// Pass: 遮罩精修（先降噪，后羽化）—— 对应 POST_MASK_FRAG；featherW 为 0..1 半宽
export function postMaskAlpha(src, w, h, { featherW, denoise, preserveSemi }) {
  const out = new Uint8ClampedArray(w * h);
  const snap = denoise * KEY.DENOISE_SNAP * 255;
  const semiLo = KEY.SEMI_LO * 255, semiHi = KEY.SEMI_HI * 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let a = src[idx];
      if (denoise > 0.001) {
        let mean = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.max(0, Math.min(h - 1, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.max(0, Math.min(w - 1, x + dx));
            mean += src[yy * w + xx];
          }
        }
        mean /= 9;
        // 向邻域均值收缩，孤立杂点被吃掉，大面积边缘不受影响
        a += (mean - a) * denoise * KEY.DENOISE_MIX;
        const isSemi = a > semiLo && a < semiHi;
        if (!(preserveSemi && isSemi)) {
          if (a < snap) a = 0;
          else if (a > 255 - snap) a = 255;
        }
      }
      if (featherW > 0.001) {
        a = smoothstep01(0.5 - featherW, 0.5 + featherW, a / 255) * 255;
      }
      out[idx] = a;
    }
  }
  return out;
}

// 溢色边缘因子 —— 与 KEY_FRAG 的 edgeFactor 相同
export function edgeFactor01(a) {
  return 1 - smoothstep01(0, KEY.EDGE_HALF_WIDTH, Math.abs(a - 0.5) * 2);
}
