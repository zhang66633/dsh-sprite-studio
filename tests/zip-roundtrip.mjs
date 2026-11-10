/**
 * ZIP 集成测试（需要外部解压器验证，所以分两步）：
 *   1. 这里生成 out.zip 与 expected.json
 *   2. 用系统解压器（PowerShell Expand-Archive / unzip）解开，再比对
 *
 * 为什么不在 Node 里自己解：自己写压缩又自己写解压，等于用一个实现证明它自己。
 * 标准解压器能过，才说明字节结构真的对。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let definition = null;
globalThis.window = { __ModuleLoader__: { load(def) { definition = def; } } };
const source = readFileSync(path.join(root, 'client.js'), 'utf8');
new Function('window', 'Image', 'document', 'indexedDB', 'ResizeObserver', source)(
  globalThis.window,
  class {},
  { querySelector: () => null, createElement: () => ({ getContext: () => null }), head: { append() {} } },
  undefined,
  class { observe() {} disconnect() {} },
);
const api = definition.factory(() => ({ createElement: () => ({}), useState: (v) => [v, () => {}], useEffect() {}, useLayoutEffect() {}, useRef: (v) => ({ current: v }), useMemo: (f) => f(), useCallback: (f) => f, Component: class {} }));
const T = api.__test;

// 1×1 透明 PNG（真 PNG 字节，让解压器拿到的不是垃圾）
const PNG_1PX = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
));

const outDir = path.join(os.tmpdir(), 'sprite-studio-zip-test');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const manifest = {
  generator: 'dsh-sprite-studio',
  schema: 'dsh-sprite-studio/manifest/1',
  count: 3,
  items: [
    { name: 'hero_01.png', width: 1, height: 1, x: 0, y: 0, scale: 1 },
    { name: 'hero_02.png', width: 1, height: 1, x: 40, y: 0, scale: 1 },
    { name: '剑士.png', width: 1, height: 1, x: 80, y: 0, scale: 1 },
  ],
};
const enc = new TextEncoder();
const zip = T.makeZip([
  { name: 'hero_01.png', bytes: PNG_1PX },
  { name: 'hero_02.png', bytes: PNG_1PX },
  { name: '剑士.png', bytes: PNG_1PX },
  { name: 'manifest.json', bytes: enc.encode(JSON.stringify(manifest, null, 2)) },
]);

const zipPath = path.join(outDir, 'out.zip');
writeFileSync(zipPath, zip);
writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify({
  names: ['hero_01.png', 'hero_02.png', '剑士.png', 'manifest.json'],
  pngSha: null,
}));
console.log(JSON.stringify({ zipPath, outDir, bytes: zip.length }));
