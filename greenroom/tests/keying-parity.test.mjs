// WebGL 着色器 与 CPU 回退 的抠像一致性对照测试。
//
// 运行：cd greenroom && node --test tests/   （Node ≥ 18，无第三方依赖）
//
// 结构：
//   js/keying.js            —— 两个引擎共用的公式定义（CPU 直接调用，GLSL 由常量插值生成）
//   tests/glsl-ref.mjs      —— 着色器各 pass 的独立 JS 移植（参照物）
//   本文件                  —— 断言“共享实现 == GLSL 移植”，并检查引擎接线
//
// 注意：js/keying.js 与 tests/glsl-ref.mjs 的公式必须保持同步修改；
// 若有意调整公式，两处 + 本文件中的字面值断言要一起改。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  KEY, smoothstep01, rgbToYuv01, rgbToHsv01, prepareKey, keyDistance01,
  alphaFromDist01, keyAlphaPass, morphAlpha3x3, gaussAlpha3x3, postMaskAlpha,
  edgeFactor01,
} from '../js/keying.js';
import { KEY_FRAG, POST_MASK_FRAG } from '../js/gl/shaders.js';
import {
  glslSmoothstep, glslRgb2Yuv, glslRgb2Hsv, glslKeyDist01, glslKeyAlpha,
  glslEdgeFactor, glslAlphaPipeline,
} from './glsl-ref.mjs';

const GREEN = [0, 0.694, 0.251];
const BLUE = [0.08, 0.25, 0.95];

// ---------- 1. GLSL 公式确实由共享常量生成（字面值锚定，改公式需同步改这里） ----------

test('GLSL 色度距离公式与共享常量一致（RGB/YUV/HSV）', () => {
  // RGB：权重 vec3(1.2, 1.0, 1.2)，整体 ×0.8 —— 旧 CPU 公式的蓝通道 0.8、缺 ×0.8 不得出现
  assert.match(KEY_FRAG, /length\(d \* vec3\(1\.2, 1\.0, 1\.2\)\) \* 0\.8/);
  // YUV：色度平面距离 ×1.8
  assert.match(KEY_FRAG, /distance\(pu, ku\) \* 1\.8/);
  // HSV：环形色相 ×2.2 + 饱和度惩罚 ×0.25
  assert.match(KEY_FRAG, /dh \* 2\.2 \+ max\(hk\.y - h\.y, 0\.0\) \* 0\.25/);
  // 距离 → alpha：smoothstep(t ± sm)，带 sm 下限保护
  assert.match(KEY_FRAG, /smoothstep\(uThreshold - sm, uThreshold \+ sm, dist\)/);
  // 遮罩精修：降噪比例 / 吸附阈值 / 半透明区间
  assert.match(POST_MASK_FRAG, /uDenoise \* 0\.55/);
  assert.match(POST_MASK_FRAG, /uDenoise \* 0\.12/);
  assert.match(POST_MASK_FRAG, /a > 0\.18 && a < 0\.82/);
});

// ---------- 2. 色彩空间转换核对（YUV / HSV） ----------

test('rgb→YUV/HSV 转换：共享实现 == GLSL 移植（含灰阶/纯色奇异点）', () => {
  const samples = [];
  for (let v = 0; v <= 255; v += 17) samples.push([v / 255, v / 255, v / 255]); // 灰阶
  samples.push([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0], [1, 1, 1]);
  for (let i = 0; i < 2000; i++) {
    samples.push([Math.random(), Math.random(), Math.random()]);
  }
  let maxYuv = 0, maxHsv = 0;
  for (const [r, g, b] of samples) {
    const y1 = rgbToYuv01(r, g, b), y2 = glslRgb2Yuv(r, g, b);
    for (let k = 0; k < 3; k++) maxYuv = Math.max(maxYuv, Math.abs(y1[k] - y2[k]));
    const h1 = rgbToHsv01(r, g, b), h2 = glslRgb2Hsv(r, g, b);
    for (let k = 0; k < 3; k++) maxHsv = Math.max(maxHsv, Math.abs(h1[k] - h2[k]));
  }
  assert.ok(maxYuv < 1e-12, `YUV 最大偏差 ${maxYuv}`);
  // HSV 在奇点附近受 GLSL 版 1e-10 保护项影响，容差放宽到 1e-8（仍远小于 1/255）
  assert.ok(maxHsv < 1e-8, `HSV 最大偏差 ${maxHsv}`);
  // 已知值锚点
  assert.deepEqual(rgbToHsv01(1, 0, 0).map((x) => +x.toFixed(6)), [0, 1, 1]);
  assert.deepEqual(rgbToHsv01(0, 1, 0).map((x) => +x.toFixed(6)), [+(1 / 3).toFixed(6), 1, 1]);
  assert.deepEqual(rgbToHsv01(0, 0, 1).map((x) => +x.toFixed(6)), [+(2 / 3).toFixed(6), 1, 1]);
  assert.deepEqual(rgbToHsv01(0.5, 0.5, 0.5), [0, 0, 0.5]); // 灰：h=0, s=0
});

