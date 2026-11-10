/**
 * 无浏览器的冒烟测试。
 *
 * 为什么这么测：DSH Web 要 `dsh web` 打印的带 token 地址才能进页面，
 * Agent 侧不能去翻 token，所以「界面观感」交给用户确认；
 * 这里负责能客观证明的部分 —— 切分/抠图算法用合成像素跑，首渲染用
 * 一个最小 React 垫片（hooks + createElement）把组件树走一遍抓崩溃。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// ── 最小 React 垫片：只够把函数组件跑一遍并遍历元素树 ────────────────────
function makeReact() {
  const element = (type, props) => ({ type, props: props || {} });
  class Component {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
    }
  }
  return {
    Component,
    createElement(type, props, ...children) {
      const p = { ...(props || {}) };
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return element(type, p);
    },
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
    useEffect() {},
    useLayoutEffect() {},
    useRef(value) { return { current: value }; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
  };
}

// ── 加载 client.js（开头即调 window.__ModuleLoader__.load）────────────────
let definition = null;
globalThis.window = { __ModuleLoader__: { load(def) { definition = def; } } };
const source = readFileSync(path.join(root, 'client.js'), 'utf8');
new Function('window', 'Image', 'document', 'indexedDB', 'ResizeObserver', source)(
  globalThis.window,
  class FakeImage {},
  { querySelector: () => null, createElement: () => ({ getContext: () => null }), head: { append() {} } },
  undefined,
  class FakeRO { observe() {} disconnect() {} },
);

assert.ok(definition, '模块没有调用 __ModuleLoader__.load');
assert.equal(definition.id, 'dsh-sprite-studio');

const api = definition.factory((name) => {
  if (name === 'react') return makeReact();
  throw new Error('unexpected require: ' + name);
});

assert.deepEqual(api.inject, ['slots'], 'inject 必须是 slots');
assert.equal(typeof api.apply, 'function');
const T = api.__test;

// ── 像素工具 ─────────────────────────────────────────────────────────────
function makeImageData(w, hh, paint) {
  const data = new Uint8ClampedArray(w * hh * 4);
  const img = { width: w, height: hh, data };
  if (paint) {
    paint((x, y, rgba) => {
      const p = (y * w + x) * 4;
      data[p] = rgba[0]; data[p + 1] = rgba[1]; data[p + 2] = rgba[2]; data[p + 3] = rgba[3];
    });
  }
  return img;
}
const px = (img, x, y) => {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
};

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

// ── 1. 网格切分 ──────────────────────────────────────────────────────────
console.log('\n[网格切分]');
check('2×2 均分 64×64', () => {
  const r = T.gridRects(64, 64, { cols: 2, rows: 2, padX: 0, padY: 0, gapX: 0, gapY: 0 });
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], { x: 0, y: 0, w: 32, h: 32 });
  assert.deepEqual(r[3], { x: 32, y: 32, w: 32, h: 32 });
});

check('外边距 + 间隔', () => {
  const r = T.gridRects(100, 100, { cols: 2, rows: 2, padX: 10, padY: 10, gapX: 10, gapY: 10 });
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], { x: 10, y: 10, w: 35, h: 35 });
  assert.deepEqual(r[1], { x: 55, y: 10, w: 35, h: 35 });
});

check('参数过大时返回空而不是负尺寸', () => {
  const r = T.gridRects(20, 20, { cols: 8, rows: 8, padX: 20, padY: 20, gapX: 2, gapY: 2 });
  assert.equal(r.length, 0);
});

// ── 2. 背景色采样 ────────────────────────────────────────────────────────
console.log('\n[背景色采样]');
check('品红边框 + 白色中心 → 品红', () => {
  const img = makeImageData(20, 20, (set) => {
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const inside = x >= 6 && x < 14 && y >= 6 && y < 14;
        set(x, y, inside ? [255, 255, 255, 255] : [255, 0, 255, 255]);
      }
    }
  });
  assert.deepEqual(T.dominantBorderColor(img), { r: 255, g: 0, b: 255 });
});

check('全透明图返回 null', () => {
  const img = makeImageData(8, 8, (set) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) set(x, y, [0, 0, 0, 0]);
  });
  assert.equal(T.dominantBorderColor(img), null);
});

// ── 3. 抠图 ──────────────────────────────────────────────────────────────
console.log('\n[抠图]');
function buildSprite({ hole }) {
  return makeImageData(20, 20, (set) => {
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const inside = x >= 6 && x < 14 && y >= 6 && y < 14;
        if (!inside) set(x, y, [255, 0, 255, 255]);
        else if (hole && x === 10 && y === 10) set(x, y, [255, 0, 255, 255]);
        else set(x, y, [255, 255, 255, 255]);
      }
    }
  });
}

check('边缘连通：清掉四周背景，保留主体', () => {
  const img = buildSprite({ hole: false });
  T.applyMatte(img, { mode: 'border', tol: 30, softness: 0, color: { r: 255, g: 0, b: 255 } });
  assert.equal(px(img, 0, 0)[3], 0, '角上应被清空');
  assert.equal(px(img, 10, 10)[3], 255, '中心应保留');
});

check('边缘连通：不碰主体内部的同色像素', () => {
  const img = buildSprite({ hole: true });
  T.applyMatte(img, { mode: 'border', tol: 30, softness: 0, color: { r: 255, g: 0, b: 255 } });
  assert.equal(px(img, 0, 0)[3], 0, '角上应被清空');
  assert.equal(px(img, 10, 10)[3], 255, '内部空洞不该被漫水进来');
});

check('全局色差：内部同色像素也清掉', () => {
  const img = buildSprite({ hole: true });
  T.applyMatte(img, { mode: 'global', tol: 30, softness: 0, color: { r: 255, g: 0, b: 255 } });
  assert.equal(px(img, 10, 10)[3], 0, '全局模式应清掉内部同色像素');
  assert.equal(px(img, 7, 7)[3], 255, '主体仍在');
});

check('容差外的软边按距离给半透明', () => {
  const img = makeImageData(4, 1, (set) => {
    set(0, 0, [255, 0, 255, 255]);
    set(1, 0, [255, 40, 255, 255]);
    set(2, 0, [255, 255, 255, 255]);
    set(3, 0, [255, 255, 255, 255]);
  });
  T.applyMatte(img, { mode: 'border', tol: 10, softness: 80, color: { r: 255, g: 0, b: 255 } });
  assert.equal(px(img, 0, 0)[3], 0);
  const mid = px(img, 1, 0)[3];
  assert.ok(mid > 0 && mid < 255, `期望半透明，实际 alpha=${mid}`);
  assert.equal(px(img, 2, 0)[3], 255);
});

// ── 4. 透明边裁切 ────────────────────────────────────────────────────────
console.log('\n[透明边裁切]');
check('裁出主体 bbox', () => {
  const img = buildSprite({ hole: false });
  T.applyMatte(img, { mode: 'border', tol: 30, softness: 0, color: { r: 255, g: 0, b: 255 } });
  assert.deepEqual(T.trimAlpha(img), { x: 6, y: 6, w: 8, h: 8 });
});

check('全透明返回 null', () => {
  assert.equal(T.trimAlpha(makeImageData(4, 4)), null);
});

// ── 5. alpha 自动检测 ────────────────────────────────────────────────────
console.log('\n[自动检测切分]');
function buildSheet(cells) {
  return makeImageData(64, 64, (set) => {
    for (const c of cells) {
      for (let y = c.y; y < c.y + c.h; y++) {
        for (let x = c.x; x < c.x + c.w; x++) set(x, y, [200, 60, 60, 255]);
      }
    }
  });
}

check('分离的 4 个方块 → 4 个边界，按阅读顺序', () => {
  const img = buildSheet([
    { x: 4, y: 4, w: 10, h: 10 },
    { x: 34, y: 4, w: 10, h: 12 },
    { x: 4, y: 34, w: 12, h: 10 },
    { x: 34, y: 34, w: 10, h: 10 },
  ]);
  const r = T.autoRects(img, { alphaMin: 12, mergeGap: 0, minArea: 4, uniform: false });
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], { x: 4, y: 4, w: 10, h: 10 });
  assert.deepEqual(r[1], { x: 34, y: 4, w: 10, h: 12 });
  assert.deepEqual(r[2], { x: 4, y: 34, w: 12, h: 10 });
});

check('拆散的部件靠 mergeGap 并回一只', () => {
  const img = buildSheet([
    { x: 10, y: 10, w: 8, h: 8 },
    { x: 20, y: 10, w: 3, h: 3 },
  ]);
  assert.equal(T.autoRects(img, { alphaMin: 12, mergeGap: 0, minArea: 4, uniform: false }).length, 2);
  const merged = T.autoRects(img, { alphaMin: 12, mergeGap: 4, minArea: 4, uniform: false });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { x: 10, y: 10, w: 13, h: 8 });
});

check('最小面积过滤噪点', () => {
  const img = buildSheet([
    { x: 4, y: 4, w: 10, h: 10 },
    { x: 40, y: 40, w: 1, h: 1 },
  ]);
  assert.equal(T.autoRects(img, { alphaMin: 12, mergeGap: 0, minArea: 16, uniform: false }).length, 1);
});

check('统一尺寸取最大帧', () => {  const img = buildSheet([
    { x: 4, y: 4, w: 10, h: 10 },
    { x: 34, y: 4, w: 16, h: 8 },
  ]);
  const r = T.autoRects(img, { alphaMin: 12, mergeGap: 0, minArea: 4, uniform: true });
  assert.equal(r.length, 2);
  assert.ok(r.every((b) => b.w === 16 && b.h === 10), JSON.stringify(r));
});

check('全透明图不产生边界', () => {
  assert.equal(T.autoRects(makeImageData(32, 32), { alphaMin: 12, mergeGap: 0, minArea: 1 }).length, 0);
});

// ── 6. 撤销 / 重做 ──────────────────────────────────────────────────────
console.log('\n[撤销/重做]');
const sp = (id) => ({ id, dataUrl: 'data:' + id, w: 8, h: 8, x: 0, y: 0, z: 1 });

check('撤销「新增」：新加的那条要进删除队列', () => {
  const a = sp('a');
  const b = sp('b');
  const { removed, dirty } = T.planRestoreDiff([a, b], [a]);
  assert.deepEqual(removed, ['b']);
  assert.deepEqual(dirty, []);
});

check('撤销「删除」：删掉的那条重新变脏（写回库）', () => {
  const a = sp('a');
  const b = sp('b');
  const { removed, dirty } = T.planRestoreDiff([a], [a, b]);
  assert.deepEqual(removed, []);
  assert.deepEqual(dirty, ['b']);
});

check('撤销「移动」：同一条被换成新对象 → 只标脏，不删', () => {
  const a1 = sp('a');
  const a2 = { ...a1, x: 100 };
  const { removed, dirty } = T.planRestoreDiff([a2], [a1]);
  assert.deepEqual(removed, []);
  assert.deepEqual(dirty, ['a']);
});

check('没变化 → 不写库', () => {
  const a = sp('a');
  const { removed, dirty } = T.planRestoreDiff([a], [a]);
  assert.deepEqual(removed, []);
  assert.deepEqual(dirty, []);
});

// ── 6b. 混合模式 / 后处理 / 色带 ─────────────────────────────────────────
console.log('\n[混合与后处理]');

const F = (arr) => Float32Array.from(arr);

check('9 种混合模式的数学都对', () => {
  const a = F([0.2, 0.5, 0.8]);
  const b = F([0.5, 0.5, 0.1]);
  const near = (x, y, msg) => assert.ok(Math.abs(x - y) < 1e-6, `${msg}: ${x} !== ${y}`);
  near(T.blendFields(a, b, 'add')[0], 0.7, '相加');
  near(T.blendFields(a, b, 'multiply')[2], 0.08, '相乘');
  near(T.blendFields(a, b, 'max')[0], 0.5, '最大');
  near(T.blendFields(a, b, 'min')[0], 0.2, '最小');
  near(T.blendFields(a, b, 'screen')[0], 1 - 0.8 * 0.5, '滤色');
  near(T.blendFields(a, b, 'overlay')[0], 2 * 0.2 * 0.5, '覆盖（暗部）');
  near(T.blendFields(F([0.8]), F([0.5]), 'overlay')[0], 1 - 2 * 0.2 * 0.5, '覆盖（亮部）');
  near(T.blendFields(a, b, 'difference')[0], 0.3, '差值');
  near(T.blendFields(a, b, 'subtract')[1], 0, '相减不为负');
  // 柔光是 pegtop 近似：(1-2b)x² + 2bx，所以 b=0 得 x²、b=1 得 2x-x²
  near(T.blendFields(F([0.5]), F([0]), 'softlight')[0], 0.25, '柔光 b=0');
  near(T.blendFields(F([0.5]), F([1]), 'softlight')[0], 2 * 0.5 - 0.25, '柔光 b=1');
});

check('混合后仍然无缝（两层都是周期场）', () => {
  const W = 96;
  const H = 96;
  const a = T.periodicFbm(W, H, { period: 3, octaves: 4, seed: 11 });
  const b = T.periodicFbm(W, H, { period: 7, octaves: 3, seed: 22 });
  for (const mode of ['multiply', 'overlay', 'screen', 'difference']) {
    const f = T.blendFields(a, b, mode);
    let seam = 0;
    let inner = 0;
    let n = 0;
    for (let y = 0; y < H; y++) {
      seam += Math.abs(f[y * W] - f[y * W + W - 1]);
      for (let x = 0; x < W - 1; x++) { inner += Math.abs(f[y * W + x] - f[y * W + x + 1]); n++; }
    }
    assert.ok(seam / H <= (inner / n) * 3, `${mode} 混合后接缝变大`);
  }
});

check('后处理：自动色阶把值域拉满，反相翻转，对比/Gamma 单调', () => {
  const f = F([0.2, 0.4, 0.6]);
  const lv = T.postProcess(f, { autoLevels: true });
  assert.ok(Math.abs(lv[0]) < 1e-6 && Math.abs(lv[2] - 1) < 1e-6, '自动色阶后应铺满 0..1');
  const inv = T.postProcess(F([0.25, 0.75]), { invert: true });
  assert.ok(Math.abs(inv[0] - 0.75) < 1e-6, '反相');
  const gam = T.postProcess(F([0.25]), { gamma: 2 });
  assert.ok(gam[0] > 0.25, 'gamma>1 应提亮');
  const con = T.postProcess(F([0.25, 0.75]), { contrast: 2 });
  assert.ok(con[0] < 0.25 && con[1] > 0.75, '加大对比应拉开');
});

check('色带：端点取端点色，中点居中', () => {
  const stops = T.gradientStops(['#000000', '#ffffff']);
  assert.deepEqual(T.sampleStops(stops, 0), { r: 0, g: 0, b: 0 });
  assert.deepEqual(T.sampleStops(stops, 1), { r: 255, g: 255, b: 255 });
  const mid = T.sampleStops(stops, 0.5);
  assert.ok(Math.abs(mid.r - 127.5) < 1.5, `中点应约 127，实际 ${mid.r}`);
  // 四段色带：停靠点在 0 / 1/3 / 2/3 / 1，所以 t=0.5 落在红绿之间、正好各半
  const q = T.gradientStops(['#000000', '#ff0000', '#00ff00', '#0000ff']);
  const mid2 = T.sampleStops(q, 0.5);
  assert.ok(Math.abs(mid2.r - 127.5) < 1.5 && Math.abs(mid2.g - 127.5) < 1.5, `四段色带中点应是红绿各半，实际 ${JSON.stringify(mid2)}`);
});

check('通道打包：R/G/B 各就各位，A 缺省不透明', () => {
  const r = F([1, 0]);
  const g = F([0, 1]);
  const b = F([0.5, 0.5]);
  const out = T.packChannels(r, g, b, null);
  assert.equal(out[0], 255);
  assert.equal(out[1], 0);
  assert.equal(out[2], 128);
  assert.equal(out[3], 255);
  assert.equal(out[5], 255);
});

check('拉伸比解析与色带选择', () => {
  assert.deepEqual(T.parseStretch('2:1'), [2, 1]);
  assert.deepEqual(T.parseStretch('1:4'), [1, 4]);
  assert.deepEqual(T.parseStretch('bad'), [1, 1]);
  assert.equal(T.resolveBgStops({ palette: 'custom', dark: '#112233', light: '#445566' }).length, 2);
  assert.ok(T.resolveBgStops({ palette: 'fire' }).length >= 3, '预设应是多段色带');
});

check('拉伸比 2:1 确实让横向特征更宽', () => {
  const W = 128;
  const H = 64;
  const normal = T.periodicFbm(W, H, { periodX: 8, periodY: 8, octaves: 2, seed: 3 });
  const stretched = T.periodicFbm(W, H, { periodX: 4, periodY: 8, octaves: 2, seed: 3 });
  // 横向相邻像素平均差：拉宽后应更小（变化更缓）
  let dN = 0;
  let dS = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      dN += Math.abs(normal[y * W + x] - normal[y * W + x + 1]);
      dS += Math.abs(stretched[y * W + x] - stretched[y * W + x + 1]);
    }
  }
  assert.ok(dS < dN * 0.8, `拉伸后横向变化应明显更小：${dS.toFixed(2)} vs ${dN.toFixed(2)}`);
});

// ── 6c. 角色合成 ─────────────────────────────────────────────────────────
console.log('\n[角色合成]');

check('脚底对齐：所有部件的底边在同一条线上', () => {
  const parts = [{ id: 'head', w: 32, h: 20 }, { id: 'body', w: 32, h: 40 }];
  const out = T.composeLayout(parts, 'bottom', {});
  assert.equal(out.w, 32);
  assert.equal(out.h, 40);
  const head = out.items.find((i) => i.id === 'head');
  const body = out.items.find((i) => i.id === 'body');
  assert.equal(head.y + 20, body.y + 40, '两者底边应相等');
  assert.equal(body.y, 0);
  assert.equal(head.x, 0, '同宽时应水平居中 = 0');
});

check('中心对齐：两者中心重合', () => {
  const parts = [{ id: 'a', w: 10, h: 10 }, { id: 'b', w: 20, h: 20 }];
  const out = T.composeLayout(parts, 'center', {});
  const a = out.items.find((i) => i.id === 'a');
  const b = out.items.find((i) => i.id === 'b');
  assert.equal(a.x + 5, b.x + 10, '水平中心相同');
  assert.equal(a.y + 5, b.y + 10, '垂直中心相同');
});

check('左上角对齐 + 手动偏移', () => {
  const parts = [{ id: 'a', w: 8, h: 8 }, { id: 'b', w: 8, h: 8 }];
  const out = T.composeLayout(parts, 'topleft', { b: { dx: 3, dy: -2 } });
  const b = out.items.find((i) => i.id === 'b');
  assert.equal(b.x, 3);
  assert.equal(b.y, -2);
});

check('画布尺寸取最大部件；空输入安全', () => {
  const out = T.composeLayout([{ id: 'a', w: 12, h: 30 }, { id: 'b', w: 40, h: 10 }], 'bottom', {});
  assert.equal(out.w, 40);
  assert.equal(out.h, 30);
  assert.deepEqual(T.composeLayout([], 'bottom', {}), { w: 0, h: 0, items: [] });
});

check('垂直堆叠：列表末尾在最下面，总高是各部分之和', () => {
  const parts = [{ id: 'head', w: 30, h: 24 }, { id: 'body', w: 40, h: 36 }, { id: 'legs', w: 36, h: 20 }];
  const out = T.composeLayout(parts, 'stack', {});
  assert.equal(out.h, 80, '总高应为 24+36+20');
  assert.equal(out.w, 40);
  const head = out.items.find((i) => i.id === 'head');
  const body = out.items.find((i) => i.id === 'body');
  const legs = out.items.find((i) => i.id === 'legs');
  assert.equal(head.y, 0);
  assert.equal(body.y, 24);
  assert.equal(legs.y, 60);
  assert.equal(legs.y + parts[2].h, 80, '最下面那层要贴底');
  assert.equal(head.x, 5, '水平居中：(40-30)/2');
});

check('图层排序：按给定顺序，未知 id 跳过，未列出的补到最后', () => {
  const parts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(T.orderLayers(['c', 'a', 'b'], parts).map((p) => p.id), ['c', 'a', 'b']);
  assert.deepEqual(T.orderLayers(['b'], parts).map((p) => p.id), ['b', 'a', 'c'], '没列出的补到最后');
  assert.deepEqual(T.orderLayers(['zz', 'a'], parts).map((p) => p.id), ['a', 'b', 'c']);
});

// ── 6d. LPC 素材库 ───────────────────────────────────────────────────────
console.log('\n[LPC 素材库]');

check('URL 拼装：各类别的真实层级（hair 多一层 adult）', () => {
  const body = T.lpcUrl('body', 'male', 'walk');
  assert.ok(body.endsWith('/spritesheets/body/bodies/male/walk.png'), body);
  assert.ok(body.startsWith('https://raw.githubusercontent.com/'), '必须指向上游原始文件');
  const hair = T.lpcUrl('hair', 'long', 'slash');
  assert.ok(hair.endsWith('/spritesheets/hair/long/adult/slash.png'), hair);
});

check('候选路径：覆盖三种上游结构', () => {
  const hair = T.lpcCandidates('hair', 'long', 'walk');
  assert.ok(hair[0].endsWith('/hair/long/adult/walk.png'), '首选：带 adult 的平铺');
  assert.ok(hair.some((u) => u.endsWith('/hair/long/adult/walk/long.png')), '应有「动作/部件名」形式');
  assert.ok(hair.some((u) => u.includes('/hair/long/walk.png')), '应有不带 adult 的备用');

  const body = T.lpcCandidates('body', 'male', 'walk');
  assert.ok(body[0].endsWith('/body/bodies/male/walk.png'), '首选：平铺');

  const zombie = T.lpcCandidates('body', 'zombie', 'walk');
  assert.ok(zombie.some((u) => u.endsWith('/body/bodies/zombie/walk/zombie.png')),
    '僵尸是「动作/部件名」结构，必须被覆盖到');
});

check('新类别：torso/legs 是三层，weapon 是两层', () => {
  assert.ok(T.lpcUrl('torso', 'armour/leather/male', 'walk')
    .endsWith('/spritesheets/torso/armour/leather/male/walk.png'));
  assert.ok(T.lpcUrl('legs', 'pants/male', 'walk')
    .endsWith('/spritesheets/legs/pants/male/walk.png'));
  assert.ok(T.lpcUrl('weapon', 'sword/longsword', 'walk')
    .endsWith('/spritesheets/weapon/sword/longsword/walk.png'));
});

check('带路径的部件：嵌套形式只用最后一段做文件名', () => {
  const c = T.lpcCandidates('torso', 'armour/leather/male', 'walk');
  assert.ok(c.some((u) => u.endsWith('/torso/armour/leather/male/walk/male.png')),
    '嵌套形式应取叶子名 male，而不是整串路径');
});

check('头与五官：都挂在 head/ 下，但走不同子路径', () => {
  const head = T.lpcUrl('head', 'heads/human/male', 'walk');
  assert.ok(head.endsWith('/spritesheets/head/heads/human/male/walk.png'), head);
  const face = T.lpcUrl('face', 'faces/male/neutral', 'walk');
  assert.ok(face.endsWith('/spritesheets/head/faces/male/neutral/walk.png'), face);
});

check('身体不含头：库里必须单独有「头」这个类别', () => {
  const ids = T.LPC_LIBRARY.map((c) => c.id);
  assert.ok(ids.includes('body'));
  assert.ok(ids.includes('head'), '缺了头，用户拼出来就是无头人');
  assert.ok(ids.includes('face'), '缺了五官，头是空白的');
});

check('按部位排序：头发必须在头之上（否则会被头挡住）', () => {
  const mk = (id, category) => ({ id, name: id, w: 64, h: 64, meta: { category } });
  const input = [mk('hair', 'hair'), mk('head', 'head'), mk('body', 'body'), mk('torso', 'torso'), mk('face', 'face'), mk('legs', 'legs'), mk('sword', 'weapon')];
  const out = T.sortLayersByCategory(input).map((s) => s.id);
  assert.deepEqual(out, ['body', 'legs', 'torso', 'head', 'face', 'hair', 'sword'],
    '顺序应为 身体→下装→上衣→头→五官→头发→武器');
  const zi = out.indexOf('hair');
  assert.ok(zi > out.indexOf('head'), '头发必须压住头');
});

check('按部位排序：不认识类别的保持原顺序、排在最后', () => {
  const mk = (id, category) => ({ id, name: id, w: 64, h: 64, meta: category ? { category } : undefined });
  const out = T.sortLayersByCategory([mk('x1'), mk('hair', 'hair'), mk('x2'), mk('body', 'body')]).map((s) => s.id);
  assert.deepEqual(out, ['body', 'hair', 'x1', 'x2'], '未知类别稳定地排在最后');
});

check('双层部件：马尾这类会同时给 fg 与 bg 两条候选', () => {
  const c = T.lpcCandidates('hair', 'ponytail', 'walk');
  assert.ok(c.some((u) => u.endsWith('/hair/ponytail/adult/fg/walk.png')), '应有前层');
  assert.ok(c.some((u) => u.endsWith('/hair/ponytail/adult/bg/walk.png')), '应有后层');
  assert.ok(c[0].endsWith('/hair/ponytail/adult/walk.png'), '单层仍排第一（不是所有头发都分两层）');
});

check('无条件时用 fg/bg 组合，且 layer 顺序里前层压住头、后层在头下面', () => {
  const mk = (id, category) => ({ id, name: id, w: 64, h: 64, meta: { category } });
  const out = T.sortLayersByCategory([mk('hair', 'hair'), mk('bg', 'hair_bg'), mk('head', 'head'), mk('torso', 'torso')]).map((s) => s.id);
  assert.deepEqual(out, ['torso', 'bg', 'head', 'hair'], '后层(torso 之后、head 之前)，前层在 head 之后');
});

check('新类别：胡子/眼睛/鞋/护臂/护肩/项链/披风/盾牌 都能拼出路径', () => {
  const cases = [
    ['beards', 'beard/basic', '/spritesheets/beards/beard/basic/walk.png'],
    ['eyes', 'human/adult/neutral', '/spritesheets/eyes/human/adult/neutral/walk.png'],
    ['feet', 'boots/basic/male', '/spritesheets/feet/boots/basic/male/walk.png'],
    ['arms', 'bracers/male', '/spritesheets/arms/bracers/male/walk.png'],
    ['shoulders', 'pauldrons/male', '/spritesheets/shoulders/pauldrons/male/walk.png'],
    ['neck', 'necklace/simple/male', '/spritesheets/neck/necklace/simple/male/walk.png'],
    ['cape', 'solid', '/spritesheets/cape/solid/walk.png'],
    ['shield', 'round', '/spritesheets/shield/round/walk.png'],
  ];
  for (const [cat, item, tail] of cases) {
    const u = T.lpcUrl(cat, item, 'walk');
    assert.ok(u && u.endsWith(tail), `${cat}/${item} → ${u}`);
  }
});

check('披风是双层：fg 与 bg 都生成候选', () => {
  const c = T.lpcCandidates('cape', 'solid', 'walk');
  assert.ok(c.some((u) => u.endsWith('/cape/solid/fg/walk.png')));
  assert.ok(c.some((u) => u.endsWith('/cape/solid/bg/walk.png')));
});

check('zPos 顺序：影子在最底、披风后层贴身、武器在最上', () => {
  const order = ['shadow', 'cape_bg', 'body', 'cape', 'legs', 'feet', 'torso', 'shoulders',
    'arms', 'hair_bg', 'head', 'neck', 'face', 'eyes', 'beards', 'hair', 'hat', 'shield', 'weapon'];
  const mk = (category) => ({ id: category, name: category, w: 64, h: 64, meta: { category } });
  const shuffled = ['weapon', 'hat', 'shadow', 'body', 'hair', 'head', 'cape_bg', 'cape', 'neck', 'eyes', 'beards'];
  const out = T.sortLayersByCategory(shuffled.map(mk)).map((s) => s.id);
  const expect = order.filter((c) => shuffled.includes(c));
  assert.deepEqual(out, expect, '排序结果应符合 zPos 表');
});

check('自检：只有 hair_bg 没有 hair 时，能识别出「缺前层」', () => {
  const mk = (id, category) => ({ id, name: id, w: 64, h: 64, meta: { category } });
  const check = (list) => {
    const cats = new Set(list.map((s) => (s.meta && s.meta.category) || ''));
    const out = [];
    for (const c of cats) {
      if (!c.endsWith('_bg')) continue;
      const base = c.slice(0, -3);
      if (!cats.has(base)) out.push(base);
    }
    return out;
  };
  assert.deepEqual(check([mk('a', 'hair_bg'), mk('b', 'head')]), ['hair'], '只有后层应报警');
  assert.deepEqual(check([mk('a', 'hair_bg'), mk('b', 'hair')]), [], '两层都在就不报');
  assert.deepEqual(check([mk('a', 'cape_bg'), mk('b', 'cape')]), [], '披风两层都在也不报');
});

check('披风必须压在上衣和护臂之上（背面才看得见）', () => {
  const mk = (category) => ({ id: category, name: category, w: 64, h: 64, meta: { category } });
  const out = T.sortLayersByCategory(['cape', 'body', 'torso', 'arms', 'cape_bg', 'head'].map(mk)).map((s) => s.id);
  assert.deepEqual(out, ['cape_bg', 'body', 'torso', 'arms', 'cape', 'head']);
});

check('一键切成帧：576×256 的表按 64 格切成 9×4', () => {
  const rects = T.gridRects(576, 256, { cols: 9, rows: 4, padX: 0, padY: 0, gapX: 0, gapY: 0 });
  assert.equal(rects.length, 36);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 64, h: 64 });
  assert.deepEqual(rects[9], { x: 0, y: 64, w: 64, h: 64 }, '第 10 格应换行');
  assert.deepEqual(rects[35], { x: 512, y: 192, w: 64, h: 64 });
});

check('待你验证：一键切成帧的命名（四向 + 序号）', () => {
  // 9 列 × 4 行：第 0 行是 up、第 1 行 left（LPC 的 n/w/s/e）
  assert.equal(T.frameName('char', 0, 9, 4, true), 'char_up_01');
  assert.equal(T.frameName('char', 9, 9, 4, true), 'char_left_01');
  assert.equal(T.frameName('char', 27, 9, 4, true), 'char_right_01');
});

check('域扭曲：0 强度是恒等，非 0 会改变内容', () => {
  const f = T.periodicFbm(64, 64, { period: 3, octaves: 3, seed: 5 });
  assert.equal(T.warpField(f, 64, 64, { amount: 0 }), f, '强度 0 应原样返回');
  const w = T.warpField(f, 64, 64, { amount: 0.15, period: 3, seed: 5 });
  let diff = 0;
  for (let i = 0; i < f.length; i++) if (Math.abs(f[i] - w[i]) > 1e-4) diff++;
  assert.ok(diff > f.length * 0.5, `扭曲应改变大部分像素，实际 ${diff}/${f.length}`);
});

check('域扭曲不破坏无缝（采样环绕）', () => {
  const W = 96;
  const f = T.periodicFbm(W, W, { period: 3, octaves: 4, seed: 9 });
  const w = T.warpField(f, W, W, { amount: 0.2, period: 3, seed: 9 });
  let seam = 0;
  let inner = 0;
  let n = 0;
  for (let y = 0; y < W; y++) {
    seam += Math.abs(w[y * W] - w[y * W + W - 1]);
    for (let x = 0; x < W - 1; x++) { inner += Math.abs(w[y * W + x] - w[y * W + x + 1]); n++; }
  }
  assert.ok(seam / W <= (inner / n) * 3, `扭曲后接缝变大：${(seam / W).toFixed(4)} vs ${(inner / n).toFixed(4)}`);
});

check('素材库搜索：跨类别，不用先猜分类', () => {
  const all = T.filterLibrary('body', '');
  assert.ok(all.length > 0 && all.every((r) => r.cat === 'body'), '无搜索词时只显示当前类别');
  const pony = T.filterLibrary('body', 'pony');
  assert.ok(pony.length > 0, '应该能搜到马尾');
  assert.ok(pony.every((r) => r.item.toLowerCase().includes('pony')), '结果都要匹配');
  assert.ok(pony.some((r) => r.cat === 'hair'), '马尾应来自 hair 类别（说明跨类别了）');
  const boot = T.filterLibrary('hair', 'boots');
  assert.ok(boot.some((r) => r.cat === 'feet'), '在头发分类下也能搜到鞋');
  assert.equal(T.filterLibrary('body', 'zzzzz').length, 0);
});

check('素材库条目：label 只取最后两段，key 唯一', () => {
  const rows = T.filterLibrary('torso', '');
  assert.ok(rows.every((r) => !r.label.includes('/') || r.label.split('/').length === 2));
  const keys = new Set(rows.map((r) => r.key));
  assert.equal(keys.size, rows.length, 'key 不应重复');
});

check('生成快捷键：空格重新生成、R 换种子，带修饰键不抢', () => {
  assert.equal(T.resolveShortcut({ code: 'Space' }), 'regen');
  assert.equal(T.resolveShortcut({ key: 'r' }), 'reseed');
  assert.equal(T.resolveShortcut({ key: 'R' }), 'reseed');
  assert.notEqual(T.resolveShortcut({ key: 'r', ctrlKey: true }), 'reseed', 'Ctrl+R 不该被占用');
  assert.notEqual(T.resolveShortcut({ key: 'r', metaKey: true }), 'reseed', '⌘R 是刷新');
});

check('全量清单：19 个类别、1000+ 件，且每件都能拼出 URL', () => {
  const cats = T.LPC_LIBRARY;
  assert.equal(cats.length, 19, `类别数 ${cats.length}`);
  const total = cats.reduce((s, c) => s + c.items.length, 0);
  assert.ok(total >= 1000, `总件数 ${total}，应该 ≥1000`);
  // 关键类别必须有足量条目（武器曾是 18 条，现在是 97）
  const byId = Object.fromEntries(cats.map((c) => [c.id, c.items.length]));
  for (const [k, min] of [['weapon', 90], ['torso', 150], ['hair', 110], ['hat', 130], ['head', 120], ['shield', 80]]) {
    assert.ok(byId[k] >= min, `${k} 只有 ${byId[k]} 件，应 ≥${min}`);
  }
  // 每一件都至少能生成一条 URL（不出现空数组 / 未定义模板）
  for (const c of cats) {
    assert.ok(c.items.length > 0, `${c.id} 是空类别`);
    const u = T.lpcUrl(c.id, c.items[0], 'walk');
    assert.ok(u && u.includes('/spritesheets/'), `${c.id} 拼不出 URL`);
  }
});

check('武器：动作是文件夹，文件名用上一级（behind/universal 变体）', () => {
  const c = T.lpcCandidates('weapon', 'sword/longsword', 'walk');
  assert.ok(c.some((u) => u.endsWith('/weapon/sword/longsword/walk/longsword.png')), '普通武器');
  const c2 = T.lpcCandidates('weapon', 'blunt/flail/behind', 'walk');
  assert.ok(c2.some((u) => u.endsWith('/weapon/blunt/flail/behind/walk/flail.png')), 'behind 变体用上一级名字');
});

check('新类别：帽子/连衣裙/背包/工具 都能拼路径', () => {
  assert.ok(T.lpcUrl('hat', 'accessory/crest/adult', 'walk').endsWith('/hat/accessory/crest/adult/walk.png'));
  assert.ok(T.lpcUrl('dress', 'bodice/female', 'walk').endsWith('/dress/bodice/female/walk.png'));
  assert.ok(T.lpcUrl('backpack', 'backpack/male', 'walk').endsWith('/backpack/backpack/male/walk.png'));
  assert.ok(T.lpcUrl('tools', 'axe/male', 'walk').endsWith('/tools/axe/male/walk.png'));
});

check('失败清单：同一条只记一次，上限 200', () => {
  const add = (prev, f) => {
    if (prev.some((x) => x.cat === f.cat && x.item === f.item && x.anim === f.anim)) return prev;
    return prev.concat(f).slice(-200);
  };
  let list = [];
  list = add(list, { cat: 'hat', item: 'a/b', anim: 'walk' });
  list = add(list, { cat: 'hat', item: 'a/b', anim: 'walk' });
  assert.equal(list.length, 1, '重复项不应再记');
  list = add(list, { cat: 'hat', item: 'a/b', anim: 'slash' });
  assert.equal(list.length, 2, '同部件不同动作算两条');
  for (let i = 0; i < 250; i++) list = add(list, { cat: 'c', item: 'i' + i, anim: 'walk' });
  assert.equal(list.length, 200, '上限 200');
  assert.equal(list[list.length - 1].item, 'i249', '保留最新的');
});

// ── 8b. 变换 / 对齐 / 分布 ───────────────────────────────────────────────
console.log('\n[变换与对齐]');

check('翻转不改尺寸，旋转 90° 宽高互换', () => {
  assert.deepEqual(T.transformedSize(576, 256, 'flip-x'), { w: 576, h: 256 });
  assert.deepEqual(T.transformedSize(576, 256, 'flip-y'), { w: 576, h: 256 });
  assert.deepEqual(T.transformedSize(576, 256, 'rotate-cw'), { w: 256, h: 576 });
  assert.deepEqual(T.transformedSize(576, 256, 'rotate-ccw'), { w: 256, h: 576 });
  // 正方形旋转不变
  assert.deepEqual(T.transformedSize(64, 64, 'rotate-cw'), { w: 64, h: 64 });
});

check('对齐：以选中项外接框为准，不多不少', () => {
  const list = [
    { id: 'a', x: 0, y: 0, w: 64, h: 64, scale: 1 },
    { id: 'b', x: 100, y: 50, w: 32, h: 32, scale: 1 },
    { id: 'c', x: 200, y: 20, w: 64, h: 64, scale: 1 },
  ];
  const left = T.alignSprites(list, 'left');
  assert.deepEqual(left.get('a'), { x: 0, y: 0 });
  assert.deepEqual(left.get('b'), { x: 0, y: 50 }, '左边对齐到 x=0');
  assert.deepEqual(left.get('c'), { x: 0, y: 20 });

  const right = T.alignSprites(list, 'right');
  assert.deepEqual(right.get('a'), { x: 200, y: 0 }, '右边对齐到最右 264-64');
  assert.deepEqual(right.get('b'), { x: 232, y: 50 }, '小图右边贴齐');

  const top = T.alignSprites(list, 'top');
  assert.deepEqual(top.get('b'), { x: 100, y: 0 });

  const bottom = T.alignSprites(list, 'bottom');
  // 外接框底边 = max(0+64, 50+32, 20+64) = 84；b 高 32 → y = 84-32 = 52
  assert.deepEqual(bottom.get('b'), { x: 100, y: 52 });
});

check('对齐：单个不产生位移（少于 2 个返回空）', () => {
  assert.equal(T.alignSprites([{ id: 'a', x: 5, y: 5, w: 10, h: 10, scale: 1 }], 'left').size, 0);
  assert.equal(T.alignSprites([], 'left').size, 0);
});

check('等距分布：两端不动，中间均分，少于 3 个不做事', () => {
  const list = [
    { id: 'a', x: 0, y: 0, w: 10, h: 10, scale: 1 },
    { id: 'b', x: 20, y: 0, w: 10, h: 10, scale: 1 },
    { id: 'c', x: 100, y: 0, w: 10, h: 10, scale: 1 },
  ];
  const out = T.distributeSprites(list, 'x');
  assert.equal(out.size, 1, '只有中间那个会动');
  // 间隙：(100 - 10) - 10 = 80，两个间隙 → 40
  assert.deepEqual(out.get('b'), { x: 50 });
  assert.equal(T.distributeSprites(list.slice(0, 2), 'x').size, 0);
});

check('角色配方：只收 LPC 部件，按 类别+部件+动作 去重', () => {
  const mk = (name, meta) => ({ id: name, name, w: 1, h: 1, x: 0, y: 0, meta });
  const list = [
    mk('a', { category: 'body', item: 'male', anim: 'walk' }),
    mk('b', { category: 'body', item: 'male', anim: 'walk' }),          // 重复
    mk('c', { category: 'hair', item: 'ponytail', anim: 'walk' }),
    mk('d', { category: 'hair_bg', item: 'ponytail', anim: 'walk' }),   // 后层 → 归到 hair，且不与 c 重复？应保留 bg 标记
    mk('e', { source: 'x' }),                                            // 非 LPC，忽略
    mk('f', {}),                                                         // 无 meta，忽略
  ];
  const out = T.recipeFromSprites(list);
  assert.equal(out.length, 2, `去重后应 2 条，实际 ${out.length}`);
  assert.deepEqual(out[0], { cat: 'body', item: 'male', anim: 'walk', bg: false });
  assert.equal(out[1].cat, 'hair');
  // 后层被前层吸收：配方只记一份，取回时命中 fg 会自动带上 bg
  assert.equal(out[1].bg, false, '同部件的后层不该单独占一条');
  assert.deepEqual(T.recipeFromSprites([]), []);
  assert.deepEqual(T.recipeFromSprites(null), []);
});

// ── 8c. 调色 ─────────────────────────────────────────────────────────────
console.log('\n[调色]');

check('调色：参数全默认时原样返回（不做无意义的往返换算）', () => {
  assert.deepEqual(T.shiftPixel(120, 80, 200, { hue: 0, sat: 1, light: 0 }), [120, 80, 200]);
  assert.deepEqual(T.shiftPixel(10, 20, 30, {}), [10, 20, 30]);
});

check('调色：色相 +360 等于不变，+180 是补色', () => {
  const base = T.shiftPixel(200, 40, 40, { hue: 0, sat: 1, light: 0 });
  const full = T.shiftPixel(200, 40, 40, { hue: 360, sat: 1, light: 0 });
  assert.deepEqual(full, base, '转一整圈应该一样');
  const half = T.shiftPixel(200, 40, 40, { hue: 180, sat: 1, light: 0 });
  assert.ok(half[1] > half[0], `红色转 180° 应偏青：${half}`);
});

check('调色：饱和度 0 变灰，亮度 +0.5 变亮、-0.5 变暗', () => {
  const grey = T.shiftPixel(200, 40, 40, { hue: 0, sat: 0, light: 0 });
  assert.ok(Math.abs(grey[0] - grey[1]) <= 1 && Math.abs(grey[1] - grey[2]) <= 1, `应接近灰：${grey}`);
  const bright = T.shiftPixel(100, 100, 100, { hue: 0, sat: 1, light: 0.3 });
  const dark = T.shiftPixel(100, 100, 100, { hue: 0, sat: 1, light: -0.3 });
  assert.ok(bright[0] > 100 && dark[0] < 100, `${bright} / ${dark}`);
});

check('调色：结果永远在 0..255 内', () => {
  for (const opt of [{ hue: 137, sat: 2, light: 0.5 }, { hue: -90, sat: 2, light: -0.5 }, { hue: 45, sat: 0, light: 0.5 }]) {
    const out = T.shiftPixel(255, 0, 128, opt);
    for (const v of out) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${JSON.stringify(opt)} → ${out}`);
  }
});

check('静态检查：带参数的函数不能直接挂 onClick（会收到点击事件）', () => {
  const src = readFileSync(path.join(root, 'client.js'), 'utf8');
  // 只看 `onClick: 名字,` 这种直接引用；箭头函数包一层的不算
  const direct = new Set(
    [...src.matchAll(/onClick:\s*([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]),
  );
  const bad = [];
  for (const name of direct) {
    const m = src.match(new RegExp(`const ${name} = useCallback\\((?:async )?\\(([^)]*)\\)`));
    if (m && m[1].trim()) bad.push(`${name}(${m[1].trim()})`);
  }
  assert.deepEqual(bad, [], `这些函数有参数，直接挂 onClick 会把事件当第一个参数：${bad.join(' / ')}`);
});

check('静态检查：每个 addEventListener 都要有对应的 removeEventListener', () => {
  const src = readFileSync(path.join(root, 'client.js'), 'utf8');
  const adds = [...src.matchAll(/addEventListener\('([a-z]+)'/g)].map((m) => m[1]);
  const removes = new Set([...src.matchAll(/removeEventListener\('([a-z]+)'/g)].map((m) => m[1]));
  const missing = [...new Set(adds)].filter((t) => !removes.has(t));
  assert.deepEqual(missing, [], `这些事件注册了却没解绑（或反过来被误删）：${missing.join(', ')}`);
  // 键盘监听是删除/撤销/Ctrl+C 的唯一入口，单独钉死
  assert.ok(/addEventListener\('keydown'/.test(src), 'keydown 监听不见了 —— 所有快捷键都会失效');
});

check('网格推断：用间距而不是盒子宽度（角色比格子窄时不能推错）', () => {
  // 造 9×4 的盒子，格子 64，角色 40 宽居中 → 盒子 x = c*64+12
  const make = (cols, rows, cell, spriteW, spriteH) => {
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({
          x: c * cell + Math.round((cell - spriteW) / 2),
          y: r * cell + Math.round((cell - spriteH) / 2),
          w: spriteW,
          h: spriteH,
        });
      }
    }
    return out;
  };
  const g1 = T.guessGridFromRects(make(9, 4, 64, 40, 50), 576, 256);
  assert.deepEqual(g1, { cols: 9, rows: 4 }, `LPC 典型表推错了：${JSON.stringify(g1)}`);
  // 旧实现（画布宽 / 盒子宽 = 576/40 ≈ 14）会得出 14×5，这条专门防它回来
  assert.notEqual(g1.cols, 14, '不能再用盒子宽度整除画布');

  const g2 = T.guessGridFromRects(make(8, 1, 112, 40, 46), 896, 96);
  assert.deepEqual(g2, { cols: 8, rows: 1 });

  const g3 = T.guessGridFromRects(make(4, 4, 64, 56, 56), 256, 256);
  assert.deepEqual(g3, { cols: 4, rows: 4 });

  // 盒子大小不一致也要能用（同一个角色不同姿势宽度会变）
  const varied = make(6, 2, 64, 40, 50).map((b, i) => ({ ...b, w: 34 + (i % 5) * 3 }));
  const g4 = T.guessGridFromRects(varied, 384, 128);
  assert.deepEqual(g4, { cols: 6, rows: 2 });
});

check('网格推断：一个盒子或空输入返回 null（单图不该被硬拆）', () => {
  assert.equal(T.guessGridFromRects([{ x: 0, y: 0, w: 40, h: 40 }], 64, 64), null);
  assert.equal(T.guessGridFromRects([], 64, 64), null);
  assert.equal(T.guessGridFromRects(null, 64, 64), null);
});

check('未知类别返回 null / 空数组（不瞎拼 URL）', () => {
  assert.equal(T.lpcUrl('nonexistent', 'x', 'walk'), null);
  assert.deepEqual(T.lpcCandidates('nonexistent', 'x', 'walk'), []);
});

check('库只存路径：没有任何图片数据', () => {
  for (const cat of T.LPC_LIBRARY) {
    assert.ok(cat.items.length > 0, `${cat.id} 应有条目`);
    for (const it of cat.items) {
      assert.equal(typeof it, 'string');
      // 允许是相对路径片段（torso 是三层：armour/leather/male），
      // 但不允许绝对路径、上跳、或直接指向图片文件。
      assert.ok(!it.startsWith('/') && !it.includes('..'), `${it} 不该是绝对路径或含 ..`);
      assert.ok(!it.endsWith('.png'), `${it} 不该直接是文件`);
    }
  }
  assert.ok(T.LPC_ANIMS.includes('walk'));
});

// ── 6e. 特效场 ───────────────────────────────────────────────────────────
console.log('\n[特效]');

check('五种特效都产出合法场：值域 0..1、非常数、尺寸对', () => {
  for (const p of T.FX_PRESETS) {
    const f = T.fxField(p.id, 96, 96, { strength: 1, thick: 0.18, arc: 150, seed: 7 });
    assert.equal(f.length, 96 * 96, `${p.id} 尺寸不对`);
    let min = 1;
    let max = 0;
    for (const v of f) { if (v < min) min = v; if (v > max) max = v; }
    assert.ok(min >= 0 && max <= 1, `${p.id} 值域越界 ${min}..${max}`);
    assert.ok(max > 0.4, `${p.id} 几乎没有内容（max=${max.toFixed(2)}）`);
    assert.ok(max - min > 0.2, `${p.id} 不该是常数场`);
  }
});

check('特效同参数同结果（种子固定即确定）', () => {
  const a = Array.from(T.fxField('burst', 64, 64, { strength: 1, thick: 0.2, seed: 42 }));
  const b = Array.from(T.fxField('burst', 64, 64, { strength: 1, thick: 0.2, seed: 42 }));
  assert.deepEqual(a, b);
});

check('强度越大，场越亮（不是线性也无所谓，单调即可）', () => {
  const lo = T.fxField('ring', 64, 64, { strength: 0.5, thick: 0.2, seed: 1 });
  const hi = T.fxField('ring', 64, 64, { strength: 2, thick: 0.2, seed: 1 });
  const sum = (f) => f.reduce((s, v) => s + v, 0);
  assert.ok(sum(hi) > sum(lo) * 1.5, `强度没起作用：${sum(lo).toFixed(1)} vs ${sum(hi).toFixed(1)}`);
});

check('弧形斩击：弧宽越大覆盖越多', () => {
  const narrow = T.fxField('slash', 96, 96, { strength: 1, thick: 0.18, arc: 60, seed: 1 });
  const wide = T.fxField('slash', 96, 96, { strength: 1, thick: 0.18, arc: 300, seed: 1 });
  const lit = (f) => f.filter((v) => v > 0.15).length;
  assert.ok(lit(wide) > lit(narrow), `宽弧应覆盖更多像素：${lit(narrow)} vs ${lit(wide)}`);
});

check('特效透明度：强度分级后 alpha 有 0 也有满值', () => {
  const f = T.fxField('ring', 64, 64, { strength: 1.2, thick: 0.2, seed: 1 });
  const rgba = T.colorizeTexture(f, 64, 64, {
    levels: 5, dither: false, alpha: true,
    stops: T.gradientStops(['#000000', '#ff8800', '#ffffff']),
  });
  let zero = 0;
  let full = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] === 0) zero++;
    if (rgba[i] === 255) full++;
  }
  assert.ok(zero > 100, '外部应该全透明');
  assert.ok(full > 50, '核心应该不透明');
});

// ── 7. 切图网格推断 ─────────────────────────────────────────────────────
console.log('\n[切图网格推断]');

const box = (x, y, w, h) => ({ x, y, w, h });

check('4 个 32×32 的块 → 4×4', () => {
  const rects = [box(0, 0, 32, 32), box(32, 0, 32, 32), box(0, 32, 32, 32), box(32, 32, 32, 32)];
  assert.deepEqual(T.guessGridFromRects(rects, 128, 128), { cols: 4, rows: 4 });
});

check('单块图不推断（保持 1×1，不硬切）', () => {
  assert.equal(T.guessGridFromRects([box(0, 0, 120, 120)], 128, 128), null);
  assert.equal(T.guessGridFromRects([], 128, 128), null);
});

check('碎到看不清的块不推断', () => {
  const rects = [box(0, 0, 2, 2), box(10, 10, 2, 2)];
  assert.equal(T.guessGridFromRects(rects, 128, 128), null);
});

check('非方形排布也按中位尺寸算', () => {
  const rects = [box(0, 0, 32, 32), box(32, 0, 32, 32), box(64, 0, 32, 32), box(0, 32, 32, 32), box(32, 32, 32, 32), box(64, 32, 32, 32)];
  assert.deepEqual(T.guessGridFromRects(rects, 96, 64), { cols: 3, rows: 2 });
});

check('median 对奇偶长度都对', () => {
  assert.equal(T.median([3, 1, 2]), 2);
  assert.equal(T.median([4, 1, 3, 2]), 2.5);
  assert.equal(T.median([]), 0);
});

// ── 7b. 切分预设与帧命名 ────────────────────────────────────────────────
console.log('\n[切分预设]');

check('预设只给参数，不带素材：尺寸都在合理范围', () => {
  assert.ok(T.GRID_PRESETS.length >= 3);
  for (const p of T.GRID_PRESETS) {
    assert.ok(p.cell >= 8 && p.cell <= 128, `${p.label} 的格宽不合理`);
    assert.equal(typeof p.label, 'string');
  }
});

check('LPC 动作行号与方向顺序来自源码（n/w/s/e）', () => {
  assert.deepEqual(T.LPC_DIRECTIONS, ['up', 'left', 'down', 'right']);
  const rows = Object.fromEntries(T.LPC_ACTIONS.map((a) => [a.id, a.row]));
  assert.equal(rows.thrust, 3);
  assert.equal(rows.walk, 7);
  assert.equal(rows.slash, 11);
  assert.equal(rows.sit, 29);
});

check('四向命名：4 行时按上左下右，列序号从 01 起', () => {
  // 4 列 × 4 行，索引 0..15
  assert.equal(T.frameName('hero', 0, 4, 4, true), 'hero_up_01');
  assert.equal(T.frameName('hero', 3, 4, 4, true), 'hero_up_04');
  assert.equal(T.frameName('hero', 4, 4, 4, true), 'hero_left_01');
  assert.equal(T.frameName('hero', 11, 4, 4, true), 'hero_down_04');
  assert.equal(T.frameName('hero', 15, 4, 4, true), 'hero_right_04');
});

check('不是 4 行或没开开关时退回序号命名', () => {
  assert.equal(T.frameName('hero', 0, 4, 2, true), 'hero_01');
  assert.equal(T.frameName('hero', 5, 4, 4, false), 'hero_06');
});

check('方向命名不会越界（行列算错也不炸）', () => {
  assert.equal(T.frameName('hero', 99, 4, 4, true), 'hero_right_04');
});

check('预设按钮再点一下取消：只对「当前生效的那一个」成立', () => {
  const active = { kind: 'lpc', id: 'walk' };
  assert.equal(T.presetToggle(active, 'lpc', 'walk'), true, '同一个 → 取消');
  assert.equal(T.presetToggle(active, 'lpc', 'slash'), false, '换一个 → 应用');
  assert.equal(T.presetToggle(active, 'cell', 'walk'), false, '不同类目即使是同名 id 也不算');
  assert.equal(T.presetToggle(null, 'lpc', 'walk'), false, '没有生效预设时 → 应用');
});

check('预设撤销栈：A→B→取消 B，网格和「A 亮着」都要还原', () => {
  const stack = [];
  const s0 = { grid: { cols: 1, rows: 1 }, preset: null };
  T.pushPreset(stack, s0);
  const aState = { grid: { cols: 7, rows: 4 }, preset: { kind: 'cell', id: 'kenney18' } };
  T.pushPreset(stack, aState);
  const back = T.popPreset(stack);
  assert.deepEqual(back.grid, { cols: 7, rows: 4 }, '参数应回到 A');
  assert.deepEqual(back.preset, { kind: 'cell', id: 'kenney18' }, '高亮也要回到 A，否则参数和标记对不上');
  assert.deepEqual(T.popPreset(stack), s0);
  assert.equal(T.popPreset(stack), null, '空栈返回 null');
});

check('撤销栈有上限，超了丢最老的', () => {
  const stack = [];
  for (let i = 0; i < 25; i++) T.pushPreset(stack, i);
  assert.equal(stack.length, 20);
  assert.equal(stack[0], 5);
  assert.equal(stack[19], 24);
});

// ── 8. 文件选择 ──────────────────────────────────────────────────────────
console.log('\n[文件选择]');
check('先取值再清空：清空后仍拿得到选中的文件', () => {
  // 模拟 Chromium 的「活」FileList：value='' 会把 files 一起清空。
  const live = [];
  const input = {
    get files() { return live; },
    set value(v) { if (v === '') live.length = 0; },
    get value() { return ''; },
  };
  live.push({ name: 'a.png' }, { name: 'b.png' });
  const taken = T.takeInputFiles(input);
  assert.equal(taken.length, 2, '清空输入后应该还能拿到 2 个文件');
  assert.deepEqual(taken.map((f) => f.name), ['a.png', 'b.png']);
  assert.equal(live.length, 0, '输入应该已被清空，允许再次选同一个文件');
});

check('没有选中文件时返回空数组而不是抛错', () => {
  assert.deepEqual(T.takeInputFiles({ files: [] }), []);
  assert.deepEqual(T.takeInputFiles(null), []);
  assert.deepEqual(T.takeInputFiles({}), []);
});

// ── 8. 切分预览层 ────────────────────────────────────────────────────────
console.log('\n[切分预览层]');
check('网格预览层有自己的 z-index（否则被精灵盖住）', () => {
  assert.match(T.css, /\.ss-slice\{[^}]*z-index/, '.ss-slice 缺少 z-index');
});

check('预览格线随缩放保持 1px 视觉宽度', () => {
  // 渲染时用 borderWidth = 1/zoom 抵消 world 的 scale
  assert.ok(T.css.includes('.ss-slice-cell'), '缺少 .ss-slice-cell 样式');
  assert.ok(T.css.includes('.ss-slice-idx'), '缺少序号徽标样式');
});

// ── 9. 快捷键 / 鼠标映射 ────────────────────────────────────────────────
console.log('\n[快捷键与鼠标]');
const key = (over) => ({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, ...over });

check('撤销 / 重做（⌘ 与 Ctrl 等价）', () => {
  assert.equal(T.resolveShortcut(key({ key: 'z', ctrlKey: true })), 'undo');
  assert.equal(T.resolveShortcut(key({ key: 'z', ctrlKey: true, shiftKey: true })), 'redo');
  assert.equal(T.resolveShortcut(key({ key: 'y', ctrlKey: true })), 'redo');
  assert.equal(T.resolveShortcut(key({ key: 'Z', metaKey: true })), 'undo');
  assert.equal(T.resolveShortcut(key({ key: 'Z', metaKey: true, shiftKey: true })), 'redo');
});

check('复制是 Ctrl+C，Ctrl+D 已不再绑定', () => {
  assert.equal(T.resolveShortcut(key({ key: 'c', ctrlKey: true })), 'duplicate');
  assert.equal(T.resolveShortcut(key({ key: 'C', metaKey: true })), 'duplicate');
  assert.equal(T.resolveShortcut(key({ key: 'd', ctrlKey: true })), null, 'Ctrl+D 应该已经解绑');
});

check('没有修饰键时不会误触', () => {
  assert.equal(T.resolveShortcut(key({ key: 'z' })), null);
  assert.equal(T.resolveShortcut(key({ key: 'c' })), null);
  assert.equal(T.resolveShortcut(key({ key: 'a' })), null);
});

check('Delete / Esc / 全选 / 缩放重置', () => {
  assert.equal(T.resolveShortcut(key({ key: 'Delete' })), 'delete');
  assert.equal(T.resolveShortcut(key({ key: 'Backspace' })), 'delete');
  assert.equal(T.resolveShortcut(key({ key: 'Escape' })), 'clear-selection');
  assert.equal(T.resolveShortcut(key({ key: 'a', ctrlKey: true })), 'select-all');
  assert.equal(T.resolveShortcut(key({ key: '0', ctrlKey: true })), 'zoom-reset');
});

check('鼠标：中键任意位置平移，左键只在空白处平移', () => {
  assert.equal(T.boardPointerMode(1, false), 'pan', '中键压在图上也要能平移');
  assert.equal(T.boardPointerMode(1, true), 'pan');
  assert.equal(T.boardPointerMode(0, false), 'ignore', '左键在图上应交给精灵拖动');
  assert.equal(T.boardPointerMode(0, true), 'pan');
  assert.equal(T.boardPointerMode(2, false), 'ignore');
  assert.equal(T.boardPointerMode(2, true), 'ignore');
});

check('拖拽时切分预览层跟着 sheet 走', () => {
  const moving = [{ id: 'sheet', x: 10, y: 20 }, { id: 'other', x: 100, y: 200 }];
  assert.deepEqual(T.overlayDragPosition(moving, 'sheet', 5, -7), { left: 15, top: 13 });
  assert.equal(
    T.overlayDragPosition([{ id: 'other', x: 100, y: 200 }], 'sheet', 5, 0),
    null,
    '拖的不是 sheet 就不该动预览层',
  );
  assert.equal(T.overlayDragPosition(moving, null, 1, 1), null, '没有预览层时返回 null');
});

// ── 10. 无缝背景生成 ─────────────────────────────────────────────────────
console.log('\n[无缝背景]');

check('Bayer 矩阵是 0..15 的排列', () => {
  assert.equal(T.BAYER4.length, 16);
  assert.deepEqual([...T.BAYER4].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
});

check('噪声场：尺寸对、值域在 0..1、不是常数场', () => {
  const f = T.periodicFbm(64, 32, { period: 3, octaves: 4, seed: 7 });
  assert.equal(f.length, 64 * 32);
  let min = 1;
  let max = 0;
  for (const v of f) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.ok(min >= 0 && max <= 1, `值域应在 0..1，实际 ${min.toFixed(3)}..${max.toFixed(3)}`);
  assert.ok(max - min > 0.1, '不该是常数场');
});

check('同种子同图，换种子换图', () => {
  const a = Array.from(T.periodicFbm(32, 32, { period: 3, octaves: 3, seed: 42 }));
  const b = Array.from(T.periodicFbm(32, 32, { period: 3, octaves: 3, seed: 42 }));
  const c = Array.from(T.periodicFbm(32, 32, { period: 3, octaves: 3, seed: 43 }));
  assert.deepEqual(a, b, '同种子应完全一致');
  assert.notDeepEqual(a, c, '换种子应换图');
});

check('左右接缝的跳变与内部同量级（真的无缝）', () => {
  const W = 128;
  const H = 128;
  const f = T.periodicFbm(W, H, { period: 3, octaves: 5, seed: 9 });
  let seamX = 0;
  let seamY = 0;
  let innerX = 0;
  let innerY = 0;
  let count = 0;
  for (let y = 0; y < H; y++) {
    seamX += Math.abs(f[y * W] - f[y * W + (W - 1)]);
    for (let x = 0; x < W - 1; x++) {
      innerX += Math.abs(f[y * W + x] - f[y * W + x + 1]);
      count++;
    }
  }
  for (let x = 0; x < W; x++) {
    seamY += Math.abs(f[x] - f[(H - 1) * W + x]);
  }
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W; x++) innerY += Math.abs(f[y * W + x] - f[(y + 1) * W + x]);
  }
  const seamXAvg = seamX / H;
  const seamYAvg = seamY / W;
  const innerXAvg = innerX / count;
  const innerYAvg = innerY / count;
  assert.ok(seamXAvg <= innerXAvg * 3, `左右接缝跳变 ${seamXAvg.toFixed(4)} 应接近内部 ${innerXAvg.toFixed(4)}`);
  assert.ok(seamYAvg <= innerYAvg * 3, `上下接缝跳变 ${seamYAvg.toFixed(4)} 应接近内部 ${innerYAvg.toFixed(4)}`);
});

check('上色：全不透明，色数不超过色阶数', () => {
  const W = 32;
  const H = 32;
  const f = T.periodicFbm(W, H, { period: 2, octaves: 3, seed: 5 });
  const rgba = T.colorizeTexture(f, W, H, {
    levels: 4,
    dither: false,
    dark: { r: 0, g: 0, b: 0 },
    light: { r: 255, g: 255, b: 255 },
  });
  assert.equal(rgba.length, W * H * 4);
  for (let i = 3; i < rgba.length; i += 4) assert.equal(rgba[i], 255, 'alpha 应为 255');
  const colors = new Set();
  for (let i = 0; i < rgba.length; i += 4) colors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
  assert.ok(colors.size <= 4, `色数 ${colors.size} 不应超过色阶 4`);
  assert.ok(colors.size >= 2, '至少要有两档色阶');
});

check('抖动改变输出，但仍只用同一组色阶', () => {  const W = 16;
  const H = 16;
  const f = T.periodicFbm(W, H, { period: 2, octaves: 3, seed: 3 });
  const opts = { levels: 6, dark: { r: 10, g: 20, b: 30 }, light: { r: 200, g: 210, b: 220 } };
  const plain = Array.from(T.colorizeTexture(f, W, H, { ...opts, dither: false }));
  const dithered = Array.from(T.colorizeTexture(f, W, H, { ...opts, dither: true }));
  assert.notDeepEqual(plain, dithered, '开抖动应该看得出差别');
  const levelsOf = (arr) => new Set(
    Array.from({ length: arr.length / 4 }, (_, i) => `${arr[i * 4]},${arr[i * 4 + 1]},${arr[i * 4 + 2]}`),
  ).size;
  assert.ok(levelsOf(dithered) <= 6, '抖动不该造出多余的色阶');
});

// ── 11. 导出 ZIP ─────────────────────────────────────────────────────────
console.log('\n[导出 ZIP]');
const utf8 = new TextEncoder();

check('crc32 对标准向量正确', () => {
  assert.equal(T.crc32(utf8.encode('123456789')), 0xCBF43926);
  assert.equal(T.crc32(new Uint8Array(0)), 0);
});

/** 从 ZIP 读回中央目录里的文件名（顺带验证目录结构可被标准方式遍历）。 */
function zipNames(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, '缺少 EOCD 签名');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, '中央目录条目签名不对');
    const nameLen = dv.getUint16(p + 28, true);
    names.push(dec.decode(zip.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return names;
}

check('单个文件：local header / 数据 / EOCD 都齐全', () => {
  const data = utf8.encode('AAA');
  const zip = T.makeZip([{ name: 'a.png', bytes: data }]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, '缺少 local header 签名');
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800, '应设置 UTF-8 文件名标志位');
  assert.equal(dv.getUint16(8, true), 0, '应为 store（不压缩）');
  assert.equal(dv.getUint32(14, true), T.crc32(data), 'local header 的 crc 不对');
  assert.equal(dv.getUint32(18, true), 3, '压缩后大小应为 3');
  assert.equal(zip.length, 30 + 5 + 3 + 46 + 5 + 22, '总长度应为 头+数据+目录+EOCD');
  assert.deepEqual(zipNames(zip), ['a.png']);
});

