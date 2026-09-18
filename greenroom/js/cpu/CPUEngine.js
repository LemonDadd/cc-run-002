// CPU 2D Canvas 回退引擎：与 GLEngine 相同的接口，纯 JS 逐像素处理
// 为保证实时性，工作分辨率限制在约 360p 以内
// 色度键 / 形态学 / 高斯 / 遮罩精修与 WebGL 共用 js/keying.js 的同一套公式，
// 相同参数下两引擎的遮罩应一致（仅分辨率不同）。
import { paneToUv } from '../layout.js';
import {
  KEY, keyAlphaPass, morphAlpha3x3, gaussAlpha3x3, postMaskAlpha, edgeFactor01,
} from '../keying.js';

export class CPUEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bgImageEl = null;
    this.bgVideoEl = null;
    this.matchExp = 1; this.matchTint = [1, 1, 1];
    this.frameNo = 0;
    this.gpuMs = null;
    this.histogram = new Array(256).fill(0);
    this.workCanvas = document.createElement('canvas');
    this.wctx = this.workCanvas.getContext('2d', { willReadFrequently: true });
    this.bgCanvas = document.createElement('canvas');
    this.bctx = this.bgCanvas.getContext('2d', { willReadFrequently: true });
  }

  setBgImage(img) { this.bgImageEl = img; }
  clearBgImage() { this.bgImageEl = null; }
  setBgVideoElement(v) { this.bgVideoEl = v; }

  render(video, params, layout) {
    const t0 = performance.now();
    this.frameNo++;
    let passes = 0;

    // 工作分辨率：取视频尺寸 × downscale，长边封顶 480
    const vw = video && video.videoWidth ? video.videoWidth : 640;
    const vh = video && video.videoHeight ? video.videoHeight : 360;
    let w = Math.round(vw * params.quality.downscale);
    let h = Math.round(vh * params.quality.downscale);
    const maxSide = 480;
    if (Math.max(w, h) > maxSide) {
      const k = maxSide / Math.max(w, h);
      w = Math.round(w * k); h = Math.round(h * k);
    }
    this.workW = w; this.workH = h;

    // 1) 采集场景
    this.workCanvas.width = w; this.workCanvas.height = h;
    const ctx = this.wctx;
    if (video && video.videoWidth) {
      ctx.drawImage(video, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#06080c'; ctx.fillRect(0, 0, w, h);
    }
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    passes++;

    // 2) 背景准备（预渲染到工作尺寸，供逐像素索引）
    let bgData = null;
    const bgPre = this._prepareBackground(params, w, h);
    if (bgPre) { bgData = bgPre; passes += 3; }

    // 3) 色度键：与 WebGL KEY_FRAG 共用 js/keying.js 的同一套距离公式
    //    （RGB 加权 / YUV 色度平面 / HSV 色相，0..1 空间计算 + smoothstep 斜坡）
    //    keyAlpha 保留键控原始 alpha，供溢色权重使用（着色器里溢色发生在形态学之前）
    const keyAlpha = keyAlphaPass(d, w, h, params.key);
    let a = keyAlpha;
    passes++;

    // 4) 形态学：顺序与 GLEngine 一致（腐蚀 → 膨胀 → 边缘收缩）
    for (let i = 0; i < params.mask.erode; i++) { a = morphAlpha3x3(a, w, h, 0); passes++; }
    for (let i = 0; i < params.mask.dilate; i++) { a = morphAlpha3x3(a, w, h, 1); passes++; }
    for (let i = 0; i < params.key.shrink; i++) { a = morphAlpha3x3(a, w, h, 0); passes++; }

    // 5) 3x3 二项式高斯（与 GAUSS_FRAG 相同核，仅 alpha）
    for (let it = 0; it < params.mask.blur; it++) { a = gaussAlpha3x3(a, w, h); passes++; }

    // 6) 遮罩精修：降噪 → 羽化（与 POST_MASK_FRAG 相同公式）
    a = postMaskAlpha(a, w, h, {
      featherW: params.key.feather * KEY.FEATHER_SCALE,
      denoise: params.mask.denoise,
      preserveSemi: params.mask.preserveSemi,
    });
    passes++;

    // 7) 溢色 + 调色 + 合成（合一处理）
    const out = ctx.createImageData(w, h);
    const od = out.data;
    const s = params.spill, g = params.grade;
    const bgc = params.background.color;
    const cc = 1 + g.contrast;
    const gamma = 1 / Math.max(g.curve, 0.05);
    const link = s.linkGrade ? 0.85 : 1;
    const expMul = g.lightMatch ? (1 + (this.matchExp - 1) * link) : 1;
    const tintArr = params.background.colorMatch ? this.matchTint : [1, 1, 1];
    for (let p = 0, i = 0; i < od.length; i += 4, p++) {
      let r = d[i], gg = d[i + 1], b = d[i + 2];
      const aa = a[p] / 255;         // 精修后的遮罩：用于合成
      const ka = keyAlpha[p] / 255;  // 键控原始 alpha：用于溢色权重（对齐 KEY_FRAG）

      // 溢色（公式与 KEY_FRAG 相同：权重基于键控原始 alpha）
      if (s.channel === 'green') {
        const edge = edgeFactor01(ka);
        const wgt = Math.min(1, s.strength * (1 - ka) + edge * s.edgeColor * KEY.SPILL_EDGE_MIX);
        const gx = Math.max(gg - Math.max(r, b), 0);
        gg -= gx * s.strength;
        r += gx * 0.12 * s.strength; b += gx * 0.12 * s.strength;
        const nr = d[i] + (r - d[i]) * wgt;
        const ng = d[i + 1] + (gg - d[i + 1]) * wgt;
        const nb = d[i + 2] + (b - d[i + 2]) * wgt;
        r = nr; gg = ng; b = nb;
      } else if (s.channel === 'blue') {
        const edge = edgeFactor01(ka);
        const wgt = Math.min(1, s.strength * (1 - ka) + edge * s.edgeColor * KEY.SPILL_EDGE_MIX);
        const bx = Math.max(b - Math.max(r, gg), 0);
        b -= bx * s.strength;
        r += bx * 0.1 * s.strength; gg += bx * 0.1 * s.strength;
        const nr = d[i] + (r - d[i]) * wgt;
        const ng = d[i + 1] + (gg - d[i + 1]) * wgt;
        const nb = d[i + 2] + (b - d[i + 2]) * wgt;
        r = nr; gg = ng; b = nb;
      }

      // 调色（系数与 KEY_FRAG 相同：色温 ±0.08、色调 g +0.08 / r,b −0.04，×255）
      r = r + g.temperature * 20.4 - g.tint * 10.2;
      b = b - g.temperature * 20.4 - g.tint * 10.2;
      gg = gg + g.tint * 20.4;
      r += g.brightness * 255; gg += g.brightness * 255; b += g.brightness * 255;
      r = (r - 127.5) * cc + 127.5;
      gg = (gg - 127.5) * cc + 127.5;
      b = (b - 127.5) * cc + 127.5;
      const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
      r = lum + (r - lum) * g.saturation;
      gg = lum + (gg - lum) * g.saturation;
      b = lum + (b - lum) * g.saturation;
      r = 255 * Math.pow(Math.max(0, Math.min(255, r)) / 255, gamma);
      gg = 255 * Math.pow(Math.max(0, Math.min(255, gg)) / 255, gamma);
      b = 255 * Math.pow(Math.max(0, Math.min(255, b)) / 255, gamma);
      r *= expMul * (1 + (tintArr[0] - 1) * link);
      gg *= expMul * (1 + (tintArr[1] - 1) * link);
      b *= expMul * (1 + (tintArr[2] - 1) * link);
      // 与 KEY_FRAG 末尾的 clamp(c, 0, 1) 对齐：合成前截断，避免半透明区溢出加权
      r = Math.max(0, Math.min(255, r));
      gg = Math.max(0, Math.min(255, gg));
      b = Math.max(0, Math.min(255, b));

      // 背景取样
      let br, bg, bb;
      if (params.key.outputAlpha) {
        od[i] = od[i + 1] = od[i + 2] = aa * 255; od[i + 3] = 255; continue;
      }
      const m = params.background.mode;
      if (m === 'solid') {
        br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255;
      } else if (m === 'blur' || m === 'image' || m === 'video') {
        if (bgData) { br = bgData[i]; bg = bgData[i + 1]; bb = bgData[i + 2]; }
        else { br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255; }
      } else {
        br = bgc[0] * 255; bg = bgc[1] * 255; bb = bgc[2] * 255;
      }
      od[i] = r * aa + br * (1 - aa);
      od[i + 1] = gg * aa + bg * (1 - aa);
      od[i + 2] = b * aa + bb * (1 - aa);
      od[i + 3] = 255;
    }
    passes++;

    // 统计
    if (this.frameNo % 30 === 0) this._updateStats(a, od, w, h);
    // 直方图
    if (this.frameNo % 12 === 0) {
      const bins = new Array(256).fill(0);
      for (let i = 0; i < a.length; i++) bins[a[i]]++;
      this.histogram = bins;
    }

    // 三路视口绘制
    const c = this.canvas, gctx = this.ctx;
    c.width = layout.W; c.height = layout.H;
    gctx.fillStyle = '#000'; gctx.fillRect(0, 0, layout.W, layout.H);
    this.maskCanvas = this.maskCanvas || document.createElement('canvas');
    this.maskCanvas.width = w; this.maskCanvas.height = h;
    const mctx = this.maskCanvas.getContext('2d');
    const mimg = mctx.createImageData(w, h);
    for (let i = 0; i < mimg.data.length; i += 4) {
      const v = a[i / 4];
      mimg.data[i] = mimg.data[i + 1] = mimg.data[i + 2] = v;
      mimg.data[i + 3] = 255;
    }
    mctx.putImageData(mimg, 0, 0);
    this.compCanvas = this.compCanvas || document.createElement('canvas');
    if (this.compCanvas.width !== w || this.compCanvas.height !== h) {
      this.compCanvas.width = w; this.compCanvas.height = h;
    }
    this.compCanvas.getContext('2d').putImageData(out, 0, 0);
    const compCanvas = this.compCanvas;
    this.origCanvas = this.workCanvas;

    const paneAspect = layout.panes[0].w / layout.panes[0].h;
    const drawCover = (src, pane) => {
      const sa = w / h;
      let dw, dh, dx, dy;
      if (sa > paneAspect) { dh = pane.h; dw = dh * sa; dx = pane.x - (dw - pane.w) / 2; dy = pane.y; }
      else { dw = pane.w; dh = dw / sa; dy = pane.y - (dh - pane.h) / 2; dx = pane.x; }
      gctx.drawImage(src, dx, dy, dw, dh);
    };
    for (let i = 0; i < 3; i++) {
      const pn = layout.panes[i];
      gctx.save();
      gctx.beginPath(); gctx.rect(pn.x, pn.y, pn.w, pn.h); gctx.clip();
      if (i === 0) drawCover(this.workCanvas, pn);
      else if (i === 1) drawCover(this.maskCanvas, pn);
      else drawCover(compCanvas, pn);
      gctx.restore();
      if (i < 2) { gctx.strokeStyle = '#222'; gctx.strokeRect(pn.x, pn.y, pn.w, pn.h); }
    }
    passes += 3;

    return {
      cpuMs: performance.now() - t0,
      gpuMs: null,
      passes,
      workW: w, workH: h,
      histogram: this.histogram,
    };
  }

  // 将背景（图片/视频/模糊场景）按 cover + scale + offset 绘制到工作尺寸
  _prepareBackground(params, w, h) {
    const mode = params.background.mode;
    let el = null;
    if (mode === 'image' && this.bgImageEl &&
        (this.bgImageEl.naturalWidth || this.bgImageEl.width)) el = this.bgImageEl;
    if (mode === 'video' && this.bgVideoEl && this.bgVideoEl.videoWidth) el = this.bgVideoEl;

    if (mode === 'blur') {
      // 多级缩小放大制造强模糊
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d');
      tc.imageSmoothingEnabled = true;
      this.bgCanvas.width = Math.max(2, Math.round(w / 10));
      this.bgCanvas.height = Math.max(2, Math.round(h / 10));
      this.bctx.drawImage(this.workCanvas, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
      tc.drawImage(this.bgCanvas, 0, 0, w, h);
      this.bgCanvas.width = Math.max(2, Math.round(w / 5));
      this.bgCanvas.height = Math.max(2, Math.round(h / 5));
      this.bctx.drawImage(tmp, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
      tc.drawImage(this.bgCanvas, 0, 0, w, h);
      return tc.getImageData(0, 0, w, h).data;
    }

    if (!el) return null;
    const ew = el.videoWidth || el.naturalWidth;
    const eh = el.videoHeight || el.naturalHeight;
    this.bgCanvas.width = w; this.bgCanvas.height = h;
    const c = this.bctx;
    c.fillStyle = '#111'; c.fillRect(0, 0, w, h);
    c.imageSmoothingEnabled = true;
    // cover 基准 + scale/offset
    const sa = ew / eh, ta = w / h, scale = params.background.scale;
    let dw, dh;
    if (sa > ta) { dh = h; dw = h * sa; } else { dw = w; dh = w / sa; }
    dw *= scale; dh *= scale;
    const dx = (w - dw) / 2 + params.background.offsetX * w;
    const dy = (h - dh) / 2 + params.background.offsetY * h;
    // 2D drawImage 对图片/视频均按正立绘制，无需翻转
    c.drawImage(el, dx, dy, dw, dh);
    return c.getImageData(0, 0, w, h).data;
  }

  _updateStats(alpha, outData, w, h) {
    let rS = 0, gS = 0, bS = 0, aS = 0;
    for (let p = 0, i = 0; i < outData.length; i += 4, p++) {
      const aw = alpha[p];
      // outData 已是合成结果，前景色无法分离，用覆盖度加权统计近似前景亮度
      rS += outData[i] * aw;
      gS += outData[i + 1] * aw;
      bS += outData[i + 2] * aw;
      aS += aw;
    }
    if (aS < 4000) return;
    // rS/aS 已是 0..255 的加权均值（与 GL 统计同尺度），不要再 ×255
    const fR = rS / aS, fG = gS / aS, fB = bS / aS;
    // 背景近似：合成图中低 alpha 区域
    let br = 0, bg = 0, bb = 0, bn = 0;
    for (let p = 0, i = 0; i < outData.length; i += 4, p++) {
      if (alpha[p] < 40) { br += outData[i]; bg += outData[i + 1]; bb += outData[i + 2]; bn++; }
    }
    if (!bn) return;
    br /= bn; bg /= bn; bb /= bn;
    const exp = Math.min(2, Math.max(0.5,
      (0.299 * br + 0.587 * bg + 0.114 * bb) /
      (0.299 * fR + 0.587 * fG + 0.114 * fB + 1)));
    this.matchExp += (exp - this.matchExp) * 0.5;
    const tint = [
      Math.min(1.6, Math.max(0.6, br / (fR + 1))),
      Math.min(1.6, Math.max(0.6, bg / (fG + 1))),
      Math.min(1.6, Math.max(0.6, bb / (fB + 1))),
    ];
    this.matchTint = this.matchTint.map((v, i) => v + (tint[i] - v) * 0.5);
  }

  pickOriginal(nx, ny, workAspect, paneAspect) {
    const [u, v] = paneToUv(nx, ny, workAspect, paneAspect);
    const x = Math.max(0, Math.min(this.workW - 1, Math.round(u * this.workW)));
    const y = Math.max(0, Math.min(this.workH - 1, Math.round(v * this.workH)));
    const d = this.wctx.getImageData(x, y, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  }
}
