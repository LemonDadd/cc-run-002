# GreenRoom · 浏览器实时视频绿幕抠像与虚拟背景合成器

纯前端（原生 ES Modules + WebGL，零构建、零依赖）实时色度键合成器。打开页面即用内置测试绿幕源演示，无需摄像头、无需上传素材。

## 运行

必须通过 HTTP 提供（ES Module 与 `captureStream` 等在 `file://` 下受限）：

```bash
cd greenroom
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000
```

任何静态服务器均可（`npx serve`、VSCode Live Server 等）。

## 功能总览

| 模块 | 能力 |
|---|---|
| 视频输入 | 摄像头采集、本地视频上传、播放/暂停/逐帧/循环、内置测试绿幕源、源切换、原始分辨率/帧率/色彩空间/状态提示 |
| 色度键 | 吸管取色、绿幕/蓝幕/自定义键色、RGB / YUV / HSV 三种色度空间、相似度阈值、平滑度、边缘收缩、边缘羽化、输出 alpha |
| 遮罩后处理 | 形态学腐蚀、膨胀、3×3 高斯（仅 alpha）、噪点抑制、半透明区域保留、遮罩棋盘预览、256 bin alpha 直方图 |
| 溢色抑制 | 绿/蓝溢色抑制、强度、边缘颜色校正、与前景调色联动 |
| 背景合成 | 纯色 / 图片 / 视频 / 原视频多级模糊、缩放、位移、视频循环、前背景基础色彩匹配 |
| 前景调色 | 亮度、对比度、饱和度、色温、色调、gamma 曲线、前背景光照统一 |
| 预览对比 | 原始 / 遮罩 / 合成 三路同屏、可拖动分屏、横竖切换、按住看原始、3× 放大镜看边缘 |
| 性能面板 | WebGL/CPU 切换、渲染分辨率、帧率、CPU 耗时、GPU 耗时（EXT_disjoint_timer_query_webgl2）、Pass 数、丢帧、降采样、动态质量 |
| 预设 | 参数 JSON 导出/导入、IndexedDB 保存/加载/删除、内置 标准绿幕 / 蓝幕 / 低光照 |
| 导出 | 参数 JSON、遮罩 PNG、合成 PNG、对比信息 TXT 报告 |

## 渲染管线（WebGL 多 Pass）

工作分辨率 = 视频分辨率 × 降采样系数，所有处理在离屏 FBO 纹理间 ping-pong：

```
视频纹理
  → Pass 1 场景采集
  → Pass 2 背景模糊链（4×3×3 高斯，仅“原视频模糊”背景）
  → Pass 3 色度键 + 溢色抑制 + 前景调色（输出 rgba，a=前景遮罩）
  → Pass 4.. 形态学（腐蚀/膨胀/边缘收缩，3×3 min/max，作用于 alpha）
  → Pass .. alpha 3×3 高斯
  → Pass .. 遮罩精修（羽化 smoothstep + 邻域降噪 + 半透明保留）
  → Pass .. 前背景统计（每 30 帧，16×16 降采样回读，驱动光照/色彩匹配）
  → Pass N 背景合成
  → 三路视口 blit（原始 / 棋盘遮罩 / 合成）
```

主画布三路视口直接作为“分屏对比”和“放大镜”的取图源（`preserveDrawingBuffer`）。

## CPU 回退

右侧面板可随时切到 `CPU Canvas`：纯 JS 逐像素实现同样的色度键/溢色/调色/形态学/高斯/降噪/合成，工作分辨率长边封顶 480px 以保证实时。WebGL 初始化失败时自动回退。

两个引擎的抠像公式共用 `js/keying.js` 一份定义：CPU 直接调用其中的函数，GLSL 由其中的常量插值生成，因此相同参数下遮罩结果一致（仅分辨率不同）。一致性由 `tests/` 下的对照测试守护。

## 测试：WebGL / CPU 抠像一致性

```bash
cd greenroom
node --test tests/    # Node ≥ 18，无第三方依赖
```

覆盖内容：

- `tests/glsl-ref.mjs`：着色器各 pass（色度键 / 形态学 / 高斯 / 遮罩精修）的独立 JS 移植，作为参照物；
- `tests/keying-parity.test.mjs`：
  - GLSL 源码中的公式字面值锚定（RGB 权重 `vec3(1.2,1.0,1.2)` ×0.8、YUV ×1.8、HSV ×2.2/×0.25、smoothstep 斜坡）；
  - RGB / YUV / HSV 三种距离在 7 万+ 采样点上与 GLSL 移植一致；
  - 完整 alpha 管线（键控 → 形态学 → 高斯 → 精修）在合成测试帧上逐像素对比，容差 ≤ 1/255；
  - 引擎接线检查（CPUEngine 必须调用共享模块，旧公式不得回归）。

修改 `js/keying.js` 或 `js/gl/shaders.js` 的公式时，需同步更新 `tests/glsl-ref.mjs` 与测试中的字面值断言。

浏览器手动验证：打开页面后切换右侧 `WebGL / CPU 回退`，同一帧的“遮罩”窗应基本一致（仅分辨率差异）。

## 目录结构

```
greenroom/
├── index.html
├── style.css
├── js/
│   ├── main.js              # 主控：UI 绑定、主循环、性能、预设、导出
│   ├── params.js            # 参数模型 + 内置预设 + JSON
│   ├── keying.js            # 色度键/遮罩共享算法核心（WebGL 与 CPU 共用）
│   ├── db.js                # IndexedDB 预设存取
│   ├── source.js            # 摄像头/文件/内置 canvas 测试源
│   ├── layout.js            # 三路视口无缝布局 / cover 映射
│   ├── gl/
│   │   ├── shaders.js       # 全部 GLSL（公式常量由 keying.js 插值生成）
│   │   └── GLEngine.js      # WebGL 多 Pass 引擎
│   ├── cpu/
│   │   └── CPUEngine.js     # 2D Canvas 逐像素回退（调用 keying.js）
│   └── ui/
│       ├── compare.js       # 分屏对比 + 放大镜
│       └── histogram.js     # alpha 直方图
└── tests/
    ├── glsl-ref.mjs         # 着色器各 pass 的独立 JS 移植（测试参照物）
    └── keying-parity.test.mjs # WebGL/CPU 抠像一致性对照测试
```

## 使用提示

- 默认是 YUV 色度平面键控（对光照不均更鲁棒）；绿幕布色不均时加大“平滑度”，有绿边时加“边缘收缩 + 边缘颜色校正”。
- 头发等半透明区域：降低“降噪”、勾选“半透明区域保留”、适当增大羽化。
- 性能吃紧时下调降采样或开启“动态质量调节”（低于 ~26fps 自动降级）。
- 所有参数都可导出 JSON 复用；内置预设只覆盖算法参数，不替换背景素材。