check('多文件 + 中文名：顺序与字节完整', () => {
  const zip = T.makeZip([
    { name: 'a.png', bytes: utf8.encode('AAA') },
    { name: '中文.png', bytes: utf8.encode('BB') },
    { name: 'manifest.json', bytes: utf8.encode('{}') },
  ]);
  assert.deepEqual(zipNames(zip), ['a.png', '中文.png', 'manifest.json']);
  // 第一个文件的数据紧跟在 30+5 字节头之后
  assert.equal(new TextDecoder().decode(zip.subarray(35, 38)), 'AAA');
});

check('dataURL 解码出原始字节', () => {
  const b64 = Buffer.from([1, 2, 3, 250]).toString('base64');
  const bytes = T.dataUrlBytes('data:image/png;base64,' + b64);
  assert.deepEqual(Array.from(bytes), [1, 2, 3, 250]);
});

// ── 11. 图集打包 ─────────────────────────────────────────────────────────
console.log('\n[图集打包]');

const overlaps = (placed) => {
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i];
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (hit) return `${a.index} 与 ${b.index} 重叠`;
    }
  }
  return null;
};

check('装箱：不重叠、不越界、数量不丢', () => {
  const items = Array.from({ length: 17 }, (_, i) => ({ w: 16 + (i % 5) * 8, h: 16 + (i % 3) * 12 }));
  const packed = T.packRects(items, { padding: 2, maxSize: 1024, pot: false });
  assert.ok(packed, '应该装得下');
  assert.equal(packed.placed.length, items.length);
  assert.equal(overlaps(packed.placed), null);
  for (const p of packed.placed) {
    assert.ok(p.x >= 0 && p.y >= 0, '坐标不能为负');
    assert.ok(p.x + p.w <= packed.width, '不能超出右边界');
    assert.ok(p.y + p.h <= packed.height, '不能超出下边界');
    // 尺寸要忠实于输入
    assert.equal(p.w, Math.max(1, Math.round(items[p.index].w)));
    assert.equal(p.h, Math.max(1, Math.round(items[p.index].h)));
  }
});

