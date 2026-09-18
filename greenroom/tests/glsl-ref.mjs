// tests/glsl-ref.mjs
// js/gl/shaders.js 中 KEY_FRAG / MORPH_FRAG / GAUSS_FRAG / POST_MASK_FRAG 的
// 逐行 JS 移植，作为测试参照物。它与 js/keying.js 是“两份独立实现”：
// 测试断言二者在相同输入下输出一致，从而间接证明 CPU 引擎与 WebGL 着色器一致。
// 公式里的常量是 GLSL 生成后的字面值（对应 js/keying.js 的 KEY 常量注入结果）；
// 若修改 shaders.js 或 keying.js 的公式，需同步修改本文件。

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// GLSL step(edge, x)
const step = (e, x) => (x < e ? 0 : 1);

// GLSL smoothstep
export function glslSmoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// KEY_FRAG.rgb2yuv（0..1），返回 [y, u, v]
export function glslRgb2Yuv(r, g, b) {
  return [
    0.299 * r + 0.587 * g + 0.114 * b,
    -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5,
    0.5 * r - 0.418688 * g - 0.081312 * b + 0.5,
  ];
}

// KEY_FRAG.rgb2hsv：无分支 K 向量版逐行移植（mix(a,b,step) 即二选一）
export function glslRgb2Hsv(r, g, b) {
  const K = [0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0];
  // p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g))
  const p = step(b, g) === 1 ? [g, b, K[0], K[1]] : [b, g, K[3], K[2]];
  // q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r))
  const q = step(p[0], r) === 1 ? [r, p[1], p[2], p[0]] : [p[0], p[1], p[3], r];
  const d = q[0] - Math.min(q[3], q[1]);
  const e = 1.0e-10;
  return [Math.abs(q[2] + (q[3] - q[1]) / (6.0 * d + e)), d / (q[0] + e), q[0]];
}

// KEY_FRAG.keyAlpha 的距离分支（0..1 空间）
export function glslKeyDist01(mode, r, g, b, kc) {
  if (mode === 'YUV') {
    const pu = glslRgb2Yuv(r, g, b), ku = glslRgb2Yuv(kc[0], kc[1], kc[2]);
    return Math.hypot(pu[1] - ku[1], pu[2] - ku[2]) * 1.8;
  }
  if (mode === 'HSV') {
    const h = glslRgb2Hsv(r, g, b), hk = glslRgb2Hsv(kc[0], kc[1], kc[2]);
    let dh = Math.abs(h[0] - hk[0]);
    dh = Math.min(dh, 1 - dh);
    return dh * 2.2 + Math.max(hk[1] - h[1], 0) * 0.25;
  }
  const dr = r - kc[0], dg = g - kc[1], db = b - kc[2];
  return Math.hypot(dr * 1.2, dg * 1.0, db * 1.2) * 0.8;
}

// KEY_FRAG.keyAlpha 完整版（含 smoothstep 斜坡与 sm 下限）
export function glslKeyAlpha(mode, r, g, b, kc, threshold, smoothness) {
  const dist = glslKeyDist01(mode, r, g, b, kc);
  const sm = Math.max(smoothness, 0.0005);
  return clamp01(glslSmoothstep(threshold - sm, threshold + sm, dist));
}

// KEY_FRAG.edgeFactor
export function glslEdgeFactor(a) {
  return 1 - glslSmoothstep(0.0, 0.25, Math.abs(a - 0.5) * 2.0);
}

// MORPH_FRAG：3x3 min/max，边界 CLAMP_TO_EDGE
function glslMorph(src, w, h, mode) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = src[y * w + x];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.max(0, Math.min(h - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          const s = src[yy * w + xx];
          a = mode === 0 ? Math.min(a, s) : Math.max(a, s);
        }
      }
      out[y * w + x] = a;
    }
  }
  return out;
}

// GAUSS_FRAG：3x3 权重 4/2/1（仅 alpha）
function glslGauss(src, w, h) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let aSum = 0, wSum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const wgt = (dx === 0 || dy === 0) ? (dx === 0 && dy === 0 ? 4 : 2) : 1;
          const xx = Math.max(0, Math.min(w - 1, x + dx));
          const yy = Math.max(0, Math.min(h - 1, y + dy));
          aSum += src[yy * w + xx] * wgt;
          wSum += wgt;
        }
      }
      out[y * w + x] = aSum / wSum;
    }
  }
  return out;
}

// POST_MASK_FRAG：先降噪，后羽化（0..1 域计算，写回字节）
function glslPostMask(src, w, h, p) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = src[y * w + x] / 255;
      if (p.denoise > 0.001) {
        let mean = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.max(0, Math.min(h - 1, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.max(0, Math.min(w - 1, x + dx));
            mean += src[yy * w + xx] / 255;
          }
        }
        mean /= 9;
        a = a + (mean - a) * (p.denoise * 0.55);
        const snap = p.denoise * 0.12;
        const isSemi = a > 0.18 && a < 0.82;
        if (!(p.preserveSemi && isSemi)) {
          a = a < snap ? 0 : (a > 1 - snap ? 1 : a);
        }
      }
      if (p.featherW > 0.001) {
        a = glslSmoothstep(0.5 - p.featherW, 0.5 + p.featherW, a);
      }
      out[y * w + x] = clamp01(a) * 255;
    }
  }
  return out;
}

// GLEngine 的 alpha 通路：KEY → MORPH(腐蚀→膨胀→收缩) → GAUSS×n → POST_MASK，
// 各 pass 之间按 RGBA8 纹理量化为字节。
// p: { mode, color, threshold, smoothness, erode, dilate, shrink, blur, featherW, denoise, preserveSemi }
export function glslAlphaPipeline(rgba, w, h, p) {
  let a = new Uint8ClampedArray(w * h);
  for (let px = 0, i = 0; px < a.length; px++, i += 4) {
    a[px] = glslKeyAlpha(p.mode, rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255,
      p.color, p.threshold, p.smoothness) * 255;
  }
  for (let i = 0; i < p.erode; i++) a = glslMorph(a, w, h, 0);
  for (let i = 0; i < p.dilate; i++) a = glslMorph(a, w, h, 1);
  for (let i = 0; i < p.shrink; i++) a = glslMorph(a, w, h, 0);
  for (let i = 0; i < p.blur; i++) a = glslGauss(a, w, h);
  return glslPostMask(a, w, h, p);
}