// ---------- 3. 三种模式的色度距离：共享实现 == GLSL 移植 ----------

test('RGB/YUV/HSV 色度距离在采样网格上一致', () => {
  const keyColors = [GREEN, BLUE, [0.8, 0.6, 0.5], [0.5, 0.5, 0.5]];
  const modes = ['RGB', 'YUV', 'HSV'];
  let maxDiff = 0, checked = 0;
  for (const kc of keyColors) {
    const key = prepareKey(kc);
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          for (const mode of modes) {
            const dShared = keyDistance01(mode, r / 255, g / 255, b / 255, key);
            const dGlsl = glslKeyDist01(mode, r / 255, g / 255, b / 255, kc);
            maxDiff = Math.max(maxDiff, Math.abs(dShared - dGlsl));
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 60000, `采样数 ${checked}`);
  assert.ok(maxDiff < 1e-9, `距离最大偏差 ${maxDiff}`);
});

test('RGB 距离已知值回归（钉住权重 1.2/1.0/1.2 与 ×0.8 缩放）', () => {
  const key = prepareKey(GREEN);
  // 键色本身 → 距离 0
  assert.equal(keyDistance01('RGB', ...GREEN, key), 0);
  // R 偏移 0.1：0.1 × 1.2 × 0.8 = 0.096
  assert.ok(Math.abs(keyDistance01('RGB', GREEN[0] + 0.1, GREEN[1], GREEN[2], key) - 0.096) < 1e-12);
  // B 偏移 0.1：同样是 0.096（蓝通道权重 1.2；旧 CPU 公式是 ×0.8 → 0.08，不得回归）
  assert.ok(Math.abs(keyDistance01('RGB', GREEN[0], GREEN[1], GREEN[2] + 0.1, key) - 0.096) < 1e-12);
  // 整体 ×0.8 缩放：各通道 +0.1 → hypot(0.12, 0.1, 0.12) × 0.8
  const expect = Math.hypot(0.12, 0.1, 0.12) * 0.8;
  assert.ok(Math.abs(keyDistance01('RGB', GREEN[0] + 0.1, GREEN[1] + 0.1, GREEN[2] + 0.1, key) - expect) < 1e-12);
});

// ---------- 4. 距离 → alpha 斜坡（smoothstep）与边界 ----------

test('alpha 斜坡：共享 smoothstep == GLSL smoothstep，且 smoothness=0 不出 NaN', () => {
  for (const threshold of [0.1, 0.38, 0.7]) {
    for (const smoothness of [0.01, 0.12, 0.5]) {
      for (let d = 0; d <= 1.6; d += 0.01) {
        const a1 = alphaFromDist01(d, threshold, smoothness);
        const sm = Math.max(smoothness, KEY.SMOOTH_EPS);
        const a2 = glslSmoothstep(threshold - sm, threshold + sm, d);
        assert.ok(Math.abs(a1 - a2) < 1e-12);
      }
    }
  }
  // smoothness = 0：两侧都有 eps 保护，结果有限且一致
  for (const d of [0, 0.379, 0.38, 0.381, 1]) {
    const a1 = alphaFromDist01(d, 0.38, 0);
    const a2 = glslKeyAlpha('RGB', 0, 0, 0, [d, 0, 0], 0.38, 0);
    assert.ok(Number.isFinite(a1) && Number.isFinite(a2));
  }
  // 中点 0.5，区间外饱和
  assert.equal(alphaFromDist01(0.38, 0.38, 0.12), 0.5);
  assert.equal(alphaFromDist01(0, 0.38, 0.12), 0);
  assert.equal(alphaFromDist01(1, 0.38, 0.12), 1);
});

test('溢色边缘因子：edgeFactor01 == GLSL edgeFactor', () => {
  for (let a = 0; a <= 1; a += 0.01) {
    assert.ok(Math.abs(edgeFactor01(a) - glslEdgeFactor(a)) < 1e-12);
  }
  assert.equal(edgeFactor01(0.5), 1);
  assert.equal(edgeFactor01(0), 0);
  assert.equal(edgeFactor01(1), 0);
});

// ---------- 5. 完整 alpha 管线：CPU 共享管线 == GLSL 移植管线 ----------

// 确定性伪随机（mulberry32）
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 合成测试帧：幕布（键色 + 光照渐变 + 噪点）+ 肤色前景块 + 1px 过渡带 + 孤立杂点
function makeScene(w, h, key01) {
  const rnd = mulberry32(42);
  const img = new Uint8ClampedArray(w * h * 4);
  const fg = [0.78, 0.57, 0.44];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const grad = 0.82 + 0.18 * (x / w);
      const n = (rnd() - 0.5) * 0.05;
      let c = key01.map((k) => k * grad + n);
      const inX = x >= w * 0.3 && x < w * 0.62, inY = y >= h * 0.25 && y < h * 0.8;
      const nearX = x >= w * 0.3 - 1 && x < w * 0.62 + 1, nearY = y >= h * 0.25 - 1 && y < h * 0.8 + 1;
      if (inX && inY) c = fg.slice();
      else if (nearX && nearY) c = fg.map((f, k) => (f + c[k]) / 2); // 过渡带
      if (rnd() < 0.004) c = [0.95, 0.95, 0.95]; // 孤立亮点（考降噪/形态学）
      img[i] = c[0] * 255; img[i + 1] = c[1] * 255; img[i + 2] = c[2] * 255; img[i + 3] = 255;
    }
  }
  return img;
}