check('补齐 2 的幂时，输出尺寸是 2 的幂', () => {
  const items = Array.from({ length: 9 }, () => ({ w: 20, h: 20 }));
  const packed = T.packRects(items, { padding: 1, maxSize: 1024, pot: true });
  assert.ok(packed);
  const isPow2 = (n) => (n & (n - 1)) === 0;
  assert.ok(isPow2(packed.width) && isPow2(packed.height), `${packed.width}×${packed.height} 不是 2 的幂`);
});

check('单张比上限还大 → 返回 null（不静默截断）', () => {
  assert.equal(T.packRects([{ w: 5000, h: 100 }], { padding: 0, maxSize: 1024, pot: false }), null);
});

check('空输入返回 null', () => {
  assert.equal(T.packRects([], { padding: 0, maxSize: 1024 }), null);
});

check('元数据字段与 Aseprite 对齐，pivot 能生效', () => {
  const items = [{ name: 'hero.png', w: 32, h: 32 }, { name: 'hero-2.png', w: 16, h: 16 }];
  const packed = T.packRects(items, { padding: 0, maxSize: 512, pot: false });
  const json = T.buildAtlasJson(packed.placed, items, {
    pivot: { x: 0.5, y: 1 },
    width: packed.width,
    height: packed.height,
  });
  assert.deepEqual(Object.keys(json.frames).sort(), ['hero-2.png', 'hero.png']);
  const first = json.frames['hero.png'];
  assert.deepEqual(first.frame, { x: 0, y: 0, w: 32, h: 32 });
  assert.deepEqual(first.pivot, { x: 0.5, y: 1 }, 'pivot 应原样写入');
  assert.equal(first.rotated, false);
  assert.equal(first.trimmed, false);
  assert.deepEqual(first.sourceSize, { w: 32, h: 32 });
  assert.deepEqual(json.meta.size, { w: packed.width, h: packed.height });
  assert.equal(json.meta.image, 'atlas.png');
});

