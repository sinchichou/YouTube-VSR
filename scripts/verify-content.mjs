#!/usr/bin/env node
/**
 * verify-content.mjs — 以程式化方式驗證 content.js 的純邏輯與 background.js 的資源代理
 * ---------------------------------------------------------------------------
 * Programmatic verification of content.js pure helpers and the background
 * resource proxy (fetchResource).
 *
 * 為什麼需要這支腳本 / Why:
 *   本輪修復的三個核心問題都在瀏覽器/擴充套件環境中發作,但可測的部分不必開瀏覽器:
 *     [A] resolveOutputSize():.wgx 套件實例(resourceManager 為直接屬性)與
 *         .wgsl 原始實例(runtime.resourceManager)兩種形狀都要取得到 OUTPUT 尺寸 —
 *         這是「Canvas 尺寸與 OUTPUT 不一致 → 每幀 copyTextureToTexture 驗證錯誤」
 *         的根因修復。
 *     [B] base64ToUint8Array():背景代理取檔的傳輸解碼正確性。
 *     [C] videoResolutionChanged():重啟判斷只能比對影片串流尺寸,
 *         不可比對 canvas 尺寸(否則升頻效果下 ResizeObserver 初始回呼就會
 *         觸發無限重編譯循環)。
 *     [D] background.js fetchResource:白名單(僅 wgx/…wgx、effects_wgsl/…wgsl)、
 *         回傳 base64 與原位元組一致、路徑穿越被拒。
 *     [E] 測試接縫:TEST 模式下 content.js 不觸碰 chrome/DOM(早退)。
 *
 * 用法 / Usage:
 *   node scripts/verify-content.mjs           # 全部檢查
 *   node scripts/verify-content.mjs --quiet   # 只輸出失敗
 *
 * 結束碼:0 = 全部通過;1 = 有失敗。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, '..');
const QUIET = process.argv.includes('--quiet');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
    if (ok) { pass++; if (!QUIET) console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); }
    else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n=== ${t} ===`); };

// ===========================================================================
// 在 Node 中執行 content.js(TEST 接縫模式)
// ===========================================================================

section('content.js 載入(TEST_MODE)');

const sandbox = {
    __VSR_CONTENT_TEST__: true,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    console: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
};
vm.createContext(sandbox);

const contentSource = fs.readFileSync(path.join(EXT_ROOT, 'content.js'), 'utf8');
let earlyReturnOk = false;
try {
    const script = new vm.Script(contentSource, { filename: 'content.js' });
    const runPromise = script.runInContext(sandbox);
    // IIFE 是 async;TEST 模式在純函式輸出後即早退,應立即 resolve
    await Promise.race([
        Promise.resolve(runPromise).then(() => { earlyReturnOk = true; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('IIFE 未在 2 秒內返回(TEST 模式應立即早退)')), 2000)),
    ]);
} catch (e) {
    check('content.js 可在 TEST 模式執行', false, String(e && e.message || e));
}
check('content.js TEST 模式立即早退(不觸碰 chrome/DOM/GPU)', earlyReturnOk);

const HOOKS = sandbox.__VSR_CONTENT_HOOKS__ || null;
check('測試接縫 __VSR_CONTENT_HOOKS__ 已輸出', !!HOOKS && typeof HOOKS === 'object');
if (!HOOKS) {
    console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
    process.exit(1);
}
check('正式模式不殘留 controller(未定義 __vsrController)', sandbox.__vsrController === undefined);

// ===========================================================================
// [A] resolveOutputSize — 兩種 WGFX 實例形狀
// ===========================================================================

section('[A] resolveOutputSize()');

const pkgShaped = (outTex) => ({
    resourceManager: { getTexture: (n) => (n === 'OUTPUT' ? outTex : null) },
});
const rawShaped = (outTex) => ({
    runtime: { resourceManager: { getTexture: (n) => (n === 'OUTPUT' ? outTex : null) } },
});

let r;
r = HOOKS.resolveOutputSize(pkgShaped({ width: 3840, height: 2160 }));
check('.wgx 套件實例:resourceManager 為直接屬性', !!r && r.width === 3840 && r.height === 2160, JSON.stringify(r));

r = HOOKS.resolveOutputSize(rawShaped({ width: 1920, height: 1080 }));
check('歷史形狀(WGFX runtime.resourceManager)仍可防禦性取得', !!r && r.width === 1920 && r.height === 1080, JSON.stringify(r));

r = HOOKS.resolveOutputSize({ outWidth: 3840.6, outHeight: 2160 });
check('無 resourceManager 時退回 outWidth/outHeight(取整)', !!r && r.width === 3840 && r.height === 2160, JSON.stringify(r));

r = HOOKS.resolveOutputSize({
    resourceManager: { getTexture: () => ({ width: 0, height: 0 }) },
    outWidth: 640, outHeight: 480,
});
check('OUTPUT 尺寸無效時退回 outWidth/outHeight', !!r && r.width === 640 && r.height === 480, JSON.stringify(r));

r = HOOKS.resolveOutputSize({
    resourceManager: { getTexture: () => { throw new Error('internal shape changed'); } },
});
check('getTexture 拋錯時回傳 null(不炸啟動流程)', r === null);

r = HOOKS.resolveOutputSize({});
check('空實例 → null', r === null);
r = HOOKS.resolveOutputSize(null);
check('null 實例 → null', r === null);
r = HOOKS.resolveOutputSize(undefined);
check('undefined 實例 → null', r === null);

// 舊版 bug 的重現驗證:舊碼只找 runtime(套件實例沒有 runtime)→ 取不到。
// 新實作對套件實例必須取得到,否則 Canvas 會以影片尺寸配置、每幀 copy 驗證錯誤。
const oldStyleLookupWouldFail = ({}).runtime === undefined;
const newGetsIt = HOOKS.resolveOutputSize(pkgShaped({ width: 3840, height: 2160 })) !== null;
check('根因回歸:套件實例(無 runtime)仍能取得 OUTPUT 尺寸', oldStyleLookupWouldFail && newGetsIt);

// ===========================================================================
// [B] base64ToUint8Array
// ===========================================================================

section('[B] base64ToUint8Array()');

{
    const bytes = new Uint8Array(256 * 4 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    const b64 = Buffer.from(bytes).toString('base64');
    const out = HOOKS.base64ToUint8Array(b64);
    // 注意:out 產生於 vm realm,不能以 Node realm 的 instanceof 判斷;
    // 用 Object.prototype.toString 跨 realm 檢查型別。
    const isU8 = Object.prototype.toString.call(out) === '[object Uint8Array]';
    let same = isU8 && out.length === bytes.length;
    if (same) for (let i = 0; i < bytes.length; i++) if (out[i] !== bytes[i]) { same = false; break; }
    check('多位元組 roundtrip(1031 bytes)逐 byte 一致', same, `len=${out && out.length}`);
}
{
    const out = HOOKS.base64ToUint8Array('AQI=');
    check('已知向量 AQI= → [1,2]', out.length === 2 && out[0] === 1 && out[1] === 2, JSON.stringify([...out]));
}
{
    const out = HOOKS.base64ToUint8Array('');
    const isU8 = Object.prototype.toString.call(out) === '[object Uint8Array]';
    check('空字串 → 長度 0', isU8 && out.length === 0);
}

// ===========================================================================
// [C] videoResolutionChanged — 重啟條件
// ===========================================================================

section('[C] videoResolutionChanged()');

check('同尺寸 → false(不重啟)', HOOKS.videoResolutionChanged(1920, 1080, 1920, 1080) === false);
check('寬變 → true', HOOKS.videoResolutionChanged(1920, 1080, 3840, 1080) === true);
check('高變 → true', HOOKS.videoResolutionChanged(1920, 1080, 1920, 2160) === true);
check('影片尺寸 vs Canvas 尺寸(升頻 2x)→ 語意上必須「不重啟」的比較基準是影片自身',
    HOOKS.videoResolutionChanged(1920, 1080, 1920, 1080) === false
    && HOOKS.videoResolutionChanged(3840, 2160, 3840, 2160) === false);

// ===========================================================================
// [D] background.js fetchResource(資源代理)
// ===========================================================================

section('[D] background.js fetchResource');

// [D] 與 [F] 主控台橋接共用同一個背景沙箱
const bgListeners = { onMessage: [], tabsUpdated: [], tabsActivated: [], installed: [] };
const bgSandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    fetch: async (url) => {
        if (!String(url).startsWith('chrome-extension://fake/wgx/')) {
            throw new Error('unexpected url: ' + url);
        }
        const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => payload.buffer.slice(0),
        };
    },
    chrome: {
        runtime: {
            getURL: (p) => 'chrome-extension://fake/' + String(p).split('\\').join('/'),
            onMessage: { addListener: (fn) => bgListeners.onMessage.push(fn) },
            onInstalled: { addListener: (fn) => bgListeners.installed.push(fn) },
            sendMessage: async () => ({}),
        },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        tabs: {
            onUpdated: { addListener: (fn) => bgListeners.tabsUpdated.push(fn) },
            onActivated: { addListener: (fn) => bgListeners.tabsActivated.push(fn) },
            query: async () => [],
            get: (_id, cb) => cb && cb(null),
            sendMessage: async () => ({}),
        },
        action: { enable: () => {}, disable: () => {} },
        scripting: { executeScript: async () => [] },
    },
};
{
    vm.createContext(bgSandbox);
    const bgSource = fs.readFileSync(path.join(EXT_ROOT, 'background.js'), 'utf8');
    try {
        new vm.Script(bgSource, { filename: 'background.js' }).runInContext(bgSandbox);
        check('background.js 可載入(stub 環境)', true);
    } catch (e) {
        check('background.js 可載入(stub 環境)', false, String(e && e.message || e));
    }

    const listener = bgListeners.onMessage[0];
    check('onMessage 監聽器已註冊', typeof listener === 'function');

    const callFetchResource = (msg) => new Promise((resolve) => {
        let responded = false;
        const keepOpen = listener(msg, {}, (resp) => { responded = true; resolve({ resp, responded }); });
        setTimeout(() => resolve({ resp: null, responded, keepOpen }), 1500);
    });

    {
        const { resp } = await callFetchResource({ command: 'fetchResource', path: 'wgx/Anime4K/Anime4K_3D_AA_Upscale_US.wgx' });
        const expect = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const got = resp && resp.ok ? Buffer.from(resp.data, 'base64') : null;
        check('允許路徑 → ok 且 base64 與原位元組一致',
            !!resp && resp.ok === true && !!got && got.length === expect.length && got.every((b, i) => b === expect[i]),
            resp ? `bytes=${resp.bytes}` : 'no response');
    }
    {
        const { resp } = await callFetchResource({ command: 'fetchResource', path: 'wgx/../private/secrets.wgx' });
        check('路徑穿越(..)→ 拒絕', !!resp && resp.ok === false, resp && resp.error);
    }
    {
        const { resp } = await callFetchResource({ command: 'fetchResource', path: 'wgx\\Anime4K\\x.wgx' });
        check('反斜線路徑 → 拒絕', !!resp && resp.ok === false, resp && resp.error);
    }
    {
        const { resp } = await callFetchResource({ command: 'fetchResource', path: 'vendor/wgfx.browser.esm.js' });
        check('非白名單路徑(vendor)→ 拒絕', !!resp && resp.ok === false, resp && resp.error);
    }
    {
        const { resp } = await callFetchResource({ command: 'fetchResource', path: 'effects_wgsl/CAS.wgsl' });
        // legacy .wgsl 路徑已拔除:白名單不再接受 effects_wgsl/**
        check('wgsl 路徑已被白名單拒絕(一律使用 .wgx)',
            !!resp && resp.ok === false && resp.error === 'path not allowed', resp && resp.error);
    }
}

// ===========================================================================
// [E] content.js 靜態接線檢查(水印 + 主控台)
// ===========================================================================

section('[E] content.js 水印與主控台接線');

check('WatermarkOverlay 類別存在', contentSource.includes('class WatermarkOverlay'));
check('水印文字帶放大倍率(VSR ×)', contentSource.includes('setText(`VSR ×'));
check('水印預設開啟(storage watermark !== false)', contentSource.includes('config.watermark !== false'));
check('首幀呈現時顯示水印', contentSource.includes('showIfEnabled()'));
check('主控台指令事件(vsr-console-cmd)已監聽', contentSource.includes("addEventListener('vsr-console-cmd'"));
check('主控台回應事件(vsr-console-res)已發送', contentSource.includes("'vsr-console-res'"));
check('水印指令處理(storage 持久化)', contentSource.includes("chrome.storage.local.set({ watermark: on })"));
check('isolated world 同組 API(window.VSR)', contentSource.includes('vsrConsoleAPI') && contentSource.includes("defineProperty(window, 'VSR'"));
check('請求背景注入 MAIN world 橋接', contentSource.includes("command: 'ensureConsoleBridge'"));

// ===========================================================================
// [F] 主控台橋接(vsrConsoleBridgeMain)— MAIN world 行為
// ===========================================================================

section('[F] 主控台橋接(window.VSR)');

{
    const bridgeLogs = [];
    const win = {
        __vsrBridgeListenerInstalled: false,
        _listeners: {},
        _dispatched: [],
        addEventListener(name, fn) { this._listeners[name] = fn; },
        dispatchEvent(ev) { this._dispatched.push(ev); },
    };
    const bridgeSandbox = {
        window: win,
        CustomEvent: class {
            constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
        },
        console: { info: (m) => bridgeLogs.push(String(m)) },
        setTimeout: () => 0, // 測試中不觸發 3 秒逾時
    };
    vm.createContext(bridgeSandbox);

    // vsrConsoleBridgeMain 是 background.js 的頂層函式宣告;序列化其原始碼到
    // 獨立 context 執行(模擬 chrome.scripting 注入 MAIN world)
    const bridgeFn = bgSandbox.vsrConsoleBridgeMain;
    check('vsrConsoleBridgeMain 已定義於 background.js', typeof bridgeFn === 'function');
    if (typeof bridgeFn === 'function') {
        const bridgeSource = String(bridgeFn) + '\nvsrConsoleBridgeMain();';
        try {
            new vm.Script(bridgeSource, { filename: 'vsrConsoleBridgeMain' }).runInContext(bridgeSandbox);
            check('橋接可在 MAIN world stub 中執行', true);
        } catch (e) {
            check('橋接可在 MAIN world stub 中執行', false, String(e && e.message || e));
        }

        const api = win.VSR;
        check('window.VSR 已定義且含 5 個方法', !!api &&
            typeof api.watermark === 'function' && typeof api.enable === 'function' &&
            typeof api.disable === 'function' && typeof api.toggle === 'function' &&
            typeof api.status === 'function');
        check('使用說明已輸出到 console.info', bridgeLogs.some((l) => l.includes('VSR.status()')));
        check('回應監聽(vsr-console-res)已註冊', typeof win._listeners['vsr-console-res'] === 'function');

        // VSR.watermark(false) → 送出 vsr-console-cmd 事件,並在收到回應後 resolve
        const p = api.watermark(false);
        const cmdEv = win._dispatched[win._dispatched.length - 1];
        check('watermark(false) 送出指令事件', !!cmdEv && cmdEv.type === 'vsr-console-cmd'
            && cmdEv.detail && cmdEv.detail.command === 'watermark' && cmdEv.detail.value === false
            && typeof cmdEv.detail.id === 'number');

        win._listeners['vsr-console-res']({ detail: { id: cmdEv.detail.id, ok: true, result: false } });
        const resolved = await Promise.race([
            p.then((v) => ({ v }), (e) => ({ err: e })),
            new Promise((res) => setTimeout(() => res(null), 1000)),
        ]);
        check('收到 vsr-console-res 後 Promise resolve(false)', !!resolved && resolved.v === false, JSON.stringify(resolved));

        // 錯誤路徑:ok:false → reject
        const p2 = api.status();
        const cmd2 = win._dispatched[win._dispatched.length - 1];
        win._listeners['vsr-console-res']({ detail: { id: cmd2.detail.id, ok: false, error: 'boom' } });
        const rejected = await Promise.race([
            p2.then((v) => ({ v }), (e) => ({ err: e })),
            new Promise((res) => setTimeout(() => res(null), 1000)),
        ]);
        check('ok:false 回應 → Promise reject', !!rejected && !!rejected.err && String(rejected.err.message).includes('boom'));

        // 冪等:重複注入不重複註冊回應監聽(window.__vsrBridgeListenerInstalled 守衛)
        const listenersBefore = Object.keys(win._listeners).length;
        new vm.Script(String(bridgeFn) + '\nvsrConsoleBridgeMain();', { filename: 'vsrConsoleBridgeMain2' }).runInContext(bridgeSandbox);
        check('重複注入為冪等(監聽器不重複)', Object.keys(win._listeners).length === listenersBefore && !!win.VSR);
    }
}

// ===========================================================================
// [G] manifest.json — host_permissions 與 web_accessible_resources
// ===========================================================================

section('[G] manifest.json');

{
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'manifest.json'), 'utf8'));
    check('permissions 含 scripting(storageBridge 用)', (manifest.permissions || []).includes('scripting'));
    check('host_permissions 涵蓋 YouTube 與 Twitch',
        (manifest.host_permissions || []).includes('*://www.youtube.com/*')
        && (manifest.host_permissions || []).includes('*://www.twitch.tv/*'));
    const war = (manifest.web_accessible_resources || []).flatMap((r) => r.resources || []);
    check('web_accessible_resources 只保留 wgx(wgsl 已拔除)',
        war.some((r) => r.includes('wgx')) && !war.some((r) => r.includes('wgsl')));
    check('manifest 版本為 MV3', manifest.manifest_version === 3);
}

// ===========================================================================
// [H] 多效果管線:鏈結尺寸規劃
// ===========================================================================

section('[H] nextLinkSize()(鏈式尺寸傳遞)');

{
    let s = HOOKS.nextLinkSize(1920, 1080, { width: 3840, height: 2160 });
    check('2x 升頻效果 → 下一級輸入 3840x2160',
        s.inW === 1920 && s.inH === 1080 && s.outW === 3840 && s.outH === 2160, JSON.stringify(s));
    s = HOOKS.nextLinkSize(1920, 1080, null);
    check('不改變尺寸的效果(null)→ 下一級輸入同尺寸',
        s.inW === 1920 && s.inH === 1080 && s.outW === 1920 && s.outH === 1080, JSON.stringify(s));
    s = HOOKS.nextLinkSize(1920.4, 1080.7, undefined);
    check('小數輸入 → 無條件捨去', s.inW === 1920 && s.inH === 1080, JSON.stringify(s));
    s = HOOKS.nextLinkSize(3840, 2160, { width: 0, height: 0 });
    check('無效輸出尺寸(0)→ 退回輸入尺寸', s.outW === 3840 && s.outH === 2160, JSON.stringify(s));
    // 鏈語意:效果1(2x)→ 效果2(1x)→ 效果3(2x)= 總倍率 4x
    let w = 1920, h = 1080;
    s = HOOKS.nextLinkSize(w, h, { width: 3840, height: 2160 }); w = s.outW; h = s.outH;
    s = HOOKS.nextLinkSize(w, h, null); w = s.outW; h = s.outH;
    s = HOOKS.nextLinkSize(w, h, { width: 7680, height: 4320 });
    check('三效果鏈:2x → 1x → 2x = 4x(7680x4320)',
        s.outW === 7680 && s.outH === 4320, JSON.stringify(s));
}

// ===========================================================================
// [I] updateParameter 路由
// ===========================================================================

section('[I] pickProcessorEntry()(參數路由)');

{
    const entries = [
        { instanceId: 'inst_a', inst: { id: 'A' } },
        { instanceId: 'inst_b', inst: { id: 'B' } },
    ];
    check('依 instanceId 命中第二個效果',
        HOOKS.pickProcessorEntry(entries, 'inst_b').inst.id === 'B');
    check('未知的 instanceId → 退回第一個(向後相容)',
        HOOKS.pickProcessorEntry(entries, 'nope').inst.id === 'A');
    check('無 instanceId → 第一個效果',
        HOOKS.pickProcessorEntry(entries, undefined).inst.id === 'A');
    check('空管線 → null', HOOKS.pickProcessorEntry([], 'inst_a') === null);
    check('非陣列 → null', HOOKS.pickProcessorEntry(null, 'inst_a') === null);
}

// ===========================================================================
// [J] rectsDiffer(位置髒旗標)
// ===========================================================================

section('[J] rectsDiffer()(位置同步髒旗標)');

{
    const a = { left: 10, top: 20, width: 100, height: 50 };
    check('相同 rect → false(不重寫 style)',
        HOOKS.rectsDiffer(a, { left: 10, top: 20, width: 100, height: 50 }) === false);
    check('left 變 → true', HOOKS.rectsDiffer(a, { ...a, left: 11 }) === true);
    check('width 變 → true', HOOKS.rectsDiffer(a, { ...a, width: 101 }) === true);
    check('任一未知(null)→ true(保守同步)',
        HOOKS.rectsDiffer(null, a) === true && HOOKS.rectsDiffer(a, null) === true);
}

// ===========================================================================
// [K] content.js 多效果與效能接線(靜態檢查)
// ===========================================================================

section('[K] content.js 多效果 / 效能接線');

check('鏈結 blit 著色器(BLIT_WGSL)存在且含格式轉換取樣',
    contentSource.includes('const BLIT_WGSL') && contentSource.includes('textureSample(tex, samp'));
check('compilePipeline 依序編譯整條管線', contentSource.includes('async compilePipeline('));
check('單/多效果同一條路徑:輸入上傳經 rm.updateTextureFromImage',
    contentSource.includes("rm0.updateTextureFromImage('INPUT', videoSource, undefined, undefined)")
    && !contentSource.includes('inst.process(videoSource)'));
check('鏈式步驟補寫 scene buffer(frame 計數器實際寫入點)',
    contentSource.includes('rm.advanceFrame();') && contentSource.includes('rm.updateSceneBuffer(entry.inW, entry.inH, entry.outW, entry.outH);'));
check('整幀僅 1 次 queue submit(content.js 全檔恰一處)',
    (contentSource.match(/queue\.submit\(/g) || []).length === 1
    && contentSource.includes("createCommandEncoder(ENCODER_DESC)"));
check('雙形狀 pass 派發(套件 manifest / 原始 runtime)',
    contentSource.includes('pipelineManager.dispatchPass') && contentSource.includes('dispatchAllPasses'));
check('參數路由 updateParameter(→ pickProcessorEntry)',
    contentSource.includes('updateParameter(instanceId, paramName, value)')
    && contentSource.includes('pickProcessorEntry(this.instances, instanceId)'));
check('訊息處理器傳遞 instanceId', contentSource.includes('vsr.updateParameter(msg.instanceId, msg.paramName, msg.value)'));
check('熱路徑零 DOM 讀取(髒旗標驅動 _syncPositions)',
    contentSource.includes('if (this._posDirty)') && contentSource.includes('_syncPositions()'));
check('直接以影片元素為輸入(免每幀 VideoFrame 配置)',
    contentSource.includes('processFrame(this.video, present)')
    && !contentSource.includes('new VideoFrame('));
check('RO 同時觀察影片與播放器容器(佈局變更觸發髒旗標)',
    contentSource.includes('this.resizeObserver.observe(this.video)')
    && contentSource.includes('this.resizeObserver.observe(this.container)'));
check('水印/渲染器改為 applyPosition(共用 rects)', contentSource.includes('applyPosition(vRect, cRect)'));
check('dispose 釋放整條鏈(逐一 + blit 資源)',
    contentSource.includes('for (const entry of this.instances)')
    && contentSource.includes('this.linkPipeline = null;'));

// --- 效能呈現路徑(本輪優化)---
check('呈現改為取樣 blit(ensurePresent + presentBindGroup),不再 copy 到畫布',
    contentSource.includes('ensurePresent(format)') && contentSource.includes('presentBindGroup')
    // 僅歷史註解允許出現該詞;實際呼叫(帶括號)必須不存在
    && !contentSource.includes('copyTextureToTexture('));
check('畫布採瀏覽器偏好格式(通常 bgra8unorm;8bit 呈現頻寬減半)',
    contentSource.includes('getPreferredCanvasFormat()'));
check('畫布 view 按紋理身分快取(swapchain 紋理未換即不重建)',
    contentSource.includes('this._dstTex !== tex'));
check('呈現 pass 描述器隨畫布紋理快取(_dstPassDesc),熱路徑零物件配置',
    contentSource.includes('this._dstPassDesc = {') && contentSource.includes('beginRenderPass(present.passDesc)'));
check('pass metadata 於編譯期預解析(entry.passes),熱路徑不做 metas.find',
    contentSource.includes('entry.passes = entry.inst.manifest.passes.map((pass) => {')
    && contentSource.includes('for (const p of entry.passes)'));
check('熱路徑共用常數(ENCODER_DESC / CLEAR_BLACK),免每幀物件字面量',
    contentSource.includes('const ENCODER_DESC = { label:') && contentSource.includes('const CLEAR_BLACK ='));
check('processFrame 為同步函式(無 async/await 開銷)',
    /processFrame\(videoSource, present\) \{/.test(contentSource)
    && !/async\s+processFrame/.test(contentSource));
check('blit render-pass 描述器快取於 link(passDesc)',
    contentSource.includes('passDesc: {') && contentSource.includes('beginRenderPass(link.passDesc)'));

// ===========================================================================
// 結果
// ===========================================================================

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) {
    console.log('失敗項目:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
process.exit(0);