// 与 CPUEngine.render 的 alpha 通路一一对应（共享模块函数）
function cpuPipeline(rgba, w, h, params) {
  let a = keyAlphaPass(rgba, w, h, params.key);
  for (let i = 0; i < params.mask.erode; i++) a = morphAlpha3x3(a, w, h, 0);
  for (let i = 0; i < params.mask.dilate; i++) a = morphAlpha3x3(a, w, h, 1);
  for (let i = 0; i < params.key.shrink; i++) a = morphAlpha3x3(a, w, h, 0);
  for (let i = 0; i < params.mask.blur; i++) a = gaussAlpha3x3(a, w, h);
  return postMaskAlpha(a, w, h, {
    featherW: params.key.feather * KEY.FEATHER_SCALE,
    denoise: params.mask.denoise,
    preserveSemi: params.mask.preserveSemi,
  });
}

function compareMasks(a, b) {
  let max = 0, sum = 0, exact = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d); sum += d;
    if (d === 0) exact++;
  }
  return { max, mean: sum / a.length, exactRatio: exact / a.length };
}

test('完整 alpha 管线：三种模式 × 多组参数，CPU 与 GLSL 参考逐像素一致', () => {
  const w = 96, h = 54;
  const paramSets = [
    { name: '默认', key: { threshold: 0.38, smoothness: 0.12, shrink: 1, feather: 1 },
      mask: { erode: 0, dilate: 0, blur: 1, denoise: 0.15, preserveSemi: true } },
    { name: '强形态学+羽化', key: { threshold: 0.45, smoothness: 0.2, shrink: 2, feather: 3 },
      mask: { erode: 1, dilate: 1, blur: 2, denoise: 0.5, preserveSemi: true } },
    { name: '硬边无后处理', key: { threshold: 0.3, smoothness: 0.01, shrink: 0, feather: 0 },
      mask: { erode: 0, dilate: 0, blur: 0, denoise: 0, preserveSemi: false } },
    { name: '膨胀收缩顺序敏感', key: { threshold: 0.4, smoothness: 0.1, shrink: 1, feather: 2 },
      mask: { erode: 0, dilate: 2, blur: 1, denoise: 0.3, preserveSemi: true } },
  ];
  for (const [mode, keyColor] of [['RGB', GREEN], ['YUV', GREEN], ['HSV', GREEN], ['RGB', BLUE]]) {
    const img = makeScene(w, h, keyColor);
    for (const ps of paramSets) {
      const key = { mode, color: keyColor, ...ps.key };
      const params = { key, mask: ps.mask };
      const aCpu = cpuPipeline(img, w, h, params);
      const aGl = glslAlphaPipeline(img, w, h, {
        mode, color: keyColor, threshold: key.threshold, smoothness: key.smoothness,
        erode: ps.mask.erode, dilate: ps.mask.dilate, shrink: key.shrink, blur: ps.mask.blur,
        featherW: key.feather * KEY.FEATHER_SCALE,
        denoise: ps.mask.denoise, preserveSemi: ps.mask.preserveSemi,
      });
      const { max, mean, exactRatio } = compareMasks(aCpu, aGl);
      assert.ok(max <= 1, `[${mode}/${ps.name}] 最大像素差 ${max}（应 ≤1/255）`);
      assert.ok(exactRatio >= 0.999, `[${mode}/${ps.name}] 完全一致像素占比 ${(exactRatio * 100).toFixed(2)}%`);
      assert.ok(mean < 0.01, `[${mode}/${ps.name}] 平均差 ${mean}`);
    }
  }
});