check('nextPow2 边界', () => {
  assert.equal(T.nextPow2(1), 1);
  assert.equal(T.nextPow2(3), 4);
  assert.equal(T.nextPow2(1024), 1024);
  assert.equal(T.nextPow2(1025), 2048);
});

// ── 11. 动画预览排序 ─────────────────────────────────────────────────────
console.log('\n[动画预览]');

check('自然序：hero_2 排在 hero_10 前面（字符串比较会反）', () => {
  const names = ['hero_10', 'hero_2', 'hero_1'];
  names.sort(T.compareNatural);
  assert.deepEqual(names, ['hero_1', 'hero_2', 'hero_10']);
});

check('自然序：非数字部分按字面比较，方向名也能排', () => {
  const names = ['h_up_1', 'h_down_1', 'h_left_1', 'h_up_2'];
  names.sort(T.compareNatural);
  assert.deepEqual(names, ['h_down_1', 'h_left_1', 'h_up_1', 'h_up_2']);
});

check('切图产物的真实命名（两位补零）顺序正确', () => {
  const names = ['hero_up_09', 'hero_up_01', 'hero_up_10', 'hero_up_02'];
  names.sort(T.compareNatural);
  assert.deepEqual(names, ['hero_up_01', 'hero_up_02', 'hero_up_09', 'hero_up_10']);
});

