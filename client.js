/**
 * 切片牢大 · Client 半边
 * ---------------------------------------------------------------
 * 形态：纯浏览器插件（无构建步骤），走 DSH 的 `window.__ModuleLoader__` 动态模块。
 *
 * 挂载点（用 cordis_inspect_query 的 Slots 目录核实过）：
 *   - `sidebar.panellist` → 左侧栏的全局面板图标（宿主给 props: { size, active }）
 *   - `main`               → 中央主区，key 与 sidebar 的 id 相同（宿主按 id 派发）
 *     catalog 原话：「Each list id addresses the matching main panel」。
 *
 * 数据：全部图片以 dataURL 存在 IndexedDB（`dsh-sprite-studio` 库），
 * 另有「导出/导入工程 JSON」保证可迁移。Host 半边是空壳，见 index.js。
 *
 * 图像处理全部用离屏 Canvas：切分（网格 / alpha 连通域）与抠图（边缘连通漫水 / 全局色差）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sprite-studio',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;

    /** 面板 id：sidebar 图标与 main 面板共用同一个字符串，宿主靠它配对。 */
    const PANEL_ID = 'sprite-studio';
    const DB_NAME = 'dsh-sprite-studio';
    const DB_VERSION = 1;
    const STYLE_ID = 'dsh-sprite-studio-styles';
    const MAX_ZOOM = 8;
    const MIN_ZOOM = 0.05;
    const IMG_CACHE_LIMIT = 160;
    const HISTORY_LIMIT = 60;
    /** 右侧检查器的折叠状态：默认全收起 —— 选中图片不该自动把面板撑满。 */
    const SECTION_NAV = [
      { id: 'sprite', label: '选中' },
      { id: 'slice', label: '切图' },
      { id: 'matte', label: '抠图' },
      { id: 'bg', label: '背景' },
      { id: 'fx', label: '特效' },
      { id: 'library', label: '素材' },
      { id: 'compose', label: '合成' },
      { id: 'anim', label: '动画' },
      { id: 'export', label: '导出' },
      { id: 'canvas', label: '画布' },
    ];

    const DEFAULT_SECTIONS = Object.freeze({
      sprite: false,
      slice: false,
      matte: false,
      bg: false,
      anim: false,
      fx: false,
      library: false,
      compose: false,
      export: false,
      canvas: false,
    });

    // ── 小工具 ────────────────────────────────────────────────────────────
    let seq = 0;
    const uid = () => `sp_${Date.now().toString(36)}_${(seq++).toString(36)}`;
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const cx = (...p) => p.filter((x) => x !== null && x !== undefined && x !== false).join(' ');
    const round = (v, d = 0) => {
      const f = Math.pow(10, d);
      return Math.round(v * f) / f;
    };
    const hexOf = (c) =>
      '#' + [c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
    const parseHex = (s) => {
      const m = /^#?([0-9a-f]{6})$/i.exec((s || '').trim());
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    };
    const fmtSize = (w, hh) => `${Math.round(w)}×${Math.round(hh)}`;

    // ── 样式（渲染在 document.head，随 ctx.effect 卸载）─────────────────────
    const CSS = `
.ss-app{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13px;line-height:1.45;overflow:hidden}
.ss-app *,.ss-app *::before,.ss-app *::after{box-sizing:border-box}

.ss-bar{display:flex;align-items:center;gap:8px;height:46px;flex:0 0 auto;padding:0 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);min-width:0}
.ss-brand{display:flex;align-items:center;gap:8px;min-width:0;margin-right:4px}
.ss-brand-dot{width:18px;height:18px;flex:0 0 auto;display:flex;align-items:center}
.ss-brand-name{font-size:13.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap}
.ss-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ss-spacer{flex:1 1 auto;min-width:8px}
.ss-divider{width:1px;height:20px;background:var(--dsw-alias-border-l1);flex:0 0 auto}

.ss-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;
  transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.ss-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ss-btn:disabled{opacity:.42;cursor:not-allowed}
.ss-btn:disabled:hover{background:transparent;border-color:var(--dsw-alias-border-l1)}
.ss-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ss-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.ss-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.ss-btn.ghost{border-color:transparent}
.ss-btn.ghost:hover{background:var(--dsw-alias-bg-layer-2)}
.ss-btn.danger{color:var(--dsw-alias-state-error-primary)}
.ss-btn.tiny{height:24px;padding:0 8px;font-size:12px}
.ss-btn.icon{width:28px;padding:0}
.ss-btn.icon.tiny{width:24px}
.ss-btn.wide{width:100%}
.ss-btn.accent{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));
  color:var(--dsw-alias-brand-primary)}

.ss-body{flex:1 1 auto;display:flex;min-height:0}
.ss-board-wrap{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden}
.ss-board{position:absolute;inset:0;overflow:hidden;cursor:grab;touch-action:none;
  background-color:var(--dsw-alias-bg-base);
  background-image:radial-gradient(color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent) 1px,transparent 1px)}
.ss-board.is-panning{cursor:grabbing}
.ss-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}

.ss-item{position:absolute;border-radius:3px;cursor:default;
  background-image:conic-gradient(color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent) 0 25%,transparent 0 50%,color-mix(in srgb,var(--dsw-alias-label-secondary) 16%,transparent) 0 75%,transparent 0);
  background-size:14px 14px;background-position:0 0}
.ss-item img{display:block;width:100%;height:100%;pointer-events:none;user-select:none;-webkit-user-drag:none}
/* 选中环用 box-shadow 画（白内圈 + 品牌色外圈），线宽在行内按缩放补偿 —— 任何 zoom 下
   都是固定屏幕像素，不会缩到看不见。 */
.ss-item[data-selected="true"]{outline:none;z-index:9999}
.ss-handle{position:absolute;background:var(--dsw-alias-brand-primary);border:1px solid #fff;
  border-radius:1px;pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
.ss-item[data-dim="true"]{opacity:.55}

.ss-slice{position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0;z-index:9000}
.ss-slice-cell{position:absolute;border-style:solid;
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);
  box-shadow:0 0 0 1px color-mix(in srgb,#fff 26%,transparent) inset}
.ss-slice-idx{position:absolute;left:0;top:0;line-height:1.5;border-radius:3px;font-weight:600;
  background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);
  font-variant-numeric:tabular-nums;white-space:nowrap}

.ss-drop{position:absolute;inset:12px;border:1.5px dashed var(--dsw-alias-brand-primary);border-radius:14px;  display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;font-weight:500;
  color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);
  pointer-events:none;z-index:20}

.ss-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:6px;text-align:center;pointer-events:none;padding:24px}
.ss-empty-mark{width:46px;height:46px;border-radius:14px;margin-bottom:6px;
  background:linear-gradient(135deg,color-mix(in srgb,#5b5bd6 22%,transparent),color-mix(in srgb,#8b5cf6 18%,transparent));
  border:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-brand-primary)}
.ss-empty h2{margin:0;font-size:14.5px;font-weight:600}
.ss-empty p{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:360px;line-height:1.6}
.ss-kbd{display:inline-block;padding:1px 5px;margin:0 1px;border-radius:5px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

.ss-hud{position:absolute;left:12px;bottom:12px;display:flex;align-items:center;gap:6px;
  padding:4px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 88%,transparent);
  border:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;pointer-events:none}

.ss-busy{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;
  padding:7px 13px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);
  box-shadow:0 8px 26px rgba(0,0,0,.16);font-size:12px;z-index:30;max-width:80%}
.ss-spin{width:12px;height:12px;border-radius:50%;flex:0 0 auto;
  border:1.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);
  border-top-color:var(--dsw-alias-brand-primary);animation:ss-spin .7s linear infinite}
@keyframes ss-spin{to{transform:rotate(360deg)}}

.ss-toast{position:absolute;left:50%;top:14px;transform:translateX(-50%);padding:7px 13px;border-radius:9px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);
  box-shadow:0 8px 26px rgba(0,0,0,.16);font-size:12px;z-index:40;max-width:80%}
.ss-toast[data-tone="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,var(--dsw-alias-border-l1));
  color:var(--dsw-alias-state-error-primary)}
.ss-toast[data-tone="success"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-border-l1))}

.ss-insp{width:302px;flex:0 0 302px;border-left:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;min-height:0}
.ss-insp-scroll{flex:1 1 auto;overflow:auto;min-height:0;padding-bottom:28px}
/* 顶部快捷入口：点一下展开该板块并滚过去 */
.ss-nav{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px 7px;
  border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.ss-nav-btn{height:22px;padding:0 8px;border-radius:6px;font:inherit;font-size:11px;cursor:pointer;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.ss-nav-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ss-nav-btn[data-active="true"]{border-color:var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ss-insp-scroll::-webkit-scrollbar{width:8px}
.ss-insp-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 32%,transparent);border-radius:4px}

.ss-sec{border-bottom:1px solid var(--dsw-alias-border-l1)}
.ss-sec-head{display:flex;align-items:center;gap:8px;width:100%;padding:11px 14px;border:0;background:none;
  color:inherit;font:inherit;cursor:pointer;text-align:left}
.ss-sec-head:hover{background:var(--dsw-alias-bg-layer-2)}
.ss-sec-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ss-chev{display:inline-block;width:10px;font-size:13px;color:var(--dsw-alias-label-secondary);
  transition:transform .15s ease;transform-origin:50% 45%}
.ss-sec.is-open .ss-chev{transform:rotate(90deg)}
.ss-sec-title{flex:1 1 auto;font-size:12.5px;font-weight:600}
.ss-sec-aside{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ss-sec-body{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px}

.ss-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ss-field-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}
.ss-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}
.ss-row{display:flex;align-items:center;gap:8px;min-width:0}
.ss-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ss-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}

.ss-input{height:28px;width:100%;min-width:0;padding:0 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.ss-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.ss-input[type="number"]{font-variant-numeric:tabular-nums}

.ss-seg{display:inline-flex;padding:2px;gap:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);align-self:flex-start}
.ss-seg-btn{height:23px;padding:0 9px;border:0;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ss-seg-btn[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  box-shadow:0 1px 2px rgba(0,0,0,.1)}
.ss-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.ss-chips{display:flex;flex-wrap:wrap;gap:6px}
.ss-chip-btn{height:24px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;
  transition:border-color .12s ease,color .12s ease,background .12s ease}
.ss-chip-btn:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.ss-chip-btn[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.ss-color{width:34px;height:28px;flex:0 0 auto;padding:0;border:1px solid var(--dsw-alias-border-l2);
  border-radius:7px;background:none;cursor:pointer}
.ss-tile-preview{position:relative;height:124px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  overflow:hidden;background-color:var(--dsw-alias-bg-layer-2);
  background-repeat:repeat;background-position:center;image-rendering:pixelated}
.ss-tile-note{position:absolute;right:6px;bottom:5px;padding:1px 6px;border-radius:5px;font-size:10.5px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,transparent);color:var(--dsw-alias-label-secondary)}

/* 棋盘铺在容器上，图用 <img> 放在里面 —— 不要在同一个元素上叠两层 background-image：
   行内只设一张图时，background-size 的列表会错位，图被画成 12px。 */
.ss-fx-preview{height:168px;display:flex;align-items:center;justify-content:center;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background-color:var(--dsw-alias-bg-layer-2);
  background-image:conic-gradient(color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 0 25%,transparent 0 50%,color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 0 75%,transparent 0);
  background-size:12px 12px}
.ss-fx-preview img{max-width:92%;max-height:92%;image-rendering:pixelated;display:block}
/* 素材库：网格 + 缩略图。纯文字列表里 150 个条目等于盲选。 */
.ss-libgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:6px;
  max-height:300px;overflow:auto;padding:2px}
.ss-libitem{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 3px;
  border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  cursor:pointer;overflow:hidden}
.ss-libitem:hover{border-color:var(--dsw-alias-border-l2)}
.ss-libitem img{width:44px;height:44px;image-rendering:pixelated;object-fit:contain;display:block}
.ss-libph{width:44px;height:44px;display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-secondary);opacity:.35}
.ss-libname{font-size:10px;line-height:1.1;color:var(--dsw-alias-label-secondary);
  max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 取不到的清单：最多 40 条，可滚动 */
.ss-faillist{max-height:120px;overflow:auto;display:flex;flex-direction:column;gap:2px;
  padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.ss-failrow{font-size:10px;line-height:1.3;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ss-anim{position:relative;height:150px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  display:flex;align-items:flex-end;justify-content:center;overflow:hidden;cursor:pointer;
  background-image:conic-gradient(color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 0 25%,transparent 0 50%,color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 0 75%,transparent 0);
  background-size:12px 12px}
/* 所有帧按「底部居中」对齐：这是动画的脚底基准，尺寸不一致时也能对上。 */
.ss-anim img{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);
  max-width:92%;max-height:calc(100% - 16px);image-rendering:pixelated}
.ss-anim-ghost{opacity:.3}
.ss-strip{display:flex;gap:4px;overflow-x:auto;padding-bottom:2px}
.ss-strip-btn{width:30px;height:30px;flex:0 0 auto;padding:1px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);cursor:pointer;
  display:flex;align-items:center;justify-content:center}
.ss-strip-btn[data-active="true"]{border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}
.ss-strip-btn img{max-width:100%;max-height:100%;image-rendering:pixelated}
.ss-scanlist{display:flex;flex-direction:column;gap:1px;max-height:170px;overflow:auto;
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px}
.ss-scanrow{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;cursor:pointer}
.ss-scanrow:hover{background:var(--dsw-alias-bg-layer-2)}
.ss-scanrow input{margin:0;flex:0 0 auto}
.ss-scanrow-txt{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ss-scanrow-num{width:46px;height:20px;padding:0 4px;font:inherit;font-size:11.5px;text-align:center;
  border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary)}
/* 平铺 / 滚动预览：背景条是否无缝，只能「铺开看」和「滚起来看」。
   用 background-position-x 做动画，避开 y 轴定位，竖向上仍然居中。 */
.ss-tile-box{position:relative;height:132px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  overflow:hidden;background-color:var(--dsw-alias-bg-layer-2);
  background-repeat:repeat;background-position:0 center;image-rendering:pixelated}
.ss-tile-box[data-mode="scroll"]{background-repeat:repeat-x;animation:ss-scroll-x linear infinite}
@keyframes ss-scroll-x{from{background-position-x:0}to{background-position-x:var(--ss-tile-x)}}
/* 预览画布必须 flex:0 0 auto —— 它是个 flex 子项，默认 flex-shrink:1 会被纵向压扁。 */
.ss-slice-preview{display:block;flex:0 0 auto;max-width:100%;height:auto;
  border-radius:6px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);image-rendering:pixelated;align-self:center}

.ss-range{width:100%;height:20px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.ss-switch{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}
.ss-switch input{appearance:none;width:30px;height:17px;border-radius:999px;margin:0;cursor:pointer;position:relative;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent);transition:background .15s ease}
.ss-switch input::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;
  background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.ss-switch input:checked{background:var(--dsw-alias-brand-primary)}
.ss-switch input:checked::after{transform:translateX(13px)}
.ss-switch input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

.ss-previews{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ss-prev{position:relative;aspect-ratio:1/1;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  overflow:hidden;display:flex;align-items:center;justify-content:center;padding:6px;
  background-image:conic-gradient(color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 0 25%,transparent 0 50%,color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 0 75%,transparent 0);
  background-size:12px 12px}
.ss-prev img{max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated}
.ss-prev[data-pick="true"]{cursor:crosshair}
.ss-prev-label{position:absolute;left:5px;top:5px;padding:1px 5px;border-radius:5px;font-size:10.5px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);color:var(--dsw-alias-label-secondary)}
.ss-prev-hint{position:absolute;right:5px;bottom:5px;font-size:10px;color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);padding:1px 5px;border-radius:5px}

.ss-swatch{width:28px;height:28px;flex:0 0 auto;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);padding:0;cursor:pointer}
.ss-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;font-size:11px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ss-empty-note{font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px;line-height:1.6}
.ss-info{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.ss-error{font-size:11.5px;color:var(--dsw-alias-state-error-primary)}

.ss-zoom{display:flex;align-items:center;gap:1px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:2px}
.ss-zoom-val{min-width:46px;text-align:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;background:none;border:0;font:inherit;cursor:pointer;padding:0 2px;border-radius:5px}
.ss-zoom-val:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}

@media (max-width:900px){.ss-insp{width:258px;flex-basis:258px}}

.ss-fallback{align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}
.ss-fallback h2{margin:0;font-size:14px;font-weight:600}
.ss-fallback pre{margin:0;max-width:100%;white-space:pre-wrap;word-break:break-word;
  font-size:11.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
`;

    function installStyles() {
      const existing = document.querySelector(`style[data-plugin="${STYLE_ID}"]`);
      if (existing) return () => {};
      const el = document.createElement('style');
      el.dataset.plugin = STYLE_ID;
      el.textContent = CSS;
      document.head.append(el);
      return () => {
        el.remove();
      };
    }

    // ── IndexedDB ────────────────────────────────────────────────────────
    let dbPromise = null;
    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sprites')) db.createObjectStore('sprites', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch((err) => {
        dbPromise = null;
        throw err;
      });
      return dbPromise;
    }

    function txDone(tx) {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }

    async function loadAll() {
      const db = await openDb();
      const tx = db.transaction(['sprites', 'kv'], 'readonly');
      const all = new Promise((res, rej) => {
        const r = tx.objectStore('sprites').getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
      const board = new Promise((res, rej) => {
        const r = tx.objectStore('kv').get('board');
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
      const [sprites, boardState] = await Promise.all([all, board]);
      return { sprites, boardState };
    }

    async function saveDelta(put, remove, boardState) {
      const db = await openDb();
      const tx = db.transaction(['sprites', 'kv'], 'readwrite');
      const store = tx.objectStore('sprites');
      for (const sp of put) store.put(sp);
      for (const id of remove) store.delete(id);
      if (boardState) tx.objectStore('kv').put(boardState, 'board');
      await txDone(tx);
    }

    // ── 文件选择 ──────────────────────────────────────────────────────────
    // 用「视觉隐藏」而不是 display:none：display:none 的 input 在部分环境里
    // 拒绝被 .click() 唤起（Chromium 允许，但没必要赌）。
    const HIDDEN_INPUT_STYLE = {
      position: 'absolute',
      width: '1px',
      height: '1px',
      opacity: 0,
      pointerEvents: 'none',
      left: '-9999px',
      top: 0,
    };

    /**
     * 取走文件输入里的选中项，并清空输入（这样用户能再次选同一个文件）。
     *
     * 顺序是硬要求：`input.value = ''` 会把 `input.files` 这个**活**的 FileList
     * 一起清空。先拿引用、再清空 = 拿到一个空列表 —— 0.2.0 的「导入图片没作用」
     * 就是这么来的（拖入走 dataTransfer.files，复制后才清，所以拖入是好的）。
     */
    function takeInputFiles(input) {
      if (!input || !input.files) return [];
      const files = Array.from(input.files);
      input.value = '';
      return files;
    }

    // ── 图片基础 ──────────────────────────────────────────────────────────
    const imgCache = new Map();

    function loadImage(src) {
      const hit = imgCache.get(src);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          if (imgCache.size > IMG_CACHE_LIMIT) {
            const first = imgCache.keys().next();
            if (!first.done) imgCache.delete(first.value);
          }
          imgCache.set(src, img);
          resolve(img);
        };
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = src;
      });
    }

    function makeCanvas(w, hh) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w));
      c.height = Math.max(1, Math.round(hh));
      return c;
    }

    function ctx2d(canvas) {
      return canvas.getContext('2d', { willReadFrequently: true });
    }

    function readPixels(img) {
      const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
      const g = ctx2d(c);
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    }

    function cropCanvas(srcCanvas, rect) {
      const c = makeCanvas(rect.w, rect.h);
      ctx2d(c).drawImage(
        srcCanvas,
        rect.x, rect.y, rect.w, rect.h,
        0, 0, rect.w, rect.h,
      );
      return c;
    }

    function trimAlpha(imageData) {
      const { width: w, height: hh, data } = imageData;
      let minX = w, minY = hh, maxX = -1, maxY = -1;
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
    }

    function download(name, url, revoke) {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.append(a);
      a.click();
      a.remove();
      if (revoke) setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function safeName(name) {
      return String(name || 'sprite').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 64);
    }

    // ── ZIP 打包（无依赖，store 模式）────────────────────────────────────
    // PNG 已经压缩过，再 deflate 收益很低；直接 store（method=0）最省事也最不容易出错。
    const CRC_TABLE = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      return table;
    })();

    function crc32(bytes) {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function dosStamp(date) {
      const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
      const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
      return { time: time & 0xFFFF, date: day & 0xFFFF };
    }

    /**
     * entries: [{ name: string, bytes: Uint8Array }] → 完整 ZIP 字节。
     * 结构：每个文件一段 local header + 数据，末尾 central directory + EOCD（无 zip64）。
     */
    function makeZip(entries, when) {
      const date = when || new Date();
      const stamp = dosStamp(date);
      const enc = new TextEncoder();
      const body = [];
      const central = [];
      let offset = 0;

      for (const entry of entries) {
        const nameBytes = enc.encode(entry.name);
        const data = entry.bytes;
        const sum = crc32(data);

        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);      // local file header
        lv.setUint16(4, 20, true);              // version needed
        lv.setUint16(6, 0x0800, true);          // flag: UTF-8 文件名
        lv.setUint16(8, 0, true);               // method: store
        lv.setUint16(10, stamp.time, true);
        lv.setUint16(12, stamp.date, true);
        lv.setUint32(14, sum, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);              // extra length
        local.set(nameBytes, 30);

        const cd = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);      // central directory header
        cv.setUint16(4, 20, true);              // version made by
        cv.setUint16(6, 20, true);              // version needed
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, stamp.time, true);
        cv.setUint16(14, stamp.date, true);
        cv.setUint32(16, sum, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);              // extra length
        cv.setUint16(32, 0, true);              // comment length
        cv.setUint16(34, 0, true);              // disk number
        cv.setUint16(36, 0, true);              // internal attrs
        cv.setUint32(38, 0, true);              // external attrs
        cv.setUint32(42, offset, true);         // local header offset
        cd.set(nameBytes, 46);

        body.push(local, data);
        central.push(cd);
        offset += local.length + data.length;
      }

      const cdSize = central.reduce((n, b) => n + b.length, 0);
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);        // end of central directory
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, entries.length, true);
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, offset, true);
      ev.setUint16(20, 0, true);                // comment length

      const out = new Uint8Array(offset + cdSize + eocd.length);
      let p = 0;
      for (const chunk of body) { out.set(chunk, p); p += chunk.length; }
      for (const chunk of central) { out.set(chunk, p); p += chunk.length; }
      out.set(eocd, p);
      return out;
    }

    /** canvas 产出的 dataURL 一定是 base64 的，直接解出来。 */
    function dataUrlBytes(dataUrl) {
      const comma = String(dataUrl).indexOf(',');
      const bin = atob(comma >= 0 ? String(dataUrl).slice(comma + 1) : '');
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function fileStamp(d = new Date()) {
      const pad = (v) => String(v).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    }

    // ── 无缝背景生成 ──────────────────────────────────────────────────────
    // 关键点：噪声晶格索引对周期取模（`i % p`），于是 x=0 与 x=W 采样到同一格，
    // 左右/上下天然接得上。这就是「无缝」的全部秘密 —— 采样环绕，不是后期接边。

    /** 小而稳的 PRNG：同一种子必定同图，换种子才换图。 */
    function mulberry32(seed) {
      let t = seed >>> 0;
      return function next() {
        t = (t + 0x6D2B79F5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** 4×4 Bayer 有序抖动矩阵（值 0..15，标准排列）。 */
    const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

    /**
     * 生成可平铺的 fBm 噪声场，值域 0..1，长度 w*h。
     * period 是基础晶格密度（越大起伏越碎），octaves 是叠加层数（越多细节越足）。
     * 层数会被「晶格已经比图还密」截断 —— 再叠也只是逐像素噪点，没有意义。
     *
     * periodX / periodY 可以分开给：这就是「拉伸比 2:1 / 1:2」的实现，
     * 两轴的晶格数不同 → 特征在水平方向更宽。周期性分别在各轴上保证，无缝不受影响。
     */
    function periodicFbm(w, hh, opt) {
      const width = Math.max(1, Math.round(w));
      const height = Math.max(1, Math.round(hh));
      const basePeriod = clamp(Math.round(opt.period) || 3, 1, 64);
      const periodX = clamp(Math.round(opt.periodX) || basePeriod, 1, 64);
      const periodY = clamp(Math.round(opt.periodY) || basePeriod, 1, 64);
      const octaves = clamp(Math.round(opt.octaves) || 5, 1, 10);
      const rnd = mulberry32((opt.seed >>> 0) || 1);
      const out = new Float32Array(width * height);

      let amp = 1;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        const px = periodX * Math.pow(2, o);
        const py = periodY * Math.pow(2, o);
        // 两轴各自到「比图还密」就停
        if (px > width * 2 || py > height * 2) break;
        if (px * py > 4_000_000) break; // 晶格本身的内存上限
        const g = new Float32Array(px * py);
        for (let i = 0; i < g.length; i++) g[i] = rnd();

        // 预先算好每一列的晶格索引与插值系数，行内循环只做查表
        const col0 = new Int32Array(width);
        const colFx = new Float32Array(width);
        for (let x = 0; x < width; x++) {
          const c = (x / width) * px;
          const base = Math.floor(c);
          col0[x] = base % px;
          const f = c - base;
          colFx[x] = f * f * (3 - 2 * f);
        }

        for (let y = 0; y < height; y++) {
          const c = (y / height) * py;
          const rowBase = Math.floor(c);
          const r0 = (rowBase % py) * px;
          const r1 = ((rowBase + 1) % py) * px;
          const fy0 = c - rowBase;
          const fy = fy0 * fy0 * (3 - 2 * fy0);
          const inv = 1 - fy;
          for (let x = 0; x < width; x++) {
            const x0 = col0[x];
            const x1 = (x0 + 1) % px;
            const fx = colFx[x];
            const top = g[r0 + x0] * (1 - fx) + g[r0 + x1] * fx;
            const bottom = g[r1 + x0] * (1 - fx) + g[r1 + x1] * fx;
            out[y * width + x] += (top * inv + bottom * fy) * amp;
          }
        }
        norm += amp;
        amp *= 0.5;
      }
      if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
      return out;
    }

    /**
     * 噪声场 → RGBA。按 levels 分级（像素画要的是色阶，不是连续渐变）。
     *
     * 上色支持两种：给了 stops 就走多段色带（火焰/冰那种分段色相），
     * 否则退回深浅两色线性插值。色带分支刻意写成无分配的循环 ——
     * 每像素 new 一个对象在 512×512 上是几十万次分配，会明显拖慢生成。
     *
     * 抖动是**带状**的，不是全图铺：只在色阶交界附近 ±DITHER_BAND 的窄带里用 4×4 Bayer，
     * 其余地方硬边。全图抖动会把中间调摊成满屏棋盘格 —— 那不是像素画，是噪点。
     */
    const DITHER_BAND = 0.16;

    function colorizeTexture(field, w, hh, opt) {
      const width = Math.max(1, Math.round(w));
      const height = Math.max(1, Math.round(hh));
      const levels = clamp(Math.round(opt.levels) || 4, 2, 8);
      const dark = opt.dark || { r: 0, g: 0, b: 0 };
      const light = opt.light || { r: 255, g: 255, b: 255 };
      const stops = opt.stops && opt.stops.length ? opt.stops : null;
      const dither = !!opt.dither;
      const lo = 0.5 - DITHER_BAND;
      const hi = 0.5 + DITHER_BAND;
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const raw = clamp(field[i], 0, 1) * (levels - 1);
          let idx = Math.floor(raw);
          const frac = raw - idx;
          let step = frac >= 0.5 ? 1 : 0;
          if (dither && frac > lo && frac < hi) {
            // 带内把 frac 重映射到 0..1，再和 Bayer 阈值比 —— 得到渐进的网点过渡
            const k = (frac - lo) / (hi - lo);
            const threshold = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
            step = k > threshold ? 1 : 0;
          }
          idx = clamp(idx + step, 0, levels - 1);
          const t = levels === 1 ? 0 : idx / (levels - 1);
          const p = i * 4;
          if (opt.alpha) {
            // 特效：颜色照常取梯度，**透明度**由分级后的强度决定 ——
            // 这样一套参数换个色带就能出白热/火焰/冰，形状和透明度不用重算。
            rgba[p + 3] = Math.round(t * 255);
          } else {
            rgba[p + 3] = 255;
          }
          if (stops) {
            let s = 0;
            while (s < stops.length - 2 && t > stops[s + 1].t) s++;
            const a = stops[s];
            const b = stops[s + 1];
            const span = b.t - a.t || 1;
            const k = clamp((t - a.t) / span, 0, 1);
            rgba[p] = a.c.r + (b.c.r - a.c.r) * k;
            rgba[p + 1] = a.c.g + (b.c.g - a.c.g) * k;
            rgba[p + 2] = a.c.b + (b.c.b - a.c.b) * k;
          } else {
            rgba[p] = dark.r + (light.r - dark.r) * t;
            rgba[p + 1] = dark.g + (light.g - dark.g) * t;
            rgba[p + 2] = dark.b + (light.b - dark.b) * t;
          }
        }
      }
      return rgba;
    }
    /**
     * 混色用的色带（多段渐变）。
     * 二色线性插值做出来的图偏「灰」，而火焰/冰/毒这类要的是**分段色相跳变**：
     * 暗部偏红、中段橙、高光近白。所以按 4 个停靠点插值，比二色像样得多。
     */
    const BG_GRADIENTS = [
      { id: 'gray', label: '灰阶', stops: ['#0e0e10', '#4a4a4f', '#9a9aa2', '#ececf0'] },
      { id: 'forest', label: '森林', stops: ['#16241c', '#2f4a33', '#5f7f45', '#a8c47a'] },
      { id: 'fire', label: '火焰', stops: ['#1a0500', '#7a1a00', '#e0662f', '#ffd88a'] },
      { id: 'ice', label: '冰', stops: ['#08131f', '#1f4f78', '#5f9fc4', '#dff2ff'] },
      { id: 'poison', label: '毒', stops: ['#0d1406', '#2f4a0a', '#6f9a1a', '#cdf27a'] },
      { id: 'lava', label: '熔岩', stops: ['#0a0300', '#4a0d00', '#c23a00', '#ffb347'] },
      { id: 'sand', label: '沙', stops: ['#2a1e12', '#6a4a24', '#b89058', '#f2e2b8'] },
    ];

    /** 把 #rrggbb 数组转成带 t 的停靠点。 */
    function gradientStops(hexList) {
      const out = [];
      for (let i = 0; i < hexList.length; i++) {
        const c = parseHex(hexList[i]);
        if (!c) continue;
        out.push({ t: hexList.length === 1 ? 0 : i / (hexList.length - 1), c });
      }
      if (!out.length) return [{ t: 0, c: { r: 0, g: 0, b: 0 } }, { t: 1, c: { r: 255, g: 255, b: 255 } }];
      if (out.length === 1) out.push({ t: 1, c: out[0].c });
      return out;
    }

    /** 在色带上取色（线性插值）。 */
    function sampleStops(stops, t) {
      const x = clamp(t, 0, 1);
      if (x <= stops[0].t) return stops[0].c;
      for (let i = 1; i < stops.length; i++) {
        if (x <= stops[i].t) {
          const a = stops[i - 1];
          const b = stops[i];
          const span = b.t - a.t || 1;
          const k = (x - a.t) / span;
          return {
            r: a.c.r + (b.c.r - a.c.r) * k,
            g: a.c.g + (b.c.g - a.c.g) * k,
            b: a.c.b + (b.c.b - a.c.b) * k,
          };
        }
      }
      return stops[stops.length - 1].c;
    }

    /**
     * 把两张噪声场按混合模式合成。
     * 全部是逐像素运算 —— 两个周期场混合后仍然是周期的，无缝性不会丢。
     */
    const BLEND_MODES = [
      { id: 'add', label: '相加' },
      { id: 'multiply', label: '相乘' },
      { id: 'max', label: '最大' },
      { id: 'min', label: '最小' },
      { id: 'screen', label: '滤色' },
      { id: 'overlay', label: '覆盖' },
      { id: 'softlight', label: '柔光' },
      { id: 'difference', label: '差值' },
      { id: 'subtract', label: '相减' },
    ];

    function blendFields(a, b, mode) {
      const n = Math.min(a.length, b.length);
      const out = new Float32Array(n);
      switch (mode) {
        case 'add':
          for (let i = 0; i < n; i++) out[i] = clamp(a[i] + b[i], 0, 1);
          break;
        case 'multiply':
          for (let i = 0; i < n; i++) out[i] = a[i] * b[i];
          break;
        case 'max':
          for (let i = 0; i < n; i++) out[i] = Math.max(a[i], b[i]);
          break;
        case 'min':
          for (let i = 0; i < n; i++) out[i] = Math.min(a[i], b[i]);
          break;
        case 'screen':
          for (let i = 0; i < n; i++) out[i] = 1 - (1 - a[i]) * (1 - b[i]);
          break;
        case 'overlay':
          for (let i = 0; i < n; i++) {
            const x = a[i];
            out[i] = x < 0.5 ? 2 * x * b[i] : 1 - 2 * (1 - x) * (1 - b[i]);
          }
          break;
        case 'softlight':
          for (let i = 0; i < n; i++) {
            const x = a[i];
            out[i] = (1 - 2 * b[i]) * x * x + 2 * b[i] * x;
          }
          break;
        case 'difference':
          for (let i = 0; i < n; i++) out[i] = Math.abs(a[i] - b[i]);
          break;
        case 'subtract':
          for (let i = 0; i < n; i++) out[i] = Math.max(0, a[i] - b[i]);
          break;
        default:
          out.set(a.subarray(0, n));
      }
      return out;
    }

    /**
     * 后处理，顺序固定：自动色阶 → 反相 → 对比 → Gamma → 亮度。
     * 顺序不能随便换（先反相再自动色阶与反过来结果完全不同），所以写死并注释。
     */
    function postProcess(field, opt) {
      const out = new Float32Array(field.length);
      const autoLevels = !!opt.autoLevels;
      const invert = !!opt.invert;
      const contrast = Number.isFinite(opt.contrast) ? opt.contrast : 1;
      const gamma = Number.isFinite(opt.gamma) ? opt.gamma : 1;
      const bright = Number.isFinite(opt.bright) ? opt.bright : 0;
      let lo = 0;
      let hi = 1;
      if (autoLevels) {
        lo = 1;
        hi = 0;
        for (let i = 0; i < field.length; i++) {
          const v = field[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo < 1e-6) { lo = 0; hi = 1; }
      }
      const invSpan = 1 / (hi - lo);
      for (let i = 0; i < field.length; i++) {
        let v = field[i];
        if (autoLevels) v = (v - lo) * invSpan;
        if (invert) v = 1 - v;
        v = clamp(v, 0, 1);
        if (contrast !== 1) v = clamp((v - 0.5) * contrast + 0.5, 0, 1);
        if (gamma !== 1) v = Math.pow(v, 1 / Math.max(0.05, gamma));
        if (bright) v = clamp(v + bright, 0, 1);
        out[i] = v;
      }
      return out;
    }

    /**
     * 通道打包：R/G/B 各放一张灰度场，A 放遮罩（不给就全不透明）。
     * 用途是给引擎算法线/遮罩图 —— 这种图肉眼看着是花的，别拿它当贴图用。
     */
    function packChannels(r, g, b, a) {
      const n = r.length;
      const out = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        out[i * 4] = clamp(r[i], 0, 1) * 255;
        out[i * 4 + 1] = g ? clamp(g[i], 0, 1) * 255 : 0;
        out[i * 4 + 2] = b ? clamp(b[i], 0, 1) * 255 : 0;
        out[i * 4 + 3] = a ? clamp(a[i], 0, 1) * 255 : 255;
      }
      return out;
    }

    /** 把 "2:1" 解析成 [2,1]，用于在 x/y 上分别缩放晶格密度（= 拉伸比）。 */
    function parseStretch(id) {
      const m = /^(\d+):(\d+)$/.exec(String(id || '1:1'));
      if (!m) return [1, 1];
      return [clamp(Number(m[1]) || 1, 1, 8), clamp(Number(m[2]) || 1, 1, 8)];
    }

    /** 取色带：预设 id，或自定义的二色。 */
    function resolveBgStops(opt) {
      if (opt.palette === 'custom') return [opt.dark, opt.light];
      const g = BG_GRADIENTS.find((x) => x.id === opt.palette);
      return g ? g.stops : BG_GRADIENTS[0].stops;
    }

    /** 背景配色预设：只给深浅两色，色阶与抖动仍由参数决定。 */
    const BG_PALETTES = [
      { id: 'forest', label: '森林', dark: '#16241c', light: '#7f9a5c' },
      { id: 'desert', label: '沙漠', dark: '#3a2a1c', light: '#d8b878' },
      { id: 'snow', label: '雪原', dark: '#3d4a5c', light: '#dfe8f2' },
      { id: 'night', label: '夜色', dark: '#0d1120', light: '#3f4d7a' },
      { id: 'lava', label: '岩浆', dark: '#2a0d08', light: '#e0662f' },
    ];

    // ── 切分预设 ──────────────────────────────────────────────────────────
    /**
     * 单元格尺寸预设。**只存参数、不分发素材** —— 绕开 LPC 那类 CC-BY-SA 素材的传染义务。
     * 数值都来自各家文档：LPC 标准单帧 64×64；Kenney Pixel Platformer 18×18；
     * Kenney Roguelike / Tiny Town 16×16；LPC Tile Atlas 32×32。
     */
    const GRID_PRESETS = [
      { id: 'lpc64', label: 'LPC 64', cell: 64 },
      { id: 'atlas32', label: '图集 32', cell: 32 },
      { id: 'kenney18', label: 'Kenney 18', cell: 18 },
      { id: 'kenney16', label: 'Kenney 16', cell: 16 },
    ];

    /**
     * LPC 通用表里每个动作占 4 行，方向顺序 **n / w / s / e**（上、左、下、右）。
     * 行号来自生成器源码 `sources/custom-animations.ts` 的 `animationRowsLayout`：
     * thrust 3–6、walk 7–10、slash 11–14、sit 29–32。
     * 这张表会随版本变化 —— 所以界面上永远允许再改，不能当成恒定事实写死。
     */
    const LPC_DIRECTIONS = ['up', 'left', 'down', 'right'];
    const LPC_ACTIONS = [
      { id: 'thrust', label: '突刺', row: 3 },
      { id: 'walk', label: '行走', row: 7 },
      { id: 'slash', label: '挥砍', row: 11 },
      { id: 'sit', label: '坐下', row: 29 },
    ];
    const LPC_CELL = 64;

    /**
     * 预设按钮的「再点一下取消」判定：当前生效的就是这一个 → 取消，否则 → 应用。
     * 抽成纯函数是因为它同时决定按钮高亮，两处必须一致。
     */
    function presetToggle(active, kind, id) {
      return !!(active && active.kind === kind && active.id === id);
    }

    /**
     * 预设的撤销栈。
     *
     * 只存「应用前的网格」是不够的：A→B→取消 B 时会还原成 A 的参数，
     * 但高亮还停在 null 上 —— 参数和标记对不上，用户会以为出了 bug（确实出了）。
     * 所以每一层压的是 { grid, preset }，取消时把「当前生效的预设」也一起还原。
     */
    const PRESET_STACK_LIMIT = 20;

    function pushPreset(stack, state) {
      stack.push(state);
      if (stack.length > PRESET_STACK_LIMIT) stack.shift();
      return stack;
    }

    function popPreset(stack) {
      return stack.length ? stack.pop() : null;
    }

    /** 帧命名。开了「四向命名」且正好 4 行时用方向，否则用序号。 */    function frameName(sheetName, index, cols, rows, useDirs) {
      const col = index % Math.max(1, cols);
      const row = Math.floor(index / Math.max(1, cols));
      const seq = String(col + 1).padStart(2, '0');
      if (useDirs && rows === 4) {
        return `${sheetName}_${LPC_DIRECTIONS[clamp(row, 0, 3)]}_${seq}`;
      }
      return `${sheetName}_${String(index + 1).padStart(2, '0')}`;
    }

    // ── 图集打包 ──────────────────────────────────────────────────────────
    function nextPow2(v) {
      let n = 1;
      while (n < v) n *= 2;
      return n;
    }

    /**
     * 货架式装箱（shelf / next-fit-decreasing-height）。
     *
     * 为什么不用 MaxRects：那要维护空闲矩形列表，代码量翻倍，而图集面积通常只差几个百分点；
     * 我们的输入多半是一批同尺寸帧（切图产物），按高度降序排好再一行行铺，已经接近最优。
     *
     * items: [{ w, h }] → { width, height, placed: [{ x, y, w, h, index }] } | null（装不下）
     */
    function packRects(items, opt) {
      const pad = Math.max(0, Math.round(opt.padding) || 0);
      const maxSize = Math.max(64, Math.round(opt.maxSize) || 2048);
      const pot = !!opt.pot;
      if (!items || !items.length) return null;

      const order = items
        .map((it, index) => ({
          w: Math.max(1, Math.round(it.w)),
          h: Math.max(1, Math.round(it.h)),
          index,
        }))
        .sort((a, b) => b.h - a.h || b.w - a.w);

      const total = order.reduce((sum, it) => sum + (it.w + pad) * (it.h + pad), 0);
      let width = nextPow2(Math.ceil(Math.sqrt(total)));
      const widest = order.reduce((m, it) => Math.max(m, it.w), 1);
      width = Math.max(width, nextPow2(widest));

      while (width <= maxSize) {
        const placed = [];
        let x = 0;
        let y = 0;
        let rowH = 0;
        let ok = true;
        for (const it of order) {
          if (x + it.w > width) {
            x = 0;
            y += rowH + pad;
            rowH = 0;
          }
          if (y + it.h > maxSize) { ok = false; break; }
          placed.push({ x, y, w: it.w, h: it.h, index: it.index });
          x += it.w + pad;
          if (it.h > rowH) rowH = it.h;
        }
        if (ok) {
          let outW = width;
          let outH = y + rowH;
          if (pot) {
            outW = nextPow2(outW);
            outH = nextPow2(outH);
          }
          if (outW <= maxSize && outH <= maxSize) {
            return { width: Math.max(1, outW), height: Math.max(1, outH), placed };
          }
        }
        width *= 2;
      }
      return null;
    }

    /**
     * 图集元数据。字段照抄 Aseprite 的 sprite sheet JSON —— 这是事实标准，
     * 引擎侧普遍能直接认（`frame` / `spriteSourceSize` / `sourceSize` / `pivot`）。
     * `pivot` 是锚点：角色用 `{x:.5, y:1}`（脚底居中）就能直接踩地。
     */
    function buildAtlasJson(placed, items, opt) {
      const pivot = opt.pivot || { x: 0.5, y: 0.5 };
      const frames = {};
      for (const p of placed) {
        const src = items[p.index];
        frames[src.name] = {
          frame: { x: p.x, y: p.y, w: p.w, h: p.h },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: p.w, h: p.h },
          sourceSize: { w: p.w, h: p.h },
          pivot: { x: pivot.x, y: pivot.y },
        };
      }
      return {
        frames,
        meta: {
          app: 'dsh-sprite-studio',
          version: '1.0',
          image: opt.image || 'atlas.png',
          format: 'RGBA8888',
          size: { w: opt.width, h: opt.height },
          scale: '1',
        },
      };
    }

    // ── 动画预览 ──────────────────────────────────────────────────────────
    /**
     * 自然序比较：`hero_2` 要排在 `hero_10` 前面。
     * 直接用字符串比较会得到 1、10、2 这种顺序，切图产物全中招。
     */
    function compareNatural(a, b) {
      const ax = String(a).match(/(\d+|\D+)/g) || [];
      const bx = String(b).match(/(\d+|\D+)/g) || [];
      const n = Math.min(ax.length, bx.length);
      for (let i = 0; i < n; i++) {
        const as = ax[i];
        const bs = bx[i];
        const aNum = /^\d/.test(as);
        const bNum = /^\d/.test(bs);
        if (aNum && bNum) {
          const diff = Number(as) - Number(bs);
          if (diff) return diff;
        } else if (as !== bs) {
          return as < bs ? -1 : 1;
        }
      }
      return ax.length - bx.length;
    }

    /** 按名字自然序排帧 —— 切图产物的名字里带序号，这就是它们的播放顺序。 */
    function sortFramesByName(list) {
      return list.slice().sort((a, b) => compareNatural(a.name, b.name));
    }

    // ── 按行扫描切分 ──────────────────────────────────────────────────────
    /**
     * 先切行带，再在**每一行内部**做一维投影切分。
     *
     * 为什么需要它：手拼的精灵表往往「一行 = 一个动画」，行高不一（61/63/79/147），
     * 行内字符又几乎贴着。全图连通域会把十几帧连成一块，网格又对不上任何等距。
     * 拆成两步之后，跨行的干扰消失了：行与行之间有 20px 空隙，行内只需要切竖缝。
     *
     * imageData: {width, height, data} → { bands: [{ y, h, frames: [{x,y,w,h}] }] }
     */
    function scanRows(imageData, opt) {
      const w = imageData.width;
      const hh = imageData.height;
      const data = imageData.data;
      const alphaMin = clamp(Math.round(opt.alphaMin ?? 12), 1, 255);
      const rowGap = Math.max(1, Math.round(opt.rowGap ?? 4));
      const colGap = Math.max(1, Math.round(opt.colGap ?? 2));
      const minRowH = Math.max(2, Math.round(opt.minRowH ?? 10));
      const minFrameW = Math.max(1, Math.round(opt.minFrameW ?? 4));
      // 列密度：一列里至少要有这么多不透明像素才算「有内容」。
      // 字符之间的细缝往往只剩 1–2 像素，按「有没有像素」判断会全焊在一起。
      const colDensity = clamp(Number(opt.colDensity ?? 0), 0, 0.9);

      // 1) 每行有没有内容
      const rowOn = new Uint8Array(hh);
      for (let y = 0; y < hh; y++) {
        const base = y * w * 4;
        for (let x = 0; x < w; x++) {
          if (data[base + x * 4 + 3] >= alphaMin) { rowOn[y] = 1; break; }
        }
      }

      // 2) 切行带：小于 rowGap 的空隙视为同一行的一部分（避免一行被细缝劈开）
      const bands = [];
      let start = -1;
      let lastOn = -1;
      for (let y = 0; y < hh; y++) {
        if (rowOn[y]) {
          if (start < 0) start = y;
          lastOn = y;
        } else if (start >= 0 && y - lastOn >= rowGap) {
          bands.push({ y: start, h: lastOn - start + 1 });
          start = -1;
        }
      }
      if (start >= 0) bands.push({ y: start, h: lastOn - start + 1 });

      // 3) 每一行内部切帧
      const out = [];
      for (const band of bands) {
        if (band.h < minRowH) continue;
        const colOn = new Uint8Array(w);
        const need = Math.max(1, Math.round(band.h * colDensity));
        for (let x = 0; x < w; x++) {
          let hit = 0;
          for (let y = band.y; y < band.y + band.h; y++) {
            if (data[(y * w + x) * 4 + 3] >= alphaMin) {
              hit++;
              if (hit >= need) { colOn[x] = 1; break; }
            }
          }
        }
        const frames = [];
        let cs = -1;
        let lastCol = -1;
        const flush = () => {
          if (cs < 0) return;
          const fw = lastCol - cs + 1;
          if (fw >= minFrameW) {
            // 收紧到真实 bbox（列投影只保证这一列有内容，纵向还要再收一次）
            let y0 = band.y + band.h;
            let y1 = band.y - 1;
            for (let y = band.y; y < band.y + band.h; y++) {
              for (let x = cs; x <= lastCol; x++) {
                if (data[(y * w + x) * 4 + 3] >= alphaMin) {
                  if (y < y0) y0 = y;
                  if (y > y1) y1 = y;
                  break;
                }
              }
            }
            if (y1 >= y0) frames.push({ x: cs, y: y0, w: fw, h: y1 - y0 + 1 });
          }
          cs = -1;
        };
        for (let x = 0; x < w; x++) {
          if (colOn[x]) {
            if (cs < 0) cs = x;
            lastCol = x;
          } else if (cs >= 0 && x - lastCol >= colGap) {
            flush();
          }
        }
        flush();
        if (frames.length) out.push({ y: band.y, h: band.h, frames });
      }
      return { bands: out };
    }

    /**
     * 把一行按「帧数」等分。
     *
     * 为什么需要：行内字符**物理上贴着**（实测把 alpha 阈值从 12 提到 250 都分不开），
     * 投影切分在这里必然失败。但这类表的行是按固定步距排的，所以「这一行有几帧」
     * 是人一看就知道、机器猜不准的信息 —— 交给用户填，比任何算法都准。
     * span 用该行已有帧的并集，保证不会把右边的标注文字也算进去。
     */
    function splitRowEven(band, n) {
      const count = Math.max(1, Math.round(n) || 1);
      const frames = band.frames || [];
      if (!frames.length) return [];
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const f of frames) {
        if (f.x < x0) x0 = f.x;
        if (f.x + f.w > x1) x1 = f.x + f.w;
      }
      const span = x1 - x0;
      if (span < count) return [];
      const out = [];
      for (let i = 0; i < count; i++) {
        const sx = x0 + Math.round((span * i) / count);
        const ex = x0 + Math.round((span * (i + 1)) / count);
        out.push({ x: sx, y: band.y, w: Math.max(1, ex - sx), h: band.h });
      }
      return out;
    }

    // ── 角色合成 ──────────────────────────────────────────────────────────
    /**
     * 把若干部件（头/身/腿/武器）按锚点对齐到一个画布里。
     *
     * 为什么默认「底部居中」：角色的脚底是所有帧的共同基准，头/身/腿尺寸不一致时，
     * 只有按脚底对齐才站得住。LPC 的部件本来就同尺寸同坐标系，这里对它们等于没偏移；
     * 这条规则真正服务的是用户自己拼的、尺寸不一的部件。
     *
     * parts: [{ id, w, h }] → { w, h, items: [{ id, x, y }] }
     */
    function composeLayout(parts, anchor, offsets) {
      const list = (parts || []).filter(Boolean);
      if (!list.length) return { w: 0, h: 0, items: [] };
      let maxW = 1;
      let maxH = 1;
      let sumH = 0;
      for (const p of list) {
        if (p.w > maxW) maxW = p.w;
        if (p.h > maxH) maxH = p.h;
        sumH += p.h;
      }
      const off = offsets || {};
      const at = (p, x, y) => {
        const o = off[p.id] || {};
        return { id: p.id, x: x + Math.round(o.dx || 0), y: y + Math.round(o.dy || 0) };
      };

      // 垂直堆叠：紧裁的散件（头/身/腿各自只是一小块）要一层压一层往下排，
      // 而不是全部对齐到同一条底边。列表末尾在最下面。
      if (anchor === 'stack') {
        const items = new Array(list.length);
        let cursor = 0;
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i];
          items[i] = at(p, Math.floor((maxW - p.w) / 2), sumH - cursor - p.h);
          cursor += p.h;
        }
        return { w: maxW, h: sumH, items };
      }

      const items = list.map((p) => {
        if (anchor === 'center') {
          return at(p, Math.floor((maxW - p.w) / 2), Math.floor((maxH - p.h) / 2));
        }
        if (anchor === 'bottom') {
          return at(p, Math.floor((maxW - p.w) / 2), maxH - p.h);
        }
        // topleft（默认）：LPC 的所有帧共用同一个左上原点，尺寸一致时就是零偏移；
        // 尺寸不一致时（128 帧的大武器 vs 64 帧的身体）也只有左上对齐是对的。
        return at(p, 0, 0);
      });
      return { w: maxW, h: maxH, items };
    }

    /** 把图层顺序换成「按列表顺序叠」，列表靠后的在上面。 */
    function orderLayers(ids, parts) {
      const byId = new Map((parts || []).map((p) => [p.id, p]));
      const out = [];
      for (const id of ids || []) {
        const p = byId.get(id);
        if (p) out.push(p);
      }
      // 不在 order 里的（刚选中、还没来得及同步）补到最后，别让它们消失
      for (const p of parts || []) if (!ids || !ids.includes(p.id)) out.push(p);
      return out;
    }

    // ── LPC 素材库 ────────────────────────────────────────────────────────
    /**
     * 库里**只存路径，不存图**。
     *
     * 法律上的理由：LPC 素材是 CC0 / CC-BY-SA / CC-BY / GPL 混合，多数强制署名。
     * 插件不复制、不分发这些图，只在用户点击时由浏览器去上游取原文件 ——
     * 这样插件本身不产生「再分发」，署名义务回到使用者（导出时会提醒）。
     *
     * 技术要求：同一动作的各个部位尺寸必须一致（都是 64×64 × N 帧 × 4 向），
     * 所以合成时直接整表叠加，不需要对齐。
     */
    const LPC_BASE = 'https://raw.githubusercontent.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator/master/spritesheets/';
    const LPC_ANIMS = ['walk', 'slash', 'thrust', 'spellcast', 'shoot', 'hurt', 'idle', 'run', 'jump'];
    const LPC_LIBRARY = [
      { id: 'body', label: '身体', items: [
        'bodies/child', 'bodies/female', 'bodies/male', 'bodies/muscular', 'bodies/pregnant',
        'bodies/skeleton', 'bodies/teen', 'bodies/zombie', 'prosthesis/hook/male',
        'prosthesis/hook/male/mask', 'prosthesis/peg_leg/male', 'prosthesis/peg_leg/male/mask',
        'tail/cat/adult', 'tail/cat/child', 'tail/fluffy/adult', 'tail/fluffy/child',
        'tail/lizard/adult', 'tail/lizard/alt/adult', 'tail/lizard/alt/child', 'tail/lizard/child',
        'tail/wolf/adult', 'tail/wolf/child', 'wings/bat/adult', 'wings/bat/lizard/adult',
        'wings/dragonfly/solid', 'wings/dragonfly/transparent', 'wings/feathered/adult',
        'wings/lizard/adult', 'wings/lizard/alt/adult', 'wings/lunar', 'wings/monarch/base',
        'wings/monarch/dots', 'wings/monarch/edge', 'wings/pixie/solid', 'wings/pixie/transparent',
        'wound/arm', 'wound/brain', 'wound/eye_left', 'wound/eye_right', 'wound/mouth', 'wound/ribs'
      ] },
      { id: 'head', label: '头', items: [
        'ears/avyon/adult', 'ears/avyon/child', 'ears/avyon/skin/adult', 'ears/avyon/skin/child',
        'ears/big/adult', 'ears/big/child', 'ears/cat/adult', 'ears/cat/child', 'ears/cat/skin/adult',
        'ears/cat/skin/child', 'ears/down/adult', 'ears/down/child', 'ears/dragon/adult',
        'ears/dragon/child', 'ears/elven/adult', 'ears/elven/child', 'ears/hang/adult',
        'ears/hang/child', 'ears/long/adult', 'ears/long/child', 'ears/lykon/adult', 'ears/lykon/child',
        'ears/lykon/skin/adult', 'ears/lykon/skin/child', 'ears/medium/adult', 'ears/medium/child',
        'ears/wolf/adult', 'ears/wolf/child', 'ears/wolf/skin/adult', 'ears/wolf/skin/child',
        'ears/zabos/adult', 'ears/zabos/child', 'ears/zabos/skin/adult', 'ears/zabos/skin/child',
        'faces/elderly/anger', 'faces/elderly/blush', 'faces/elderly/closed', 'faces/elderly/closing',
        'faces/elderly/eyeroll', 'faces/elderly/happy', 'faces/elderly/look_l', 'faces/elderly/look_r',
        'faces/elderly/neutral', 'faces/elderly/sad', 'faces/elderly/shame', 'faces/elderly/shock',
        'faces/female/anger', 'faces/female/blush', 'faces/female/closed', 'faces/female/closing',
        'faces/female/eyeroll', 'faces/female/happy', 'faces/female/look_l', 'faces/female/look_r',
        'faces/female/neutral', 'faces/female/sad', 'faces/female/shame', 'faces/female/shock',
        'faces/global/angry2', 'faces/global/happy2', 'faces/global/sad2', 'faces/global/tears',
        'faces/male/anger', 'faces/male/blush', 'faces/male/closed', 'faces/male/closing',
        'faces/male/eyeroll', 'faces/male/happy', 'faces/male/look_l', 'faces/male/look_r',
        'faces/male/neutral', 'faces/male/sad', 'faces/male/shame', 'faces/male/shock', 'fins/fin/adult',
        'fins/fin/child', 'fins/fin_short/adult', 'fins/fin_short/child', 'heads/alien/adult',
        'heads/boarman/adult', 'heads/boarman/child', 'heads/frankenstein/adult', 'heads/goblin/adult',
        'heads/goblin/child', 'heads/human/child', 'heads/human/elderly_small', 'heads/human/female',
        'heads/human/female_elderly', 'heads/human/female_small', 'heads/human/male',
        'heads/human/male_elderly', 'heads/human/male_gaunt', 'heads/human/male_plump',
        'heads/human/male_small', 'heads/jack/adult', 'heads/lizard/child', 'heads/lizard/female',
        'heads/lizard/male', 'heads/minotaur/child', 'heads/minotaur/female', 'heads/minotaur/male',
        'heads/mouse/adult', 'heads/mouse/child', 'heads/orc/child', 'heads/orc/female',
        'heads/orc/male', 'heads/pig/adult', 'heads/pig/child', 'heads/rabbit/adult',
        'heads/rabbit/child', 'heads/rat/adult', 'heads/rat/child', 'heads/sheep/adult',
        'heads/sheep/child', 'heads/skeleton/adult', 'heads/troll/adult', 'heads/troll/child',
        'heads/vampire/adult', 'heads/wartotaur/adult', 'heads/wolf/child', 'heads/wolf/female',
        'heads/wolf/male', 'heads/zombie/adult', 'horns/backwards/adult', 'horns/backwards/child',
        'horns/curled/adult', 'horns/curled/child', 'nose/big/adult', 'nose/button/adult',
        'nose/elderly/adult', 'nose/large/adult', 'nose/straight/adult', 'wrinkles'
      ] },
      { id: 'face', label: '五官', items: [
        'faces/elderly/anger', 'faces/elderly/blush', 'faces/elderly/closed', 'faces/elderly/closing',
        'faces/elderly/eyeroll', 'faces/elderly/happy', 'faces/elderly/look_l', 'faces/elderly/look_r',
        'faces/elderly/neutral', 'faces/elderly/sad', 'faces/elderly/shame', 'faces/elderly/shock',
        'faces/female/anger', 'faces/female/blush', 'faces/female/closed', 'faces/female/closing',
        'faces/female/eyeroll', 'faces/female/happy', 'faces/female/look_l', 'faces/female/look_r',
        'faces/female/neutral', 'faces/female/sad', 'faces/female/shame', 'faces/female/shock',
        'faces/global/angry2', 'faces/global/happy2', 'faces/global/sad2', 'faces/global/tears',
        'faces/male/anger', 'faces/male/blush', 'faces/male/closed', 'faces/male/closing',
        'faces/male/eyeroll', 'faces/male/happy', 'faces/male/look_l', 'faces/male/look_r',
        'faces/male/neutral', 'faces/male/sad', 'faces/male/shame', 'faces/male/shock'
      ] },
      { id: 'eyes', label: '眼睛', items: [
        'cyclops/adult', 'cyclops/child', 'cyclops2/adult', 'cyclops2/child', 'eyebrows/thick/adult',
        'eyebrows/thick/child', 'eyebrows/thin/adult', 'eyebrows/thin/child', 'human/adult/anger',
        'human/adult/closing', 'human/adult/default', 'human/adult/eyeroll', 'human/adult/look_l',
        'human/adult/look_r', 'human/adult/neutral', 'human/adult/neutral/default', 'human/adult/sad',
        'human/adult/sad2', 'human/adult/shame', 'human/adult/shock', 'human/child',
        'human/elderly/anger', 'human/elderly/closing', 'human/elderly/default', 'human/elderly/look_l',
        'human/elderly/look_r', 'human/elderly/roll_eyes', 'human/elderly/sad', 'human/elderly/shame',
        'human/elderly/shock'
      ] },
      { id: 'beards', label: '胡子', items: [
        'beard/5oclock_shadow', 'beard/basic', 'beard/medium', 'beard/trimmed', 'beard/winter/female',
        'beard/winter/male', 'mustache/basic', 'mustache/bigstache', 'mustache/chevron',
        'mustache/french', 'mustache/handlebar', 'mustache/horseshoe', 'mustache/lampshade',
        'mustache/walrus'
      ] },
      { id: 'hair', label: '头发', items: [
        'afro/adult', 'balding/adult', 'bangs/adult', 'bangs_bun/adult', 'bangslong/adult',
        'bangslong2/adult', 'bangsshort/adult', 'bedhead/adult', 'bob/adult', 'bob_side_part/adult',
        'braid/adult', 'braid2/adult', 'bunches/adult', 'buzzcut/adult', 'cornrows/adult',
        'cowlick/adult', 'cowlick_tall/adult', 'curls_large/adult', 'curls_large_xlong/adult',
        'curly_long/adult', 'curly_short/adult', 'curly_short2/adult', 'curtains/adult',
        'curtains_long/adult', 'dreadlocks_long/adult', 'dreadlocks_short/adult',
        'extensions/bangs/braidl/adult', 'extensions/bangs/braidl/child',
        'extensions/bangs/braidr/adult', 'extensions/bangs/braidr/child',
        'extensions/bangs/long_straightl/adult', 'extensions/bangs/long_straightr/adult',
        'extensions/bangs/long_wavyl/adult', 'extensions/bangs/long_wavyr/adult',
        'extensions/bangs/xlong_bangl/adult', 'extensions/bangs/xlong_bangl/child',
        'extensions/bangs/xlong_bangr/adult', 'extensions/bangs/xlong_bangr/child',
        'extensions/bangs/xlong_braidl/adult', 'extensions/bangs/xlong_braidl/child',
        'extensions/bangs/xlong_braidr/adult', 'extensions/bangs/xlong_braidr/child',
        'extensions/bangs/xlong_curlyl/adult', 'extensions/bangs/xlong_curlyr/adult',
        'extensions/bangs/xlong_wavyl/adult', 'extensions/bangs/xlong_wavyr/adult',
        'extensions/ponytails/relm_ponytail/adult', 'extensions/ponytails/topknot_long/adult',
        'extensions/ponytails/topknot_long/child', 'extensions/ponytails/topknot_short/adult',
        'extensions/ponytails/topknot_short/child', 'extensions/ties/high_bun/adult',
        'flat_top_fade/adult', 'flat_top_fade/female', 'flat_top_fade/male', 'flat_top_straight/adult',
        'half_up/adult', 'halfmessy/adult', 'high_and_tight/adult', 'high_ponytail/adult', 'idol/adult',
        'jewfro/adult', 'jewfro/child', 'lob/adult', 'long/adult', 'long_band/adult',
        'long_center_part/adult', 'long_messy/adult', 'long_messy2/adult', 'long_straight/adult',
        'long_tied/adult', 'longhawk/adult', 'loose/adult', 'messy1/adult', 'messy2/adult',
        'messy3/adult', 'mop/adult', 'natural/adult', 'page/adult', 'page2/adult', 'parted/adult',
        'parted2/adult', 'parted3/adult', 'parted_side_bangs/adult', 'parted_side_bangs/child',
        'parted_side_bangs2/adult', 'parted_side_bangs2/child', 'pigtails/adult', 'pigtails_bangs/adult',
        'pixie/adult', 'plain/adult', 'ponytail/adult', 'ponytail2/adult', 'princess/adult',
        'relm_ponytail/adult', 'relm_ponytail/adult/mg', 'relm_short/adult', 'relm_short/child',
        'relm_xlong/adult', 'sara/adult', 'shorthawk/adult', 'shoulderl/adult', 'shoulderr/adult',
        'single/adult', 'spiked/adult', 'spiked2/adult', 'spiked_beehive/adult', 'spiked_liberty/adult',
        'spiked_liberty2/adult', 'spiked_porcupine/adult', 'swoop/adult', 'swoop_side/adult',
        'swoop_side/child', 'twists_fade/adult', 'twists_straight/adult', 'unkempt/adult', 'wavy/adult',
        'wavy/child', 'xlong/adult', 'xlong/female', 'xlong/male', 'xlong_wavy/adult'
      ] },
      { id: 'hat', label: '帽子', items: [
        'accessory/crest/adult', 'accessory/crest_centurion/adult', 'accessory/horns_downward/bg/adult',
        'accessory/horns_downward/fg/adult', 'accessory/horns_short/bg/adult',
        'accessory/horns_short/fg/adult', 'accessory/horns_upward/bg/adult',
        'accessory/horns_upward/fg/adult', 'accessory/plumage/adult',
        'accessory/plumage_centurion/adult', 'accessory/plumage_legion/adult',
        'accessory/wings/bg/adult', 'accessory/wings/fg/adult', 'cloth/bandana/adult',
        'cloth/bandana2/adult', 'cloth/hijab/male', 'cloth/hijab/thin', 'cloth/hood/adult',
        'cloth/hood_sack/adult', 'cloth/leather_cap/adult', 'cloth/leather_cap/feather',
        'cloth/leather_cap/feather/adult', 'formal/bowler/adult', 'formal/crown/adult',
        'formal/tiara/adult', 'formal/tophat/adult', 'headband/hairtie/adult', 'headband/hairtie/child',
        'headband/hairtie/rune/adult', 'headband/hairtie/rune/child', 'headband/thick/adult',
        'headband/thick/child', 'headband/thick/rune/adult', 'headband/thick/rune/child',
        'headband/tied/adult', 'helmet/armet/adult', 'helmet/armet_simple/adult',
        'helmet/barbarian/adult', 'helmet/barbarian_nasal/adult', 'helmet/barbarian_viking/adult',
        'helmet/barbuta/female', 'helmet/barbuta/male', 'helmet/barbuta_simple/adult',
        'helmet/bascinet/adult', 'helmet/bascinet_round/adult', 'helmet/close/female',
        'helmet/close/male', 'helmet/flattop/female', 'helmet/flattop/male', 'helmet/greathelm/female',
        'helmet/greathelm/male', 'helmet/horned/adult', 'helmet/kettle/adult', 'helmet/legion/adult',
        'helmet/mail/adult', 'helmet/maximus/adult', 'helmet/morion/adult', 'helmet/nasal/adult',
        'helmet/norman/adult', 'helmet/pointed/adult', 'helmet/spangenhelm/adult',
        'helmet/spangenhelm_viking/adult', 'helmet/sugarloaf/female', 'helmet/sugarloaf/male',
        'helmet/sugarloaf_simple/female', 'helmet/sugarloaf_simple/male', 'helmet/xeon/adult',
        'holiday/christmas/adult', 'holiday/elf', 'holiday/elf/adult', 'holiday/santa',
        'holiday/santa/adult', 'magic/celestial/adult', 'magic/celestial/trim/adult',
        'magic/celestial_moon/adult', 'magic/celestial_moon/trim/adult', 'magic/large/adult',
        'magic/wizard/base/adult', 'magic/wizard/belt/adult', 'magic/wizard/buckle/adult',
        'pirate/bandana/adult', 'pirate/bandana/skull/adult', 'pirate/bicorne/athwart/admiral',
        'pirate/bicorne/athwart/admiral/adult', 'pirate/bicorne/athwart/admiral/cockade',
        'pirate/bicorne/athwart/admiral/cockade/adult',
        'pirate/bicorne/athwart/admiral/cockade/original', 'pirate/bicorne/athwart/admiral/original',
        'pirate/bicorne/athwart/admiral/trim/adult', 'pirate/bicorne/athwart/basic/adult',
        'pirate/bicorne/athwart/basic/skull', 'pirate/bicorne/athwart/basic/skull/adult',
        'pirate/bicorne/athwart/basic/skull/combined', 'pirate/bicorne/athwart/captain',
        'pirate/bicorne/athwart/captain/adult', 'pirate/bicorne/athwart/captain/original',
        'pirate/bicorne/athwart/captain/skull/adult', 'pirate/bicorne/athwart/commodore',
        'pirate/bicorne/athwart/commodore/adult', 'pirate/bicorne/athwart/commodore/original',
        'pirate/bicorne/athwart/commodore/trim/adult', 'pirate/bicorne/foreaft/adult',
        'pirate/bicorne/foreaft/commodore', 'pirate/bicorne/foreaft/commodore/adult',
        'pirate/bicorne/foreaft/commodore/original', 'pirate/bicorne/foreaft/commodore/trim/adult',
        'pirate/bonnie', 'pirate/bonnie/adult', 'pirate/bonnie/feather', 'pirate/bonnie/feather/adult',
        'pirate/bonnie/tilt/adult', 'pirate/bonnie/trim/adult', 'pirate/cavalier/adult',
        'pirate/cavalier/feather/adult', 'pirate/kerchief/adult', 'pirate/tricorne/basic/adult',
        'pirate/tricorne/basic/stitched', 'pirate/tricorne/basic/stitched/adult',
        'pirate/tricorne/basic/stitching/adult', 'pirate/tricorne/basic/thatched',
        'pirate/tricorne/basic/thatched/adult', 'pirate/tricorne/basic/thatching/adult',
        'pirate/tricorne/captain', 'pirate/tricorne/captain/adult', 'pirate/tricorne/captain/original',
        'pirate/tricorne/captain/skull/adult', 'pirate/tricorne/captain/trim/adult',
        'pirate/tricorne/lieutenant', 'pirate/tricorne/lieutenant/adult',
        'pirate/tricorne/lieutenant/original', 'pirate/tricorne/lieutenant/trim/adult',
        'visor/grated/adult', 'visor/grated_narrow/adult', 'visor/horned/adult', 'visor/pigface/adult',
        'visor/pigface_raised/adult', 'visor/round/adult', 'visor/round_raised/adult',
        'visor/slit/adult', 'visor/slit_narrow/adult'
      ] },
      { id: 'torso', label: '上衣', items: [
        'aprons/apron/female', 'aprons/apron/male', 'aprons/apron_full/female',
        'aprons/apron_half/female', 'aprons/overalls/female', 'aprons/overalls/male',
        'aprons/overalls/teen', 'aprons/suspenders/female', 'aprons/suspenders/male',
        'aprons/suspenders/teen', 'armour/leather/female', 'armour/leather/male', 'armour/leather/teen',
        'armour/legion/female', 'armour/legion/male', 'armour/legion/teen', 'armour/plate/female',
        'armour/plate/male', 'armour/plate/teen', 'bandage/female', 'bandage/male', 'chainmail/female',
        'chainmail/male', 'clothes/blouse/female', 'clothes/blouse_longsleeve/female',
        'clothes/corset/female', 'clothes/longsleeve/formal/male',
        'clothes/longsleeve/formal_striped/male', 'clothes/longsleeve/laced/male',
        'clothes/longsleeve/longsleeve/female', 'clothes/longsleeve/longsleeve/male',
        'clothes/longsleeve/longsleeve/pregnant', 'clothes/longsleeve/longsleeve/teen',
        'clothes/longsleeve/longsleeve2/female', 'clothes/longsleeve/longsleeve2/male',
        'clothes/longsleeve/longsleeve2/teen', 'clothes/longsleeve/longsleeve2_buttoned/female',
        'clothes/longsleeve/longsleeve2_buttoned/male', 'clothes/longsleeve/longsleeve2_buttoned/teen',
        'clothes/longsleeve/longsleeve2_cardigan/female', 'clothes/longsleeve/longsleeve2_cardigan/male',
        'clothes/longsleeve/longsleeve2_cardigan/teen', 'clothes/longsleeve/longsleeve2_polo/female',
        'clothes/longsleeve/longsleeve2_polo/male', 'clothes/longsleeve/longsleeve2_polo/teen',
        'clothes/longsleeve/longsleeve2_scoop/female', 'clothes/longsleeve/longsleeve2_scoop/male',
        'clothes/longsleeve/longsleeve2_scoop/teen', 'clothes/longsleeve/longsleeve2_vneck/female',
        'clothes/longsleeve/longsleeve2_vneck/male', 'clothes/longsleeve/longsleeve2_vneck/teen',
        'clothes/longsleeve/longsleeves/female', 'clothes/longsleeve/longsleeves/male',
        'clothes/longsleeve/longsleeves/teen', 'clothes/longsleeve/longsleeves2/female',
        'clothes/longsleeve/longsleeves2/male', 'clothes/longsleeve/longsleeves2/teen',
        'clothes/longsleeve/longsleeves_cuffed/female', 'clothes/longsleeve/longsleeves_cuffed/male',
        'clothes/longsleeve/longsleeves_cuffed/teen', 'clothes/longsleeve/scoop/female',
        'clothes/longsleeve/scoop/male', 'clothes/longsleeve/scoop/pregnant', 'clothes/robe/female',
        'clothes/shirt/child', 'clothes/shortsleeve/shortsleeve/female',
        'clothes/shortsleeve/shortsleeve/male', 'clothes/shortsleeve/shortsleeve/pregnant',
        'clothes/shortsleeve/shortsleeve/teen', 'clothes/shortsleeve/shortsleeve_cardigan/female',
        'clothes/shortsleeve/shortsleeve_cardigan/male', 'clothes/shortsleeve/shortsleeve_cardigan/teen',
        'clothes/shortsleeve/shortsleeve_polo/female', 'clothes/shortsleeve/shortsleeve_polo/male',
        'clothes/shortsleeve/shortsleeve_polo/teen', 'clothes/shortsleeve/shortsleeves/female',
        'clothes/shortsleeve/shortsleeves/male', 'clothes/shortsleeve/shortsleeves/teen',
        'clothes/shortsleeve/shortsleeves2/female', 'clothes/shortsleeve/shortsleeves2/male',
        'clothes/shortsleeve/shortsleeves2/teen', 'clothes/shortsleeve/tshirt/female',
        'clothes/shortsleeve/tshirt/male', 'clothes/shortsleeve/tshirt/teen',
        'clothes/shortsleeve/tshirt_buttoned/female', 'clothes/shortsleeve/tshirt_buttoned/male',
        'clothes/shortsleeve/tshirt_buttoned/teen', 'clothes/shortsleeve/tshirt_scoop/female',
        'clothes/shortsleeve/tshirt_scoop/male', 'clothes/shortsleeve/tshirt_scoop/teen',
        'clothes/shortsleeve/tshirt_vneck/female', 'clothes/shortsleeve/tshirt_vneck/male',
        'clothes/shortsleeve/tshirt_vneck/teen', 'clothes/sleeveless/laced/male',
        'clothes/sleeveless/sleeveless/female', 'clothes/sleeveless/sleeveless/male',
        'clothes/sleeveless/sleeveless/pregnant', 'clothes/sleeveless/sleeveless1/female',
        'clothes/sleeveless/sleeveless1/male', 'clothes/sleeveless/sleeveless1/teen',
        'clothes/sleeveless/sleeveless2/female', 'clothes/sleeveless/sleeveless2/male',
        'clothes/sleeveless/sleeveless2/teen', 'clothes/sleeveless/sleeveless2_buttoned/female',
        'clothes/sleeveless/sleeveless2_buttoned/male', 'clothes/sleeveless/sleeveless2_buttoned/teen',
        'clothes/sleeveless/sleeveless2_cardigan/female', 'clothes/sleeveless/sleeveless2_cardigan/male',
        'clothes/sleeveless/sleeveless2_cardigan/teen', 'clothes/sleeveless/sleeveless2_polo/female',
        'clothes/sleeveless/sleeveless2_polo/male', 'clothes/sleeveless/sleeveless2_polo/teen',
        'clothes/sleeveless/sleeveless2_scoop/female', 'clothes/sleeveless/sleeveless2_scoop/male',
        'clothes/sleeveless/sleeveless2_scoop/teen', 'clothes/sleeveless/sleeveless2_vneck/female',
        'clothes/sleeveless/sleeveless2_vneck/male', 'clothes/sleeveless/sleeveless2_vneck/teen',
        'clothes/sleeveless/striped/male', 'clothes/sleeveless/tanktop/female',
        'clothes/sleeveless/tanktop/pregnant', 'clothes/tunic/female', 'clothes/tunic_sara/female',
        'clothes/vest/male', 'clothes/vest_open/male', 'jacket/collared/male', 'jacket/frock/male',
        'jacket/iverness/male', 'jacket/santa/male', 'jacket/tabard/female', 'jacket/tabard/male',
        'jacket/trench/male', 'jacket/trim/frock_buttons', 'jacket/trim/frock_collar',
        'jacket/trim/frock_lace', 'jacket/trim/frock_lapel', 'jacket/trim/jacket_pockets',
        'waist/belt_belly/female', 'waist/belt_belly/male', 'waist/belt_double/female',
        'waist/belt_double/male', 'waist/belt_formal', 'waist/belt_leather/female',
        'waist/belt_leather/male', 'waist/belt_leather2/female', 'waist/belt_leather2/male',
        'waist/belt_loose/female', 'waist/belt_loose/male', 'waist/belt_mage', 'waist/belt_robe/female',
        'waist/belt_robe/male', 'waist/buckles/female', 'waist/obi/knot/left/male',
        'waist/obi/knot/left/thin', 'waist/obi/knot/right/male', 'waist/obi/knot/right/thin',
        'waist/obi/male', 'waist/obi/thin', 'waist/sash/female', 'waist/sash/male',
        'waist/sash_narrow/female', 'waist/sash_narrow/male', 'waist/waistband/female'
      ] },
      { id: 'dress', label: '连衣裙', items: [
        'bodice/female', 'kimono/normal/trim/universal/female', 'kimono/normal/universal/female',
        'kimono/sleeves/trim/universal', 'kimono/sleeves/trim/universal/female',
        'kimono/sleeves/trim/universal/female_front', 'kimono/sleeves/universal',
        'kimono/sleeves/universal/female', 'kimono/sleeves/universal/female_front',
        'kimono/sleeves_oversize/trim/universal', 'kimono/sleeves_oversize/trim/universal/female',
        'kimono/sleeves_oversize/trim/universal/female_front', 'kimono/sleeves_oversize/universal',
        'kimono/sleeves_oversize/universal/female', 'kimono/sleeves_oversize/universal/female_front',
        'kimono/split/trim/universal/female', 'kimono/split/universal/female', 'sash/female',
        'slit/female'
      ] },
      { id: 'legs', label: '下装', items: [
        'armour/plate/male', 'armour/plate/thin', 'cuffed/male', 'cuffed/thin', 'formal/male',
        'formal/thin', 'formal_striped/male', 'formal_striped/thin', 'hose/male', 'hose/thin',
        'leggings/male', 'leggings/thin', 'leggings2/male', 'leggings2/thin', 'pantaloons/male',
        'pantaloons/muscular', 'pantaloons/thin', 'pants/child', 'pants/male', 'pants/muscular',
        'pants/pregnant', 'pants/thin', 'pants2/male', 'pants2/thin', 'shorts/short_shorts/male',
        'shorts/short_shorts/thin', 'shorts/shorts/male', 'shorts/shorts/thin', 'skirts/belle/thin',
        'skirts/child', 'skirts/legion/male', 'skirts/legion/thin', 'skirts/overskirt/thin',
        'skirts/plain/male', 'skirts/plain/thin', 'skirts/slit/thin', 'skirts/straight/thin'
      ] },
      { id: 'feet', label: '鞋', items: [
        'accessory/plate_toe/male', 'accessory/plate_toe/thin', 'accessory/plate_toe_thick/male',
        'accessory/plate_toe_thick/thin', 'armour/plate/male', 'armour/plate/thin', 'boots/basic/male',
        'boots/basic/thin', 'boots/fold/male', 'boots/fold/thin', 'boots/revised/male',
        'boots/revised/thin', 'boots/rimmed/male', 'boots/rimmed/thin', 'hoofs/male', 'hoofs/thin',
        'sandals/male', 'sandals/thin', 'shoes/basic/male', 'shoes/basic/thin', 'shoes/ghillies/male',
        'shoes/ghillies/thin', 'shoes/revised/male', 'shoes/revised/thin', 'shoes/sara/male',
        'shoes/sara/thin', 'slippers/male', 'slippers/thin', 'socks/ankle/male', 'socks/ankle/thin',
        'socks/high/male', 'socks/high/thin', 'socks/tabi/male', 'socks/tabi/thin'
      ] },
      { id: 'arms', label: '护臂', items: [
        'armour/plate/male', 'armour/plate/thin', 'bracers/male', 'bracers/thin', 'hands/gloves/male',
        'hands/gloves/thin', 'hands/ring/stud/male', 'hands/ring/stud/thin', 'wrists/cuffs/male',
        'wrists/cuffs/thin', 'wrists/lace/male', 'wrists/lace/thin'
      ] },
      { id: 'shoulders', label: '护肩', items: [
        'bauldron/male', 'bauldron/thin', 'epaulets/male', 'epaulets/thin', 'legion/female',
        'legion/male', 'mantal/male', 'mantal/thin', 'pauldrons/male', 'pauldrons/thin'
      ] },
      { id: 'neck', label: '项链', items: [
        'amulet/cross/female', 'amulet/cross/male', 'amulet/dangle/female', 'amulet/dangle/male',
        'amulet/spider/female', 'amulet/spider/male', 'amulet/star/female', 'amulet/star/male',
        'capeclip/female', 'capeclip/male', 'capeclip/thin', 'capetie/female', 'capetie/male',
        'capetie/thin', 'charm/box/female', 'charm/box/male', 'charm/oval/female', 'charm/oval/male',
        'charm/ring/female', 'charm/ring/male', 'charm/star/female', 'charm/star/male', 'cravat/female',
        'cravat/male', 'cravat/thin', 'gem/emerald/female', 'gem/emerald/male', 'gem/marquise/female',
        'gem/marquise/male', 'gem/natural/female', 'gem/natural/male', 'gem/pear/female',
        'gem/pear/male', 'gem/pearl/female', 'gem/pearl/male', 'gem/pillow/female', 'gem/pillow/male',
        'gem/princess/female', 'gem/princess/male', 'gem/round/female', 'gem/round/male',
        'gem/trilliant/female', 'gem/trilliant/male', 'jabot/female', 'jabot/male', 'jabot/thin',
        'necklace/beaded_large/female', 'necklace/beaded_large/male', 'necklace/beaded_large/thin',
        'necklace/beaded_small/female', 'necklace/beaded_small/male', 'necklace/beaded_small/thin',
        'necklace/chain/female', 'necklace/chain/male', 'necklace/female', 'necklace/simple/female',
        'necklace/simple/male', 'scarf', 'tie/bowtie/adult', 'tie/bowtie2/adult', 'tie/necktie/female',
        'tie/necktie/male'
      ] },
      { id: 'cape', label: '披风', items: [
        'solid', 'tattered', 'trim'
      ] },
      { id: 'backpack', label: '背包', items: [
        'backpack/female', 'backpack/male', 'basket', 'basket_contents/ore', 'basket_contents/wood',
        'jetpack/female', 'jetpack/male', 'jetpack_fins/female', 'jetpack_fins/male',
        'squarepack/female', 'squarepack/male', 'straps/female', 'straps/male'
      ] },
      { id: 'shield', label: '盾牌', items: [
        'crusader', 'crusader/fg/female', 'crusader/fg/male', 'crusader2/female', 'crusader2/male',
        'heater/original/paint', 'heater/original/pattern/barry', 'heater/original/pattern/bend',
        'heater/original/pattern/bend_sinister', 'heater/original/pattern/bendy',
        'heater/original/pattern/bendy_sinister', 'heater/original/pattern/bordure',
        'heater/original/pattern/chevron', 'heater/original/pattern/chevron_inverted',
        'heater/original/pattern/chief', 'heater/original/pattern/cross', 'heater/original/pattern/fess',
        'heater/original/pattern/lozengy', 'heater/original/pattern/pale',
        'heater/original/pattern/pall', 'heater/original/pattern/paly',
        'heater/original/pattern/per_bend', 'heater/original/pattern/per_bend_sinister',
        'heater/original/pattern/per_chevron', 'heater/original/pattern/per_chevron_inverted',
        'heater/original/pattern/per_fess', 'heater/original/pattern/per_pale',
        'heater/original/pattern/per_saltire', 'heater/original/pattern/quarterly',
        'heater/original/pattern/saltire', 'heater/original/trim', 'heater/original/wood',
        'heater/revised/paint', 'heater/revised/pattern/barry', 'heater/revised/pattern/bend',
        'heater/revised/pattern/bend_sinister', 'heater/revised/pattern/bendy',
        'heater/revised/pattern/bendy_sinister', 'heater/revised/pattern/bordure',
        'heater/revised/pattern/chevron', 'heater/revised/pattern/chevron_inverted',
        'heater/revised/pattern/chief', 'heater/revised/pattern/cross', 'heater/revised/pattern/fess',
        'heater/revised/pattern/lozengy', 'heater/revised/pattern/pale', 'heater/revised/pattern/pall',
        'heater/revised/pattern/paly', 'heater/revised/pattern/per_bend',
        'heater/revised/pattern/per_bend_sinister', 'heater/revised/pattern/per_chevron',
        'heater/revised/pattern/per_chevron_inverted', 'heater/revised/pattern/per_fess',
        'heater/revised/pattern/per_pale', 'heater/revised/pattern/per_saltire',
        'heater/revised/pattern/quarterly', 'heater/revised/pattern/saltire', 'heater/revised/trim',
        'heater/revised/wood', 'kite/female', 'kite/male', 'plus', 'plus/fg/female', 'plus/fg/male',
        'round', 'scutum/paint', 'scutum/paint/fg/female', 'scutum/paint/fg/male', 'scutum/trim',
        'scutum/trim/fg/female', 'scutum/trim/fg/male', 'scutum_trim', 'scutum_trim/fg/female',
        'scutum_trim/fg/male', 'spartan', 'two_engrailed', 'two_engrailed/fg/female',
        'two_engrailed/fg/male', 'two_engrailed/paint', 'two_engrailed/paint/fg/female',
        'two_engrailed/paint/fg/male', 'two_engrailed/trim', 'two_engrailed/trim/fg/female',
        'two_engrailed/trim/fg/male', 'two_engrailed_trim', 'two_engrailed_trim/fg/female',
        'two_engrailed_trim/fg/male'
      ] },
      { id: 'weapon', label: '武器', items: [
        'blunt/flail', 'blunt/flail/behind', 'blunt/mace', 'blunt/mace/universal_behind', 'blunt/waraxe',
        'blunt/waraxe/behind', 'magic/crystal', 'magic/crystal/universal',
        'magic/crystal/universal/background', 'magic/crystal/universal/foreground', 'magic/diamond',
        'magic/diamond/universal', 'magic/diamond/universal/background',
        'magic/diamond/universal/foreground', 'magic/diamond_off', 'magic/diamond_off/universal',
        'magic/diamond_off/universal/background', 'magic/diamond_off/universal/foreground',
        'magic/gnarled', 'magic/gnarled/universal', 'magic/gnarled/universal/background',
        'magic/gnarled/universal/foreground', 'magic/gnarled_off', 'magic/gnarled_off/universal',
        'magic/gnarled_off/universal/background', 'magic/gnarled_off/universal/foreground', 'magic/loop',
        'magic/loop/universal', 'magic/loop/universal/background', 'magic/loop/universal/foreground',
        'magic/loop_off', 'magic/loop_off/universal', 'magic/loop_off/universal/background',
        'magic/loop_off/universal/foreground', 'magic/s', 'magic/s/universal',
        'magic/s/universal/background', 'magic/s/universal/foreground', 'magic/simple/background',
        'magic/simple/foreground', 'magic/wand/female', 'magic/wand/male', 'polearm/cane/female',
        'polearm/cane/male', 'polearm/dragonspear', 'polearm/dragonspear/background',
        'polearm/dragonspear/foreground', 'polearm/halberd', 'polearm/halberd/behind',
        'polearm/longspear', 'polearm/longspear/background', 'polearm/longspear/foreground',
        'polearm/scythe', 'polearm/scythe/universal_behind', 'polearm/spear', 'polearm/spear/background',
        'polearm/spear/foreground', 'polearm/spear_off', 'polearm/spear_off/background',
        'polearm/spear_off/foreground', 'polearm/trident', 'polearm/trident/background',
        'polearm/trident/foreground', 'ranged/bow/arrow', 'ranged/bow/great',
        'ranged/bow/great/universal', 'ranged/bow/great/universal/background',
        'ranged/bow/great/universal/foreground', 'ranged/bow/normal', 'ranged/bow/normal/universal',
        'ranged/bow/normal/universal/background', 'ranged/bow/normal/universal/foreground',
        'ranged/bow/recurve', 'ranged/bow/recurve/universal', 'ranged/bow/recurve/universal/background',
        'ranged/bow/recurve/universal/foreground', 'ranged/crossbow', 'ranged/crossbow/background',
        'ranged/crossbow/foreground', 'ranged/slingshot', 'ranged/slingshot/background',
        'ranged/slingshot/behind', 'ranged/slingshot/foreground', 'sword/arming/universal',
        'sword/dagger', 'sword/dagger/behind', 'sword/glowsword', 'sword/glowsword/universal_behind',
        'sword/katana', 'sword/longsword', 'sword/longsword/universal_behind', 'sword/longsword_alt',
        'sword/rapier', 'sword/rapier/universal_behind', 'sword/saber', 'sword/saber/universal_behind',
        'sword/scimitar'
      ] },
      { id: 'tools', label: '工具', items: [
        'axe/male', 'axe/thin', 'hammer/male', 'hammer/thin', 'hoe', 'pickaxe/male', 'pickaxe/thin',
        'shovel', 'watering_can'
      ] },
    ];

    /**
     * 各类别的目录层级 —— **实测出来的，三种结构并存**：
     *   body/bodies/male/walk.png            平铺：<目录>/<动作>.png
     *   hair/long/adult/walk.png             多一层 adult
     *   body/bodies/zombie/walk/zombie.png   动作是文件夹，文件名是**部件名**
     *
     * 与其逐个类别写死一张对照表（上游一改就废），不如把两种命名方式都生成成候选，
     * 按顺序 fetch，第一个 200 的用。
     */
    const LPC_DIRS = {
      body: ['body/bodies/{item}', 'body/{item}'],
      hair: ['hair/{item}/adult', 'hair/{item}', 'hair/{item}/male', 'hair/{item}/female'],
      head: ['head/{item}'],
      face: ['head/{item}'],
      eyes: ['eyes/{item}', 'head/eyes/{item}'],
      beards: ['beards/{item}'],
      neck: ['neck/{item}'],
      torso: ['torso/{item}'],
      dress: ['dress/{item}'],
      legs: ['legs/{item}'],
      feet: ['feet/{item}'],
      arms: ['arms/{item}'],
      shoulders: ['shoulders/{item}'],
      cape: ['cape/{item}'],
      backpack: ['backpack/{item}'],
      shield: ['shield/{item}'],
      weapon: ['weapon/{item}'],
      tools: ['tools/{item}'],
      hat: ['hat/{item}'],
    };

    function lpcCandidates(category, item, anim) {
      const tpl = LPC_DIRS[category];
      if (!tpl) return [];
      // 部件名允许是路径片段（torso 是 `armour/leather/male` 这种三层）；
      // 但「动作/部件名」那种命名里只取最后一段（就是部件本身的名字）。
      const leaf = String(item).split('/').pop();
      const out = [];
      for (const t of tpl) {
        const dir = LPC_BASE + t.replace('{item}', item);
        out.push(`${dir}/${anim}.png`);             // 单层
        out.push(`${dir}/fg/${anim}.png`);          // 双层的前面
        out.push(`${dir}/bg/${anim}.png`);          // 双层的后面
        out.push(`${dir}/${anim}/${leaf}.png`);     // 动作是文件夹
        // 武器还有 <组>/<件>/<变体>/<动作>/<件>.png 这种（behind / universal 变体），
        // 文件名用的是上一级，不是叶子
        const prev = String(item).split('/').slice(-2)[0];
        if (prev && prev !== leaf) out.push(`${dir}/${anim}/${prev}.png`);
      }
      return out;
    }

    /** 首选 URL（供测试与展示用）。 */
    function lpcUrl(category, item, anim) {
      const list = lpcCandidates(category, item, anim);
      return list.length ? list[0] : null;
    }

    /**
     * LPC 的固定叠放顺序（数字越大越靠上）。
     * 这不是随便定的：身体是最底层皮肤，衣服盖身体，头盖在脖子上，五官画在脸上，
     * 头发和帽子再盖住头 —— 顺序错了就会出现「头发被头挡住」这种一眼假的图。
     */
    /**
     * 叠放顺序（数字越大越靠上）。
     *
     * 这套值不是我编的：拿 LPC 生成器自己的 `sheet_definitions` 里的 `zPos` 对过 ——
     * body 10 / legs 20 / feet 27 / torso 40 / arms 60-70 / 胡子 110 / 帽子 115 /
     * 头发 120 / 武器 140-150 / 双层部件的后层 9。这里按同一**相对顺序**缩放到 0-60，
     * 只有披风是特意往上提的：它要盖在盔甲外面，否则背面看就是被上衣吃掉。
     */
    const LPC_Z = {
      shadow: 5, cape_bg: 8, body: 10, backpack: 12, backpack_bg: 11,
      legs: 20, feet: 22, torso: 30, dress: 30,
      shoulders: 32, arms: 34, hair_bg: 35,
      cape: 38, head: 40, neck: 44, face: 45, eyes: 46, beards: 47,
      hair: 50, hat: 55, shield: 56, weapon: 60, tools: 60,
    };

    /**
     * 按部位把图层排好。稳定排序：都是同类或都不认识的，保持原来的相对顺序，
     * 不认识的排最后（不抢戏）。
     */
    function sortLayersByCategory(parts) {
      const list = (parts || []).filter(Boolean);
      const rank = (p) => {
        const c = p.meta && p.meta.category;
        return Object.prototype.hasOwnProperty.call(LPC_Z, c) ? LPC_Z[c] : 999;
      };
      return list.slice().sort((a, b) => rank(a) - rank(b));
    }

    // ── 特效场 ────────────────────────────────────────────────────────────
    /**
     * 特效不是贴图，是**在归一化坐标上算出来的场**（0..1），再走和背景同一套上色管线。
     *
     * 坐标系：中心 (0.5,0.5)，按短边归一化，所以同一组参数在 128 和 512 上形状一致。
     * 每个效果只算「强度」，颜色交给梯度、透明度交给阈值 —— 这样一套参数能出白热、火焰、冰三种色。
     */
    const FX_PRESETS = [
      { id: 'slash', label: '弧形斩击' },
      { id: 'burst', label: '爆炸放射' },
      { id: 'ring', label: '光晕圆环' },
      { id: 'speed', label: '速度线' },
      { id: 'trail', label: '拖尾' },
      { id: 'halo', label: '月晕' },
      { id: 'flash', label: '冲击闪光' },
      { id: 'orb', label: '能量球' },
      { id: 'nebula', label: '星云辉光' },
      { id: 'shimmer', label: '微光星场' },
      { id: 'shock', label: '冲击波' },
      { id: 'smoke', label: '烟尘' },
    ];

    function fxField(kind, w, hh, opt) {
      const width = Math.max(1, Math.round(w));
      const height = Math.max(1, Math.round(hh));
      const out = new Float32Array(width * height);
      const scale = 1;                       // 尺度
      const strength = clamp(Number(opt.strength ?? 1), 0.2, 3);
      const thick = clamp(Number(opt.thick ?? 0.18), 0.02, 0.9);
      const arcDeg = clamp(Number(opt.arc ?? 150), 30, 350);
      const seed = (opt.seed >>> 0) || 1;
      const rnd = mulberry32(seed);
      const aspect = width / height;
      // 预生成几个随机相位，避免每像素调用随机数
      const phase = [rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2];
      // 星云/烟尘要一张噪声底，按需生成一次（每像素算 fbm 太慢）
      let noise = null;
      if (kind === 'nebula' || kind === 'smoke') {
        noise = periodicFbm(width, height, { period: 3, octaves: 4, seed: (seed + 17) >>> 0 });
      }

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // 归一化到 [-1,1]，短边为准
          const nx = ((x + 0.5) / width - 0.5) * 2 * (aspect > 1 ? aspect : 1);
          const ny = ((y + 0.5) / height - 0.5) * 2 * (aspect > 1 ? 1 : 1 / aspect);
          const r = Math.hypot(nx, ny);
          const a = Math.atan2(ny, nx);
          let v = 0;

          if (kind === 'slash') {
            // 一段圆弧：角度范围由 arcDeg 控制，两端渐细
            const half = (arcDeg * Math.PI) / 360;
            const startA = -Math.PI * 0.5 - half;   // 从上方开始扫
            let t = (a - startA) / (half * 2);
            if (t > 0 && t < 1) {
              const taper = Math.pow(Math.sin(Math.PI * t), 0.55);
              const band = thick * taper * 0.55 + 0.008;
              v = Math.exp(-Math.pow((r - 0.62 * scale) / band, 2)) * (0.6 + 0.4 * taper);
            }
          } else if (kind === 'burst') {
            // 放射尖刺 × 径向衰减
            const spikes = 10 + Math.round(strength * 6);
            const wob = 0.15 * Math.sin(a * 3 + phase[0]);
            const spike = Math.pow(Math.max(0, Math.cos(a * spikes + wob)), 2.2);
            const fall = Math.max(0, 1 - r / (0.95 * scale));
            v = spike * Math.pow(fall, 1.6) + 0.25 * Math.pow(fall, 3);
          } else if (kind === 'ring') {
            // 圆环 + 外发光
            const band = thick * 0.5 + 0.01;
            const ring = Math.exp(-Math.pow((r - 0.6 * scale) / band, 2));
            const glow = Math.exp(-Math.pow(r / (thick * 2.2 + 0.05), 2)) * 0.45;
            v = ring + glow;
          } else if (kind === 'speed') {
            // 放射细线，越靠外越亮
            const lines = 26 + Math.round(strength * 10);
            const wob = 0.08 * Math.sin(a * 2 + phase[1]);
            const line = Math.pow(Math.max(0, Math.cos(a * lines + wob)), 14);
            const mask = clamp((r - 0.25) / 0.55, 0, 1);
            v = line * mask * (0.7 + 0.3 * Math.sin(r * 9 + phase[2]));
          } else if (kind === 'halo') {
            // 月晕：宽而软的辉光 + 亮核
            v = Math.exp(-Math.pow(r / 0.55, 2)) * 0.75 + Math.exp(-Math.pow(r / 0.16, 2)) * 0.8;
          } else if (kind === 'flash') {
            // 冲击闪光：中心爆点 + 四向长芒 + 斜向短芒
            const bloom = Math.exp(-Math.pow(r / (thick * 0.5 + 0.05), 2));
            const long = Math.pow(Math.max(0, Math.cos(a * 4 + phase[0])), 60) * Math.pow(Math.max(0, 1 - r), 2.2);
            const diag = Math.pow(Math.max(0, Math.cos(a * 4 + Math.PI / 4)), 120) * Math.pow(Math.max(0, 1 - r), 3);
            v = bloom + long * 0.85 + diag * 0.45;
          } else if (kind === 'orb') {
            // 能量球：中心亮、边缘一圈更亮的轮廓光
            const body = Math.pow(Math.max(0, 1 - r), 1.4) * 0.55;
            const rim = Math.exp(-Math.pow((r - 0.72) / (thick * 0.35 + 0.03), 2)) * 0.9;
            const core = Math.exp(-Math.pow(r / 0.22, 2)) * 0.7;
            v = body + rim + core;
          } else if (kind === 'nebula') {
            // 星云：噪声云 × 径向衰减。对比要拉起来，否则只是一团糊
            const cloud = noise ? noise[y * width + x] : 0.5;
            const fall = Math.pow(Math.max(0, 1 - r / 0.95), 1.1);
            const shaped = Math.max(0, cloud - 0.22) / 0.78;
            v = Math.pow(shaped, 1.4) * fall * 3.4;
          } else if (kind === 'shimmer') {
            // 微光星场：整数哈希撒点，越靠中心越密
            let hsh = (x * 374761393 + y * 668265263 + seed * 2654435761) >>> 0;
            hsh = ((hsh ^ (hsh >>> 13)) * 1274126177) >>> 0;
            hsh = (hsh ^ (hsh >>> 16)) >>> 0;
            const star = hsh / 4294967295;
            const density = 0.982 - 0.02 * strength;
            v = star > density ? ((star - density) / (1 - density)) * Math.max(0, 1 - r * 0.9) : 0;
          } else if (kind === 'shock') {
            // 冲击波：一圈很薄、边缘锐利的环
            const band = thick * 0.18 + 0.012;
            v = Math.exp(-Math.pow((r - 0.68 * scale) / band, 2))
              * (1 - 0.25 * Math.abs(Math.sin(a * 5 + phase[1])));
          } else if (kind === 'smoke') {
            // 烟尘：噪声 × 径向衰减。断续交给噪声本身，别用正弦 —— 正弦会做出规则花瓣
            const cloud = noise ? noise[y * width + x] : 0.5;
            const fall = Math.pow(Math.max(0, 1 - r / 0.9), 1.15);
            const wisps = Math.pow(Math.max(0, cloud - 0.25) / 0.75, 1.05);
            v = wisps * fall * 3.6;
          } else {
            const wob = 0.03 * Math.sin(ny * 14 + phase[0]);
            const halfW = thick * 0.6 * Math.pow(clamp(0.5 - nx / 2.2, 0.05, 1), 0.8) + 0.01;
            const core = Math.exp(-Math.pow((ny + wob) / halfW, 2));
            const along = clamp(1.15 - Math.abs(nx + 0.1), 0, 1);
            v = core * pow1_5(along);
          }

          out[y * width + x] = clamp(v * strength, 0, 1);
        }
      }
      return out;
    }

    function pow1_5(v) {
      const x = clamp(v, 0, 1);
      return Math.pow(x, 1.5);
    }

    /**
     * 域扭曲（domain warping）：用另一层低频噪声去「推」采样坐标。
     *
     * 这是程序化纹理从「一眼假」到「像真的」最关键的一步 —— 直线变弯、圆变有机，
     * 而参数只有一个强度。
     *
     * **采样必须环绕**（x,y 取模），否则扭曲会在接缝处撕开，无缝就没了。
     */
    function warpField(field, w, hh, opt) {
      const width = Math.max(1, Math.round(w));
      const height = Math.max(1, Math.round(hh));
      const amount = clamp(Number(opt.amount) || 0, 0, 0.5);
      if (amount <= 0) return field;
      const period = clamp(Math.round(opt.period) || 3, 1, 32);
      const seed = (opt.seed >>> 0) || 1;
      const nx = periodicFbm(width, height, { period, octaves: 2, seed: seed + 101 });
      const ny = periodicFbm(width, height, { period, octaves: 2, seed: seed + 202 });
      const out = new Float32Array(width * height);
      const sx = amount * width;
      const sy = amount * height;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const dx = (nx[i] - 0.5) * 2 * sx;
          const dy = (ny[i] - 0.5) * 2 * sy;
          // 环绕双线性采样：坐标取模，保证接缝处仍然连续
          let fx = x + dx;
          let fy = y + dy;
          fx = ((fx % width) + width) % width;
          fy = ((fy % height) + height) % height;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const tx = fx - x0;
          const ty = fy - y0;
          const x1 = (x0 + 1) % width;
          const y1 = (y0 + 1) % height;
          const a = field[y0 * width + x0];
          const b = field[y0 * width + x1];
          const c = field[y1 * width + x0];
          const d = field[y1 * width + x1];
          out[i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        }
      }
      return out;
    }

    /**
     * 素材库当前该显示什么。
     * 有搜索词就**跨类别搜** —— 否则用户得先猜它在哪个类别里（马尾在「头发」、
     * 皮甲在「上衣」、护腕在「护臂」，猜错就找不到）。
     */
    function filterLibrary(catId, query) {
      const q = String(query || '').trim().toLowerCase();
      const toRow = (cat, item) => ({
        key: cat + '|' + item,
        cat,
        item,
        label: item.split('/').slice(-2).join('/'),
      });
      if (q) {
        const out = [];
        for (const c of LPC_LIBRARY) {
          for (const it of c.items) {
            if (it.toLowerCase().includes(q)) out.push(toRow(c.id, it));
          }
        }
        return out;
      }
      const c = LPC_LIBRARY.find((x) => x.id === catId) || LPC_LIBRARY[0];
      return c.items.map((it) => toRow(c.id, it));
    }

    // ── 几何变换（纯计算，方便直接测） ────────────────────────────────────
    /**
     * 变换后的尺寸。翻转不改变尺寸，旋转 90° 宽高互换 —— 这条弄反了会把图拉变形。
     */
    function transformedSize(w, hh, op) {
      return op === 'rotate-cw' || op === 'rotate-ccw'
        ? { w: hh, h: w }
        : { w, h: hh };
    }

    /**
     * 对齐：算出每个精灵该挪到哪。返回 Map<id,{x,y}>，不改原数组。
     * 边界全部按「选中项的外接框」算 —— 这样多选对齐和单个都对得上。
     */
    function alignSprites(list, mode) {
      const out = new Map();
      if (!list || list.length < 2) return out;
      const minX = Math.min(...list.map((s) => s.x));
      const minY = Math.min(...list.map((s) => s.y));
      const maxR = Math.max(...list.map((s) => s.x + s.w * (s.scale || 1)));
      const maxB = Math.max(...list.map((s) => s.y + s.h * (s.scale || 1)));
      const cx = (minX + maxR) / 2;
      const cy = (minY + maxB) / 2;
      for (const s of list) {
        const dw = s.w * (s.scale || 1);
        const dh = s.h * (s.scale || 1);
        let x = s.x;
        let y = s.y;
        if (mode === 'left') x = minX;
        else if (mode === 'hcenter') x = cx - dw / 2;
        else if (mode === 'right') x = maxR - dw;
        else if (mode === 'top') y = minY;
        else if (mode === 'vcenter') y = cy - dh / 2;
        else if (mode === 'bottom') y = maxB - dh;
        out.set(s.id, { x: Math.round(x), y: Math.round(y) });
      }
      return out;
    }

    /**
     * 等距分布：两端的留在原地，中间的按间隔均分。少于 3 个没有意义（返回空）。
     */
    function distributeSprites(list, axis) {
      const out = new Map();
      if (!list || list.length < 3) return out;
      const horiz = axis === 'x';
      const size = (s) => (horiz ? s.w * (s.scale || 1) : s.h * (s.scale || 1));
      const pos = (s) => (horiz ? s.x : s.y);
      const sorted = [...list].sort((a, b) => pos(a) - pos(b));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const start = pos(first) + size(first);
      const end = pos(last);
      const total = end - start;
      const between = sorted.length - 2;
      const sumSizes = sorted.slice(1, -1).reduce((acc, s) => acc + size(s), 0);
      if (between < 1) return out;
      const gap = (total - sumSizes) / (between + 1);
      let cursor = start + gap;
      for (let i = 1; i < sorted.length - 1; i++) {
        const s = sorted[i];
        out.set(s.id, horiz ? { x: Math.round(cursor) } : { y: Math.round(cursor) });
        cursor += size(s) + gap;
      }
      return out;
    }

    /**
     * 从一堆精灵里提取「配方」：只保留 LPC 部件（有 meta.item 的），按 类别+部件+动作 去重。
     * 位置/偏移不存 —— 合成时会按锚点重算，存了反而会让不同尺寸的表对不齐。
     */
    function recipeFromSprites(list) {
      const out = [];
      const seen = new Set();
      for (const s of list || []) {
        const m = s.meta;
        if (!m || !m.item || !m.category) continue;
        const cat = String(m.category).replace(/_bg$/, '');
        const key = `${cat}|${m.item}|${m.anim || 'walk'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ cat, item: m.item, anim: m.anim || 'walk', bg: /_bg$/.test(m.category) });
      }
      return out;
    }

    /**
     * 调色：RGB → HSL → 改 → RGB。
     * 色相用「加角度再取模」，饱和度和亮度用乘法/加法 —— 这样多个参数叠加时不会互相吃掉。
     * 纯函数，方便直接测；透明像素不参与（调用方跳过 alpha=0）。
     */
    function shiftPixel(r, g, b, opt) {
      const hue = Number(opt.hue) || 0;
      const sat = opt.sat == null ? 1 : Number(opt.sat);
      const light = Number(opt.light) || 0;
      if (!hue && sat === 1 && !light) return [r, g, b];
      const R = r / 255;
      const G = g / 255;
      const B = b / 255;
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      let hh = 0;
      let ss = 0;
      const ll = (max + min) / 2;
      const d = max - min;
      if (d !== 0) {
        ss = ll > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === R) hh = ((G - B) / d + (G < B ? 6 : 0)) / 6;
        else if (max === G) hh = ((B - R) / d + 2) / 6;
        else hh = ((R - G) / d + 4) / 6;
      } else {
        // 灰阶没有色相可言，只调整亮度就好
        const out = clamp(Math.round((ll + light) * 255), 0, 255);
        return [out, out, out];
      }
      hh = (hh + hue / 360 + 1) % 1;
      const s2 = clamp(ss * sat, 0, 1);
      const l2 = clamp(ll + light, 0, 1);
      const hue2rgb = (p, q, t) => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
      };
      const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2;
      const p = 2 * l2 - q;
      return [
        clamp(Math.round(hue2rgb(p, q, hh + 1 / 3) * 255), 0, 255),
        clamp(Math.round(hue2rgb(p, q, hh) * 255), 0, 255),
        clamp(Math.round(hue2rgb(p, q, hh - 1 / 3) * 255), 0, 255),
      ];
    }

    // ── 切分：网格 ────────────────────────────────────────────────────────
    function gridRects(w, hh, opt) {
      const cols = clamp(Math.round(opt.cols) || 1, 1, 64);
      const rows = clamp(Math.round(opt.rows) || 1, 1, 64);
      const padX = Math.max(0, opt.padX || 0);
      const padY = Math.max(0, opt.padY || 0);
      const gapX = Math.max(0, opt.gapX || 0);
      const gapY = Math.max(0, opt.gapY || 0);
      const availW = w - padX * 2 - gapX * (cols - 1);
      const availH = hh - padY * 2 - gapY * (rows - 1);
      if (availW <= 0 || availH <= 0) return [];
      const cw = availW / cols;
      const ch = availH / rows;
      const out = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = Math.round(padX + c * (cw + gapX));
          const y = Math.round(padY + r * (ch + gapY));
          out.push({
            x,
            y,
            w: clamp(Math.round(cw), 1, w - x),
            h: clamp(Math.round(ch), 1, hh - y),
          });
        }
      }
      return out;
    }

    // ── 切分：alpha 连通域自动检测 ─────────────────────────────────────────
    function nearBox(a, b, gap) {
      return !(
        a.x - gap > b.x + b.w ||
        b.x - gap > a.x + a.w ||
        a.y - gap > b.y + b.h ||
        b.y - gap > a.y + a.h
      );
    }

    function unionBox(a, b) {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return {
        x,
        y,
        w: Math.max(a.x + a.w, b.x + b.w) - x,
        h: Math.max(a.y + a.h, b.y + b.h) - y,
      };
    }

    function autoRects(imageData, opt) {
      const w = imageData.width;
      const hh = imageData.height;
      const data = imageData.data;
      const alphaMin = clamp(opt.alphaMin ?? 12, 1, 254);
      const minArea = Math.max(0, opt.minArea ?? 24);
      const mergeGap = Math.max(0, opt.mergeGap ?? 2);

      const mask = new Uint8Array(w * hh);
      for (let i = 0, p = 3; i < mask.length; i++, p += 4) mask[i] = data[p] > alphaMin ? 1 : 0;

      const seen = new Uint8Array(w * hh);
      const boxes = [];
      for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) continue;
        const stack = [start];
        seen[start] = 1;
        let minX = w, minY = hh, maxX = -1, maxY = -1, count = 0;
        while (stack.length) {
          const idx = stack.pop();
          const x = idx % w;
          const y = (idx - x) / w;
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x > 0) {
            const n = idx - 1;
            if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
          if (x < w - 1) {
            const n = idx + 1;
            if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
          if (y > 0) {
            const n = idx - w;
            if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
          if (y < hh - 1) {
            const n = idx + w;
            if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
        }
        if (count >= minArea) boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
      }

      // 邻近合并：把同一只精灵拆散的部件（眼睛、武器、影子）并回一个框。
      let changed = mergeGap > 0 && boxes.length > 1;
      while (changed) {
        changed = false;
        for (let i = 0; i < boxes.length && !changed; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            if (nearBox(boxes[i], boxes[j], mergeGap)) {
              boxes[i] = unionBox(boxes[i], boxes[j]);
              boxes.splice(j, 1);
              changed = true;
              break;
            }
          }
        }
      }

      boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      // 行聚类：以出现最多的框高作为行高，避免高低不齐的精灵被打乱阅读顺序。
      if (boxes.length > 1) {
        const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
        const rowH = Math.max(1, heights[Math.floor(heights.length / 2)] * 0.75);
        boxes.sort((a, b) => {
          const ra = Math.round((a.y + a.h / 2) / rowH);
          const rb = Math.round((b.y + b.h / 2) / rowH);
          return ra - rb || a.x - b.x;
        });
      }

      if (opt.uniform && boxes.length > 1) {
        let mw = 0;
        let mh = 0;
        for (const b of boxes) {
          if (b.w > mw) mw = b.w;
          if (b.h > mh) mh = b.h;
        }
        return boxes.map((b) => ({ x: b.x, y: b.y, w: Math.min(mw, w - b.x), h: Math.min(mh, hh - b.y) }));
      }
      return boxes;
    }

    // ── 抠图 ──────────────────────────────────────────────────────────────
    /** 取边框出现最多的颜色当背景色（量化到 5bit，再回原始像素求均值）。 */
    function dominantBorderColor(imageData, stride = 2) {
      const w = imageData.width;
      const hh = imageData.height;
      const data = imageData.data;
      const counts = new Map();
      const tally = (x, y) => {
        const p = (y * w + x) * 4;
        if (data[p + 3] < 8) return;
        const k = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
        counts.set(k, (counts.get(k) || 0) + 1);
      };
      for (let x = 0; x < w; x += stride) { tally(x, 0); tally(x, hh - 1); }
      for (let y = 0; y < hh; y += stride) { tally(0, y); tally(w - 1, y); }
      let best = -1;
      let bestCount = 0;
      counts.forEach((c, k) => { if (c > bestCount) { bestCount = c; best = k; } });
      if (best < 0) return null;
      const br = (best >> 10) & 31;
      const bg = (best >> 5) & 31;
      const bb = best & 31;
      let r = 0, g = 0, b = 0, n = 0;
      const refine = (x, y) => {
        const p = (y * w + x) * 4;
        if (data[p + 3] < 8) return;
        const dr = (data[p] >> 3) - br;
        const dg = (data[p + 1] >> 3) - bg;
        const db = (data[p + 2] >> 3) - bb;
        if (dr * dr + dg * dg + db * db <= 3) { r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
      };
      for (let x = 0; x < w; x += stride) { refine(x, 0); refine(x, hh - 1); }
      for (let y = 0; y < hh; y += stride) { refine(0, y); refine(w - 1, y); }
      return n ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) } : null;
    }

    /**
     * 就地修改 imageData 的 alpha。
     * mode='border'：从四边向内漫水，只清掉与边缘连通的背景（保护精灵内部的同色块）。
     * mode='global'：所有接近背景色的像素都清掉（适合纯色块背景 + 精灵内部无同色）。
     * tol/softness 是 0..441 的 RGB 欧氏距离；softness 之外的环形带按距离给半透明，边缘更自然。
     */
    function applyMatte(imageData, opt) {
      const w = imageData.width;
      const hh = imageData.height;
      const data = imageData.data;
      const bg = opt.color;
      const inner = Math.max(0, opt.tol);
      const outer = inner + Math.max(0, opt.softness);
      const removed = new Uint8Array(w * hh);
      const dist = new Float32Array(w * hh);

      for (let i = 0, p = 0; i < dist.length; i++, p += 4) {
        const dr = data[p] - bg.r;
        const dg = data[p + 1] - bg.g;
        const db = data[p + 2] - bg.b;
        dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
      }

      if (opt.mode === 'global') {
        for (let i = 0; i < dist.length; i++) if (dist[i] <= inner) removed[i] = 1;
      } else {
        const queue = [];
        const push = (idx) => {
          if (!removed[idx] && dist[idx] <= inner) { removed[idx] = 1; queue.push(idx); }
        };
        for (let x = 0; x < w; x++) { push(x); push((hh - 1) * w + x); }
        for (let y = 0; y < hh; y++) { push(y * w); push(y * w + w - 1); }
        while (queue.length) {
          const idx = queue.pop();
          const x = idx % w;
          const y = (idx - x) / w;
          if (x > 0) push(idx - 1);
          if (x < w - 1) push(idx + 1);
          if (y > 0) push(idx - w);
          if (y < hh - 1) push(idx + w);
        }
      }

      for (let i = 0, p = 0; i < dist.length; i++, p += 4) {
        if (removed[i]) { data[p + 3] = 0; continue; }
        if (outer > inner && dist[i] < outer) {
          const k = (dist[i] - inner) / (outer - inner);
          data[p + 3] = Math.round(data[p + 3] * k);
        }
      }
      return imageData;
    }

    // ── 撤销 / 重做的持久化差异 ───────────────────────────────────────────
    /**
     * 把一个快照与当前状态比对，算出该往 IndexedDB 写什么。
     * 未改动的条目在两个快照里是同一个对象引用，所以 `!==` 就足以判断「变过」。
     */
    function planRestoreDiff(prev, next) {
      const nextIds = new Set(next.map((s) => s.id));
      const prevById = new Map(prev.map((s) => [s.id, s]));
      const removed = [];
      const dirty = [];
      for (const s of prev) if (!nextIds.has(s.id)) removed.push(s.id);
      for (const s of next) if (prevById.get(s.id) !== s) dirty.push(s.id);
      return { removed, dirty };
    }

    // ── 键盘映射 ──────────────────────────────────────────────────────────
    /**
     * 把一次 keydown 解析成一个动作名，纯函数，方便直接测。
     * ⌘ 与 Ctrl 等价（Windows 上只按 Ctrl 就行）。
     */
    function resolveShortcut(e) {
      // 生成面板的快捷键：空格 = 重新生成，R = 换种子（只有面板打开时才生效，见调用处）
      if (e.code === 'Space') return 'regen';
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'r' || e.key === 'R')) return 'reseed';
      const mod = !!(e.metaKey || e.ctrlKey);
      const key = String(e.key || '').toLowerCase();
      if (mod && key === 'z') return e.shiftKey ? 'redo' : 'undo';
      if (mod && key === 'y') return 'redo';
      if (mod && key === 'c') return 'duplicate';
      if (mod && key === 'a') return 'select-all';
      if (mod && key === '0') return 'zoom-reset';
      if (e.key === 'Escape') return 'clear-selection';
      if (e.key === 'Delete' || e.key === 'Backspace') return 'delete';
      return null;
    }

    /**
     * 画布背景上按下时的意图。
     * - 中键：任意位置都能平移（压在图上也算，图自己会先让开）
     * - 左键：空白处平移；压在图上时交给精灵去选中/拖动
     */
    function boardPointerMode(button, onEmptyTarget) {
      if (button === 1) return 'pan';
      if (button === 0) return onEmptyTarget ? 'pan' : 'ignore';
      return 'ignore';
    }

    /**
     * 从自动检测出来的边界反推「网格应该是几乘几」。
     *
     * 为什么不用图片尺寸猜：128×128 既可能是 2×2 的 sheet，也可能是一张单图，
     * 尺寸整除关系对两者都成立 —— 用尺寸猜必然误判。用**内容**（连通域）才靠谱：
     * 只有真的有多块内容，才值得给一个非 1×1 的默认值。
     */
        /**
     * 从自动检测出来的边界反推「网格应该是几乘几」。
     *
     * 为什么不能拿**盒子宽高**去整除画布：角色通常比格子窄（64px 的格子里只站 40px 宽），
     * 用宽度去除会得出 14×5 这种偏大的网格 —— 实测在 LPC 表上必错。
     *
     * 正确做法是用**相邻盒子的间距（pitch）**：同一行里相邻两格的 x 差就是列距，
     * 行与行中心的 y 差就是行距。再用首尾跨度算格数，这样外边距不会参与。
     */
    function guessGridFromRects(rects, w, hh) {
      if (!rects || rects.length < 2) return null;
      const medW = median(rects.map((r) => r.w));
      const medH = median(rects.map((r) => r.h));
      // 碎到看不清就不猜（2×2 的噪声块不是精灵）
      if (!(medW >= 4) || !(medH >= 4)) return null;

      // 按行聚类：y 中心相差不到半个中位高度就算同一行
      const rows = [];
      for (const r of [...rects].sort((a, b) => a.y - b.y)) {
        const cy = r.y + r.h / 2;
        const row = rows.find((it) => Math.abs(it.cy - cy) < medH * 0.5);
        if (row) {
          row.items.push(r);
          row.cy = row.items.reduce((s, it) => s + it.y + it.h / 2, 0) / row.items.length;
        } else {
          rows.push({ cy, items: [r] });
        }
      }

      // 列距：每行内相邻盒子的 x 差；行距：相邻行中心的 y 差
      const dxs = [];
      for (const row of rows) {
        const xs = row.items.map((r) => r.x).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) if (xs[i] > xs[i - 1]) dxs.push(xs[i] - xs[i - 1]);
      }
      const dys = [];
      for (let i = 1; i < rows.length; i++) if (rows[i].cy > rows[i - 1].cy) dys.push(rows[i].cy - rows[i - 1].cy);

      const colPitch = dxs.length ? median(dxs) : 0;
      const rowPitch = dys.length ? median(dys) : 0;

      // 格数按**整张画布**算（空单元格也是格子，切的时候要对齐）；
      // 格子尺寸用间距而不是盒子宽 —— 角色比格子窄时才不会多算。
      const cols = colPitch > 0 ? clamp(Math.round(w / colPitch), 1, 64) : 1;
      const rowCount = rowPitch > 0 ? clamp(Math.round(hh / rowPitch), 1, 64) : 1;

      if (cols * rowCount < 2 || cols * rowCount > 1024) return null;
      // 格子数比盒子还少，说明间距估歪了
      if (cols * rowCount < rects.length) return null;
      return { cols, rows: rowCount };
    }

    function median(values) {
      if (!values.length) return 0;
      const sorted = values.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * 拖拽时切分预览层要落到哪里（世界坐标 px）。
     * 预览层是 sheet 的兄弟节点、不是子节点（它得压在所有精灵之上），
     * 所以没有继承关系可用 —— 拖 sheet 时必须自己把预览层一起挪。
     */
    function overlayDragPosition(moving, ownerId, dx, dy) {
      if (!ownerId) return null;
      const item = moving.find((m) => m.id === ownerId);
      if (!item) return null;
      return { left: Math.round(item.x + dx), top: Math.round(item.y + dy) };
    }

    // ── 少量 UI 原子组件 ──────────────────────────────────────────────────
    function Seg({ value, options, onChange, label }) {
      return h(
        'div',
        { className: 'ss-seg', role: 'group', 'aria-label': label },
        options.map((o) =>
          h('button', {
            key: o.id,
            type: 'button',
            className: 'ss-seg-btn',
            'data-active': o.id === value ? 'true' : 'false',
            'aria-pressed': o.id === value,
            onClick: () => onChange(o.id),
          }, o.label),
        ),
      );
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { className: 'ss-field' },
        h('span', { className: 'ss-field-label' }, label, hint ? h('span', { className: 'ss-hint' }, hint) : null),
        children,
      );
    }

    function Num({ value, onChange, min, max, step = 1 }) {
      return h('input', {
        className: 'ss-input',
        type: 'number',
        value: Number.isFinite(value) ? value : 0,
        min, max, step,
        onChange: (e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(clamp(v, min ?? -1e9, max ?? 1e9));
        },
      });
    }

    function Switch({ checked, onChange, children }) {
      return h(
        'label',
        { className: 'ss-switch' },
        h('input', { type: 'checkbox', checked: !!checked, onChange: (e) => onChange(e.target.checked) }),
        h('span', null, children),
      );
    }

    /**
     * 受控折叠区。展开状态由面板统一持有 —— 这样「选中一张图就把所有板块弹开」
     * 不会发生，而且用户开过哪几个板块能跨面板/跨刷新记住。
     */
    function Section({ title, aside, children, open, onToggle, id }) {
      return h(
        'section',
        { className: cx('ss-sec', open && 'is-open'), 'data-section': id },
        h('button', {
          type: 'button',
          className: 'ss-sec-head',
          'aria-expanded': !!open,
          onClick: onToggle,
        },
          h('span', { className: 'ss-chev', 'aria-hidden': 'true' }, '›'),
          h('span', { className: 'ss-sec-title' }, title),
          aside ? h('span', { className: 'ss-sec-aside' }, aside) : null,
        ),
        open ? h('div', { className: 'ss-sec-body' }, children) : null,
      );
    }

    function Slider({ value, onChange, min, max, step = 1 }) {
      return h('input', {
        className: 'ss-range',
        type: 'range',
        value, min, max, step,
        onChange: (e) => onChange(Number(e.target.value)),
      });
    }

    // ── 侧边栏图标 ────────────────────────────────────────────────────────
    /** 顶栏品牌标：与插件 icon.svg 同一套图形，保证「侧栏图标 = 面板标题」。 */
    function BrandMark(props) {
      const size = typeof props.size === 'number' ? props.size : 18;
      return h('svg', {
        viewBox: '0 0 64 64',
        width: size,
        height: size,
        'aria-hidden': 'true',
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('defs', null,
          h('linearGradient', {
            id: 'ss-brand-grad',
            x1: '8', y1: '4', x2: '58', y2: '60',
            gradientUnits: 'userSpaceOnUse',
          },
            h('stop', { offset: '0', stopColor: '#5b5bd6' }),
            h('stop', { offset: '1', stopColor: '#8b5cf6' }),
          ),
        ),
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 15, fill: 'url(#ss-brand-grad)' }),
        h('g', { fill: '#fff' },
          h('rect', { x: 13, y: 13, width: 17, height: 17, rx: 4.5 }),
          h('rect', { x: 34, y: 13, width: 17, height: 17, rx: 4.5, fillOpacity: 0.92 }),
          h('rect', { x: 13, y: 34, width: 17, height: 17, rx: 4.5, fillOpacity: 0.92 }),
        ),
        h('rect', {
          x: 34, y: 34, width: 17, height: 17, rx: 4.5,
          fill: 'none', stroke: '#fff', strokeWidth: 2.2,
          strokeDasharray: '4 3.4', strokeOpacity: 0.85,
        }),
      );
    }

    function HistoryIcon(props) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block', transform: props.flip ? 'scaleX(-1)' : undefined },
      },
        h('path', { d: 'M13.1 8.2a5.1 5.1 0 1 1-1.65-3.78' }),
        h('path', { d: 'M13.2 2.9v3h-3' }),
      );
    }

    function SidebarIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18;
      const common = { stroke: 'currentColor', strokeWidth: 1.25, fill: 'none' };
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: props.active ? 1 : 0.92 },
        },
        h('rect', { x: 2.7, y: 2.7, width: 4.6, height: 4.6, rx: 1.2, ...common }),
        h('rect', { x: 8.7, y: 2.7, width: 4.6, height: 4.6, rx: 1.2, ...common }),
        h('rect', { x: 2.7, y: 8.7, width: 4.6, height: 4.6, rx: 1.2, ...common }),
        h('rect', { x: 8.7, y: 8.7, width: 4.6, height: 4.6, rx: 1.2, ...common, strokeDasharray: '1.5 1.4', opacity: 0.65 }),
      );
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    function StudioPanel() {
      const [loaded, setLoaded] = useState(false);
      const [loadError, setLoadError] = useState(null);
      const [sprites, setSprites] = useState([]);
      const [view, setView] = useState({ x: 48, y: 56, zoom: 1 });
      const [selection, setSelection] = useState([]);
      const [busy, setBusy] = useState('');
      const [toast, setToast] = useState(null);
      const [dragging, setDragging] = useState(false);
      const [panning, setPanning] = useState(false);

      const [sliceMode, setSliceMode] = useState('grid');
      const [grid, setGrid] = useState({ cols: 4, rows: 4, padX: 0, padY: 0, gapX: 0, gapY: 0 });
      const [autoOpts, setAutoOpts] = useState({ alphaMin: 12, mergeGap: 2, minArea: 24, uniform: false });
      const [detected, setDetected] = useState(null);
      const [gridAuto, setGridAuto] = useState(null);
      const [sliceDirs, setSliceDirs] = useState(false);
      const [sliceSkipEmpty, setSliceSkipEmpty] = useState(true);
      const [scanResult, setScanResult] = useState(null);
      const [scanOff, setScanOff] = useState([]);
      const [scanCounts, setScanCounts] = useState({});
      const [scanOpts, setScanOpts] = useState({ rowGap: 4, colGap: 2, minFrameW: 4 });
      // 当前生效的预设 { kind:'cell'|'lpc', id }，再点一下同一个就取消
      const [activePreset, setActivePreset] = useState(null);
      const presetStackRef = useRef([]);
      const gridTouchedRef = useRef(false);
      const gridOwnerRef = useRef(null);
      const gridGuessRef = useRef(new Map()); // 每张图各自的推断结果（不是"记住上次用的网格"）
      const [sliceTrim, setSliceTrim] = useState(true);
      const [exportScope, setExportScope] = useState('selection');
      const [atlasMax, setAtlasMax] = useState(2048);
      const [atlasPadding, setAtlasPadding] = useState(2);
      const [atlasPot, setAtlasPot] = useState(true);
      const [atlasPivot, setAtlasPivot] = useState('center');
      const [animPlaying, setAnimPlaying] = useState(false);
      const [animFps, setAnimFps] = useState(12);
      const [animOnion, setAnimOnion] = useState(true);
      const [animIndex, setAnimIndex] = useState(0);
      const [tileMode, setTileMode] = useState('grid');
      const [tileSpeed, setTileSpeed] = useState(60);
      const [tileRun, setTileRun] = useState(true);
      const [compOrder, setCompOrder] = useState([]);
      const [compOffset, setCompOffset] = useState({});
      const [compHidden, setCompHidden] = useState([]);
      const [compAnchor, setCompAnchor] = useState('topleft');
      const [compActive, setCompActive] = useState(null);
      const compPreviewRef = useRef(null);
      const [libCat, setLibCat] = useState('body');
      const [libAnim, setLibAnim] = useState('walk');
      const [tint, setTint] = useState({ hue: 0, sat: 1, light: 0 });
      // 导出倍率：1/2/4，按最近邻放大，进引擎缩回去更清楚
      const [exportScale, setExportScale] = useState(1);
      const tintBaseRef = useRef(new Map());
      const [recipes, setRecipes] = useState([]);
      const recipesRef = useRef([]);
      recipesRef.current = recipes;
      const [recipeName, setRecipeName] = useState('');

      const [libQuery, setLibQuery] = useState('');
      const [libThumbs, setLibThumbs] = useState({});
      /**
       * 取不到的部件清单。
       * 上游 1000+ 个目录里有一部分「有目录、没有对应动作文件」，候选规则只能覆盖已知形态。
       * 与其让用户一次次撞 404，不如把撞到的记下来 —— 能一次发给我，我照着补规则。
       */
      const [libFails, setLibFails] = useState([]);
      const libFailsRef = useRef([]);
      libFailsRef.current = libFails;
      const noteLibFail = useCallback((cat, item, anim) => {
        setLibFails((prev) => {
          if (prev.some((f) => f.cat === cat && f.item === item && f.anim === anim)) return prev;
          return prev.concat({ cat, item, anim }).slice(-200);
        });
      }, []);

      /**
       * 素材库当前该显示的条目。
       * 有搜索词时**跨类别搜** —— 否则用户得先猜它在哪个类别里（马尾在「头发」、
       * 皮甲在「上衣」、护腕在「护臂」，猜错就找不到）。
       */
      const libVisible = useMemo(
        () => filterLibrary(libCat, libQuery),
        [libCat, libQuery],
      );
      const [fx, setFx] = useState({
        kind: 'slash', size: 128, strength: 1, thick: 0.18, arc: 150,
        palette: 'fire', levels: 5, seed: 7, warp: 0,
      });
      const [fxPreview, setFxPreview] = useState(null);
      const [bg, setBg] = useState({
        w: 256,
        h: 256,
        seed: 1337,
        period: 3,
        octaves: 5,
        levels: 5,
        dither: true,
        cell: 4,
        dark: '#16241c',
        light: '#7f9a5c',
        palette: 'forest',
        layer2: false,
        p2Period: 6,
        p2Octaves: 3,
        p2Seed: 91,
        blend: 'overlay',
        invert: false,
        contrast: 1,
        gamma: 1,
        autoLevels: false,
        stretch: '1:1',
        pack: false,
        warp: 0,
      });
      const [bgPreview, setBgPreview] = useState(null);

      const [matteMode, setMatteMode] = useState('border');
      const [matteTol, setMatteTol] = useState(26);
      const [matteSoft, setMatteSoft] = useState(26);
      const [matteBgMode, setMatteBgMode] = useState('auto');
      const [matteHex, setMatteHex] = useState('#ffffff');
      const [matteTrim, setMatteTrim] = useState(true);
      const [matteKeep, setMatteKeep] = useState(false);
      const [mattePreview, setMattePreview] = useState(null);
      const [matteErr, setMatteErr] = useState(null);
      const [picking, setPicking] = useState(false);

      // ── UI 折叠状态（默认全收起，展开选择会被记住）─────────────────────
      const [sections, setSections] = useState(DEFAULT_SECTIONS);
      const sectionsRef = useRef(sections);
      sectionsRef.current = sections;
      const toggleSection = useCallback((id) => {
        setSections((s) => ({ ...s, [id]: !s[id] }));
      }, []);

      const rootRef = useRef(null);

      /** 顶部快捷入口：展开目标板块并滚过去。 */
      const jumpToSection = useCallback((id) => {
        setSections((s) => ({ ...s, [id]: true }));
        setTimeout(() => {
          const el = rootRef.current && rootRef.current.querySelector(`[data-section="${id}"]`);
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }, 40);
      }, []);


      // 生成动作放进 ref：键盘 effect 在它们之前定义，直接引用会踩 TDZ
      const genActionsRef = useRef({});
      const boardRef = useRef(null);
      const worldRef = useRef(null);
      const itemRefs = useRef(new Map());
      // 切分预览层是被拖精灵的兄弟节点，拖拽时得手动跟着动，否则网格会留在原地。
      const sliceOverlayRef = useRef(null);
      const sliceOwnerRef = useRef(null);
      const viewRef = useRef(view);
      const spritesRef = useRef(sprites);
      const selectionRef = useRef(selection);
      const dirtyRef = useRef(new Set());
      const removedRef = useRef(new Set());
      const historyRef = useRef({ past: [], future: [] });
      const textEditRef = useRef({ key: '', at: 0 });
      const [, setHistVersion] = useState(0);
      const loadRef = useRef(false);
      const toastTimer = useRef(0);
      const fileInputRef = useRef(null);
      const projectInputRef = useRef(null);

      viewRef.current = view;
      spritesRef.current = sprites;
      selectionRef.current = selection;

      const selectedSprites = useMemo(
        () => sprites.filter((s) => selection.includes(s.id)),
        [sprites, selection],
      );
      const primary = selectedSprites[0] || null;

      // 动画预览：选中项按名字自然序排队（切图产物的序号就是播放顺序）
      const playFrames = useMemo(() => sortFramesByName(selectedSprites), [selectedSprites]);

      /**
       * 单张整表也能直接看动画：按 64 网格自动拆，**不生成新精灵**。
       * 用「裁剪容器 + 负偏移」显示单格，比逐帧 canvas 便宜得多，也不污染画布。
       */
      const sheetGrid = useMemo(() => {
        const sp = selectedSprites.length === 1 ? primary : null;
        if (!sp || sp.w % 64 || sp.h % 64) return null;
        const cols = Math.round(sp.w / 64);
        const rows = Math.round(sp.h / 64);
        if (cols < 2 || rows < 1) return null;
        return { sp, cols, rows };
      }, [primary, selectedSprites.length]);
      const [sheetDir, setSheetDir] = useState(0);
      // 平铺预览的显示尺寸：放进 300×132 的盒子里，按比例缩（不放大，避免糊）
      const tileView = useMemo(() => {
        const sp = primary;
        if (!sp) return { w: 1, h: 1, dur: 1 };
        const k = Math.min(132 / Math.max(1, sp.h), 300 / Math.max(1, sp.w), 1);
        const w = Math.max(1, Math.round(sp.w * k));
        const h = Math.max(1, Math.round(sp.h * k));
        // 滚动一圈 = 一个 tile 宽；速度是 px/s
        return { w, h, dur: Math.max(0.35, w / Math.max(8, tileSpeed)) };
      }, [primary, tileSpeed]);

      const selectionKey = selection.join(',');

      // ── 角色合成 ───────────────────────────────────────────────────────
      // 图层顺序默认跟随选中顺序；选中变了就重置（不做跨选的「记住」）。
      useEffect(() => {
        // 默认就按 LPC 的部位顺序排好 —— 否则「头发被头挡住」这种一眼假的结果太常见。
        setCompOrder(sortLayersByCategory(selectedSprites).map((s) => s.id));
        setCompOffset({});
        setCompHidden([]);
        // selectedSprites 由 selection 派生，selectionKey 已覆盖它的变化
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selectionKey]);

      const compLayers = useMemo(
        () => orderLayers(compOrder, selectedSprites).filter((s) => !compHidden.includes(s.id)),
        [compOrder, selectedSprites, compHidden],
      );
      const compList = useMemo(
        () => orderLayers(compOrder, selectedSprites),
        [compOrder, selectedSprites],
      );

      /**
       * 自检 2：图层尺寸不一致。
       * LPC 大部分部位是 576×256（64px × 9 帧 × 4 向），但**大型武器**是 128 帧、
       * 表会大一圈（如武士刀 1789×512）。尺寸不同的两张表叠在一起必然错位 ——
       * 用户看到的现象就是「武器只在一行里有」。
       */
      const mixedSizes = useMemo(() => {
        const seen = new Map();
        for (const s of compList) {
          const k = `${s.w}×${s.h}`;
          seen.set(k, (seen.get(k) || 0) + 1);
        }
        return seen.size > 1 ? [...seen.keys()] : [];
      }, [compList]);
      const missingForeLayer = useMemo(() => {
        const cats = new Set(compList.map((s) => (s.meta && s.meta.category) || ''));
        const out = [];
        for (const c of cats) {
          if (!c.endsWith('_bg')) continue;
          const base = c.slice(0, -3);
          if (!cats.has(base)) out.push({ bg: c, base });
        }
        return out;
      }, [compList]);
      const compLayout = useMemo(
        () => composeLayout(compLayers, compAnchor, compOffset),
        [compLayers, compAnchor, compOffset],
      );

      // 合成预览：按布局把部件画进一张小 canvas，改了偏移/顺序立刻能看到
      const compKey = useMemo(
        () => compLayout.items.map((i) => `${i.id}:${i.x},${i.y}`).join('|') + `#${compLayout.w}x${compLayout.h}`,
        [compLayout],
      );

      useEffect(() => {
        const cv = compPreviewRef.current;
        if (!cv || !compLayout.w || !compLayout.h) return undefined;
        let alive = true;
        (async () => {
          try {
            const k = Math.min(240 / compLayout.w, 180 / compLayout.h, 3);
            cv.width = Math.max(1, Math.round(compLayout.w * k));
            cv.height = Math.max(1, Math.round(compLayout.h * k));
            cv.style.width = cv.width + 'px';
            cv.style.height = cv.height + 'px';
            const g = ctx2d(cv);
            g.clearRect(0, 0, cv.width, cv.height);
            g.imageSmoothingEnabled = false;
            for (const item of compLayout.items) {
              const sp = compLayers.find((s) => s.id === item.id);
              if (!sp) continue;
              const img = await loadImage(sp.dataUrl);
              if (!alive) return;
              g.drawImage(img, item.x * k, item.y * k, sp.w * k, sp.h * k);
            }
          } catch (err) {
            // 预览失败不影响合成
          }
        })();
        return () => { alive = false; };
      }, [compKey, compLayout, compLayers]);
      useEffect(() => {
        setAnimIndex(0);
        setAnimPlaying(false);
      }, [selectionKey]);

      useEffect(() => {
        // 整表模式下帧数来自网格列数，多个精灵时来自选中数量
        const total = playFrames.length >= 2
          ? playFrames.length
          : (sheetGrid ? sheetGrid.cols : 0);
        if (!animPlaying || total < 2) return undefined;
        const step = Math.max(20, Math.round(1000 / Math.max(1, animFps)));
        const timer = setInterval(() => {
          setAnimIndex((i) => (i + 1) % total);
        }, step);
        return () => clearInterval(timer);
      }, [animPlaying, animFps, playFrames.length, sheetGrid]);

      const notify = useCallback((msg, tone) => {
        setToast({ msg, tone: tone || 'info' });
        clearTimeout(toastTimer.current);
        // 报错要多留一会儿 —— 2.8 秒里你正在看别处，回来就没了，只能重试一次才知道错在哪。
        const t = tone || 'info';
        const ms = t === 'error' ? 7000 : t === 'success' ? 2200 : 3500;
        toastTimer.current = setTimeout(() => setToast(null), ms);
      }, []);

      // ── 载入 ───────────────────────────────────────────────────────────
      useEffect(() => {
        let alive = true;
        loadAll()
          .then(({ sprites: rows, boardState }) => {
            if (!alive) return;
            const list = (rows || []).filter((s) => s && s.id && s.dataUrl);
            list.sort((a, b) => (a.z || 0) - (b.z || 0));
            setSprites(list);
            if (boardState && boardState.view) {
              setView({
                x: Number(boardState.view.x) || 0,
                y: Number(boardState.view.y) || 0,
                zoom: clamp(Number(boardState.view.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
              });
            }
            if (boardState && boardState.sections && typeof boardState.sections === 'object') {
              setSections({ ...DEFAULT_SECTIONS, ...boardState.sections });
        if (Array.isArray(boardState.libFails)) setLibFails(boardState.libFails.slice(-200));
        if (Array.isArray(boardState.recipes)) setRecipes(boardState.recipes.slice(0, 50));
            }
            loadRef.current = true;
            setLoaded(true);
          })
          .catch((err) => {
            if (!alive) return;
            loadRef.current = true;
            setLoaded(true);
            setLoadError(err && err.message ? err.message : String(err));
          });
        return () => { alive = false; };
      }, []);

      // ── 持久化（脏标记 + 去抖）─────────────────────────────────────────
      useEffect(() => {
        if (!loaded) return undefined;
        const timer = setTimeout(() => {
          const putIds = Array.from(dirtyRef.current);
          const rmIds = Array.from(removedRef.current);
          dirtyRef.current.clear();
          removedRef.current.clear();
          const byId = new Map(spritesRef.current.map((s) => [s.id, s]));
          const put = putIds.map((id) => byId.get(id)).filter(Boolean);
          // 即使没有脏精灵也要写一次 view/sections：平移缩放和折叠状态本身也是要记住的。
          saveDelta(put, rmIds, { view: viewRef.current, sections: sectionsRef.current, libFails: libFailsRef.current, recipes: recipesRef.current }).catch((err) => {
            console.warn('[sprite-studio] 保存失败', err);
            notify('自动保存失败：' + (err && err.message ? err.message : err), 'error');
          });
        }, 550);
        return () => clearTimeout(timer);
      }, [sprites, view, sections, loaded, notify]);

      // ── 根节点高度兜底（宿主容器可能没有给 100% 高度）──────────────────
      useLayoutEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        let locked = false;
        const measure = () => {
          if (locked) return;
          const parent = el.parentElement;
          const ph = parent ? parent.getBoundingClientRect().height : 0;
          if (ph < 120) {
            // 宿主容器没有确实高度：先给一个显式高度把自己撑开，然后锁定，
            // 否则「撑开 → 量到够高 → 回到 100% → 再塌回 0」会来回抖。
            locked = true;
            el.style.height = Math.max(360, window.innerHeight - 120) + 'px';
          } else {
            el.style.height = '100%';
          }
        };
        measure();
        const ro = new ResizeObserver(measure);
        if (el.parentElement) ro.observe(el.parentElement);
        return () => ro.disconnect();
      }, []);

      // ── 变更原语 ───────────────────────────────────────────────────────
      const patchSprites = useCallback((patchById) => {
        if (!patchById.size) return;
        patchById.forEach((_v, id) => dirtyRef.current.add(id));
        setSprites((list) => list.map((sp) => (patchById.has(sp.id) ? { ...sp, ...patchById.get(sp.id) } : sp)));
      }, []);

      const addSprites = useCallback((items) => {
        items.forEach((it) => dirtyRef.current.add(it.id));
        setSprites((list) => [...list, ...items]);
      }, []);

      const removeSprites = useCallback((ids) => {
        if (!ids.length) return;
        ids.forEach((id) => {
          removedRef.current.add(id);
          dirtyRef.current.delete(id);
        });
        setSprites((list) => list.filter((sp) => !ids.includes(sp.id)));
        setSelection((sel) => sel.filter((id) => !ids.includes(id)));
      }, []);

      const nextZ = useCallback(() => {
        const list = spritesRef.current;
        let z = 0;
        for (const s of list) if ((s.z || 0) > z) z = s.z;
        return z + 1;
      }, []);

      // ── 撤销 / 重做 ────────────────────────────────────────────────────
      // 快照式，但一条历史只是一份 {sprites, selection} 的数组引用：
      // 图片是 dataURL 字符串，未改动的条目在两个快照里是同一个对象/同一个字符串，
      // 所以一条历史真实成本是几十个指针，不做像素深拷贝。
      // 视图（平移/缩放）故意不进历史：撤销应该撤内容，不是撤镜头。
      const pushHistory = useCallback(() => {
        const hst = historyRef.current;
        hst.past.push({ sprites: spritesRef.current, selection: selectionRef.current });
        if (hst.past.length > HISTORY_LIMIT) hst.past.shift();
        hst.future.length = 0;
        setHistVersion((v) => v + 1);
      }, []);

      /** 连续输入（改名、拖数值）合并成一条历史，避免每个字符一条。 */
      const pushHistoryCoalesced = useCallback((key) => {
        const now = Date.now();
        const last = textEditRef.current;
        if (last.key !== key || now - last.at > 700) pushHistory();
        textEditRef.current = { key, at: now };
      }, [pushHistory]);

      const applySnapshot = useCallback((snap) => {
        const prev = spritesRef.current;
        const next = snap.sprites;
        const { removed, dirty } = planRestoreDiff(prev, next);
        // 撤销掉一次「新增」，那些 id 要从库里删；撤销掉一次「删除」，它们要重新写回。
        for (const id of removed) {
          removedRef.current.add(id);
          dirtyRef.current.delete(id);
        }
        const nextIds = new Set(next.map((s) => s.id));
        for (const id of dirty) dirtyRef.current.add(id);
        for (const id of nextIds) removedRef.current.delete(id);
        setSprites(next);
        setSelection((snap.selection || []).filter((id) => nextIds.has(id)));
      }, []);

      const undo = useCallback(() => {
        const hst = historyRef.current;
        if (!hst.past.length) return;
        const snap = hst.past.pop();
        hst.future.push({ sprites: spritesRef.current, selection: selectionRef.current });
        applySnapshot(snap);
        textEditRef.current = { key: '', at: 0 };
        setHistVersion((v) => v + 1);
      }, [applySnapshot]);

      const redo = useCallback(() => {
        const hst = historyRef.current;
        if (!hst.future.length) return;
        const snap = hst.future.pop();
        hst.past.push({ sprites: spritesRef.current, selection: selectionRef.current });
        applySnapshot(snap);
        textEditRef.current = { key: '', at: 0 };
        setHistVersion((v) => v + 1);
      }, [applySnapshot]);

      // ── 视图 ───────────────────────────────────────────────────────────
      const toWorld = useCallback((clientX, clientY) => {
        const el = boardRef.current;
        const v = viewRef.current;
        const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
        return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
      }, []);

      const boundsOf = useCallback((list) => {
        if (!list.length) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const s of list) {
          const w = s.w * s.scale;
          const hh = s.h * s.scale;
          if (s.x < x0) x0 = s.x;
          if (s.y < y0) y0 = s.y;
          if (s.x + w > x1) x1 = s.x + w;
          if (s.y + hh > y1) y1 = s.y + hh;
        }
        return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
      }, []);

      const fitTo = useCallback((box) => {
        const el = boardRef.current;
        if (!el || !box) return;
        const W = el.clientWidth;
        const H = el.clientHeight;
        if (W < 40 || H < 40) return;
        const pad = 56;
        const zoom = clamp(Math.min((W - pad * 2) / box.w, (H - pad * 2) / box.h), MIN_ZOOM, 4);
        setView({
          zoom,
          x: (W - box.w * zoom) / 2 - box.x * zoom,
          y: (H - box.h * zoom) / 2 - box.y * zoom,
        });
      }, []);

      const zoomBy = useCallback((factor) => {
        const el = boardRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const px = r.width / 2;
        const py = r.height / 2;
        setView((v) => {
          const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
          const k = zoom / v.zoom;
          return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
        });
      }, []);

      // 滚轮：⌘/Ctrl + 滚 = 以光标为锚缩放；普通滚 = 平移。
      useEffect(() => {
        const el = boardRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            const r = el.getBoundingClientRect();
            const px = e.clientX - r.left;
            const py = e.clientY - r.top;
            const factor = Math.exp(-e.deltaY * 0.0022);
            setView((v) => {
              const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
              const k = zoom / v.zoom;
              return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
            });
          } else {
            setView((v) => ({
              ...v,
              x: v.x - (e.shiftKey ? e.deltaY : e.deltaX),
              y: v.y - (e.shiftKey ? 0 : e.deltaY),
            }));
          }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, []);

      // ── 导入 ───────────────────────────────────────────────────────────
      const importFiles = useCallback(async (files, at) => {
        // 有些系统的文件选择器不给 MIME（type 为空），所以后缀也认一遍。
        const isImage = (f) => /^image\//.test(f.type || '') || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(f.name || '');
        const list = Array.from(files || []).filter((f) => f && isImage(f));
        if (!list.length) {
          notify('只接受图片文件', 'error');
          return;
        }
        setBusy(`正在导入 ${list.length} 张…`);
        try {
          const added = [];
          let origin = at || null;
          if (!origin) {
            const box = boundsOf(spritesRef.current);
            origin = box ? { x: box.x, y: box.y + box.h + 48 } : { x: 0, y: 0 };
          }
          let z = nextZ();
          let cursorX = origin.x;
          const baseY = origin.y;
          for (const file of list) {
            const dataUrl = await fileToDataUrl(file);
            const img = await loadImage(dataUrl);
            const w = img.naturalWidth || img.width;
            const hh = img.naturalHeight || img.height;
            added.push({
              id: uid(),
              name: safeName(file.name.replace(/\.[^.]+$/, '')),
              dataUrl,
              w, h: hh,
              x: Math.round(cursorX),
              y: Math.round(baseY),
              scale: 1,
              opacity: 1,
              z: z++,
              pixelated: true,
              kind: 'image',
              meta: {},
            });
            cursorX += w + 28;
          }
          pushHistory();
          addSprites(added);
          setSelection(added.map((s) => s.id));
          const box = boundsOf(added);
          if (box) fitTo(box);
          notify(`已加入 ${added.length} 张`, 'success');
        } catch (err) {
          notify('导入失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, boundsOf, fitTo, nextZ, notify, pushHistory]);

      // 拖拽文件进画布
      const onDragOver = useCallback((e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }, []);
      const onDragLeave = useCallback((e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }, []);
      const onDrop = useCallback((e) => {
        e.preventDefault();
        setDragging(false);
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        const at = toWorld(e.clientX, e.clientY);
        importFiles(files, { x: Math.round(at.x), y: Math.round(at.y) });
      }, [importFiles, toWorld]);

      // 粘贴
      useEffect(() => {
        const onPaste = (e) => {
          const t = e.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          const items = e.clipboardData && e.clipboardData.files;
          if (!items || !items.length) return;
          e.preventDefault();
          const box = boundsOf(spritesRef.current);
          importFiles(items, box ? { x: box.x, y: box.y + box.h + 48 } : { x: 0, y: 0 });
        };
        window.addEventListener('paste', onPaste);
        return () => window.removeEventListener('paste', onPaste);
      }, [boundsOf, importFiles]);

      // ── 交互：拖动精灵 / 平移画布 ──────────────────────────────────────
      const startItemDrag = useCallback((ev, sp) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        ev.preventDefault();
        const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
        let ids = selectionRef.current;
        if (additive) {
          ids = ids.includes(sp.id) ? ids.filter((id) => id !== sp.id) : [...ids, sp.id];
          setSelection(ids);
          if (!ids.includes(sp.id)) return;
        } else if (!ids.includes(sp.id)) {
          ids = [sp.id];
          setSelection(ids);
        }
        const byId = new Map(spritesRef.current.map((s) => [s.id, s]));
        const moving = ids.map((id) => {
          const s = byId.get(id);
          return s ? { id, el: itemRefs.current.get(id), x: s.x, y: s.y } : null;
        }).filter(Boolean);
        const zoom = viewRef.current.zoom;
        const sx = ev.clientX;
        const sy = ev.clientY;
        let moved = false;
        const onMove = (e) => {
          const dx = (e.clientX - sx) / zoom;
          const dy = (e.clientY - sy) / zoom;
          if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 2) return;
          moved = true;
          for (const m of moving) {
            if (!m.el) continue;
            m.el.style.left = Math.round(m.x + dx) + 'px';
            m.el.style.top = Math.round(m.y + dy) + 'px';
          }
          // 预览层跟着被拖的那张 sheet 走：它不是 sheet 的子节点（要压在所有图层之上），
          // 所以没有继承关系可用，只能同步挪。
          const spot = overlayDragPosition(moving, sliceOwnerRef.current, dx, dy);
          if (spot && sliceOverlayRef.current) {
            sliceOverlayRef.current.style.left = spot.left + 'px';
            sliceOverlayRef.current.style.top = spot.top + 'px';
          }
        };
        const onUp = (e) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          if (!moved) return;
          const dx = (e.clientX - sx) / zoom;
          const dy = (e.clientY - sy) / zoom;
          const patch = new Map();
          for (const m of moving) patch.set(m.id, { x: Math.round(m.x + dx), y: Math.round(m.y + dy) });
          pushHistory();
          patchSprites(patch);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }, [patchSprites, pushHistory]);

      const onBoardPointerDown = useCallback((ev) => {
        const onEmpty = ev.target === boardRef.current || ev.target === worldRef.current;
        // 中键：压在图上也算拖画布（图自己的 pointerdown 对非左键直接让开）。
        if (boardPointerMode(ev.button, onEmpty) !== 'pan') return;
        ev.preventDefault();
        // 只有左键在空白处才是「取消选择」；中键平移不该动选择。
        if (ev.button === 0 && !(ev.shiftKey || ev.metaKey || ev.ctrlKey)) setSelection([]);
        const startX = ev.clientX;
        const startY = ev.clientY;
        const v = viewRef.current;
        let moved = false;
        const world = worldRef.current;
        const onMove = (e) => {
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          if (!moved) { moved = true; setPanning(true); }
          if (world) world.style.transform = `translate(${v.x + dx}px,${v.y + dy}px) scale(${v.zoom})`;
        };
        const onUp = (e) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          setPanning(false);
          if (!moved) return;
          setView({ zoom: v.zoom, x: v.x + (e.clientX - startX), y: v.y + (e.clientY - startY) });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }, []);

      // ── 键盘 ───────────────────────────────────────────────────────────
      useEffect(() => {
        const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        const onKey = (e) => {
          // 焦点在输入框里就交给输入框：否则改名时按 Delete 会把图删了。
          if (isTyping(e.target)) return;
          const action = resolveShortcut(e);
          if (!action) return;
          const sel = selectionRef.current;
          switch (action) {
            case 'undo':
              e.preventDefault();
              undo();
              return;
            case 'redo':
              e.preventDefault();
              redo();
              return;
            case 'select-all':
              e.preventDefault();
              setSelection(spritesRef.current.map((s) => s.id));
              return;
            case 'clear-selection':
              setSelection([]);
              setDetected(null);
              return;
            case 'delete':
              if (!sel.length) return;
              e.preventDefault();
              pushHistory();
              removeSprites(sel.slice());
              return;
            case 'duplicate': {
              if (!sel.length) return;
              e.preventDefault();
              const picked = spritesRef.current.filter((s) => sel.includes(s.id));
              const z = nextZ();
              const copies = picked.map((s, i) => ({ ...s, id: uid(), x: s.x + 24, y: s.y + 24, z: z + i, meta: {} }));
              pushHistory();
              addSprites(copies);
              setSelection(copies.map((s) => s.id));
              return;
            }
            case 'zoom-reset':
              e.preventDefault();
              zoomBy(1);
              return;
            case 'regen': {
              // 只有生成面板开着才占用空格，否则不拦（空格还能用来滚页面）
              const a = genActionsRef.current;
              if (sectionsRef.current.fx && a.fx) { e.preventDefault(); a.fx(); return; }
              if (sectionsRef.current.bg && a.bg) { e.preventDefault(); a.bg(); return; }
              return;
            }
            case 'reseed': {
              if (sectionsRef.current.fx) { setFx((o) => ({ ...o, seed: 1 + Math.floor(Math.random() * 999998) })); return; }
              if (sectionsRef.current.bg) { setBg((o) => ({ ...o, seed: 1 + Math.floor(Math.random() * 999998) })); return; }
              return;
            }
            default:
              return;
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [addSprites, nextZ, pushHistory, redo, removeSprites, undo, zoomBy]);

      // ── 切分：预览矩形 ─────────────────────────────────────────────────
      const sliceTarget = primary;
      const sliceTargetId = sliceTarget ? sliceTarget.id : null;

      /** 手动改过网格之后就不再自动推断 —— 用户的选择优先。 */
      const setGridManual = useCallback((fn) => {
        gridTouchedRef.current = true;
        setGridAuto(null);
        setActivePreset(null);
        presetStackRef.current.length = 0;
        setGrid(fn);
      }, []);

      /** 扫一遍像素，按内容反推网格。推断不出来就返回 null。 */
      const detectGrid = useCallback(async (sp) => {
        const img = await loadImage(sp.dataUrl);
        const data = readPixels(img);
        const rects = autoRects(data, {
          alphaMin: 12,
          mergeGap: 2,
          minArea: Math.max(16, Math.round(sp.w * sp.h * 0.0002)),
          uniform: false,
        });
        return guessGridFromRects(rects, sp.w, sp.h);
      }, []);

      const autoGuessGrid = useCallback(async () => {
        const sp = sliceTarget;
        if (!sp) return;
        setBusy('正在按内容推断网格…');
        try {
          const guess = await detectGrid(sp);
          gridGuessRef.current.set(sp.id, guess || null);
          if (guess) {
            gridTouchedRef.current = false;
            presetStackRef.current.length = 0;
            setActivePreset(null);
            setGrid((g) => ({ ...g, cols: guess.cols, rows: guess.rows }));
            setGridAuto(`${guess.cols}×${guess.rows}`);
            notify(`按内容推断：${guess.cols}×${guess.rows}`, 'success');
          } else {
            notify('这张图看不出网格：可能是整张单图，或背景不透明', 'error');
          }
        } catch (err) {
          notify('推断失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [detectGrid, notify, sliceTarget]);

      /** 套一个单元格尺寸预设：按图尺寸整除出行列（只存参数，不带任何素材）。 */
      const applyGridPreset = useCallback((preset) => {
        const sp = sliceTarget;
        if (!sp) { notify('先选中一张图', 'error'); return; }
        // 再点一下同一个 → 取消，并把网格恢复成点之前的样子
        if (presetToggle(activePreset, 'cell', preset.id)) {
          const prev = popPreset(presetStackRef.current);
          if (prev) {
            setGrid(prev.grid);
            setActivePreset(prev.preset);
          } else {
            setActivePreset(null);
          }
          setGridAuto(null);
          notify(prev ? '已取消预设，回到上一个' : '已取消预设');
          return;
        }
        const cell = preset.cell;
        const exact = sp.w % cell === 0 && sp.h % cell === 0;
        const cols = Math.max(1, Math.floor(sp.w / cell));
        const rows = Math.max(1, Math.floor(sp.h / cell));
        pushPreset(presetStackRef.current, { grid: { ...grid }, preset: activePreset });
        gridTouchedRef.current = true;
        setGridAuto(null);
        setGrid({ cols, rows, padX: 0, padY: 0, gapX: 0, gapY: 0 });
        setActivePreset({ kind: 'cell', id: preset.id });
        notify(
          exact
            ? `${preset.label}：${cols}×${rows}`
            : `${preset.label}：${sp.w}×${sp.h} 不是 ${cell} 的整数倍，按 ${cols}×${rows} 近似`,
          exact ? 'success' : 'info',
        );
      }, [activePreset, grid, notify, sliceTarget]);

      /**
       * 套一个 LPC 动作：固定 4 行（上/左/下/右）+ 行号偏移。
       * 整张通用表才需要偏移；只导出一个动作的表从第 0 行开始，所以按高度自动判断。
       */
      const applyLpcAction = useCallback((action) => {
        const sp = sliceTarget;
        if (!sp) { notify('先选中一张图', 'error'); return; }
        if (presetToggle(activePreset, 'lpc', action.id)) {
          const prev = popPreset(presetStackRef.current);
          if (prev) {
            setGrid(prev.grid);
            setActivePreset(prev.preset);
          } else {
            setActivePreset(null);
          }
          setGridAuto(null);
          notify(prev ? '已取消预设，回到上一个' : '已取消预设');
          return;
        }
        const cols = Math.max(1, Math.floor(sp.w / LPC_CELL));
        const fullSheet = sp.h >= (action.row + 4) * LPC_CELL;
        pushPreset(presetStackRef.current, { grid: { ...grid }, preset: activePreset });
        gridTouchedRef.current = true;
        setGridAuto(null);
        setGrid({ cols, rows: 4, padX: 0, padY: fullSheet ? action.row * LPC_CELL : 0, gapX: 0, gapY: 0 });
        setSliceDirs(true);
        setActivePreset({ kind: 'lpc', id: action.id });
        notify(
          fullSheet
            ? `LPC ${action.label}：第 ${action.row}–${action.row + 3} 行（上/左/下/右），空白格会自动跳过`
            : `LPC ${action.label}：按单动作表处理（4 行从 0 开始）`,
          'success',
        );
      }, [activePreset, grid, notify, sliceTarget]);

      // 换图就把网格重置回默认：**不跨图沿用参数**。
      // 否则「切完 4×4 的 sheet，再选一张单图」会带着 4×4 一起过去，等于变相记住了。
      useEffect(() => {
        if (!sliceTargetId || gridOwnerRef.current === sliceTargetId) return;
        gridOwnerRef.current = sliceTargetId;
        gridTouchedRef.current = false;
        presetStackRef.current.length = 0;
        setActivePreset(null);
        setGridAuto(null);
        setGrid((g) => ({ ...g, cols: 1, rows: 1, padX: 0, padY: 0, gapX: 0, gapY: 0 }));
      }, [sliceTargetId]);

      // 打开「切图」且仍是默认 1×1 时，按图内容推断一次网格。
      // 缓存的是「这张图的推断结果」，不是「上次用的网格」——换图不会带参数过去。
      useEffect(() => {
        if (!sections.slice) return undefined;
        const sp = sliceTarget;
        if (!sp || gridTouchedRef.current) return undefined;
        if (grid.cols !== 1 || grid.rows !== 1) return undefined;

        const cached = gridGuessRef.current.get(sp.id);
        if (cached !== undefined) {
          if (cached) {
            setGrid((g) => ({ ...g, cols: cached.cols, rows: cached.rows }));
            setGridAuto(`${cached.cols}×${cached.rows}`);
          }
          return undefined;
        }

        let alive = true;
        detectGrid(sp).then((guess) => {
          gridGuessRef.current.set(sp.id, guess || null);
          if (!alive || !guess) return;
          setGrid((g) => ({ ...g, cols: guess.cols, rows: guess.rows }));
          setGridAuto(`${guess.cols}×${guess.rows}`);
        }).catch(() => {
          gridGuessRef.current.set(sp.id, null);
        });
        return () => { alive = false; };
      }, [sections.slice, sliceTargetId, grid.cols, grid.rows, detectGrid]);

      const previewRects = useMemo(() => {        if (!sliceTarget) return [];
        if (sliceMode === 'grid') return gridRects(sliceTarget.w, sliceTarget.h, grid);
        if (sliceMode === 'scan') {
          if (!scanResult || scanResult.sheetId !== sliceTarget.id) return [];
          const out = [];
          scanResult.bands.forEach((band, i) => {
            if (scanOff.includes(i)) return;
            const n = scanCounts[i];
            const frames = n ? splitRowEven(band, n) : band.frames;
            frames.forEach((f, k) => out.push({ ...f, row: i, col: k }));
          });
          return out;
        }
        if (detected && detected.sheetId === sliceTarget.id) return detected.rects;
        return [];
      }, [sliceTarget, sliceMode, grid, detected, scanResult, scanOff, scanCounts]);

      // 结果预览：把整张图缩到面板宽度，再把每帧的框画上去。
      // 为什么不靠画布上的叠加层：那个层在缩小时会被隐藏（minCell < 5），
      // 而这里永远看得见，且能看到「整块切得对不对」。
      const previewRef = useRef(null);
      const previewKey = useMemo(
        () => previewRects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join('|'),
        [previewRects],
      );
      const previewCount = previewRects.length;

      useEffect(() => {
        const cv = previewRef.current;
        const sp = sliceTarget;
        if (!cv || !sp) return undefined;
        let alive = true;
        (async () => {
          try {
            const img = await loadImage(sp.dataUrl);
            if (!alive) return;
            const boxW = 268;
            const boxH = 180;
            const k = Math.min(boxW / sp.w, boxH / sp.h, 1);
            cv.width = Math.max(1, Math.round(sp.w * k));
            cv.height = Math.max(1, Math.round(sp.h * k));
            // 显式钉住显示尺寸：只给 max-width 的话，flex 布局有机会把它压扁。
            cv.style.width = cv.width + 'px';
            cv.style.height = cv.height + 'px';
            const g = ctx2d(cv);
            g.clearRect(0, 0, cv.width, cv.height);
            g.imageSmoothingEnabled = false;
            g.drawImage(img, 0, 0, cv.width, cv.height);
            if (previewCount > 0 && previewCount <= 3000) {
              g.lineWidth = 1;
              g.strokeStyle = 'rgba(59,130,246,0.95)';
              for (const r of previewRects) {
                g.strokeRect(Math.round(r.x * k) + 0.5, Math.round(r.y * k) + 0.5,
                  Math.max(1, Math.round(r.w * k) - 1), Math.max(1, Math.round(r.h * k) - 1));
              }
            }
          } catch (err) {
            // 画不出预览不影响切图本身
          }
        })();
        return () => { alive = false; };
        // previewKey 已经包含全部矩形信息，不用把数组放进依赖。
        // sliceMode 必须有：切模式时 canvas 是新建的 DOM 节点，不重画就是空白。
      }, [sliceTarget, previewKey, previewCount, sliceMode]);

      const detectFrames = useCallback(async () => {
        const sp = sliceTarget;
        if (!sp) return;
        setBusy('正在检测精灵边界…');
        try {
          const img = await loadImage(sp.dataUrl);
          const data = readPixels(img);
          const rects = autoRects(data, autoOpts);
          setDetected({ sheetId: sp.id, rects });
          if (!rects.length) notify('没检测到不透明像素，先抠掉背景再试', 'error');
          else notify(`检测到 ${rects.length} 个精灵`, 'success');
        } catch (err) {
          notify('检测失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [autoOpts, notify, sliceTarget]);

      /** 按行扫描：先切行带，再逐行切帧。手拼表的正确工具。 */
      const runScan = useCallback(async () => {
        const sp = sliceTarget;
        if (!sp) return;
        setBusy('正在扫描行…');
        try {
          const img = await loadImage(sp.dataUrl);
          const data = readPixels(img);
          const res = scanRows(data, scanOpts);
          const total = res.bands.reduce((n, b) => n + b.frames.length, 0);
          setScanResult({ sheetId: sp.id, bands: res.bands });
          setScanOff([]);
          setScanCounts({});
          if (!res.bands.length) notify('没扫到任何行，试试减小行间距', 'error');
          else notify(`扫到 ${res.bands.length} 行，共 ${total} 帧`, 'success');
        } catch (err) {
          notify('扫描失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [notify, scanOpts, sliceTarget]);

      const cropFrames = useCallback(async (sheet, rects, skipEmpty) => {
        const img = await loadImage(sheet.dataUrl);
        const canvas = makeCanvas(img.naturalWidth, img.naturalHeight);
        ctx2d(canvas).drawImage(img, 0, 0);
        const out = [];
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          const rect = {
            x: clamp(r.x, 0, sheet.w - 1),
            y: clamp(r.y, 0, sheet.h - 1),
            w: clamp(r.w, 1, sheet.w - clamp(r.x, 0, sheet.w - 1)),
            h: clamp(r.h, 1, sheet.h - clamp(r.y, 0, sheet.h - 1)),
          };
          const cell = cropCanvas(canvas, rect);
          let dataUrl = null;
          let w = rect.w;
          let hh = rect.h;
          if (sliceTrim) {
            const trimmed = trimAlpha(ctx2d(cell).getImageData(0, 0, rect.w, rect.h));
            if (trimmed) {
              const cut = cropCanvas(cell, trimmed);
              dataUrl = cut.toDataURL('image/png');
              w = trimmed.w;
              hh = trimmed.h;
            } else if (skipEmpty) {
              // 整格全透明 = 表里没有内容的那几列（比如 LPC 行走只占 9 列、表却有 13 列）。
              // 跳过它，别生成一堆空帧。
              out.push(null);
              continue;
            }
          }
          if (!dataUrl) dataUrl = cell.toDataURL('image/png');
          out.push({ dataUrl, w, h: hh });
        }
        return out;
      }, [sliceTrim]);

      /** 取消扫描：清掉结果，画布上的叠加层和预览一起消失。 */
      const cancelScan = useCallback(() => {
        setScanResult(null);
        setScanOff([]);
        setScanCounts({});
      }, []);

      /** 取消检测：同上。 */
      const cancelDetect = useCallback(() => {
        setDetected(null);
      }, []);

      /**
       * 切分。参数可以显式传，这样「一键切成帧」不必等 setState 生效就能直接切。
       * rects 默认取预览层那批；opts 默认取面板上的设置。
       */
      const runSlice = useCallback(async (rectsArg, optsArg) => {
        const sheet = sliceTarget;
        const rects = rectsArg || previewRects;
        const o = optsArg || {};
        const colsN = o.cols != null ? o.cols : grid.cols;
        const rowsN = o.rows != null ? o.rows : grid.rows;
        const dirs = o.dirs != null ? o.dirs : sliceDirs;
        const skipEmpty = o.skipEmpty != null ? o.skipEmpty : sliceSkipEmpty;
        const isScan = o.scan != null ? o.scan : sliceMode === 'scan';
        if (!sheet) { notify('先选中一张精灵图', 'error'); return; }
        if (!rects.length) { notify('当前参数切不出内容', 'error'); return; }
        setBusy(`正在切分 ${rects.length} 张…`);
        try {
          const raw = await cropFrames(sheet, rects, skipEmpty);
          // cropFrames 会把全透明的格子标成 null；位置要跟着原索引走，命名才不会错位。
          const frames = [];
          for (let i = 0; i < raw.length; i++) if (raw[i]) frames.push({ ...raw[i], index: i });
          if (!frames.length) { notify('切出来全是空的，检查一下行列或关掉「跳过空白格」', 'error'); return; }
          const n = frames.length;
          const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
          const maxW = Math.max(...frames.map((f) => f.w));
          const maxH = Math.max(...frames.map((f) => f.h));
          const gap = 12;
          const startX = sheet.x;
          const startY = sheet.y + sheet.h * sheet.scale + 48;
          let z = nextZ();
          const created = frames.map((f, i) => ({
            id: uid(),
            name: (() => {
              const rect = rects[f.index];
              if (isScan && rect && rect.row != null) {
                return `${sheet.name}_r${rect.row + 1}_${String((rect.col || 0) + 1).padStart(2, '0')}`;
              }
              return frameName(sheet.name, f.index, colsN, rowsN, dirs);
            })(),
            dataUrl: f.dataUrl,
            w: f.w,
            h: f.h,
            x: Math.round(startX + (i % cols) * (maxW + gap)),
            y: Math.round(startY + Math.floor(i / cols) * (maxH + gap)),
            scale: sheet.scale,
            opacity: 1,
            z: z++,
            pixelated: sheet.pixelated !== false,
            kind: 'slice',
            meta: { sourceId: sheet.id, index: f.index },
          }));
          pushHistory();
          addSprites(created);
          setSelection(created.map((s) => s.id));
          setDetected(null);
          fitTo(boundsOf(created) || null);
          notify(`已切出 ${created.length} 张`, 'success');
        } catch (err) {
          notify('切分失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, boundsOf, cropFrames, fitTo, grid.cols, grid.rows, nextZ, notify, previewRects, pushHistory, sliceDirs, sliceMode, sliceSkipEmpty, sliceTarget]);

      /**
       * 一键切成帧：对 LPC 那种「64px 一格、4 向、动作内还有空白列」的表，
       * 一次设好网格 + 四向命名 + 跳过空白 + 直接切，省掉手点五六下。
       */
      const oneClickSlice = useCallback(() => {
        const sp = sliceTarget;
        if (!sp) { notify('先选中一张精灵图', 'error'); return; }
        const cell = 64;
        const cols = Math.max(1, Math.floor(sp.w / cell));
        const rows = Math.max(1, Math.floor(sp.h / cell));
        const rects = gridRects(sp.w, sp.h, { cols, rows, padX: 0, padY: 0, gapX: 0, gapY: 0 });
        // 面板上的参数一并同步过去，用户切完还能接着手调
        gridTouchedRef.current = true;
        setGridAuto(null);
        setGrid({ cols, rows, padX: 0, padY: 0, gapX: 0, gapY: 0 });
        setSliceMode('grid');
        setSliceDirs(true);
        setSliceSkipEmpty(true);
        runSlice(rects, { cols, rows, dirs: true, skipEmpty: true, scan: false });
      }, [notify, runSlice, sliceTarget]);

      // ── 抠图 ───────────────────────────────────────────────────────────
      const effectiveColor = useMemo(() => {
        if (matteBgMode === 'custom') return parseHex(matteHex) || { r: 255, g: 255, b: 255 };
        return null;
      }, [matteBgMode, matteHex]);

      const resolveBg = useCallback(async (sp) => {
        if (effectiveColor) return effectiveColor;
        const img = await loadImage(sp.dataUrl);
        const data = readPixels(img);
        return dominantBorderColor(data) || { r: 255, g: 255, b: 255 };
      }, [effectiveColor]);

      // 选中换了 → 重新采样背景色 + 清预览
      useEffect(() => {
        setMattePreview(null);
        setMatteErr(null);
        if (!primary) return undefined;
        let alive = true;
        if (matteBgMode !== 'auto') return undefined;
        resolveBg(primary).then((c) => {
          if (alive && c) setMatteHex(hexOf(c));
        }).catch(() => {});
        return () => { alive = false; };
      }, [primary, matteBgMode, resolveBg]);

      // 参数变化 → 去抖重算预览（缩略图，保证跟手）
      useEffect(() => {
        const sp = primary;
        if (!sp) return undefined;
        let alive = true;
        const timer = setTimeout(async () => {
          try {
            const img = await loadImage(sp.dataUrl);
            const nw = img.naturalWidth || img.width;
            const nh = img.naturalHeight || img.height;
            const scale = Math.min(1, 300 / Math.max(nw, nh));
            const w = Math.max(1, Math.round(nw * scale));
            const hh = Math.max(1, Math.round(nh * scale));
            const base = makeCanvas(w, hh);
            const g = ctx2d(base);
            g.drawImage(img, 0, 0, w, hh);
            const beforeUrl = base.toDataURL('image/png');
            const data = g.getImageData(0, 0, w, hh);
            const color = effectiveColor || dominantBorderColor(data) || { r: 255, g: 255, b: 255 };
            applyMatte(data, { mode: matteMode, tol: matteTol, softness: matteSoft, color });
            const out = makeCanvas(w, hh);
            ctx2d(out).putImageData(data, 0, 0);
            const afterUrl = out.toDataURL('image/png');
            if (alive) {
              setMattePreview({ before: beforeUrl, after: afterUrl, scale, w, h: hh });
              setMatteErr(null);
            }
          } catch (err) {
            if (alive) setMatteErr(err && err.message ? err.message : String(err));
          }
        }, 160);
        return () => { alive = false; clearTimeout(timer); };
      }, [primary, matteMode, matteTol, matteSoft, effectiveColor, matteKeep]);

      const matteOne = useCallback(async (sp) => {
        const img = await loadImage(sp.dataUrl);
        const canvas = makeCanvas(img.naturalWidth, img.naturalHeight);
        const g = ctx2d(canvas);
        g.drawImage(img, 0, 0);
        const data = g.getImageData(0, 0, canvas.width, canvas.height);
        const color = effectiveColor || dominantBorderColor(data) || { r: 255, g: 255, b: 255 };
        applyMatte(data, { mode: matteMode, tol: matteTol, softness: matteSoft, color });
        g.putImageData(data, 0, 0);
        let rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
        if (matteTrim) {
          const trimmed = trimAlpha(data);
          if (trimmed) rect = trimmed;
        }
        const out = cropCanvas(canvas, rect);
        return { dataUrl: out.toDataURL('image/png'), w: rect.w, h: rect.h, dx: rect.x, dy: rect.y, color };
      }, [effectiveColor, matteMode, matteSoft, matteTol, matteTrim]);

      const runMatte = useCallback(async (targets) => {
        const list = targets && targets.length ? targets : selectedSprites;
        if (!list.length) { notify('先选中精灵图', 'error'); return; }
        setBusy(`正在抠图 ${list.length} 张…`);
        try {
          const patch = new Map();
          const extras = [];
          let z = nextZ();
          for (const sp of list) {
            const res = await matteOne(sp);
            if (matteKeep) {
              // 原图整份留在抠图结果左侧，位置按它自己的显示宽度算。
              extras.push({
                ...sp,
                id: uid(),
                name: sp.name + '_orig',
                x: Math.round(sp.x - sp.w * sp.scale - 16),
                y: sp.y,
                z: z++,
              });
            }
            patch.set(sp.id, {
              dataUrl: res.dataUrl,
              w: res.w,
              h: res.h,
              x: sp.x + res.dx * sp.scale,
              y: sp.y + res.dy * sp.scale,
            });
          }
          pushHistory();
          patchSprites(patch);
          if (extras.length) addSprites(extras);
          notify(`已抠图 ${list.length} 张`, 'success');
          setMattePreview(null);
        } catch (err) {
          notify('抠图失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, matteKeep, matteOne, nextZ, notify, patchSprites, pushHistory, selectedSprites]);

      // 一键：智能抠图 → 自动检测 → 切分
      const runPipeline = useCallback(async () => {
        const sheet = sliceTarget;
        if (!sheet) { notify('先选中一张精灵图', 'error'); return; }
        setBusy('一键处理中…');
        try {
          const img = await loadImage(sheet.dataUrl);
          const canvas = makeCanvas(img.naturalWidth, img.naturalHeight);
          const g = ctx2d(canvas);
          g.drawImage(img, 0, 0);
          const data = g.getImageData(0, 0, canvas.width, canvas.height);
          const color = dominantBorderColor(data);
          if (color) applyMatte(data, { mode: 'border', tol: Math.max(18, matteTol), softness: matteSoft, color });
          g.putImageData(data, 0, 0);
          const trimmed = trimAlpha(data);
          const rect = trimmed || { x: 0, y: 0, w: canvas.width, h: canvas.height };
          const cut = cropCanvas(canvas, rect);
          const sheetUrl = cut.toDataURL('image/png');
          const rects = autoRects(g.getImageData(rect.x, rect.y, rect.w, rect.h), autoOpts);
          if (!rects.length) { notify('没检测到精灵，可能背景色太杂', 'error'); return; }
          const sheetSprite = { ...sheet, dataUrl: sheetUrl, w: rect.w, h: rect.h };
          pushHistory();
          patchSprites(new Map([[sheet.id, sheetSprite]]));

          const frames = await cropFrames(sheetSprite, rects);
          const n = frames.length;
          const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
          const maxW = Math.max(...frames.map((f) => f.w));
          const maxH = Math.max(...frames.map((f) => f.h));
          const gap = 12;
          const startX = sheet.x;
          const startY = sheet.y + sheetSprite.h * sheet.scale + 48;
          let z = nextZ();
          const created = frames.map((f, i) => ({
            id: uid(),
            name: `${sheet.name}_${String(i + 1).padStart(2, '0')}`,
            dataUrl: f.dataUrl,
            w: f.w,
            h: f.h,
            x: Math.round(startX + (i % cols) * (maxW + gap)),
            y: Math.round(startY + Math.floor(i / cols) * (maxH + gap)),
            scale: sheet.scale,
            opacity: 1,
            z: z++,
            pixelated: sheet.pixelated !== false,
            kind: 'slice',
            meta: { sourceId: sheet.id, index: i },
          }));
          addSprites(created);
          setSelection(created.map((s) => s.id));
          fitTo(boundsOf(created) || null);
          notify(`抠图 + 切分完成：${created.length} 张`, 'success');
        } catch (err) {
          notify('一键处理失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, autoOpts, boundsOf, cropFrames, fitTo, matteSoft, matteTol, nextZ, notify, patchSprites, pushHistory, sliceTarget]);

      // 吸管取色：把预览图上的点击换算回原图坐标
      const pickColor = useCallback(async (ev) => {
        const sp = primary;
        if (!sp || !mattePreview) return;
        const el = ev.currentTarget;
        const r = el.getBoundingClientRect();
        const px = clamp((ev.clientX - r.left) / r.width, 0, 0.999);
        const py = clamp((ev.clientY - r.top) / r.height, 0, 0.999);
        try {
          const img = await loadImage(sp.dataUrl);
          const nw = img.naturalWidth || img.width;
          const nh = img.naturalHeight || img.height;
          const c = makeCanvas(nw, nh);
          const g = ctx2d(c);
          g.drawImage(img, 0, 0);
          const d = g.getImageData(Math.floor(px * nw), Math.floor(py * nh), 1, 1).data;
          const color = { r: d[0], g: d[1], b: d[2] };
          setMatteBgMode('custom');
          setMatteHex(hexOf(color));
          setPicking(false);
        } catch (err) {
          setPicking(false);
        }
      }, [mattePreview, primary]);

      // ── 背景生成 ───────────────────────────────────────────────────────
      /**
       * 参数 → PNG dataURL。
       *
       * 关键：先在**逻辑像素**网格上算（`cell` 个真实像素 = 1 个逻辑像素），
       * 再用最近邻整体放大。像素画是在 32×32 上画的、放大 4 倍给人看；
       * 在 128×128 上逐像素决策，色块边界就会碎成一粒一粒（这就是「散落感」的来源）。
       * 抖动也落在逻辑格上，于是它是有意的网点，而不是满屏噪点。
       */
      const bgRender = useCallback((opt) => {
        const cell = clamp(Math.round(opt.cell) || 1, 1, 16);
        const lw = Math.max(1, Math.round(opt.w / cell));
        const lh = Math.max(1, Math.round(opt.h / cell));
        const outW = lw * cell;
        const outH = lh * cell;
        const dark = parseHex(opt.dark) || { r: 0, g: 0, b: 0 };
        const light = parseHex(opt.light) || { r: 255, g: 255, b: 255 };
        const [rx, ry] = parseStretch(opt.stretch);
        const periodX = Math.max(1, Math.round((Number(opt.period) || 3) / rx));
        const periodY = Math.max(1, Math.round((Number(opt.period) || 3) / ry));

        const f1 = periodicFbm(lw, lh, {
          periodX,
          periodY,
          octaves: opt.octaves,
          seed: opt.seed,
        });
        let field = f1;
        let f2 = null;
        if (opt.layer2) {
          f2 = periodicFbm(lw, lh, {
            periodX: Math.max(1, Math.round((Number(opt.p2Period) || 5) / rx)),
            periodY: Math.max(1, Math.round((Number(opt.p2Period) || 5) / ry)),
            octaves: opt.p2Octaves,
            seed: opt.p2Seed,
          });
          field = blendFields(f1, f2, opt.blend);
        }
        field = postProcess(field, {
          invert: opt.invert,
          contrast: opt.contrast,
          gamma: opt.gamma,
          autoLevels: opt.autoLevels,
        });
        if (opt.warp > 0) {
          field = warpField(field, lw, lh, { amount: opt.warp, period: 3, seed: opt.seed });
        }

        let rgba;
        if (opt.pack && f2) {
          // 通道打包：R/G/B = 三层灰度，A = 不透明。这种图肉眼看是花的，是给引擎当数据用的。
          rgba = packChannels(f1, f2, field, null);
        } else {
          const stops = gradientStops(resolveBgStops(opt));
          rgba = colorizeTexture(field, lw, lh, {
            levels: opt.levels,
            dither: opt.dither,
            stops,
            dark,
            light,
          });
        }

        const small = makeCanvas(lw, lh);
        ctx2d(small).putImageData(new ImageData(rgba, lw, lh), 0, 0);
        const canvas = makeCanvas(outW, outH);
        const g = ctx2d(canvas);
        g.imageSmoothingEnabled = false;
        g.drawImage(small, 0, 0, lw, lh, 0, 0, outW, outH);
        return { dataUrl: canvas.toDataURL('image/png'), w: outW, h: outH, cell, lw, lh };
      }, []);

      // 参数一动就重算缩略图（去抖），拖滑块时不会卡
      useEffect(() => {
        let alive = true;
        const timer = setTimeout(() => {
          try {
            const res = bgRender(bg);
            if (alive) setBgPreview(res.dataUrl);
          } catch (err) {
            if (alive) setBgPreview(null);
          }
        }, 130);
        return () => { alive = false; clearTimeout(timer); };
      }, [bg, bgRender]);

      const generateBg = useCallback(() => {
        setBusy('正在生成背景…');
        try {
          const res = bgRender(bg);
          const box = boundsOf(spritesRef.current);
          const sprite = {
            id: uid(),
            name: `bg_${res.w}x${res.h}_${bg.seed}`,
            dataUrl: res.dataUrl,
            w: res.w,
            h: res.h,
            x: box ? Math.round(box.x) : 0,
            y: box ? Math.round(box.y + box.h + 48) : 0,
            scale: 1,
            opacity: 1,
            z: nextZ(),
            pixelated: true,
            kind: 'image',
            meta: { generated: 'noise', cell: res.cell },
          };
          pushHistory();
          addSprites([sprite]);
          setSelection([sprite.id]);
          fitTo(boundsOf([sprite]));
          notify(`已生成 ${res.w}×${res.h}（逻辑 ${res.lw}×${res.lh}）`, 'success');
        } catch (err) {
          notify('生成失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, bg, bgRender, boundsOf, fitTo, nextZ, notify, pushHistory]);

      // ── 导出 ───────────────────────────────────────────────────────────
      /** scope: 'selection' | 'all' */
      const pickScope = useCallback((scope) => {
        if (scope === 'all') return sprites;
        return selectedSprites.length ? selectedSprites : sprites;
      }, [selectedSprites, sprites]);

      const buildZip = useCallback((list) => {
        const used = new Set();
        const entries = [];
        const items = [];
        for (const sp of list) {
          const base = safeName(sp.name) || 'sprite';
          let name = base + '.png';
          let n = 2;
          while (used.has(name.toLowerCase())) name = `${base}-${n++}.png`;
          used.add(name.toLowerCase());
          entries.push({ name, bytes: dataUrlBytes(sp.dataUrl) });
          items.push({
            name,
            width: sp.w,
            height: sp.h,
            x: Math.round(sp.x),
            y: Math.round(sp.y),
            scale: sp.scale,
          });
        }
        const manifest = {
          generator: 'dsh-sprite-studio',
          schema: 'dsh-sprite-studio/manifest/1',
          exportedAt: new Date().toISOString(),
          count: items.length,
          items,
        };
        entries.push({
          name: 'manifest.json',
          bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        });
        return makeZip(entries);
      }, []);

      /** 一次下载一个 ZIP —— 逐张下载会撞上浏览器的「多文件下载」拦截。 */
      /** 导出倍率：按最近邻放大像素，引擎里再缩回去画质更好。k=1 时原样返回。 */
      const upscaleForExport = useCallback(async (list, k) => {
        if (k === 1) return list;
        return Promise.all(list.map(async (sp) => {
          const img = await loadImage(sp.dataUrl);
          const w = Math.max(1, sp.w * k);
          const hh = Math.max(1, sp.h * k);
          const cv = makeCanvas(w, hh);
          const g = ctx2d(cv);
          g.imageSmoothingEnabled = false;
          g.drawImage(img, 0, 0, w, hh);
          return { ...sp, dataUrl: cv.toDataURL('image/png'), w, h: hh };
        }));
      }, []);

      const exportZip = useCallback(async (scope) => {
        const raw = pickScope(scope || (selectionRef.current.length ? 'selection' : 'all'));
        if (!raw.length) { notify('没有可导出的精灵', 'error'); return; }
        setBusy(`正在打包 ${raw.length} 张…`);
        try {
          const list = await upscaleForExport(raw, exportScale);
          const zip = buildZip(list);
          const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
          download(`sprite-studio-${fileStamp()}.zip`, url, true);
          notify(`已导出 ${list.length} 张（ZIP${exportScale > 1 ? ` ×${exportScale}` : ''}）`, 'success');
        } catch (err) {
          notify('导出失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [buildZip, exportScale, notify, pickScope, upscaleForExport]);

      /**
       * 打包图集：装箱 → 画到一张画布 → 导出 ZIP（atlas.png + atlas.json）。
       * 用引擎认的 Aseprite 字段，而不是自己发明一套。
       */
      const packAtlas = useCallback(async (scope) => {
        const list = pickScope(scope || (selectionRef.current.length ? 'selection' : 'all'));
        if (!list.length) { notify('没有可打包的精灵', 'error'); return; }
        setBusy(`正在打包 ${list.length} 张…`);
        try {
          const used = new Set();
          const items = list.map((sp) => {
            const base = safeName(sp.name) || 'sprite';
            let name = base + '.png';
            let n = 2;
            while (used.has(name.toLowerCase())) name = `${base}-${n++}.png`;
            used.add(name.toLowerCase());
            return { name, w: sp.w, h: sp.h, dataUrl: sp.dataUrl };
          });
          const packed = packRects(items, {
            padding: atlasPadding,
            maxSize: atlasMax,
            pot: atlasPot,
          });
          if (!packed) {
            notify(`装不下：${atlasMax}px 上限放不下 ${items.length} 张，调大上限或减小间距`, 'error');
            return;
          }
          const pivot = atlasPivot === 'bottom'
            ? { x: 0.5, y: 1 }
            : atlasPivot === 'topleft' ? { x: 0, y: 0 } : { x: 0.5, y: 0.5 };
          const canvas = makeCanvas(packed.width, packed.height);
          const g = ctx2d(canvas);
          for (const p of packed.placed) {
            const img = await loadImage(items[p.index].dataUrl);
            g.drawImage(img, p.x, p.y, p.w, p.h);
          }
          const png = canvas.toDataURL('image/png');
          const json = buildAtlasJson(packed.placed, items, {
            pivot,
            width: packed.width,
            height: packed.height,
            image: 'atlas.png',
          });
          const zip = makeZip([
            { name: 'atlas.png', bytes: dataUrlBytes(png) },
            { name: 'atlas.json', bytes: new TextEncoder().encode(JSON.stringify(json, null, 2)) },
          ]);
          const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
          download(`atlas-${fileStamp()}.zip`, url, true);
          notify(`图集 ${packed.width}×${packed.height}，${items.length} 张`, 'success');
        } catch (err) {
          notify('打包失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [atlasMax, atlasPadding, atlasPivot, atlasPot, notify, pickScope]);

      const exportEachPng = useCallback((scope) => {
        const list = pickScope(scope);
        if (!list.length) { notify('没有可导出的精灵', 'error'); return; }
        if (list.length > 12 && !window.confirm(`逐张下载 ${list.length} 个文件，浏览器可能只放行前几个。改用 ZIP 打包更稳，仍要继续吗？`)) return;
        list.forEach((sp, i) => {
          setTimeout(() => download(safeName(sp.name) + '.png', sp.dataUrl), i * 160);
        });
        notify(`开始逐张下载 ${list.length} 张`, 'success');
      }, [notify, pickScope]);

      const exportProject = useCallback(() => {
        if (!sprites.length) return;
        const payload = {
          schema: 'dsh-sprite-studio/1',
          savedAt: new Date().toISOString(),
          view,
          sprites,
        };
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        download(`sprite-studio-${new Date().toISOString().slice(0, 10)}.json`, url, true);
        notify('工程已导出', 'success');
      }, [notify, sprites, view]);

      const importProject = useCallback(async (file) => {
        if (!file) return;
        setBusy('正在导入工程…');
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          const rows = Array.isArray(data && data.sprites) ? data.sprites : [];
          const incoming = rows
            .filter((s) => s && s.dataUrl && s.w && s.h)
            .map((s, i) => ({
              ...s,
              id: uid(),
              z: nextZ() + i,
              scale: Number(s.scale) || 1,
              opacity: Number.isFinite(s.opacity) ? s.opacity : 1,
            }));
          if (!incoming.length) { notify('工程里没有精灵', 'error'); return; }
          pushHistory();
          addSprites(incoming);
          setSelection(incoming.map((s) => s.id));
          fitTo(boundsOf(incoming) || null);
          notify(`已导入 ${incoming.length} 个精灵`, 'success');
        } catch (err) {
          notify('导入工程失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, boundsOf, fitTo, nextZ, notify, pushHistory]);

      const clearBoard = useCallback(() => {
        if (!sprites.length) return;
        if (!window.confirm(`清空画布上的 ${sprites.length} 个精灵？（可以用 Ctrl+Z 撤销）`)) return;
        pushHistory();
        removeSprites(sprites.map((s) => s.id));
        setDetected(null);
        notify('画布已清空，Ctrl+Z 可撤销');
      }, [notify, pushHistory, removeSprites, sprites]);

      // ── 渲染 ───────────────────────────────────────────────────────────
      const zoomPct = Math.round(view.zoom * 100);
      // 这里读 ref 而不是 state：setHistVersion 只负责把重渲染叫醒，计数永远读最新的栈。
      const undoCount = historyRef.current.past.length;
      const redoCount = historyRef.current.future.length;
      const canUndo = undoCount > 0;
      const canRedo = redoCount > 0;

      // 选中环的线宽按缩放补偿：世界层被 scale(zoom) 缩放，写死 1.5px 会在缩小后消失。
      // 但同样要设下限 —— 放大到 4 倍时 1.5/4 = 0.375px 会掉成亚像素被浏览器丢掉。
      const ringW = Math.max(1.5 / view.zoom, 0.55);
      const haloW = Math.max(3.5 / view.zoom, 1.3);
      const handleSize = Math.max(6 / view.zoom, 1.2);
      const handleBorder = Math.max(1 / view.zoom, 0.35);
      const handleOff = -handleSize / 2;
      const primaryId = selection[0] || null;

      const itemNodes = sprites.map((sp) => {
        const isSelected = selection.includes(sp.id);
        const dispW = Math.max(1, sp.w * sp.scale) * view.zoom;
        const dispH = Math.max(1, sp.h * sp.scale) * view.zoom;
        // 图在屏幕上太小时不画手柄，否则四个 6px 方块会把整张图糊住
        const showHandles = isSelected && sp.id === primaryId && dispW >= 14 && dispH >= 14;
        return h('div', {
          key: sp.id,
          className: 'ss-item',
          'data-id': sp.id,
          'data-selected': isSelected ? 'true' : undefined,
          style: {
            left: sp.x + 'px',
            top: sp.y + 'px',
            width: Math.max(1, sp.w * sp.scale) + 'px',
            height: Math.max(1, sp.h * sp.scale) + 'px',
            // 不抬 z-index：切分预览层是 max(z)+10，抬了会把网格盖住。环被别的图压住就压住吧。
            zIndex: sp.z || 1,
            // 双色环：白内圈在任何彩色图上都有对比，品牌色外圈在白底上也看得见
            boxShadow: isSelected
              ? `0 0 0 ${ringW}px #fff, 0 0 0 ${haloW}px var(--dsw-alias-brand-primary)`
              : undefined,
          },
          onPointerDown: (ev) => startItemDrag(ev, sp),
          onDoubleClick: () => { setSelection([sp.id]); },
          title: `${sp.name}  ${fmtSize(sp.w, sp.h)}`,
          ref: (el) => {
            if (el) itemRefs.current.set(sp.id, el);
            else itemRefs.current.delete(sp.id);
          },
        },
          h('img', {
            src: sp.dataUrl,
            alt: sp.name,
            draggable: false,
            style: {
              opacity: Number.isFinite(sp.opacity) ? sp.opacity : 1,
              imageRendering: sp.pixelated === false ? 'auto' : 'pixelated',
            },
          }),
          // 四角手柄只在主选中项上画，多选时不至于糊成一片方块
          showHandles
            ? [-1, 1].map((sx) => [-1, 1].map((sy) => h('span', {
              key: `h${sx}${sy}`,
              className: 'ss-handle',
              style: {
                width: handleSize + 'px',
                height: handleSize + 'px',
                borderWidth: handleBorder + 'px',
                left: sx < 0 ? handleOff + 'px' : `calc(100% + ${handleOff}px)`,
                top: sy < 0 ? handleOff + 'px' : `calc(100% + ${handleOff}px)`,
              },
            })))
            : null,
        );
      });

      // 切分预览层要压在精灵之上：图层的 z-index 是 1..n，这层取 max(z)+10。
      // 之前漏了这层 z-index，网格线被图片盖住，看起来像「没有预览」。
      const topZ = sprites.reduce((m, s) => Math.max(m, s.z || 0), 0);
      // 切完之后选中的是一堆小图，再在上面叠 4×4 网格只会糊成一片 —— 格子小到看不清就不画。
      const minCell = previewRects.length
        ? Math.min(...previewRects.map((r) => Math.min(r.w, r.h))) * (sliceTarget ? sliceTarget.scale : 1) * view.zoom
        : 0;
      const showSliceOverlay = !!(sliceTarget && previewRects.length && minCell >= 5);
      // 拖拽期间用这个拿到「预览层跟着谁走」（只需要 id：起点坐标从被拖项本身取）。
      sliceOwnerRef.current = showSliceOverlay ? sliceTarget.id : null;
      const sliceOverlay = showSliceOverlay
        ? h('div', {
          className: 'ss-slice',
          ref: sliceOverlayRef,
          style: {
            left: sliceTarget.x + 'px',
            top: sliceTarget.y + 'px',
            width: sliceTarget.w * sliceTarget.scale + 'px',
            height: sliceTarget.h * sliceTarget.scale + 'px',
            zIndex: topZ + 10,
          },
        },
          previewRects.map((r, i) => {
            const cw = r.w * sliceTarget.scale;
            const ch = r.h * sliceTarget.scale;
            // 只在格子够大时标序号，否则字会糊成一坨。
            const showIdx = cw * view.zoom > 36 && ch * view.zoom > 26;
            // 1/zoom 能让线宽在屏幕上恒定，但放大到 2 倍以上就变成 0.5px、0.25px ——
            // 浏览器会把这些亚像素边框直接丢掉，看起来就是「放大后网格消失」。
            // 所以给世界坐标下的线宽和字号都设下限。
            const borderWorld = Math.max(1.4 / view.zoom, 0.55);
            const fontWorld = Math.max(11 / view.zoom, 1.3);
            return h('div', {
              key: 'c' + i,
              className: 'ss-slice-cell',
              style: {
                left: r.x * sliceTarget.scale + 'px',
                top: r.y * sliceTarget.scale + 'px',
                width: cw + 'px',
                height: ch + 'px',
                borderWidth: borderWorld + 'px',
              },
            },
              showIdx
                ? h('span', {
                  className: 'ss-slice-idx',
                  style: {
                    fontSize: fontWorld + 'px',
                    padding: `0 ${Math.max(4 / view.zoom, 0.6)}px`,
                    borderRadius: (3 / view.zoom) + 'px',
                  },
                }, String(i + 1))
                : null,
            );
          }),
        )
        : null;

      const emptyState = sprites.length === 0
        ? h('div', { className: 'ss-empty' },
          h('div', { className: 'ss-empty-mark' },
            h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' },
              h('rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.6 }),
              h('rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.6 }),
              h('rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.6 }),
              h('path', { d: 'M14 17h6M17 14v6', strokeLinecap: 'round' }),
            ),
          ),
          h('h2', null, '把精灵图拖进来'),
          h('p', null,
            '松手即存进本地画布（IndexedDB）。也可以 ',
            h('span', { className: 'ss-kbd' }, 'Ctrl'),
            ' + ',
            h('span', { className: 'ss-kbd' }, 'V'),
            ' 粘贴剪贴板里刚复制的那张图。',
          ),
          h('p', null, '进来之后：选中 → 右侧「切图」切成一张张小图，或「抠图」去背景。'),
        )
        : null;

      // —— 右侧检查器 ——
      /**
       * 变换：翻转/旋转。
       * **原地替换像素**（保留 id / 层级 / 选中）而不是造一张新的 —— 造新的会打乱层序，
       * 撤销也变两步。
       */
      const transformSelection = useCallback(async (op) => {
        const ids = selectionRef.current.slice();
        const picked = spritesRef.current.filter((s) => ids.includes(s.id));
        if (!picked.length) return;
        pushHistory();
        const patch = new Map();
        try {
          for (const sp of picked) {
            // eslint-disable-next-line no-await-in-loop
            const img = await loadImage(sp.dataUrl);
            const size = transformedSize(sp.w, sp.h, op);
            const cv = makeCanvas(size.w, size.h);
            const g = ctx2d(cv);
            g.imageSmoothingEnabled = false;
            if (op === 'flip-x') { g.translate(size.w, 0); g.scale(-1, 1); }
            else if (op === 'flip-y') { g.translate(0, size.h); g.scale(1, -1); }
            else if (op === 'rotate-cw') { g.translate(size.w, 0); g.rotate(Math.PI / 2); }
            else if (op === 'rotate-ccw') { g.translate(0, size.h); g.rotate(-Math.PI / 2); }
            g.drawImage(img, 0, 0);
            patch.set(sp.id, { dataUrl: cv.toDataURL('image/png'), w: size.w, h: size.h });
          }
          patchSprites(patch);
          notify(`已变换 ${picked.length} 张`, 'success');
        } catch (err) {
          notify('变换失败：' + (err && err.message ? err.message : err), 'error');
        }
      }, [notify, patchSprites, pushHistory]);

      /** 缩放到 2 倍 / 1/2（最近邻，像素不糊）。 */
      const scaleSelection = useCallback(async (factor) => {
        const ids = selectionRef.current.slice();
        const picked = spritesRef.current.filter((s) => ids.includes(s.id));
        if (!picked.length) return;
        pushHistory();
        const patch = new Map();
        try {
          for (const sp of picked) {
            // eslint-disable-next-line no-await-in-loop
            const img = await loadImage(sp.dataUrl);
            const w = Math.max(1, Math.round(sp.w * factor));
            const hh = Math.max(1, Math.round(sp.h * factor));
            const cv = makeCanvas(w, hh);
            const g = ctx2d(cv);
            g.imageSmoothingEnabled = false;
            g.drawImage(img, 0, 0, w, hh);
            patch.set(sp.id, { dataUrl: cv.toDataURL('image/png'), w, h: hh });
          }
          patchSprites(patch);
          notify(`已${factor > 1 ? '放大' : '缩小'}到 ${Math.round(factor * 100)}%`, 'success');
        } catch (err) {
          notify('缩放失败：' + (err && err.message ? err.message : err), 'error');
        }
      }, [notify, patchSprites, pushHistory]);

      /** 裁掉四周全透明的边。 */
      const trimSelection = useCallback(async () => {
        const ids = selectionRef.current.slice();
        const picked = spritesRef.current.filter((s) => ids.includes(s.id));
        if (!picked.length) return;
        pushHistory();
        const patch = new Map();
        let trimmed = 0;
        try {
          for (const sp of picked) {
            // eslint-disable-next-line no-await-in-loop
            const img = await loadImage(sp.dataUrl);
            const cv = makeCanvas(sp.w, sp.h);
            const g = ctx2d(cv);
            g.drawImage(img, 0, 0);
            const bbox = trimAlpha(ctx2d(cv).getImageData(0, 0, sp.w, sp.h));
            if (!bbox) continue;
            if (bbox.w === sp.w && bbox.h === sp.h) continue;
            const out = makeCanvas(bbox.w, bbox.h);
            const og = ctx2d(out);
            og.imageSmoothingEnabled = false;
            og.drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
            patch.set(sp.id, { dataUrl: out.toDataURL('image/png'), w: bbox.w, h: bbox.h });
            trimmed++;
          }
          if (!patch.size) { notify('这几张四周没有透明边', 'info'); return; }
          patchSprites(patch);
          notify(`已裁掉透明边：${trimmed} 张`, 'success');
        } catch (err) {
          notify('裁剪失败：' + (err && err.message ? err.message : err), 'error');
        }
      }, [notify, patchSprites, pushHistory]);

      /**
       * 调色。**从「调色前的底图」重算**，不是在上一次结果上叠加 ——
       * 否则拖动滑块会越调越怪，撤销也追不回来。
       */
      const applyTint = useCallback(async () => {
        const ids = selectionRef.current.slice();
        const picked = spritesRef.current.filter((s) => ids.includes(s.id));
        if (!picked.length) return;
        pushHistory();
        const patch = new Map();
        try {
          for (const sp of picked) {
            const base = tintBaseRef.current.get(sp.id) || sp.dataUrl;
            // eslint-disable-next-line no-await-in-loop
            const img = await loadImage(base);
            const cv = makeCanvas(sp.w, sp.h);
            const g = ctx2d(cv);
            g.imageSmoothingEnabled = false;
            g.drawImage(img, 0, 0, sp.w, sp.h);
            const data = g.getImageData(0, 0, sp.w, sp.h);
            const px = data.data;
            for (let i = 0; i < px.length; i += 4) {
              if (px[i + 3] === 0) continue;         // 透明像素跳过
              const out = shiftPixel(px[i], px[i + 1], px[i + 2], tint);
              px[i] = out[0];
              px[i + 1] = out[1];
              px[i + 2] = out[2];
            }
            g.putImageData(data, 0, 0);
            if (!tintBaseRef.current.has(sp.id)) tintBaseRef.current.set(sp.id, base);
            patch.set(sp.id, { dataUrl: cv.toDataURL('image/png') });
          }
          patchSprites(patch);
          notify(`已调色 ${picked.length} 张`, 'success');
        } catch (err) {
          notify('调色失败：' + (err && err.message ? err.message : err), 'error');
        }
      }, [notify, patchSprites, pushHistory, tint]);

      /** 还原到调色前的底图。 */
      const resetTint = useCallback(() => {
        const ids = selectionRef.current.slice();
        const patch = new Map();
        for (const id of ids) {
          const base = tintBaseRef.current.get(id);
          if (!base) continue;
          patch.set(id, { dataUrl: base });
          tintBaseRef.current.delete(id);
        }
        if (!patch.size) { notify('这些没有调过色', 'info'); return; }
        pushHistory();
        patchSprites(patch);
        notify(`已还原 ${patch.size} 张`, 'success');
      }, [notify, patchSprites, pushHistory]);

      const applyAlign = useCallback((mode) => {        const ids = selectionRef.current.slice();
        const picked = spritesRef.current.filter((s) => ids.includes(s.id));
        const moves = alignSprites(picked, mode);
        if (!moves.size) return;
        pushHistory();
        patchSprites(moves);
      }, [patchSprites, pushHistory]);

      const applyDistribute = useCallback((axis) => {
        const ids = selectionRef.current.slice();
        const picked = spritesRef.current.filter((s) => ids.includes(s.id));
        const moves = distributeSprites(picked, axis);
        if (!moves.size) { notify('等距分布至少要选中 3 个', 'info'); return; }
        pushHistory();
        patchSprites(moves);
      }, [notify, patchSprites, pushHistory]);


      const spriteSection = h(Section, {
        title: '选中项',
        aside: primary ? (selectedSprites.length > 1 ? `${selectedSprites.length} 个` : fmtSize(primary.w, primary.h)) : null,
        id: 'sprite',
        open: sections.sprite,
        onToggle: () => toggleSection('sprite'),
      },
        primary
          ? [
            h(Field, { key: 'n', label: '名称' },
              h('input', {
                className: 'ss-input',
                value: primary.name,
                onChange: (e) => {
                  pushHistoryCoalesced('name:' + primary.id);
                  patchSprites(new Map([[primary.id, { name: e.target.value }]]));
                },
              }),
            ),
            h('div', { key: 'tf', className: 'ss-row', style: { flexWrap: 'wrap', gap: '4px' } },
              h('button', { type: 'button', className: 'ss-btn tiny', title: '水平翻转', onClick: () => transformSelection('flip-x') }, '⇋ 翻转'),
              h('button', { type: 'button', className: 'ss-btn tiny', title: '垂直翻转', onClick: () => transformSelection('flip-y') }, '⇅ 翻转'),
              h('button', { type: 'button', className: 'ss-btn tiny', title: '顺时针 90°', onClick: () => transformSelection('rotate-cw') }, '↻ 90°'),
              h('button', { type: 'button', className: 'ss-btn tiny', title: '逆时针 90°', onClick: () => transformSelection('rotate-ccw') }, '↺ 90°'),
            ),
            h('div', { key: 'sz', className: 'ss-row', style: { flexWrap: 'wrap', gap: '4px' } },
              h('button', { type: 'button', className: 'ss-btn tiny', title: '像素放大 2 倍（最近邻）', onClick: () => scaleSelection(2) }, '×2'),
              h('button', { type: 'button', className: 'ss-btn tiny', title: '像素缩小一半', onClick: () => scaleSelection(0.5) }, '÷2'),
              h('button', { type: 'button', className: 'ss-btn tiny', title: '裁掉四周全透明的边', onClick: trimSelection }, '裁透明边'),
            ),
            h('div', { key: 'ser', className: 'ss-btn tiny', style: { display: 'none' } }),
            h('div', { key: 'tint' },
              h('div', { className: 'ss-field-label' }, '调色 ',
                h('span', { className: 'ss-hint' }, `H ${Math.round(tint.hue)}° · S ${tint.sat.toFixed(2)} · L ${tint.light.toFixed(2)}`)),
              h(Slider, { value: tint.hue, min: -180, max: 180, step: 5, onChange: (v) => setTint((o) => ({ ...o, hue: v })) }),
              h(Slider, { value: tint.sat, min: 0, max: 2, step: 0.05, onChange: (v) => setTint((o) => ({ ...o, sat: v })) }),
              h(Slider, { value: tint.light, min: -0.5, max: 0.5, step: 0.02, onChange: (v) => setTint((o) => ({ ...o, light: v })) }),
              h('div', { className: 'ss-row', style: { gap: '4px' } },
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: applyTint }, '应用调色'),
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: resetTint }, '还原'),
                h('button', {
                  type: 'button',
                  className: 'ss-btn tiny',
                  onClick: () => { setTint({ hue: 0, sat: 1, light: 0 }); resetTint(); },
                }, '重置参数'),
              ),
            ),
            selectedSprites.length >= 2
              ? h('div', { key: 'al', className: 'ss-row', style: { flexWrap: 'wrap', gap: '4px' } },
                h('span', { className: 'ss-hint', style: { width: '100%' } }, `对齐（${selectedSprites.length} 张）`),
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyAlign('left') }, '左'),
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyAlign('hcenter') }, '水平中'),
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyAlign('right') }, '右'),
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyAlign('top') }, '上'),
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyAlign('vcenter') }, '垂直中'),
                h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyAlign('bottom') }, '下'),
                selectedSprites.length >= 3
                  ? h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyDistribute('x') }, '水平等距')
                  : null,
                selectedSprites.length >= 3
                  ? h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => applyDistribute('y') }, '垂直等距')
                  : null,
              )
              : null,
            h('div', { key: 'info', className: 'ss-info' },
              h('span', null, `原图 ${fmtSize(primary.w, primary.h)} px · 显示 ${fmtSize(primary.w * primary.scale, primary.h * primary.scale)} px`),
              h('span', null, `位置 (${Math.round(primary.x)}, ${Math.round(primary.y)}) · 层级 ${primary.z || 1}`),
            ),
            h('div', { key: 'sc', className: 'ss-grid2' },
              h(Field, { label: '缩放' },
                h(Num, {
                  value: round(primary.scale, 2), min: 0.05, max: 8, step: 0.05,
                  onChange: (v) => {
                    pushHistoryCoalesced('scale:' + primary.id);
                    patchSprites(new Map([[primary.id, { scale: v }]]));
                  },
                }),
              ),
              h(Field, { label: '不透明度' },
                h(Num, {
                  value: round(primary.opacity ?? 1, 2), min: 0, max: 1, step: 0.05,
                  onChange: (v) => {
                    pushHistoryCoalesced('opacity:' + primary.id);
                    patchSprites(new Map([[primary.id, { opacity: v }]]));
                  },
                }),
              ),
            ),
            h('div', { key: 'sw', className: 'ss-row', style: { justifyContent: 'space-between' } },
              h(Switch, {
                checked: primary.pixelated !== false,
                onChange: (v) => {
                  pushHistory();
                  patchSprites(new Map([[primary.id, { pixelated: v }]]));
                },
              }, '像素锐利'),
              h('button', {
                type: 'button',
                className: 'ss-btn danger tiny',
                onClick: () => {
                  pushHistory();
                  removeSprites(selection.slice());
                },
              }, '删除'),
            ),
            h('div', { key: 'tile', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('div', { className: 'ss-row' },
                h('span', { className: 'ss-field-label' }, '平铺预览'),
                h('button', {
                  type: 'button',
                  className: 'ss-chip-btn',
                  'data-active': tileMode === 'grid' ? 'true' : 'false',
                  onClick: () => setTileMode('grid'),
                }, '3×3'),
                h('button', {
                  type: 'button',
                  className: 'ss-chip-btn',
                  'data-active': tileMode === 'scroll' ? 'true' : 'false',
                  onClick: () => setTileMode('scroll'),
                }, '滚动'),
                tileMode === 'scroll'
                  ? h('button', {
                    type: 'button',
                    className: 'ss-chip-btn',
                    onClick: () => setTileRun((r) => !r),
                  }, tileRun ? '暂停' : '播放')
                  : null,
              ),
              h('div', {
                className: 'ss-tile-box',
                'data-mode': tileMode,
                style: {
                  backgroundImage: `url(${primary.dataUrl})`,
                  backgroundSize: `${tileView.w}px ${tileView.h}px`,
                  '--ss-tile-x': `-${tileView.w}px`,
                  animationDuration: `${tileView.dur}s`,
                  animationPlayState: tileRun ? 'running' : 'paused',
                },
              }),
              tileMode === 'scroll'
                ? h('div', { className: 'ss-row' },
                  h(Field, { label: '速度' }, h(Num, {
                    value: tileSpeed, min: 8, max: 600,
                    onChange: (v) => setTileSpeed(Math.round(v)),
                  })),
                  h('span', { className: 'ss-hint' }, `${Math.round(tileView.w / tileView.dur)} px/s · 一圈 ${tileView.dur.toFixed(1)}s`),
                )
                : h('div', { className: 'ss-hint' }, '铺开 3×3 看接缝；切「滚动」看循环会不会跳。'),
            ),
            h('div', { key: 'acts', className: 'ss-row' },
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                onClick: () => { const box = boundsOf(selectedSprites); if (box) fitTo(box); },
              }, '聚焦'),
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                title: '复制一份（Ctrl+C）',
                onClick: () => {
                  const z = nextZ();
                  const copies = selectedSprites.map((s, i) => ({ ...s, id: uid(), x: s.x + 28, y: s.y + 28, z: z + i }));
                  pushHistory();
                  addSprites(copies);
                  setSelection(copies.map((s) => s.id));
                },
              }, '复制'),
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                title: '图层顺序：叠到所有精灵的最上层',
                onClick: () => {
                  pushHistory();
                  patchSprites(new Map(selectedSprites.map((s) => [s.id, { z: nextZ() + 1 }])));
                },
              }, '移到最前'),
            ),
          ]
          : h('div', { className: 'ss-empty-note' }, '在画布上点选一个精灵，这里显示它的属性。'),
      );

      const sliceSection = h(Section, {
        title: '切图',
        aside: sliceTarget ? `${previewRects.length} 张` : null,
        id: 'slice',
        open: sections.slice,
        onToggle: () => toggleSection('slice'),
      },
        !sliceTarget
          ? h('div', { className: 'ss-empty-note' }, '先选中一张精灵图（整张 sheet），再选切分方式。')
          : [
            h('div', { key: 'pipe', className: 'ss-row' },
              h('button', {
                type: 'button',
                className: 'ss-btn primary tiny wide',
                onClick: runPipeline,
              }, '一键：抠图 + 自动切分'),
              h('button', {
                type: 'button',
                className: 'ss-btn tiny wide',
                title: '按 64 格切、四向命名、跳过空白格，并立刻切分（LPC 角色表专用）',
                onClick: oneClickSlice,
              }, '一键切成帧'),
            ),
            h(Seg, {
              key: 'mode',
              label: '切分方式',
              value: sliceMode,
              onChange: setSliceMode,
              options: [{ id: 'grid', label: '网格' }, { id: 'scan', label: '按行扫描' }, { id: 'auto', label: '自动检测' }],
            }),
            sliceMode === 'grid'
              ? h('div', { key: 'grid', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('div', { className: 'ss-chips' },
                  GRID_PRESETS.map((p) => h('button', {
                    key: p.id,
                    type: 'button',
                    className: 'ss-chip-btn',
                    'data-active': presetToggle(activePreset, 'cell', p.id) ? 'true' : 'false',
                    title: `按 ${p.cell}×${p.cell} 一格切${presetToggle(activePreset, 'cell', p.id) ? '（再点一下取消）' : ''}`,
                    onClick: () => applyGridPreset(p),
                  }, p.label)),
                ),
                h('div', { className: 'ss-chips' },
                  LPC_ACTIONS.map((a) => h('button', {
                    key: a.id,
                    type: 'button',
                    className: 'ss-chip-btn',
                    'data-active': presetToggle(activePreset, 'lpc', a.id) ? 'true' : 'false',
                    title: `LPC 通用表：第 ${a.row}–${a.row + 3} 行（仅对 64 格的角色表有效）`
                      + (presetToggle(activePreset, 'lpc', a.id) ? '，再点一下取消' : ''),
                    onClick: () => applyLpcAction(a),
                  }, `LPC ${a.label}`)),
                ),
                h('div', { className: 'ss-grid2' },
                  h(Field, { label: '列' }, h(Num, { value: grid.cols, min: 1, max: 64, onChange: (v) => setGridManual((g) => ({ ...g, cols: v })) })),
                  h(Field, { label: '行' }, h(Num, { value: grid.rows, min: 1, max: 64, onChange: (v) => setGridManual((g) => ({ ...g, rows: v })) })),
                  h(Field, { label: '外边距 X' }, h(Num, { value: grid.padX, min: 0, max: 4096, onChange: (v) => setGridManual((g) => ({ ...g, padX: v })) })),
                  h(Field, { label: '外边距 Y' }, h(Num, { value: grid.padY, min: 0, max: 4096, onChange: (v) => setGridManual((g) => ({ ...g, padY: v })) })),
                  h(Field, { label: '间隔 X' }, h(Num, { value: grid.gapX, min: 0, max: 4096, onChange: (v) => setGridManual((g) => ({ ...g, gapX: v })) })),
                  h(Field, { label: '间隔 Y' }, h(Num, { value: grid.gapY, min: 0, max: 4096, onChange: (v) => setGridManual((g) => ({ ...g, gapY: v })) })),
                  h('div', { key: 'guess', style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px' } },
                    h('button', { type: 'button', className: 'ss-btn tiny', onClick: autoGuessGrid }, '按内容推断'),
                    gridAuto
                      ? h('span', { className: 'ss-hint' }, `已推断为 ${gridAuto}（可改）`)
                      : h('span', { className: 'ss-hint' },
                        grid.cols === 1 && grid.rows === 1 ? '现在是整张，没切' : ''),
                  ),
                ),
              )
              : sliceMode === 'scan'
                ? h('div', { key: 'scan', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                  h('div', { key: 'hint', className: 'ss-hint' },
                    '手拼表用这个：先按行切开，再在每行内部切帧。行高可以不一致。'),
                  h('div', { key: 'opt', className: 'ss-grid2' },
                    h(Field, { label: '行间距', hint: '小于此值的空隙算同一行' }, h(Num, {
                      value: scanOpts.rowGap, min: 1, max: 64,
                      onChange: (v) => setScanOpts((o) => ({ ...o, rowGap: v })),
                    })),
                    h(Field, { label: '帧间距' }, h(Num, {
                      value: scanOpts.colGap, min: 1, max: 64,
                      onChange: (v) => setScanOpts((o) => ({ ...o, colGap: v })),
                    })),
                    h(Field, { label: '最小帧宽' }, h(Num, {
                      value: scanOpts.minFrameW, min: 1, max: 4096,
                      onChange: (v) => setScanOpts((o) => ({ ...o, minFrameW: v })),
                    })),
                  ),
                  h('button', {
                    type: 'button', className: 'ss-btn wide', onClick: runScan,
                  }, '扫描行'),
                  scanResult && scanResult.sheetId === sliceTarget.id
                    ? h('div', { key: 'list', className: 'ss-scanlist' },
                      scanResult.bands.map((b, i) => h('div', {
                        key: i,
                        className: 'ss-scanrow',
                      },
                        h('input', {
                          type: 'checkbox',
                          checked: !scanOff.includes(i),
                          onChange: () => {
                            setScanOff((prev) => (prev.includes(i) ? prev.filter((n) => n !== i) : prev.concat(i)));
                          },
                        }),
                        h('span', { className: 'ss-scanrow-txt' }, `第 ${i + 1} 行 · y${b.y} · ${b.h}px`),
                        h('input', {
                          type: 'number',
                          className: 'ss-scanrow-num',
                          title: '这一行切几帧（留空=按空隙自动切；填了就等分）',
                          value: scanCounts[i] == null ? '' : scanCounts[i],
                          placeholder: String(b.frames.length),
                          min: 1,
                          max: 512,
                          onChange: (e) => {
                            const raw = e.target.value.trim();
                            setScanCounts((prev) => {
                              const next = { ...prev };
                              const n = Number(raw);
                              if (!raw || !Number.isFinite(n) || n < 1) delete next[i];
                              else next[i] = Math.round(n);
                              return next;
                            });
                          },
                        }),
                        h('span', { className: 'ss-scanrow-txt' }, '帧'),
                      )),
                    )
                    : h('div', { key: 'empty', className: 'ss-hint' },
                      '还没扫描。扫描后会列出每一行和它的帧数，可以逐行关掉不要的。'),
                  previewRects.length
                    ? h('div', { key: 'res', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                      h('canvas', { key: 'pv', ref: previewRef, className: 'ss-slice-preview' }),
                      h('div', { key: 'row', className: 'ss-row' },
                        h('span', { className: 'ss-hint' }, `共 ${previewRects.length} 帧`),
                        h('button', {
                          type: 'button',
                          className: 'ss-btn tiny',
                          onClick: cancelScan,
                        }, '取消扫描'),
                      ),
                    )
                    : null,
                )
                : h('div', { key: 'auto', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                  h('div', { className: 'ss-grid2' },
                  h(Field, { label: '合并间距', hint: '把拆散的部件并回一只' }, h(Num, {
                    value: autoOpts.mergeGap, min: 0, max: 64,
                    onChange: (v) => setAutoOpts((o) => ({ ...o, mergeGap: v })),
                  })),
                  h(Field, { label: '最小面积' }, h(Num, {
                    value: autoOpts.minArea, min: 0, max: 100000,
                    onChange: (v) => setAutoOpts((o) => ({ ...o, minArea: v })),
                  })),
                ),
                h(Switch, {
                  checked: autoOpts.uniform,
                  onChange: (v) => setAutoOpts((o) => ({ ...o, uniform: v })),
                }, '统一成最大尺寸'),
                h('button', { type: 'button', className: 'ss-btn wide', onClick: detectFrames }, '检测精灵（按 alpha 连通域）'),
                detected && detected.sheetId === sliceTarget.id
                  ? h('div', { key: 'res', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    h('canvas', { key: 'pv', ref: previewRef, className: 'ss-slice-preview' }),
                    h('div', { key: 'row', className: 'ss-row' },
                      h('span', { className: 'ss-hint' }, `已检测 ${detected.rects.length} 个切片`),
                      h('button', {
                        type: 'button',
                        className: 'ss-btn tiny',
                        onClick: cancelDetect,
                      }, '取消检测'),
                    ),
                  )
                  : h('div', { className: 'ss-hint' }, '背景是透明的才能分离；纯色背景请先「抠图」，或用上面的一键处理。'),
              ),
            // 画布上叠的那层网格就是这个读数，写在这里也可以不用眼睛找。
            previewRects.length
              ? h('div', { key: 'stat', className: 'ss-info' },
                h('span', null,
                  sliceMode === 'grid'
                    ? `网格 ${grid.cols}×${grid.rows} = ${previewRects.length} 张`
                    : `自动检测 ${previewRects.length} 张`,
                  ` · 画布上已叠出切分预览`,
                ),
                h('span', null,
                  `单格 ${Math.max(...previewRects.map((r) => r.w))}×${Math.max(...previewRects.map((r) => r.h))} px`,
                ),
              )
              : null,
            h(Switch, { key: 'trim', checked: sliceTrim, onChange: setSliceTrim }, '裁掉每张的透明边'),
            h(Switch, { key: 'dirs', checked: sliceDirs, onChange: setSliceDirs }, '四向命名：上/左/下/右'),
            h(Switch, { key: 'skip', checked: sliceSkipEmpty, onChange: setSliceSkipEmpty }, '跳过全空白的格'),
            h('button', {
              key: 'go',
              type: 'button',
              className: 'ss-btn primary wide',
              disabled: !previewRects.length,
              // 必须包一层：runSlice 的第一个参数是矩形数组，直接传函数会把点击事件塞进去
              onClick: () => runSlice(),
            }, `切分为 ${previewRects.length} 张`),
          ],
      );

      const hexOk = parseHex(matteHex) !== null;
      const matteSection = h(Section, {
        title: '抠图',
        aside: mattePreview ? '实时预览' : null,
        id: 'matte',
        open: sections.matte,
        onToggle: () => toggleSection('matte'),
      },
        !primary
          ? h('div', { className: 'ss-empty-note' }, '选中精灵后可在这里去背景。建议先抠图，再切分。')
          : [
            h('div', { key: 'mode', className: 'ss-row' },
              h(Seg, {
                label: '抠图模式',
                value: matteMode,
                onChange: setMatteMode,
                options: [{ id: 'border', label: '边缘连通' }, { id: 'global', label: '全局色差' }],
              }),
            ),
            h('div', { key: 'tol' },
              h('div', { className: 'ss-field-label' }, '颜色容差 ', h('span', { className: 'ss-hint' }, `${matteTol}`)),
              h(Slider, { value: matteTol, min: 0, max: 200, step: 1, onChange: setMatteTol }),
            ),
            h('div', { key: 'soft' },
              h('div', { className: 'ss-field-label' }, '边缘柔化 ', h('span', { className: 'ss-hint' }, `${matteSoft}`)),
              h(Slider, { value: matteSoft, min: 0, max: 160, step: 1, onChange: setMatteSoft }),
            ),
            h('div', { key: 'bg', className: 'ss-row' },
              h('button', {
                type: 'button',
                className: 'ss-swatch',
                title: '自定义背景色',
                style: { background: hexOk ? matteHex : '#ffffff' },
                onClick: () => setMatteBgMode((m) => (m === 'custom' ? 'auto' : 'custom')),
              }),
              h('input', {
                className: 'ss-input',
                value: matteHex,
                spellCheck: false,
                onChange: (e) => { setMatteHex(e.target.value); setMatteBgMode('custom'); },
              }),
              h('button', {
                type: 'button',
                className: cx('ss-btn tiny', picking && 'accent'),
                title: '从左侧原图拾取颜色',
                onClick: () => setPicking((p) => !p),
              }, picking ? '拾取中' : '吸管'),
            ),
            h('div', { key: 'pv', className: 'ss-previews' },
              h('div', {
                className: 'ss-prev',
                'data-pick': picking ? 'true' : undefined,
                onClick: picking ? pickColor : undefined,
                title: picking ? '点一下取这里的颜色' : '原图',
              },
                h('span', { className: 'ss-prev-label' }, '原图'),
                mattePreview ? h('img', { src: mattePreview.before, alt: '原图预览' }) : null,
                picking ? h('span', { className: 'ss-prev-hint' }, '点击取色') : null,
              ),
              h('div', { className: 'ss-prev' },
                h('span', { className: 'ss-prev-label' }, '抠图后'),
                mattePreview ? h('img', { src: mattePreview.after, alt: '抠图预览' }) : null,
              ),
            ),
            matteErr ? h('div', { key: 'err', className: 'ss-error' }, matteErr) : null,
            h('div', { key: 'opt', className: 'ss-row', style: { justifyContent: 'space-between' } },
              h(Switch, { checked: matteTrim, onChange: setMatteTrim }, '裁掉透明边'),
              h(Switch, { checked: matteKeep, onChange: setMatteKeep }, '留一份原图'),
            ),
            h('button', {
              key: 'run',
              type: 'button',
              className: 'ss-btn primary wide',
              onClick: () => runMatte(selectedSprites),
            }, selectedSprites.length > 1 ? `抠图（${selectedSprites.length} 张）` : '抠图'),
            h('div', { key: 'tip', className: 'ss-hint' },
              matteMode === 'border'
                ? '边缘连通：只清掉与画布边缘相连的背景，精灵内部的同色块会保留。'
                : '全局色差：所有接近背景色的像素都清掉，适合纯色底 + 内部无同色的图。'),
          ],
      );

      const bgSection = h(Section, {
        title: '生成背景',
        aside: `${bg.w}×${bg.h}`,
        id: 'bg',
        open: sections.bg,
        onToggle: () => toggleSection('bg'),
      },
        h('div', { key: 'hint', className: 'ss-hint' }, '程序化生成可平铺底图。像素块 = 逻辑像素大小：先在 1/4 分辨率上算，再整体放大 —— 这样色块才成块，不会碎成一粒一粒。'),
        h('div', { key: 'cell', className: 'ss-chips' },
          [1, 2, 4, 8].map((c) => h('button', {
            key: c,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': (bg.cell || 1) === c ? 'true' : 'false',
            title: c === 1 ? '逐像素（会出碎点）' : `每 ${c}×${c} 像素一个色块`,
            onClick: () => setBg((o) => ({ ...o, cell: c })),
          }, `${c}× 块`)),
        ),
        h('div', { key: 'size', className: 'ss-chips' },
          [16, 32, 64, 128, 256].map((s) => h('button', {
            key: s,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': bg.w === s && bg.h === s ? 'true' : 'false',
            onClick: () => setBg((o) => ({ ...o, w: s, h: s })),
          }, `${s}²`)),
          h('button', {
            key: 'strip',
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': bg.w === 512 && bg.h === 256 ? 'true' : 'false',
            onClick: () => setBg((o) => ({ ...o, w: 512, h: 256 })),
          }, '512×256 条'),
        ),
        h('div', { key: 'wh', className: 'ss-grid2' },
          h(Field, { label: '宽' },
            h(Num, { value: bg.w, min: 8, max: 2048, onChange: (v) => setBg((o) => ({ ...o, w: Math.round(v) })) })),
          h(Field, { label: '高' },
            h(Num, { value: bg.h, min: 8, max: 2048, onChange: (v) => setBg((o) => ({ ...o, h: Math.round(v) })) })),
        ),
        h('div', { key: 'pal', className: 'ss-chips' },
          BG_GRADIENTS.map((p) => h('button', {
            key: p.id,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': bg.palette === p.id ? 'true' : 'false',
            onClick: () => setBg((o) => ({ ...o, palette: p.id })),
          }, p.label)),
          h('button', {
            key: 'custom',
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': bg.palette === 'custom' ? 'true' : 'false',
            onClick: () => setBg((o) => ({ ...o, palette: 'custom' })),
          }, '自定义'),
        ),
        h('div', { key: 'colors', className: 'ss-row' },
          h('input', {
            type: 'color', className: 'ss-color', value: bg.dark, title: '深色',
            onChange: (e) => setBg((o) => ({ ...o, dark: e.target.value, palette: 'custom' })),
          }),
          h('input', {
            type: 'color', className: 'ss-color', value: bg.light, title: '浅色',
            onChange: (e) => setBg((o) => ({ ...o, light: e.target.value, palette: 'custom' })),
          }),
          h('span', { className: 'ss-hint' }, bg.palette === 'custom' ? '深 → 浅' : '自定义时生效'),
        ),
        h('div', { key: 'stretch', className: 'ss-chips' },
          ['1:1', '2:1', '4:1', '1:2', '1:4'].map((s) => h('button', {
            key: s,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': bg.stretch === s ? 'true' : 'false',
            title: '拉伸比：2:1 = 横向特征更宽',
            onClick: () => setBg((o) => ({ ...o, stretch: s })),
          }, s)),
        ),
        h('div', { key: 'period' },
          h('div', { className: 'ss-field-label' }, '起伏 ', h('span', { className: 'ss-hint' }, `${bg.period}`)),
          h(Slider, { value: bg.period, min: 1, max: 8, step: 1, onChange: (v) => setBg((o) => ({ ...o, period: v })) }),
        ),
        h('div', { key: 'octaves' },
          h('div', { className: 'ss-field-label' }, '细节层数 ', h('span', { className: 'ss-hint' }, `${bg.octaves}`)),
          h(Slider, { value: bg.octaves, min: 1, max: 8, step: 1, onChange: (v) => setBg((o) => ({ ...o, octaves: v })) }),
        ),
        h('div', { key: 'levels' },
          h('div', { className: 'ss-field-label' }, '色阶 ', h('span', { className: 'ss-hint' }, `${bg.levels}`)),
          h(Slider, { value: bg.levels, min: 2, max: 8, step: 1, onChange: (v) => setBg((o) => ({ ...o, levels: v })) }),
        ),
        h('div', { key: 'seed', className: 'ss-row' },
          h(Field, { label: '种子' },
            h(Num, { value: bg.seed, min: 1, max: 999999, onChange: (v) => setBg((o) => ({ ...o, seed: Math.round(v) })) })),
          h('button', {
            type: 'button',
            className: 'ss-btn tiny',
            onClick: () => setBg((o) => ({ ...o, seed: 1 + Math.floor(Math.random() * 999998) })),
          }, '随机'),
        ),
        h(Switch, {
          key: 'dither',
          checked: bg.dither,
          onChange: (v) => setBg((o) => ({ ...o, dither: v })),
        }, 'Bayer 抖动'),
        h('div', { key: 'div2', className: 'ss-divider' }),
        h(Switch, {
          key: 'l2',
          checked: bg.layer2,
          onChange: (v) => setBg((o) => ({ ...o, layer2: v })),
        }, '第二层噪声（压重复感）'),
        bg.layer2
          ? [
            h('div', { key: 'p2p' },
              h('div', { className: 'ss-field-label' }, '二起伏 ', h('span', { className: 'ss-hint' }, `${bg.p2Period}`)),
              h(Slider, { value: bg.p2Period, min: 1, max: 12, step: 1, onChange: (v) => setBg((o) => ({ ...o, p2Period: v })) }),
            ),
            h('div', { key: 'p2o' },
              h('div', { className: 'ss-field-label' }, '二细节 ', h('span', { className: 'ss-hint' }, `${bg.p2Octaves}`)),
              h(Slider, { value: bg.p2Octaves, min: 1, max: 8, step: 1, onChange: (v) => setBg((o) => ({ ...o, p2Octaves: v })) }),
            ),
            h('div', { key: 'p2s', className: 'ss-row' },
              h(Field, { label: '二种子' },
                h(Num, { value: bg.p2Seed, min: 1, max: 999999, onChange: (v) => setBg((o) => ({ ...o, p2Seed: Math.round(v) })) })),
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                onClick: () => setBg((o) => ({ ...o, p2Seed: 1 + Math.floor(Math.random() * 999998) })),
              }, '随机'),
            ),
            h(Field, { key: 'blend', label: '混合模式' },
              h('select', {
                className: 'ss-input',
                value: bg.blend,
                onChange: (e) => setBg((o) => ({ ...o, blend: e.target.value })),
              }, BLEND_MODES.map((m) => h('option', { key: m.id, value: m.id }, m.label))),
            ),
            h(Switch, {
              key: 'pack',
              checked: bg.pack,
              onChange: (v) => setBg((o) => ({ ...o, pack: v })),
            }, '通道打包（R=层1 G=层2 B=结果）'),
          ]
          : null,
        h('div', { key: 'div3', className: 'ss-divider' }),
        h(Switch, {
          key: 'al',
          checked: bg.autoLevels,
          onChange: (v) => setBg((o) => ({ ...o, autoLevels: v })),
        }, '自动色阶'),
        h(Switch, {
          key: 'inv',
          checked: bg.invert,
          onChange: (v) => setBg((o) => ({ ...o, invert: v })),
        }, '反相'),
        h('div', { key: 'ct' },
          h('div', { className: 'ss-field-label' }, '对比 ', h('span', { className: 'ss-hint' }, `${(bg.contrast || 1).toFixed(2)}×`)),
          h(Slider, { value: bg.contrast, min: 0.5, max: 2, step: 0.05, onChange: (v) => setBg((o) => ({ ...o, contrast: v })) }),
        ),
        h('div', { key: 'gm' },
          h('div', { className: 'ss-field-label' }, 'Gamma ', h('span', { className: 'ss-hint' }, `${(bg.gamma || 1).toFixed(2)}`)),
          h(Slider, { value: bg.gamma, min: 0.4, max: 3, step: 0.05, onChange: (v) => setBg((o) => ({ ...o, gamma: v })) }),
        ),
        h('div', { key: 'warp' },
          h('div', { className: 'ss-field-label' }, '扭曲 ', h('span', { className: 'ss-hint' }, (bg.warp || 0).toFixed(2))),
          h(Slider, { value: bg.warp || 0, min: 0, max: 0.3, step: 0.01, onChange: (v) => setBg((o) => ({ ...o, warp: v })) }),
        ),
        h('div', {
          key: 'preview',
          className: 'ss-tile-preview',
          style: bgPreview ? { backgroundImage: `url(${bgPreview})`, backgroundSize: '50% auto' } : undefined,
        },
          h('span', { className: 'ss-tile-note' }, bgPreview ? '平铺预览' : '生成中…'),
        ),
        h('button', {
          key: 'go',
          type: 'button',
          className: 'ss-btn primary wide',
          onClick: generateBg,
        }, `生成 ${bg.w}×${bg.h} 并放入画布`),
      );

      /** 把当前选中项按图层顺序合成成一张新精灵。 */
      const composeNow = useCallback(async () => {
        if (!compLayers.length) { notify('先选中若干部件（头/身/腿…）', 'error'); return; }
        setBusy('正在合成…');
        try {
          const layout = compLayout;
          if (!layout.w || !layout.h) { notify('合成尺寸为 0，检查一下部件', 'error'); return; }
          const canvas = makeCanvas(layout.w, layout.h);
          const g = ctx2d(canvas);
          for (const item of layout.items) {
            const sp = compLayers.find((s) => s.id === item.id);
            if (!sp) continue;
            const img = await loadImage(sp.dataUrl);
            g.drawImage(img, item.x, item.y, sp.w, sp.h);
          }
          const dataUrl = canvas.toDataURL('image/png');
          const box = boundsOf(spritesRef.current);
          const sprite = {
            id: uid(),
            name: `char_${layout.w}x${layout.h}_${Math.floor(Math.random() * 900 + 100)}`,
            dataUrl,
            w: layout.w,
            h: layout.h,
            x: box ? Math.round(box.x) : 0,
            y: box ? Math.round(box.y + box.h + 48) : 0,
            scale: 1,
            opacity: 1,
            z: nextZ(),
            pixelated: true,
            kind: 'compose',
            meta: { parts: compLayers.map((s) => s.id), anchor: compAnchor },
          };
          pushHistory();
          addSprites([sprite]);
          setSelection([sprite.id]);
          fitTo(boundsOf([sprite]));
          // 报出实际画进画布的层数 —— 层列表有、成品没有，这两者的差就是线索
          notify(`已合成 ${layout.w}×${layout.h} · ${layout.items.length} 层`, 'success');
        } catch (err) {
          notify('合成失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, boundsOf, compAnchor, compLayers, compLayout, fitTo, nextZ, notify, pushHistory]);

      /** 从上游取一个部位（一个动作一张表），落进画布。 */
      const fetchLpcPart = useCallback(async (itemId, catArg, animArg) => {
        const catId = catArg || libCat;
        const anim = animArg || libAnim;
        const cat = LPC_LIBRARY.find((c) => c.id === catId);
        if (!cat) return;
        setBusy(`正在取 ${cat.label} ${itemId}…`);
        try {
          let hit = null;
          let extra = null;
          for (const u of lpcCandidates(catId, itemId, anim)) {
            // eslint-disable-next-line no-await-in-loop
            const r = await fetch(u);
            if (!r.ok) continue;
            hit = { url: u, res: r };
            // 命中的是「前面」那层 → 把「后面」那层也取来，否则马尾会缺后脑那截
            if (u.includes('/fg/')) {
              const bgUrl = u.replace('/fg/', '/bg/');
              // eslint-disable-next-line no-await-in-loop
              const rb = await fetch(bgUrl);
              if (rb.ok) extra = { url: bgUrl, res: rb };
            }
            break;
          }
          if (!hit) {
            notify(`上游没有这个组合：${itemId} 可能不支持 ${anim}`, 'error');
            noteLibFail(catId, itemId, anim);
            return;
          }

          const box0 = boundsOf(spritesRef.current);
          const made = [];
          const toSprite = async (source, res, category, nameTag) => {
            const blob = await res.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            const img = await loadImage(dataUrl);
            const w = img.naturalWidth;
            const hh = img.naturalHeight;
            // 解码失败会得到 0×0：画布上看不见，但层列表里有它 —— 这种「幽灵层」最难查，
            // 所以直接当失败处理，别让它进画布。
            if (!w || !hh) throw new Error(`图片解码失败：${source.split('/').pop()}`);
            return {
              id: uid(),
              name: `lpc_${nameTag}_${anim}`,
              dataUrl,
              w,
              h: hh,
              x: box0 ? Math.round(box0.x) : 0,
              y: 0,
              scale: 1,
              opacity: 1,
              z: 0,
              pixelated: true,
              kind: 'lpc',
              meta: { source, category, item: itemId, anim },
            };
          };

          const base = await toSprite(hit.url, hit.res, catId, itemId);
          made.push(base);
          if (extra) made.push(await toSprite(extra.url, extra.res, `${catId}_bg`, itemId + '_bg'));

          const box = boundsOf(spritesRef.current);
          const startX = box ? Math.round(box.x) : 0;
          const startY = box ? Math.round(box.y + box.h + 48) : 0;
          let z = nextZ();
          // 双层部件**并排摆**，不要叠在同一处：叠在一起时后层盖住前层，
          // 用户点选只能点到上面那张，前层永远选不上（马尾就是这么丢的）。
          // 合成时位置会按锚点重算，所以摆在哪里都不影响结果。
          made.forEach((sp, i) => {
            sp.x = startX + i * (sp.w + 24);
            sp.y = startY;
            sp.z = z++;
          });
          pushHistory();
          addSprites(made);
          // **追加**到当前选择，而不是替换 —— 否则「连取六件再合成」时，
          // 前面取的会被一次次取消选中，最后合成出来只有零星几件（头发就是这么丢的）。
          setSelection((prev) => {
            const seen = new Set(prev);
            const add = made.map((s) => s.id).filter((id) => !seen.has(id));
            return prev.concat(add);
          });
          fitTo(boundsOf(made) || null);
          notify(
            made.length > 1
              ? `已取 ${itemId}（${made.length} 层：前 + 后），已加入当前组合`
              : `已取 ${itemId}_${libAnim}（${base.w}×${base.h}），已加入当前组合`,
            'success',
          );
        } catch (err) {
          notify('取素材失败：' + (err && err.message ? err.message : err), 'error');
        } finally {
          setBusy('');
        }
      }, [addSprites, boundsOf, fitTo, libAnim, libCat, nextZ, notify, pushHistory]);

      // ── 特效生成 ───────────────────────────────────────────────────────
      const fxRender = useCallback((opt) => {
        const size = clamp(Math.round(opt.size) || 128, 16, 512);
        let field = fxField(opt.kind, size, size, opt);
        if (opt.warp > 0) field = warpField(field, size, size, { amount: opt.warp, period: 3, seed: opt.seed });
        const g = BG_GRADIENTS.find((x) => x.id === opt.palette) || BG_GRADIENTS[0];
        const rgba = colorizeTexture(field, size, size, {
          levels: opt.levels,
          dither: false,
          stops: gradientStops(g.stops),
          alpha: true,
        });
        const canvas = makeCanvas(size, size);
        ctx2d(canvas).putImageData(new ImageData(rgba, size, size), 0, 0);
        return canvas.toDataURL('image/png');
      }, []);

      useEffect(() => {
        let alive = true;
        const t = setTimeout(() => {
          try {
            const url = fxRender(fx);
            if (alive) setFxPreview(url);
          } catch (err) {
            if (alive) setFxPreview(null);
          }
        }, 120);
        return () => { alive = false; clearTimeout(t); };
      }, [fx, fxRender]);

      const generateFx = useCallback(() => {
        try {
          const dataUrl = fxRender(fx);
          const box = boundsOf(spritesRef.current);
          const sprite = {
            id: uid(),
            name: `fx_${fx.kind}_${fx.size}`,
            dataUrl,
            w: fx.size,
            h: fx.size,
            x: box ? Math.round(box.x) : 0,
            y: box ? Math.round(box.y + box.h + 48) : 0,
            scale: 1,
            opacity: 1,
            z: nextZ(),
            pixelated: true,
            kind: 'fx',
            meta: { generated: 'fx', preset: fx.kind },
          };
          pushHistory();
          addSprites([sprite]);
          setSelection([sprite.id]);
          fitTo(boundsOf([sprite]));
          notify(`已生成特效 ${fx.size}×${fx.size}`, 'success');
        } catch (err) {
          notify('生成失败：' + (err && err.message ? err.message : err), 'error');
        }
      }, [addSprites, boundsOf, fitTo, fx, fxRender, nextZ, notify, pushHistory]);


      // 缩略图：取整张表后**只裁第一格**（64×64），按需拉、限制并发、缓存起来。
      // 不做全量预取 —— 15 个类别 150 件全拉一遍是几百个请求，没必要。
      useEffect(() => {
        const pending = libVisible
          // 用 in 判断而不是真值判断：失败过的存成 ''，真值判断会让它无限重试
          .filter((v) => !(v.key in libThumbs))
          .slice(0, 30);
        if (!pending.length) return undefined;
        let alive = true;
        let cursor = 0;
        const worker = async () => {
          while (alive && cursor < pending.length) {
            const v = pending[cursor++];
            try {
              const urls = lpcCandidates(v.cat, v.item, libAnim);
              let res = null;
              for (const u of urls) {
                // eslint-disable-next-line no-await-in-loop
                const r = await fetch(u);
                if (r.ok) { res = r; break; }
              }
              if (!res) { if (alive) setLibThumbs((m) => ({ ...m, [v.key]: '' })); continue; }
              // eslint-disable-next-line no-await-in-loop
              const blob = await res.blob();
              const dataUrl = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => resolve('');
                reader.readAsDataURL(blob);
              });
              if (!dataUrl) continue;
              const img = await loadImage(dataUrl);
              const cell = 64;
              const cv = makeCanvas(cell, cell);
              const g = ctx2d(cv);
              g.imageSmoothingEnabled = false;
              g.drawImage(img, 0, 0, cell, cell, 0, 0, cell, cell);
              const thumb = cv.toDataURL('image/png');
              if (alive) setLibThumbs((m) => ({ ...m, [v.key]: thumb }));
            } catch (err) {
              if (alive) setLibThumbs((m) => ({ ...m, [v.key]: '' }));
            }
          }
        };
        // 三个并发够了：再多会被上游当成爬虫，再少就慢
        worker(); worker(); worker();
        return () => { alive = false; };
        // libVisible 由 libCat/libQuery 派生；libThumbs 进依赖是为了「每批 30 张」能接着下一批
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [libCat, libQuery, libAnim, libThumbs]);

      // 到这里 generateBg / generateFx 都已定义，把动作挂到 ref 上供快捷键使用
      genActionsRef.current = { bg: generateBg, fx: generateFx };

      const fxSection = h(Section, {
        title: '特效',
        aside: `${fx.size}px`,
        id: 'fx',
        open: sections.fx,
        onToggle: () => toggleSection('fx'),
      },
        h('div', { key: 'hint', className: 'ss-hint' },
          '程序化特效：形状由参数算出来，颜色交给色带，透明度按强度分级 —— 换个色带就是另一种属性。'),
        h('div', { key: 'kind', className: 'ss-chips' },
          FX_PRESETS.map((p) => h('button', {
            key: p.id,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': fx.kind === p.id ? 'true' : 'false',
            onClick: () => setFx((o) => ({ ...o, kind: p.id })),
          }, p.label)),
        ),
        h('div', { key: 'size', className: 'ss-chips' },
          [64, 128, 256].map((s) => h('button', {
            key: s,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': fx.size === s ? 'true' : 'false',
            onClick: () => setFx((o) => ({ ...o, size: s })),
          }, `${s}px`)),
        ),
        h('div', { key: 'pal', className: 'ss-chips' },
          BG_GRADIENTS.map((p) => h('button', {
            key: p.id,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': fx.palette === p.id ? 'true' : 'false',
            onClick: () => setFx((o) => ({ ...o, palette: p.id })),
          }, p.label)),
        ),
        h('div', { key: 'strength' },
          h('div', { className: 'ss-field-label' }, '强度 ', h('span', { className: 'ss-hint' }, fx.strength.toFixed(2))),
          h(Slider, { value: fx.strength, min: 0.3, max: 2.5, step: 0.05, onChange: (v) => setFx((o) => ({ ...o, strength: v })) }),
        ),
        h('div', { key: 'thick' },
          h('div', { className: 'ss-field-label' }, '厚度 ', h('span', { className: 'ss-hint' }, fx.thick.toFixed(2))),
          h(Slider, { value: fx.thick, min: 0.03, max: 0.6, step: 0.01, onChange: (v) => setFx((o) => ({ ...o, thick: v })) }),
        ),
        fx.kind === 'slash'
          ? h('div', { key: 'arc' },
            h('div', { className: 'ss-field-label' }, '弧度 ', h('span', { className: 'ss-hint' }, `${Math.round(fx.arc)}°`)),
            h(Slider, { value: fx.arc, min: 40, max: 340, step: 5, onChange: (v) => setFx((o) => ({ ...o, arc: v })) }),
          )
          : null,
        h('div', { key: 'levels' },
          h('div', { className: 'ss-field-label' }, '色阶 ', h('span', { className: 'ss-hint' }, `${fx.levels}`)),
          h(Slider, { value: fx.levels, min: 2, max: 8, step: 1, onChange: (v) => setFx((o) => ({ ...o, levels: v })) }),
        ),
        h('div', { key: 'warp' },
          h('div', { className: 'ss-field-label' }, '扭曲 ', h('span', { className: 'ss-hint' }, (fx.warp || 0).toFixed(2))),
          h(Slider, { value: fx.warp || 0, min: 0, max: 0.3, step: 0.01, onChange: (v) => setFx((o) => ({ ...o, warp: v })) }),
        ),
        h('div', { key: 'preview', className: 'ss-fx-preview' },
          fxPreview
            ? h('img', { src: fxPreview, alt: '特效预览' })
            : h('span', { className: 'ss-hint' }, '生成中…'),
        ),
        h('button', {
          key: 'go', type: 'button', className: 'ss-btn primary wide', onClick: generateFx,
        }, `生成 ${fx.size}×${fx.size} 特效`),
      );

      const libSection = h(Section, {
        title: 'LPC 素材库',
        aside: `${libVisible.length}`,
        id: 'library',
        open: sections.library,
        onToggle: () => toggleSection('library'),
      },
        h('div', { key: 'hint', className: 'ss-hint' },
          '点击才去上游取原文件 —— 插件不复制、不分发这些图。同动作的部位尺寸一致，取回来直接叠就是角色。'),
        h('div', { key: 'hint2', className: 'ss-hint' },
          '取素材会追加到当前选择：连取身体→头→五官→头发→衣服，然后去「角色合成」直接合成。'),
        h('div', { key: 'hint3', className: 'ss-hint' },
          '注意：身体不含头。要完整角色至少取五个——身体 + 头 + 五官 + 头发，再加衣服。'),
        h('div', { key: 'cat', className: 'ss-chips' },
          LPC_LIBRARY.map((c) => h('button', {
            key: c.id,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': libCat === c.id && !libQuery.trim() ? 'true' : 'false',
            onClick: () => { setLibCat(c.id); setLibQuery(''); },
          }, c.label)),
        ),
        h('input', {
          key: 'q',
          className: 'ss-input',
          placeholder: '搜索全部类别（如 pony / boot / sword）…',
          value: libQuery,
          onChange: (e) => setLibQuery(e.target.value),
        }),
        h('div', { key: 'anim', className: 'ss-chips' },
          LPC_ANIMS.map((a) => h('button', {
            key: a,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': libAnim === a ? 'true' : 'false',
            onClick: () => setLibAnim(a),
          }, a)),
        ),
        libQuery.trim()
          ? h('div', { key: 'qhint', className: 'ss-hint' }, `跨类别搜到 ${libVisible.length} 件`)
          : null,
        h('div', { key: 'items', className: 'ss-libgrid' },
          libVisible.map((v) => h('button', {
            key: v.key,
            type: 'button',
            className: 'ss-libitem',
            title: `${v.cat} · ${v.item} · ${libAnim}`,
            onClick: () => fetchLpcPart(v.item, v.cat),
          },
            libThumbs[v.key]
              ? h('img', { src: libThumbs[v.key], alt: '' })
              : h('span', { className: 'ss-libph' }, '·'),
            h('span', { className: 'ss-libname' }, libQuery.trim() ? `${v.cat.slice(0, 2)}·${v.label}` : v.label),
          )),
        ),
        h('div', { key: 'note', className: 'ss-hint' },
          '这些素材是 CC-BY-SA / GPL 混合，用作游戏时要在你的作品里署名。插件只提供路径，不提供图片。'),
        libFails.length
          ? h('div', { key: 'fails' },
            h('div', { className: 'ss-field-label' },
              `取不到 ${libFails.length} 条`,
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                style: { marginLeft: '6px' },
                onClick: () => {
                  const text = libFails.map((f) => `${f.cat} | ${f.item} | ${f.anim}`).join('\n');
                  const done = () => notify(`已复制 ${libFails.length} 条，粘贴给我就能补规则`, 'success');
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done, () => notify('复制失败，请手动选中列表', 'error'));
                  } else {
                    notify('这个环境不支持剪贴板，手动选中列表复制', 'error');
                  }
                },
              }, '复制清单'),
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                style: { marginLeft: '4px' },
                onClick: () => setLibFails([]),
              }, '清空'),
              ),
            h('div', { className: 'ss-faillist' },
              libFails.slice(-40).reverse().map((f) => h('div', {
                key: `${f.cat}|${f.item}|${f.anim}`,
                className: 'ss-failrow',
                title: `${f.cat} · ${f.item} · ${f.anim}`,
              }, `${f.cat} · ${f.item} · ${f.anim}`)),
            ),
            h('div', { className: 'ss-hint' }, '这些是候选规则没覆盖到的形态。复制清单发我，我照着补。'),
          )
          : null,
      );

/**
       * 存配方：把当前合成列表里的 LPC 部件记下来。
       * 拼半小时的角色刷新就散，是这个工具最痛的一处。
       */
      const saveRecipe = useCallback(() => {
        const parts = recipeFromSprites(compList);
        if (!parts.length) { notify('当前组合里没有 LPC 部件，没什么可存的', 'error'); return; }
        const name = (recipeName || '').trim() || `角色 ${recipes.length + 1}`;
        setRecipes((prev) => [{ id: uid(), name, parts, at: Date.now() }, ...prev].slice(0, 50));
        setRecipeName('');
        notify(`已存配方「${name}」（${parts.length} 件）`, 'success');
      }, [compList, notify, recipeName, recipes.length]);

      /** 还原配方：逐件取回来并选中。合成留给人点 —— 合成读的是渲染后的状态，立刻调会拿到旧的。 */
      const restoreRecipe = useCallback(async (recipe) => {
        if (!recipe || !recipe.parts.length) return;
        const ok = [];
        for (const p of recipe.parts) {
          // eslint-disable-next-line no-await-in-loop
          const before = spritesRef.current.length;
          // eslint-disable-next-line no-await-in-loop
          await fetchLpcPart(p.item, p.cat, p.anim);
          if (spritesRef.current.length > before) ok.push(p);
        }
        notify(ok.length === recipe.parts.length
          ? `已取回 ${ok.length} 件，去点「合成为新精灵」`
          : `取回 ${ok.length}/${recipe.parts.length} 件，缺的可能不支持这个动作`, ok.length ? 'success' : 'error');
      }, [fetchLpcPart, notify]);

      const deleteRecipe = useCallback((id) => {
        setRecipes((prev) => prev.filter((r) => r.id !== id));
      }, []);

      const compSection = h(Section, {
        title: '角色合成',
        aside: compLayers.length ? `${compLayers.length} 层` : null,
        id: 'compose',
        open: sections.compose,
        onToggle: () => toggleSection('compose'),
      },
        !compList.length
          ? h('div', { className: 'ss-empty-note' }, '选中若干部件（头 / 身 / 腿 / 武器），按列表顺序叠成一个角色。锚点默认「脚底居中」。')
          : [
            h('div', { key: 'list', className: 'ss-scanlist' },
              compList.map((sp, i) => h('div', {
                key: sp.id,
                className: 'ss-scanrow',
                style: compActive === sp.id ? { background: 'var(--dsw-alias-bg-layer-2)' } : undefined,
                onClick: () => setCompActive(sp.id),
              },
                h('input', {
                  type: 'checkbox',
                  checked: !compHidden.includes(sp.id),
                  onChange: () => setCompHidden((prev) => (
                    prev.includes(sp.id) ? prev.filter((x) => x !== sp.id) : prev.concat(sp.id)
                  )),
                }),
                h('span', { className: 'ss-scanrow-txt' },
                  `${i + 1}. ${sp.name} · ${(sp.meta && sp.meta.category) || '?'} ${LPC_Z[(sp.meta && sp.meta.category)] ?? ''}`),
              )),
            ),
            h('div', { key: 'ops', className: 'ss-row' },
              h('button', {
                type: 'button', className: 'ss-btn tiny',
                onClick: () => {
                  const id = compActive || compList[0].id;
                  setCompOrder((prev) => {
                    const i = prev.indexOf(id);
                    if (i <= 0) return prev;
                    const next = prev.slice();
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    return next;
                  });
                },
              }, '上移'),
              h('button', {
                type: 'button', className: 'ss-btn tiny',
                onClick: () => {
                  const id = compActive || compList[0].id;
                  setCompOrder((prev) => {
                    const i = prev.indexOf(id);
                    if (i < 0 || i >= prev.length - 1) return prev;
                    const next = prev.slice();
                    [next[i + 1], next[i]] = [next[i], next[i + 1]];
                    return next;
                  });
                },
              }, '下移'),
              h('button', {
                type: 'button', className: 'ss-btn tiny',
                onClick: () => setCompHidden([]),
              }, '全部显示'),
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                title: '身体→下装→上衣→头→五官→头发→武器',
                onClick: () => setCompOrder((prev) => {
                  const byId = new Map(compList.map((s) => [s.id, s]));
                  const ordered = sortLayersByCategory(prev.map((id) => byId.get(id)).filter(Boolean));
                  const rest = prev.filter((id) => !byId.has(id));
                  return ordered.map((s) => s.id).concat(rest);
                }),
              }, '按部位排序'),
            ),
            h('div', { key: 'off', className: 'ss-grid2' },
              h(Field, { label: '当前层偏移 X' }, h(Num, {
                value: (compOffset[compActive] || {}).dx || 0, min: -512, max: 512,
                onChange: (v) => setCompOffset((prev) => ({ ...prev, [compActive]: { ...(prev[compActive] || {}), dx: Math.round(v) } })),
              })),
              h(Field, { label: '偏移 Y' }, h(Num, {
                value: (compOffset[compActive] || {}).dy || 0, min: -512, max: 512,
                onChange: (v) => setCompOffset((prev) => ({ ...prev, [compActive]: { ...(prev[compActive] || {}), dy: Math.round(v) } })),
              })),
            ),
            h(Field, { key: 'anchor', label: '对齐锚点' },
              h('select', {
                className: 'ss-input',
                value: compAnchor,
                onChange: (e) => setCompAnchor(e.target.value),
              },
                h('option', { value: 'topleft' }, '左上对齐（LPC 标准，默认）'),
                h('option', { value: 'bottom' }, '脚底居中'),
                h('option', { value: 'stack' }, '垂直堆叠（紧裁散件）'),
                h('option', { value: 'center' }, '中心'),
              ),
            ),
            h('canvas', { key: 'pv', ref: compPreviewRef, className: 'ss-slice-preview' }),
            mixedSizes.length
              ? h('div', { key: 'szwarn', className: 'ss-hint', style: { color: 'var(--dsw-alias-brand-primary)' } },
                `图层尺寸不一致：${mixedSizes.join(' 与 ')}。`
                + 'LPC 大型武器是 128 帧（表更大），和 64 帧的身体叠在一起必然错位——'
                + '这类武器只适合单独特效/展示，不能直接拼到角色上。')
              : null,
            missingForeLayer.length
              ? h('div', { key: 'warn', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { className: 'ss-hint', style: { color: 'var(--dsw-alias-brand-primary)' } },
                  `缺少前层：只有 ${missingForeLayer.map((m) => m.bg).join('、')}，没有对应的 ${missingForeLayer.map((m) => m.base).join('、')}。`
                  + '双层部件（马尾、披风、部分盾牌）必须两层都选中，否则只剩被挡住的后层。'),
                h('button', {
                  type: 'button',
                  className: 'ss-btn tiny',
                  onClick: () => {
                    // 在画布上找同类别的精灵，把缺的前层补进选择
                    const want = new Set(missingForeLayer.map((m) => m.base));
                    const extra = sprites
                      .filter((s) => want.has((s.meta && s.meta.category) || ''))
                      .map((s) => s.id);
                    if (!extra.length) {
                      notify('画布上也没有前层，去素材库重新取一次（会同时加两层）', 'error');
                      return;
                    }
                    setSelection((prev) => prev.concat(extra.filter((id) => !prev.includes(id))));
                    notify(`已补上 ${extra.length} 层`, 'success');
                  },
                }, '补上前层'),
                )
              : null,
            h('div', { key: 'hint', className: 'ss-hint' },
              `合成尺寸 ${compLayout.w}×${compLayout.h} · 列表靠后的压在上面`),
            h('div', { key: 'recipe', className: 'ss-row', style: { gap: '4px' } },
              h('input', {
                className: 'ss-input',
                placeholder: '配方名（可空）',
                value: recipeName,
                onChange: (e) => setRecipeName(e.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                title: '把当前组合的部件记下来，刷新/重开还能一键取回',
                onClick: saveRecipe,
              }, '存配方'),
            ),
            recipes.length
              ? h('div', { key: 'recipelist', className: 'ss-faillist' },
                recipes.map((r) => h('div', { key: r.id, className: 'ss-row', style: { gap: '4px' } },
                  h('span', { className: 'ss-scanrow-txt', style: { flex: '1 1 auto' } }, `${r.name} · ${r.parts.length} 件`),
                  h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => restoreRecipe(r) }, '取回'),
                  h('button', { type: 'button', className: 'ss-btn tiny', onClick: () => deleteRecipe(r.id) }, '删'),
                )),
              )
              : null,
            h('button', {
              key: 'go', type: 'button', className: 'ss-btn primary wide', onClick: composeNow,
            }, '合成为新精灵'),
          ],
      );

      const animSection = h(Section, {
        title: '动画预览',
        aside: playFrames.length >= 2 ? `${playFrames.length} 帧` : (sheetGrid ? `${sheetGrid.cols} 帧` : null),
        id: 'anim',
        open: sections.anim,
        onToggle: () => toggleSection('anim'),
      },
        // 整表模式：选中一张 64 的整数倍的表，自动按网格拆帧播放
        sheetGrid && playFrames.length < 2
          ? [
            h('div', { key: 'sg', className: 'ss-hint' },
              `这张表 ${sheetGrid.cols} 列 × ${sheetGrid.rows} 行（每格 64px）。点方向行直接看动画，不用先切。`),
            h('div', {
              key: 'box',
              className: 'ss-anim',
              title: animPlaying ? '点一下暂停' : '点一下播放',
              onClick: () => setAnimPlaying((p) => !p),
            },
              (() => {
                const k = Math.max(1, Math.min(3, Math.floor(96 / 64)));
                const idx = sheetGrid.cols > 0 ? animIndex % sheetGrid.cols : 0;
                return h('div', {
                  style: {
                    width: `${64 * k}px`,
                    height: `${64 * k}px`,
                    overflow: 'hidden',
                    position: 'relative',
                    imageRendering: 'pixelated',
                  },
                }, h('img', {
                  src: sheetGrid.sp.dataUrl,
                  alt: '',
                  style: {
                    position: 'absolute',
                    left: `${-idx * 64 * k}px`,
                    top: `${-Math.min(sheetDir, sheetGrid.rows - 1) * 64 * k}px`,
                    width: `${sheetGrid.sp.w * k}px`,
                    height: `${sheetGrid.sp.h * k}px`,
                    imageRendering: 'pixelated',
                  },
                }));
              })(),
            ),
            h('div', { key: 'row', className: 'ss-chips' },
              ['下', '左', '右', '上'].slice(0, sheetGrid.rows).map((label, i) => h('button', {
                key: label,
                type: 'button',
                className: 'ss-chip-btn',
                'data-active': sheetDir === i ? 'true' : 'false',
                onClick: () => { setSheetDir(i); setAnimIndex(0); },
              }, `第 ${i + 1} 行 ${label}`)),
            ),
            h('div', { key: 'rowctl', className: 'ss-row' },
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                onClick: () => setAnimPlaying((p) => !p),
              }, animPlaying ? '暂停' : '播放'),
              h('span', { className: 'ss-hint' }, `${(animIndex % sheetGrid.cols) + 1} / ${sheetGrid.cols}`),
            ),
            h(Seg, {
              key: 'fps2',
              label: '帧率',
              value: String(animFps),
              onChange: (v) => setAnimFps(Number(v)),
              options: [{ id: '8', label: '8 fps' }, { id: '12', label: '12 fps' }, { id: '24', label: '24 fps' }],
            }),
          ]
          : playFrames.length < 2
            ? h('div', { className: 'ss-empty-note' }, '至少选两张图。切出来的帧会按名字里的序号自动排队（hero_2 排在 hero_10 前面）。')
            : [
            h('div', {
              key: 'box',
              className: 'ss-anim',
              title: animPlaying ? '点一下暂停' : '点一下播放',
              onClick: () => setAnimPlaying((p) => !p),
            },
              animOnion
                ? h('img', {
                  key: 'ghost',
                  className: 'ss-anim-ghost',
                  src: playFrames[(animIndex - 1 + playFrames.length) % playFrames.length].dataUrl,
                  alt: '',
                })
                : null,
              h('img', {
                key: 'now',
                src: playFrames[Math.min(animIndex, playFrames.length - 1)].dataUrl,
                alt: '',
              }),
            ),
            h('div', { key: 'ctl', className: 'ss-row' },
              h('button', {
                type: 'button',
                className: 'ss-btn tiny',
                onClick: () => setAnimPlaying((p) => !p),
              }, animPlaying ? '暂停' : '播放'),
              h('span', { className: 'ss-hint' }, `${Math.min(animIndex + 1, playFrames.length)} / ${playFrames.length} · ${playFrames[Math.min(animIndex, playFrames.length - 1)].name}`),
            ),
            h(Seg, {
              key: 'fps',
              label: '帧率',
              value: String(animFps),
              onChange: (v) => setAnimFps(Number(v)),
              options: [{ id: '8', label: '8 fps' }, { id: '12', label: '12 fps' }, { id: '24', label: '24 fps' }],
            }),
            h(Switch, {
              key: 'onion',
              checked: animOnion,
              onChange: setAnimOnion,
            }, '洋葱皮：叠半透明上一帧'),
            h('div', { key: 'strip', className: 'ss-strip' },
              playFrames.map((f, i) => h('button', {
                key: f.id,
                type: 'button',
                className: 'ss-strip-btn',
                'data-active': i === animIndex ? 'true' : 'false',
                title: f.name,
                onClick: () => { setAnimPlaying(false); setAnimIndex(i); },
              }, h('img', { src: f.dataUrl, alt: '' }))),
            ),
            h('div', { key: 'hint', className: 'ss-hint' }, '所有帧按底部居中叠放 —— 尺寸不一致时看得更准。'),
          ],
      );





      const exportSection = h(Section, {
        title: '导出',
        aside: sprites.length ? `${pickScope(exportScope).length} 张` : null,
        id: 'export',
        open: sections.export,
        onToggle: () => toggleSection('export'),
      },
        h(Seg, {
          label: '导出范围',
          value: exportScope,
          onChange: setExportScope,
          options: [{ id: 'selection', label: `选中的` }, { id: 'all', label: '全部' }],
        }),
        h('div', { className: 'ss-hint' },
          exportScope === 'selection' && !selectedSprites.length
            ? '当前没选中任何精灵，会退回导出全部。'
            : `将导出 ${pickScope(exportScope).length} 张 PNG`),
        h('div', { className: 'ss-field-label' }, '导出倍率'),
        h('div', { className: 'ss-chips' },
          [1, 2, 4].map((k) => h('button', {
            key: k,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': exportScale === k ? 'true' : 'false',
            onClick: () => setExportScale(k),
          }, `×${k}`)),
        ),
        h('button', {
          type: 'button',
          className: 'ss-btn primary wide',
          disabled: !sprites.length,
          onClick: () => exportZip(exportScope),
        }, '打包下载 ZIP'),
        h('button', {
          type: 'button',
          className: 'ss-btn wide',
          disabled: !sprites.length,
          onClick: () => exportEachPng(exportScope),
        }, '逐张下载 PNG'),
        h('div', { className: 'ss-hint' }, 'ZIP 里是每张一个 PNG（原名）+ manifest.json（尺寸与画布坐标）。'),
        h('div', { className: 'ss-divider' }),
        h('div', { className: 'ss-field-label' }, '图集合成'),
        h('div', { className: 'ss-chips' },
          [1024, 2048, 4096].map((s) => h('button', {
            key: s,
            type: 'button',
            className: 'ss-chip-btn',
            'data-active': atlasMax === s ? 'true' : 'false',
            onClick: () => setAtlasMax(s),
          }, `${s}px`)),
        ),
        h('div', { className: 'ss-grid2' },
          h(Field, { label: '间距' },
            h(Num, { value: atlasPadding, min: 0, max: 32, onChange: setAtlasPadding })),
          h(Field, { label: '锚点' },
            h('select', {
              className: 'ss-input',
              value: atlasPivot,
              onChange: (e) => setAtlasPivot(e.target.value),
            },
              h('option', { value: 'center' }, '中心'),
              h('option', { value: 'bottom' }, '脚底居中'),
              h('option', { value: 'topleft' }, '左上角'),
            )),
        ),
        h(Switch, { checked: atlasPot, onChange: setAtlasPot }, '补齐到 2 的幂'),
        h('button', {
          type: 'button',
          className: 'ss-btn primary wide',
          disabled: !sprites.length,
          onClick: () => packAtlas(exportScope),
        }, '打包图集（atlas.png + atlas.json）'),
        h('div', { className: 'ss-hint' },
          '字段照抄 Aseprite 的 frame / spriteSourceSize / sourceSize / pivot，引擎一般能直接读。'),
        h('div', { className: 'ss-row' },
          h('button', { type: 'button', className: 'ss-btn tiny wide', onClick: exportProject, disabled: !sprites.length }, '导出工程'),
          h('button', {
            type: 'button',
            className: 'ss-btn tiny wide',
            onClick: () => projectInputRef.current && projectInputRef.current.click(),
          }, '导入工程'),
        ),
        h('div', { className: 'ss-hint' }, '工程 JSON 带图片本体，用于换机器接着改。'),
      );

      const canvasSection = h(Section, {
        title: '画布',
        aside: `${sprites.length} 个`,
        id: 'canvas',
        open: sections.canvas,
        onToggle: () => toggleSection('canvas'),
      },
        h('div', { className: 'ss-info' },
          h('span', null, `缩放 ${zoomPct}% · 位置 (${Math.round(view.x)}, ${Math.round(view.y)})`),
          h('span', null, '⌘/Ctrl + 滚轮缩放 · 拖空白处平移 · Shift 点选多选'),
          h('span', null, '数据存在本机 IndexedDB，换机器请用「导出工程」。'),
        ),
        h('button', { type: 'button', className: 'ss-btn tiny danger wide', onClick: clearBoard, disabled: !sprites.length }, '清空画布'),
        loadError ? h('div', { className: 'ss-error' }, '本地存储不可用：' + loadError) : null,
      );

      return h('div', { className: 'ss-app', ref: rootRef },
        // 顶部工具栏
        h('div', { className: 'ss-bar' },
          h('div', { className: 'ss-brand' },
            h('span', { className: 'ss-brand-dot' }, h(BrandMark, null)),
            h('span', { className: 'ss-brand-name' }, '切片牢大'),
            h('span', { className: 'ss-count' }, sprites.length ? `${sprites.length} 个精灵` : '空画布'),
          ),
          h('div', { className: 'ss-spacer' }),
          h('button', {
            type: 'button',
            className: 'ss-btn ghost icon',
            disabled: !canUndo,
            title: canUndo ? `撤销（Ctrl+Z）· 还有 ${undoCount} 步` : '没有可撤销的操作',
            'aria-label': '撤销',
            onClick: undo,
          }, h(HistoryIcon, null)),
          h('button', {
            type: 'button',
            className: 'ss-btn ghost icon',
            disabled: !canRedo,
            title: canRedo ? `重做（Ctrl+Shift+Z）· 还有 ${redoCount} 步` : '没有可重做的操作',
            'aria-label': '重做',
            onClick: redo,
          }, h(HistoryIcon, { flip: true })),
          h('div', { className: 'ss-divider' }),
          h('button', {
            type: 'button',
            className: 'ss-btn primary',
            onClick: () => fileInputRef.current && fileInputRef.current.click(),
          }, '导入图片'),
          h('div', { className: 'ss-divider' }),
          h('div', { className: 'ss-zoom' },
            h('button', {
              type: 'button', className: 'ss-btn ghost icon tiny', title: '缩小',
              onClick: () => zoomBy(1 / 1.25), 'aria-label': '缩小',
            }, '−'),
            h('button', {
              type: 'button', className: 'ss-zoom-val', title: '重置为 100%',
              onClick: () => zoomBy(1 / view.zoom),
            }, `${zoomPct}%`),
            h('button', {
              type: 'button', className: 'ss-btn ghost icon tiny', title: '放大',
              onClick: () => zoomBy(1.25), 'aria-label': '放大',
            }, '+'),
            h('button', {
              type: 'button', className: 'ss-btn ghost tiny', title: '适应内容',
              onClick: () => fitTo(boundsOf(sprites)),
            }, '适应'),
          ),
          h('div', { className: 'ss-divider' }),
          h('button', {
            type: 'button', className: 'ss-btn ghost', disabled: !sprites.length,
            onClick: () => setSelection(sprites.map((s) => s.id)),
          }, '全选'),
          h('button', {
            type: 'button', className: 'ss-btn ghost', disabled: !sprites.length,
            title: '打包成 ZIP 下载（内含 PNG + manifest.json）',
            onClick: () => exportZip(selection.length ? 'selection' : 'all'),
          }, '导出'),
        ),
        // 主体
        h('div', { className: 'ss-body' },
          h('div', { className: 'ss-board-wrap' },
            h('div', {
              className: cx('ss-board', panning && 'is-panning'),
              ref: boardRef,
              style: {
                backgroundSize: `${22 * view.zoom}px ${22 * view.zoom}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              },
              onPointerDown: onBoardPointerDown,
              // 中键按下的默认动作是 Chromium 的「自动滚动」，必须挡掉，否则一拖就出来个滚动圈。
              onMouseDown: (e) => { if (e.button === 1) e.preventDefault(); },
              onDragOver,
              onDragLeave,
              onDrop,
            },
              h('div', {
                className: 'ss-world',
                ref: worldRef,
                style: { transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` },
              }, itemNodes, sliceOverlay),
              emptyState,
              dragging ? h('div', { className: 'ss-drop' }, '松手放进画布') : null,
              h('div', { className: 'ss-hud' }, `${zoomPct}% · ${selection.length ? `${selection.length} 选中` : '未选中'}`),
            ),
            busy ? h('div', { className: 'ss-busy', role: 'status' }, h('span', { className: 'ss-spin' }), busy) : null,
            toast
              ? h('div', { className: 'ss-toast', 'data-tone': toast.tone, role: 'status' }, toast.msg)
              : null,
          ),
          h('aside', { className: 'ss-insp', 'aria-label': '精灵检查器' },
            // 十个板块堆在一起，找东西要滚半天 —— 顶部放一排快捷入口，点一下开 + 滚过去
            h('div', { className: 'ss-nav' },
              SECTION_NAV.map((n) => h('button', {
                key: n.id,
                type: 'button',
                className: 'ss-nav-btn',
                'data-active': sections[n.id] ? 'true' : 'false',
                onClick: () => jumpToSection(n.id),
              }, n.label)),
            ),
            h('div', { className: 'ss-insp-scroll' },
              spriteSection,
              sliceSection,
              matteSection,
              bgSection,
              fxSection,
              libSection,
              compSection,
              animSection,
              exportSection,
              canvasSection,
            ),
          ),
        ),
        h('input', {
          ref: fileInputRef,
          type: 'file',
          accept: 'image/*',
          multiple: true,
          tabIndex: -1,
          'aria-hidden': 'true',
          style: HIDDEN_INPUT_STYLE,
          onChange: (e) => {
            const picked = takeInputFiles(e.currentTarget);
            if (picked.length) importFiles(picked, null);
          },
        }),
        h('input', {
          ref: projectInputRef,
          type: 'file',
          accept: 'application/json,.json',
          tabIndex: -1,
          'aria-hidden': 'true',
          style: HIDDEN_INPUT_STYLE,
          onChange: (e) => {
            const [file] = takeInputFiles(e.currentTarget);
            if (file) importProject(file);
          },
        }),
      );
    }

    // ── 错误边界 ──────────────────────────────────────────────────────────
    // 槽位里的组件一旦渲染抛错，宿主只会留下一条 `slot entry crashed` 的控制台记录、
    // 页面上什么都没有。包一层边界，至少把「哪炸了」显示出来，并且能重试。
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
        this.reset = () => this.setState({ err: null });
      }

      static getDerivedStateFromError(err) {
        return { err };
      }

      componentDidCatch(err, info) {
        console.error('[sprite-studio] 渲染失败', err, info);
      }

      render() {
        if (!this.state.err) return this.props.children;
        return h('div', { className: 'ss-app ss-fallback' },
          h('h2', null, '切片牢大出错了'),
          h('pre', null, String(this.state.err && this.state.err.stack ? this.state.err.stack : this.state.err)),
          h('button', { type: 'button', className: 'ss-btn primary', onClick: this.reset }, '重试'),
        );
      }
    }

    function PanelRoot() {
      return h(PanelBoundary, null, h(StudioPanel));
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'sprite-studio: styles');

      // main 先就位：宿主需要「这个 id 有页面」才肯从侧边栏切过去。
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelRoot));

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => '切片牢大' },
          SidebarIcon,
        ));
    }

    // `__test` 只暴露纯函数与组件引用，不参与界面的任何逻辑；
    // tests/ 下的 Node 脚本靠它在无浏览器环境下验证切分/抠图算法与首渲染。
    return {
      inject: ['slots'],
      apply,
      __test: {
        StudioPanel,
        gridRects,
        autoRects,
        applyMatte,
        dominantBorderColor,
        trimAlpha,
        planRestoreDiff,
        takeInputFiles,
        crc32,
        makeZip,
        dataUrlBytes,
        resolveShortcut,
        boardPointerMode,
        overlayDragPosition,
        periodicFbm,
        colorizeTexture,
        warpField,
        fxField,
        FX_PRESETS,
        BAYER4,
        blendFields,
        BLEND_MODES,
        postProcess,
        packChannels,
        gradientStops,
        sampleStops,
        BG_GRADIENTS,
        parseStretch,
        resolveBgStops,
        composeLayout,
        orderLayers,
        lpcUrl,
        filterLibrary,
        shiftPixel,
        transformedSize,
        recipeFromSprites,
        alignSprites,
        distributeSprites,
        lpcCandidates,
        sortLayersByCategory,
        LPC_LIBRARY,
        LPC_ANIMS,
        guessGridFromRects,
        median,
        frameName,
        presetToggle,
        pushPreset,
        popPreset,
        packRects,
        buildAtlasJson,
        nextPow2,
        compareNatural,
        sortFramesByName,
        scanRows,
        splitRowEven,
        GRID_PRESETS,
        LPC_ACTIONS,
        LPC_DIRECTIONS,
        css: CSS,
      },
    };
  },
});      