// ---------- 6. 遮罩 pass 单元行为 ----------

test('形态学/高斯/精修的基本行为', () => {
  const w = 8, h = 8;
  const impulse = new Uint8ClampedArray(w * h);
  impulse[3 * w + 3] = 255;
  // 腐蚀：孤立点被吃掉
  assert.ok(morphAlpha3x3(impulse, w, h, 0).every((v) => v === 0));
  // 膨胀：中心 3x3 变白
  const dil = morphAlpha3x3(impulse, w, h, 1);
  assert.equal(dil[3 * w + 3], 255);
  assert.equal(dil[2 * w + 2], 255);
  assert.equal(dil[0], 0);
  // 高斯：冲激 → 中心 4/16、轴邻 2/16、角邻 1/16
  const g = gaussAlpha3x3(impulse, w, h);
  assert.equal(g[3 * w + 3], Math.round(255 * 4 / 16));
  assert.equal(g[3 * w + 4], Math.round(255 * 2 / 16));
  assert.equal(g[2 * w + 2], Math.round(255 * 1 / 16));
  // 精修：feather=0 且 denoise=0 时恒等
  const flat = new Uint8ClampedArray(w * h).fill(128);
  const same = postMaskAlpha(flat, w, h, { featherW: 0, denoise: 0, preserveSemi: true });
  assert.deepEqual([...same], [...flat]);
  // 羽化曲线是 smoothstep：中点不变，斜率关于中点对称
  const ramp = new Uint8ClampedArray(w * h).fill(128 + 25);
  const f = postMaskAlpha(ramp, w, h, { featherW: 0.25, denoise: 0, preserveSemi: false });
  const expectF = smoothstep01(0.25, 0.75, (128 + 25) / 255) * 255;
  assert.ok(Math.abs(f[0] - expectF) <= 1);
});

// ---------- 7. 引擎接线：CPU 真的在用共享模块，旧公式不回归 ----------

test('CPUEngine / GLEngine 接线共享算法核心', () => {
  const cpuSrc = readFileSync(new URL('../js/cpu/CPUEngine.js', import.meta.url), 'utf8');
  assert.match(cpuSrc, /from '\.\.\/keying\.js'/);
  for (const fn of ['keyAlphaPass', 'morphAlpha3x3', 'gaussAlpha3x3', 'postMaskAlpha', 'edgeFactor01']) {
    assert.match(cpuSrc, new RegExp(fn), `CPUEngine 应调用 ${fn}`);
  }
  // 旧的未对齐公式不得回归：蓝通道 0.8 权重 / 线性斜坡 / 盒式模糊
  assert.doesNotMatch(cpuSrc, /keyColor\[2\]\) \* 0\.8/);
  assert.doesNotMatch(cpuSrc, /_boxBlurAlpha/);
  // 羽化系数同源
  const glSrc = readFileSync(new URL('../js/gl/GLEngine.js', import.meta.url), 'utf8');
  assert.match(glSrc, /KEY\.FEATHER_SCALE/);
  assert.match(cpuSrc, /KEY\.FEATHER_SCALE/);
});