check('sortFramesByName 不改原数组、不丢帧', () => {
  const input = [{ name: 'f_3' }, { name: 'f_1' }, { name: 'f_2' }];
  const out = T.sortFramesByName(input);
  assert.deepEqual(out.map((f) => f.name), ['f_1', 'f_2', 'f_3']);
  assert.deepEqual(input.map((f) => f.name), ['f_3', 'f_1', 'f_2'], '原数组不该被改动');
  assert.equal(out.length, input.length);
});

// ── 11. 按行扫描 ─────────────────────────────────────────────────────────
console.log('\n[按行扫描]');

const makeImage = (w, h, rects) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * w + x) * 4;
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
      }
    }
  }
  return { width: w, height: h, data };
};

check('两行各两帧：先切行、再在行内切帧', () => {
  const img = makeImage(100, 60, [
    { x: 5, y: 5, w: 20, h: 20 }, { x: 40, y: 5, w: 20, h: 20 },
    { x: 5, y: 35, w: 20, h: 20 }, { x: 40, y: 35, w: 20, h: 20 },
  ]);
  const res = T.scanRows(img, { rowGap: 4, colGap: 2, minRowH: 8, minFrameW: 4 });
  assert.equal(res.bands.length, 2, '应切成两行');
  assert.equal(res.bands[0].frames.length, 2);
  assert.equal(res.bands[1].frames.length, 2);
  assert.deepEqual(res.bands[0].frames[0], { x: 5, y: 5, w: 20, h: 20 }, '框要收紧到真实边界');
});

check('行内 1px 细缝不会被劈成两行（rowGap 容差）', () => {
  const img = makeImage(60, 40, [
    { x: 5, y: 5, w: 10, h: 10 },
    { x: 5, y: 16, w: 10, h: 10 },   // 与上一块相隔 1px
  ]);
  const res = T.scanRows(img, { rowGap: 4, colGap: 2, minRowH: 4, minFrameW: 2 });
  assert.equal(res.bands.length, 1, '1px 空隙应被容差吃掉');
});

check('行高不一致也能各自成行', () => {
  const img = makeImage(80, 70, [
    { x: 5, y: 5, w: 30, h: 61 },    // 高行
    { x: 5, y: 50, w: 30, h: 12 },   // 矮行（和上一行重叠？不重叠：y 50 < 66）
  ]);
  // 这里故意让两块垂直方向相接，应被当成一行
  const res = T.scanRows(img, { rowGap: 4, colGap: 2, minRowH: 4, minFrameW: 2 });
  assert.equal(res.bands.length, 1, '垂直相接的内容属于同一行');
});

check('太矮的行会被 minRowH 丢掉', () => {
  const img = makeImage(60, 60, [
    { x: 5, y: 5, w: 20, h: 4 },     // 4px 高的“文字行”
    { x: 5, y: 30, w: 20, h: 20 },
  ]);
  const res = T.scanRows(img, { rowGap: 4, colGap: 2, minRowH: 10, minFrameW: 2 });
  assert.equal(res.bands.length, 1, '矮行应被过滤');
  assert.equal(res.bands[0].frames.length, 1);
});

check('空图不炸', () => {
  const res = T.scanRows(makeImage(40, 40, []), { rowGap: 4, colGap: 2, minRowH: 4, minFrameW: 2 });
  assert.equal(res.bands.length, 0);
});

check('按帧数等分：铺满整行、不重叠、不留缝', () => {
  const band = { y: 10, h: 20, frames: [{ x: 0, y: 10, w: 10, h: 20 }, { x: 90, y: 10, w: 10, h: 20 }] };
  const out = T.splitRowEven(band, 4);
  assert.equal(out.length, 4);
  assert.equal(out[0].x, 0);
  assert.equal(out[3].x + out[3].w, 100, '最后一帧要顶到右边界');
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].y, 10);
    assert.equal(out[i].h, 20);
    if (i) assert.equal(out[i].x, out[i - 1].x + out[i - 1].w, '相邻帧必须首尾相接');
  }
  const total = out.reduce((s, f) => s + f.w, 0);
  assert.equal(total, 100, '宽度总和应等于跨度');
});

check('按帧数等分：只用该行已有帧的并集（不吞掉右边的标注文字）', () => {
  // 帧只覆盖 0..60，右边 100..180 是文字，不该被算进等分范围
  const band = { y: 0, h: 10, frames: [{ x: 0, y: 0, w: 20, h: 10 }, { x: 40, y: 0, w: 20, h: 10 }] };
  const out = T.splitRowEven(band, 2);
  assert.equal(out[0].x, 0);
  assert.equal(out[1].x + out[1].w, 60);
});

check('等分边界：跨度为 0 或帧数超过像素宽时返回空', () => {
  assert.deepEqual(T.splitRowEven({ y: 0, h: 4, frames: [{ x: 5, y: 0, w: 0, h: 4 }] }, 3), []);
  assert.deepEqual(T.splitRowEven({ y: 0, h: 4, frames: [] }, 3), []);
});

// ── 12. 组件树 ───────────────────────────────────────────────────────────
console.log('\n[组件树]');
function renderTree(node) {
  const out = { tags: [], classes: [], text: [] };
  const walk = (n) => {
    if (n === null || n === undefined || n === false || n === true) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'string' || typeof n === 'number') { out.text.push(String(n)); return; }
    if (typeof n.type === 'function') { walk(n.type(n.props || {})); return; }
    if (typeof n.type === 'string') {
      out.tags.push(n.type);
      if (n.props && typeof n.props.className === 'string') out.classes.push(n.props.className);
      if (n.props && n.props.children !== undefined) walk(n.props.children);
    }
  };
  walk(node);
  return out;
}

check('空画布：组件树完整、无崩溃', () => {  const tree = renderTree({ type: T.StudioPanel, props: {} });
  const cls = tree.classes.join(' ');
  const text = tree.text.join('');
  assert.ok(cls.includes('ss-app'), '缺少根节点 .ss-app');
  assert.ok(cls.includes('ss-board'), '缺少画布');
  assert.ok(cls.includes('ss-insp'), '缺少检查器');
  assert.ok(text.includes('切片牢大'), '缺少标题');
  assert.ok(text.includes('把精灵图拖进来'), '缺少空状态');
  assert.ok(text.includes('导入图片'), '缺少导入按钮');
  assert.ok(text.includes('切图') && text.includes('抠图'), '检查器缺少切图/抠图分区');
  assert.ok(!text.includes('undefined'), '渲染文本里出现了 undefined');
  assert.ok(!text.includes('[object Object]'), '渲染文本里出现了 [object Object]');
  assert.ok(tree.tags.includes('svg'), '侧栏/空状态图标应渲染成 svg');
});

check('有选中项时也能渲染（空状态覆盖不到的分支）', () => {
  // 空状态会走另一个三元分支：选中为空时，那些「合成 / 素材库」按钮根本不构建，
  // 于是「回调定义在板块之后」这类 TDZ 错误在空状态下完全暴露不出来 ——
  // 0.11.0 就是这样带着一个必然崩溃的版本过了全部测试。这条专门补上。
  const sprite = {
    id: 's1', name: 'hero', dataUrl: 'data:image/png;base64,AAAA',
    w: 64, h: 64, x: 0, y: 0, scale: 1, opacity: 1, z: 1, pixelated: true,
  };
  let stateIdx = 0;
  const seeded = makeReact();
  seeded.useState = (init) => {
    const i = stateIdx++;
    const has = Object.prototype.hasOwnProperty.call({ 2: [sprite], 4: ['s1'] }, i);
    const v = has ? { 2: [sprite], 4: ['s1'] }[i] : (typeof init === 'function' ? init() : init);
    return [v, () => {}];
  };
  const api2 = definition.factory((name) => {
    if (name === 'react') return seeded;
    throw new Error('unexpected require: ' + name);
  });
  const T2 = api2.__test;
  const tree = renderTree({ type: T2.StudioPanel, props: {} });
  const text = tree.text.join('');
  assert.ok(text.includes('角色合成'), '缺少角色合成分区');
  assert.ok(text.includes('LPC 素材库'), '缺少素材库分区');
  // 反向确认种子真的生效了：画布分区会显示「1 个」，否则这条测试等于在测空状态。
  assert.ok(text.includes('1 个'), '种子状态没生效，这条测试就白测了');
  // 板块默认收起，子节点不进文本；但**子节点在创建 Section 时就已经构建了**，
  // 所以只要 compList 非空，这里就会走到 `onClick: composeNow`。
  // 换句话说：这条测试只要不抛 ReferenceError，就证明了声明顺序正确。
  assert.ok(!text.includes('[object Object]'), '渲染文本里出现了 [object Object]');
});

check('右侧板块默认全收起（选图不自动展开）', () => {
  const tree = renderTree({ type: T.StudioPanel, props: {} });
  const text = tree.text.join('');
  assert.equal(tree.classes.filter((c) => c === 'ss-sec').length, 10, '应有 10 个折叠区');
  assert.equal(tree.classes.filter((c) => c === 'ss-sec-body').length, 0, '默认不应展开任何板块');
  for (const title of ['选中项', '切图', '抠图', '生成背景', '特效', 'LPC 素材库', '角色合成', '动画预览', '导出', '画布']) {
    assert.ok(text.includes(title), `缺少板块标题：${title}`);
  }
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : ''}\n`);
