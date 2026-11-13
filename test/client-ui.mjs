/**
 * 客户端 UI 测试（在 vm 里跑 lib/client.js）
 *
 * lib/client.js 是宿主加载用的 bundle：
 *   window.__ModuleLoader__.load({ id, factory: function(require){ ...raw... } })
 * 所以这里伪造 window.__ModuleLoader__ 捕获 factory，再用最小的 React mock 让它
 * 跑起来，直接检查它注册进 slots 的组件渲染结果。
 *
 * 覆盖点：
 *   - 模块导出 apply/default/inject；apply 注册 settings.section + icon
 *   - 只有两个页签（接入 / 远程设备），「显示」页签已彻底移除
 *   - 桌面端「远程设备」有「删除远程设备」按钮 + 每行 × 按钮；当前设备没有 ×
 *   - 移动端（data-remote 存在）不渲染任何删除控件（纵深防御的另一半）
 *   - 删除走宿主确认框/行内确认，不使用 window.confirm
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRunner } from './_home.mjs';

const r = createRunner('客户端 UI');
const clientPath = path.resolve(import.meta.dirname, '..', 'lib', 'client.js');
const clientJs = fs.readFileSync(clientPath, 'utf8');

/* ── React mock ──────────────────────────────────────────── *
 * 只需要「能把元素树建出来、能展开函数组件」。useState 返回 [init, noop]，
 * 需要注入特定值的用例通过 setter 捕获后重新渲染（见 renderWith）。
 */
function makeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, kids: children.flat(Infinity) };
    },
    useState(init) {
      return [typeof init === 'function' ? init() : init, () => {}];
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useRef(init) {
      return { current: init };
    },
    useLayoutEffect() {},
    useMemo(fn) {
      return fn();
    },
    Fragment: Symbol.for('react.fragment'),
    createContext(v) {
      return { Provider: ({ children }) => children, _v: v };
    },
  };
  return React;
}

/** 递归展开元素树，收集所有文本与 props */
function flatten(node, acc, depth = 0) {
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.texts.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, acc, depth);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  if (node.props) {
    acc.props.push(node.props);
    acc.nodes.push(node);
  }
  const { type, props, kids } = node;
  if (typeof type === 'function') {
    acc.types.push(type);
    if (depth > 40) {
      acc.errors.push('展开层级过深');
      return acc;
    }
    try {
      flatten(type(props || {}), acc, depth + 1);
    } catch (err) {
      acc.errors.push(`${type.name || 'anon'}: ${err.message}`);
    }
    return acc;
  }
  if (type === Symbol.for('react.fragment')) {
    for (const k of kids) flatten(k, acc, depth);
    return acc;
  }
  for (const k of kids) flatten(k, acc, depth);
  return acc;
}

function collect(node) {
  const acc = { texts: [], props: [], nodes: [], types: [], errors: [] };
  flatten(node, acc);
  return { ...acc, allText: acc.texts.join(' ') };
}

/** 取某个元素的文本子节点（createElement 把 children 放在 kids 里） */
function nodeText(node) {
  if (!node) return '';
  return (node.kids || [])
    .flat(Infinity)
    .map((k) => (typeof k === 'string' || typeof k === 'number' ? String(k) : ''))
    .join('');
}

let captured = null;
const sandbox = {
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  navigator: { language: 'zh-CN', clipboard: null },
  document: {
    baseURI: 'http://127.0.0.1:3180/',
    documentElement: { getAttribute: () => null },
    head: { appendChild() {} },
    body: {},
    createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {} }),
  },
};
sandbox.window = { __ModuleLoader__: { load: (o) => { captured = o; } } };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(clientJs, ctx, { filename: 'client.js' });

/**
 * 在当前 sandbox 里重新执行一遍 bundle，用给定的 React / document data-remote /
 * primitives 构造导出对象。每次都是全新模块实例，避免状态串味。
 */
function loadModule({ react = makeReact(), remote = null, modal = null, primitives = null } = {}) {
  const sb = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    navigator: { language: 'zh-CN', clipboard: null },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    document: {
      baseURI: 'http://127.0.0.1:3180/',
      documentElement: { getAttribute: (k) => (k === 'data-remote' ? remote : null) },
      head: { appendChild() {} },
      body: {},
      createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {} }),
    },
  };
  let cap = null;
  sb.window = { __ModuleLoader__: { load: (o) => { cap = o; } } };
  sb.globalThis = sb;
  const c = vm.createContext(sb);
  vm.runInContext(clientJs, c, { filename: 'client.js' });
  if (!cap) throw new Error('bundle 没有调用 __ModuleLoader__.load');
  const mod = cap.factory(function require(id) {
    if (id === 'react' || id === 'react/jsx-runtime') return react;
    if (id === 'react-dom') return { createPortal: (n) => n };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (!primitives && !modal) throw new Error('no primitives');
      return primitives || { Modal: modal };
    }
    throw new Error(`unexpected require: ${id}`);
  });
  return { mod, cap };
}

/** 拿 apply 注册的 settings.section 组件 */
function getSectionComponent(reactOpts = {}) {
  const { mod } = loadModule({ react: reactOpts.react || makeReact(), remote: reactOpts.remote ?? null, modal: reactOpts.modal ?? null, primitives: reactOpts.primitives ?? null });
  const registrations = [];
  const slots = {
    component: null,
    inject(_name, fn) {
      fn();
    },
    register(meta, comp) {
      registrations.push({ meta, comp });
      if (meta.name === 'settings.section') slots.component = comp;
      return () => {};
    },
  };
  const locale = { lang: reactOpts.lang || 'zh' };
  const c = {
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'locale') return locale;
      if (name === 'connection') return {};
      return null;
    },
  };
  mod.apply(c);
  return { registrations, slots, Section: slots.component, mod };
}

/** 渲染 RemoteControlSection 并返回收集结果 */
function renderSection(reactOpts = {}) {
  const { Section, mod } = getSectionComponent(reactOpts);
  if (!Section) throw new Error('settings.section 未注册');
  const react = reactOpts.react || makeReact();
  const node = Section({ ctx: { get: () => (reactOpts.lang === 'en' ? 'en' : 'zh') } });
  return collect(node);
}

/* ── 让 useState 支持注入 devices / currentDeviceId ─────── *
 * RemoteControlSection 会同时挂载 AccessCard 与 SecurityCard，两者的 useState
 * 混在同一个调用序列里。这里按「初值特征」定位：
 *   - 第一个 init 为空数组 [] 的 useState  → devices
 *   - 其后的第一个 init 为 null 的 useState → currentDeviceId
 * AccessCard 的 useState 初值没有空数组，因此不会误命中。
 */
function reactWithState({ devices, currentId } = {}) {
  const React = makeReact();
  const captured = { setters: [], state: [] };
  let devicesInjected = false;
  let currentInjected = false;
  let idx = 0;
  React.useState = (init) => {
    const callIdx = idx++;
    const value = typeof init === 'function' ? init() : init;
    let final = value;
    if (!devicesInjected && Array.isArray(value) && value.length === 0) {
      devicesInjected = true;
      if (devices !== undefined) final = devices;
    } else if (devicesInjected && !currentInjected && value === null) {
      currentInjected = true;
      if (currentId !== undefined) final = currentId;
    }
    captured.state.push(final);
    const setter = (v) => captured.setters.push({ callIdx, value: v });
    return [final, setter];
  };
  return { React, captured };
}

const DEVICES = [
  { id: 'cur1', name: '当前电脑', ua: 'ua', pairedAt: 1700000000000, remote: 'desktop', online: true, ip: '192.168.0.2' },
  { id: 'mob1', name: 'Android · Safari', ua: 'ua', pairedAt: 1700000001000, remote: 'mobile', online: false, ip: '192.168.0.7' },
  { id: 'desk2', name: '未知设备', ua: 'ua', pairedAt: 1700000002000, remote: 'desktop', online: false },
];

/**
 * 渲染 SecurityCard（经 RemoteControlSection，两个 tabPanel 都会挂载）。
 * 通过 useState 初值特征注入 devices / currentDeviceId。
 */
function renderSecurity({ devices = DEVICES, currentId = 'cur1', remote = null, modal = null } = {}) {
  const { React, captured } = reactWithState({ devices, currentId });
  const { Section } = getSectionComponent({ react: React, remote, modal });
  const node = Section({ ctx: { get: () => 'zh' } });
  const acc = { texts: [], props: [], nodes: [], types: [], errors: [] };
  flatten(node, acc);
  return { acc, text: acc.texts.join(' '), captured, props: acc.props, nodes: acc.nodes };
}

/* ── 断言开始 ───────────────────────────────────────────── */
await r.run(async (check) => {
  // 1. 模块契约
  {
    const { mod, cap } = loadModule({ primitives: null, modal: null });
    check('bundle 调用 __ModuleLoader__.load', Boolean(cap));
    check('load 的 id 为 dshweb', cap && cap.id === 'dshweb', cap && cap.id);
    check('导出 apply 函数', typeof mod.apply === 'function');
    check('导出 default === apply', mod.default === mod.apply);
    check('导出 inject 数组', Array.isArray(mod.inject), JSON.stringify(mod.inject));
    check('inject 含 slots/locale/connection', ['slots', 'locale', 'connection'].every((x) => mod.inject.includes(x)), JSON.stringify(mod.inject));
  }

  // 2. apply 注册行为
  {
    const { registrations, Section } = getSectionComponent({});
    check('settings.section 已注册', Boolean(Section));
    check('settings.section.icon 已注册', registrations.some((x) => x.meta.name === 'settings.section.icon'));
    const sec = registrations.find((x) => x.meta.name === 'settings.section');
    check('settings.section id 为 dshweb-remote-control', sec && sec.meta.id === 'dshweb-remote-control', sec && sec.meta.id);
    check('settings.section order 为 151', sec && sec.meta.order === 151, sec && String(sec.meta.order));
    check('label() 返回中文标题', sec && sec.meta.label() === '远程连接', sec && sec.meta.label());
  }
  {
    const { registrations } = getSectionComponent({ lang: 'en' });
    const sec = registrations.find((x) => x.meta.name === 'settings.section');
    check('英文 locale 下 label 为 Remote Connect', sec && sec.meta.label() === 'Remote Connect', sec && sec.meta.label());
  }
  {
    // 非远程浏览器（桌面 GUI 直连核心）不注册目录选择器
    const { registrations } = getSectionComponent({});
    check('桌面模式下不注册 directoryFlow', !registrations.some((x) => String(x.meta.name).includes('directoryFlow')), registrations.map((x) => x.meta.name).join(','));
  }
  {
    // 远程浏览器（手机）才注册目录选择器
    const { registrations } = getSectionComponent({ remote: 'mobile' });
    check('移动端注册目录选择器', registrations.some((x) => String(x.meta.name).includes('directoryFlow')), registrations.map((x) => x.meta.name).join(','));
  }

  // 3. 页签：只有接入 / 远程设备，「显示」已删除
  {
    const out = renderSection({});
    check('渲染不报错', out.errors.length === 0, out.errors.join(' | '));
    check('含页签「接入」', out.allText.includes('接入'));
    check('含页签「远程设备」', out.allText.includes('远程设备'));
    check('已删除「显示」页签', !out.allText.includes('显示'));
    check('已移除 🔠 显示卡图标', !out.allText.includes('🔠'));
    check('不再有 DisplayCard 的「文字大小」文案', !out.allText.includes('文字大小'));
    check('不再有「保存显示设置」按钮', !out.allText.includes('保存显示设置'));
    check('渲染了 NetworkIcon svg', out.types.length > 0);
  }
  {
    const out = renderSection({ lang: 'en' });
    check('英文含 Access 页签', out.allText.includes('Access'));
    check('英文含 Remote Devices 页签', out.allText.includes('Remote Devices'));
    check('英文不含 Display 页签', !out.allText.includes('Display'));
  }

  // 4. 桌面端：删除控件齐全
  {
    const { acc, text, nodes } = renderSecurity({});
    check('远程设备卡渲染无异常', acc.errors.length === 0, acc.errors.join(' | '));
    check('含「删除远程设备」一键按钮', text.includes('删除远程设备'));
    check('设备名渲染出来', text.includes('Android · Safari') && text.includes('未知设备'), text.slice(0, 200));

    const delAllNodes = nodes.filter((n) => n.props && n.props.className === 'dshweb-del-all');
    check('恰好一个 dshweb-del-all 按钮', delAllNodes.length === 1, `实际 ${delAllNodes.length}`);
    if (delAllNodes.length === 1) {
      const n = delAllNodes[0];
      check('一键删除按钮是 button 元素', n.type === 'button', String(n.type));
      check('一键删除按钮文案为「删除远程设备」', nodeText(n) === '删除远程设备', nodeText(n));
      check('一键删除按钮有 title', Boolean(n.props.title), JSON.stringify(n.props.title));
      check('一键删除按钮为红字样式', String((n.props.style && n.props.style.color) || '').includes('label-error'), JSON.stringify(n.props.style));
      check('一键删除按钮可点击', typeof n.props.onClick === 'function');
      check('一键删除按钮未被禁用（有远程设备）', !n.props.disabled, String(n.props.disabled));
    }

    const delOneNodes = nodes.filter((n) => n.props && n.props.className === 'dshweb-del-device');
    check('非当前设备各有一个 × 按钮（2 个）', delOneNodes.length === 2, `实际 ${delOneNodes.length}`);
    for (const n of delOneNodes) {
      check('× 按钮带 aria-label「删除设备」', n.props['aria-label'] === '删除设备', String(n.props['aria-label']));
      check('× 按钮宽度 24', Number(n.props.style && n.props.style.width) === 24, String(n.props.style && n.props.style.width));
      check('× 按钮文案为 ×', nodeText(n) === '×', nodeText(n));
    }
    check('当前设备没有 × 按钮', delOneNodes.length === DEVICES.length - 1, `${delOneNodes.length} vs ${DEVICES.length - 1}`);
  }

  // 5. 只有当前设备时：一键删除仍出现（可点，但后端会保留当前设备），无 ×
  {
    const { nodes } = renderSecurity({ devices: [DEVICES[0]], currentId: 'cur1' });
    const delAll = nodes.filter((n) => n.props && n.props.className === 'dshweb-del-all');
    check('只有当前设备时仍渲染一键删除按钮', delAll.length === 1);
    check('只有当前设备时一键删除按钮可点（禁用条件仅为「无设备」）', delAll.length === 1 && !delAll[0].props.disabled, delAll.length === 1 ? String(delAll[0].props.disabled) : '');
    const delOne = nodes.filter((n) => n.props && n.props.className === 'dshweb-del-device');
    check('只有当前设备时无 × 按钮', delOne.length === 0, `实际 ${delOne.length}`);
  }

  // 6. 空设备列表：显示占位、无 × 按钮
  {
    const { text, nodes } = renderSecurity({ devices: [], currentId: null });
    check('空列表显示「暂无设备」', text.includes('暂无设备'), text.slice(0, 80));
    check('空列表无 × 按钮', nodes.filter((n) => n.props && n.props.className === 'dshweb-del-device').length === 0);
    check('空列表一键删除按钮禁用', (() => {
      const b = nodes.filter((n) => n.props && n.props.className === 'dshweb-del-all');
      return b.length === 1 && Boolean(b[0].props.disabled);
    })());
  }

  // 7. 移动端：不渲染任何删除控件
  {
    const { text, nodes } = renderSecurity({ remote: 'mobile' });
    check('移动端不渲染 dshweb-del-all', nodes.filter((n) => n.props && n.props.className === 'dshweb-del-all').length === 0);
    check('移动端不渲染 dshweb-del-device', nodes.filter((n) => n.props && n.props.className === 'dshweb-del-device').length === 0);
    check('移动端界面无「删除远程设备」文案', !text.includes('删除远程设备'));
    check('移动端仍能看到设备列表', text.includes('Android · Safari'), text.slice(0, 200));
  }
  {
    const { nodes } = renderSecurity({ remote: 'desktop' });
    check('data-remote=desktop 时删除控件仍隐藏（远程桌面浏览器）', nodes.filter((n) => n.props && n.props.className === 'dshweb-del-all').length === 0);
  }

  // 8. 不使用 window.confirm，改由宿主 Modal / 行内确认
  {
    const { acc } = renderSecurity({});
    check('客户端不使用 window.confirm', !clientJs.includes('window.confirm'));
    check('客户端不含 askConfirm 辅助', !clientJs.includes('askConfirm'));
    check('客户端不含旧 ConfirmDialog 类名', !clientJs.includes('ConfirmDialog') && !clientJs.includes('dshweb-confirm-overlay'));
    check('客户端引用宿主 Modal 原语', clientJs.includes('@deepseek-ai/dsh-client-ui-primitives') && clientJs.includes('HostModal'));
    check('渲染出的树里没有 alertdialog 遮罩', acc.props.filter((p) => p.role === 'alertdialog').length === 0);
    check('客户端不含固定定位遮罩的自绘弹窗', !clientJs.includes('dshweb-del-overlay'));
  }

  // 9. 宿主 Modal 可用时，删除确认交给宿主 Modal（保证置顶）
  {
    const modalCalls = [];
    const Modal = (props) => {
      modalCalls.push(props);
      return null;
    };
    const { acc } = renderSecurity({ modal: Modal, primitives: { Modal } });
    check('有宿主 Modal 时仍无行内 × 之外的确认控件重复渲染', acc.errors.length === 0, acc.errors.join(' | '));
    // 未点击删除时 Modal open=false
    const opened = modalCalls.filter((p) => p.open === true);
    check('未触发删除时宿主 Modal 不打开', opened.length === 0, `open=true 出现 ${opened.length} 次`);
    const anyModal = modalCalls[0];
    check('宿主 Modal 收到 title「删除设备」', anyModal && anyModal.title === '删除设备', anyModal && anyModal.title);
    check('宿主 Modal 收到 onClose 回调', anyModal && typeof anyModal.onClose === 'function');
    check('宿主 Modal 收到 closeLabel', anyModal && anyModal.closeLabel === '关闭', anyModal && anyModal.closeLabel);
    check('宿主 Modal footer 含取消/删除按钮', anyModal && Boolean(anyModal.footer));
  }
});

/* ── 交互测试：点击 × / 一键删除后的状态变化 ─────────────── */
await r.run(async (check) => {
  const { React, captured } = reactWithState({ devices: DEVICES, currentId: 'cur1' });
  const { Section } = getSectionComponent({ react: React });
  const node = Section({ ctx: { get: () => 'zh' } });

  const acc = { texts: [], props: [], nodes: [], types: [], errors: [] };
  flatten(node, acc);
  check('交互用例渲染无异常', acc.errors.length === 0, acc.errors.join(' | '));

  const delOne = acc.nodes.filter((n) => n.props && n.props.className === 'dshweb-del-device');
  check('交互用例：找到 × 按钮', delOne.length === 2, `实际 ${delOne.length}`);
  if (delOne.length > 0) {
    const before = captured.setters.length;
    delOne[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    const after = captured.setters.slice(before);
    check('点击 × 会调用 setter（进入确认态）', after.length > 0, `setter 调用 ${after.length} 次`);
    const confirmSetter = after.find((s) => s.value && typeof s.value === 'object' && s.value.mode);
    check('确认态包含 mode', Boolean(confirmSetter), JSON.stringify(after.map((s) => s.value)));
    if (confirmSetter) {
      check('单台删除的 mode 为 one', confirmSetter.value.mode === 'one', confirmSetter.value.mode);
      check('确认态带 id（对应被点的设备）', typeof confirmSetter.value.id === 'string', String(confirmSetter.value.id));
      check('确认文案提到该设备', String(confirmSetter.value.text || '').length > 0, confirmSetter.value.text);
      check('确认态带 onYes/onNo', typeof confirmSetter.value.onYes === 'function' && typeof confirmSetter.value.onNo === 'function');
    }
  }

  const delAll = acc.nodes.filter((n) => n.props && n.props.className === 'dshweb-del-all');
  check('交互用例：找到一键删除按钮', delAll.length === 1, `实际 ${delAll.length}`);
  if (delAll.length > 0) {
    const before = captured.setters.length;
    delAll[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
    const after = captured.setters.slice(before);
    const confirmSetter = after.find((s) => s.value && typeof s.value === 'object' && s.value.mode);
    check('点击一键删除进入确认态', Boolean(confirmSetter), JSON.stringify(after.map((s) => s.value)));
    if (confirmSetter) {
      check('一键删除的 mode 为 all', confirmSetter.value.mode === 'all', confirmSetter.value.mode);
      check('确认文案提到「所有远程设备」', String(confirmSetter.value.text || '').includes('所有远程设备'), confirmSetter.value.text);
    }
  }
});

/* ── 目录选择器（移动端专用）基本契约 ─────────────────────── */
await r.run(async (check) => {
  const { registrations } = getSectionComponent({ remote: 'mobile' });
  const dirReg = registrations.find((x) => String(x.meta.name).includes('directoryFlow'));
  check('目录选择器已注册', Boolean(dirReg));
  if (dirReg) {
    const out = collect(dirReg.comp({ open: false }));
    check('open=false 时目录选择器返回空', out.texts.length === 0, out.allText);
    const out2 = collect(dirReg.comp({ open: true, listDirectory: () => Promise.resolve({ path: 'D:\\', entries: [], crumbs: [] }) }));
    check('open=true 时渲染标题「选择工作区文件夹」', out2.allText.includes('选择工作区文件夹'), out2.allText.slice(0, 80));
  }
});

/* ── 目录选择器「← 返回」行为（回归：返回按钮曾永远禁用）────────
 * 根因回顾：旧实现把「压历史栈」放在 load() 异步回调里，而 pathRef 镜像
 * useEffect([path]) 先于回调提交 → 回调读到的已是新路径 → 栈永远为空 →
 * 「← 返回」disabled 恒为 true。修复后 navigate() 在前进导航时同步压栈、
 * goBack 只弹栈不再 load（避免把当前路径又压回去造成振荡）。
 */
await r.run(async (check) => {
  // 静态断言：bundle 必须包含修复关键结构（防回归）
  check('bundle 含 navigate() 统一压栈（修复结构）', clientJs.includes('function navigate(p)'));
  check('bundle goBack 弹栈后直接 setPath（不再 load，避免振荡）',
    /function goBack\(\)\s*\{[^}]*pop\(\)[^}]*setPath/.test(clientJs));
  check('bundle load() 内不含压栈逻辑（压栈已前移到 navigate）',
    !/function load\(p\)\s*\{[^}]*backStackRef/.test(clientJs));
  check('bundle open 重置返回历史栈（第二次打开不残留）',
    clientJs.includes('backStackRef.current = [];'));

  // 交互断言：渲染目录选择器，确认「← 返回」按钮初始禁用、绑定 onClick，
  // 且前进导航按钮（子文件夹行）也绑定 onClick（navigate 链路入口在位）
  const navData = {
    path: 'D:/projects', home: 'C:/Users/tester', workspaceRoot: 'C:/Users/tester/Documents/deepseek-harness',
    parent: 'D:/', crumbs: [{ name: 'D:', path: 'D:/' }, { name: 'projects', path: 'D:/projects' }],
    drives: ['C:', 'D:'], entries: [{ path: 'D:/projects/alpha', name: 'alpha', hidden: false }], truncated: false,
  };
  // 注入 data 初值：mock React 没有「异步 load 完成→重渲」机制，
  // 直接用 useState 注入让 entries 在首帧渲染出来（第 2 个 useState 是 data）
  const reactWith = makeReact();
  let dataIdx = -1;
  reactWith.useState = (init) => {
    dataIdx++;
    if (dataIdx === 1) return [navData, () => {}];
    const value = typeof init === 'function' ? init() : init;
    return [value, () => {}];
  };
  const backRegs = getSectionComponent({ react: reactWith, remote: 'mobile' }).registrations;
  const dirReg = backRegs.find((x) => String(x.meta.name).includes('directoryFlow'));
  check('返回行为用例：目录选择器已注册', Boolean(dirReg));
  if (!dirReg) return;

  const out = collect(dirReg.comp({
    open: true, busy: false,
    listDirectory: () => Promise.resolve(navData),
    onPicked() {}, onCancel() {}, onError() {},
  }));
  check('返回行为用例：渲染无异常', out.errors.length === 0, out.errors.join(' | '));

  const backBtn = out.nodes.filter((n) => n.props && nodeText(n) === '← 返回');
  check('返回行为用例：存在「← 返回」按钮', backBtn.length === 1, `实际 ${backBtn.length}`);
  if (backBtn.length === 1) {
    // 初始 path='' 且历史栈为空 → disabled=true（这曾是不起作用的表象，
    // 修复后栈在 navigate 时压入，进入子目录后即变为可用）
    check('返回行为用例：初始栈空 → 返回按钮禁用', Boolean(backBtn[0].props.disabled), String(backBtn[0].props.disabled));
    check('返回行为用例：返回按钮绑定 onClick（goBack）', typeof backBtn[0].props.onClick === 'function');
  }
  const subDirBtn = out.nodes.filter((n) => n.props && nodeText(n) === '📂 alpha');
  check('返回行为用例：子文件夹行按钮绑定 onClick（navigate 压栈入口）',
    subDirBtn.length === 1 && typeof subDirBtn[0].props.onClick === 'function', `实际 ${subDirBtn.length}`);
  const upBtn = out.nodes.filter((n) => n.props && nodeText(n) === '↑ 上级目录');
  check('返回行为用例：上级目录按钮绑定 onClick', upBtn.length === 1 && typeof upBtn[0].props.onClick === 'function');
});

/* ── 远程端弹宿主机文件夹（偶发）回归 ─────────────────────────
 * 根因：官方 ui-directory-picker-native 在 directoryPicker/pick 被授权时向同一
 * directoryFlow 空位注册 renderless 组件，行为就是 ctx.uiWorkspace.pickDirectory()
 * → RPC 到宿主机弹系统框。priority -1 遮蔽依赖 inject 回调顺序，存在「native
 * 暂时上位 + owner 恰好 open」的竞态窗口。
 * 修复：installDirectoryFlow 先把 uiWorkspace.pickDirectory 换成 resolve(null)，
 * 并把自绘 occupant 的 priority 压到 -1000，确定性地抢在 native 之前。
 */
await r.run(async (check) => {
  check('bundle 含宿主机选择器护栏 neutralizeHostPicker', clientJs.includes('function neutralizeHostPicker'));
  // esbuild 会把具名函数表达式压成匿名 function(){...}，这里只断言语义（返回 null）
  check('bundle 护栏返回 null（native 只会走 onCancel）', clientJs.includes('Promise.resolve(null)'));
  check('bundle 护栏带幂等标记 __dshwebPickGuarded', clientJs.includes('__dshwebPickGuarded'));
  // esbuild 可能把 -1000 写成 -1e3，二者都接受
  check('bundle 自绘 occupant 优先于 native（priority -1000）', /priority: -(?:1000|1e3)\b/.test(clientJs));

  // 行为断言：apply 时 uiWorkspace.pickDirectory 被替换，且返回 null
  const picked = [];
  const uiWorkspace = { pickDirectory: () => { picked.push('native'); return Promise.resolve('C:/native-pick'); } };
  const { mod } = loadModule({ remote: 'mobile' });
  const slots = { inject() {}, register() { return () => {}; } };
  const c = {
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'locale') return { lang: 'zh' };
      if (name === 'uiWorkspace') return uiWorkspace;
      return null;
    },
  };
  mod.apply(c);
  check('远程浏览器下 uiWorkspace.pickDirectory 被打桩', uiWorkspace.__dshwebPickGuarded === true);
  const value = await uiWorkspace.pickDirectory();
  check('打桩后的 pickDirectory 返回 null（不触达宿主机）', value === null, String(value));
  check('打桩后原宿主机实现未被调用', picked.length === 0, picked.join(','));

  // 桌面直连（无 data-remote）不得改动宿主服务
  const uiWorkspace2 = { pickDirectory: () => Promise.resolve('C:/keep') };
  const { mod: mod2 } = loadModule({ remote: null });
  mod2.apply({
    get(name) {
      if (name === 'slots') return { inject() {}, register() { return () => {}; } };
      if (name === 'locale') return { lang: 'zh' };
      if (name === 'uiWorkspace') return uiWorkspace2;
      return null;
    },
  });
  check('桌面直连不改动 pickDirectory', uiWorkspace2.__dshwebPickGuarded === undefined);
  check('桌面直连 pickDirectory 保持原实现', (await uiWorkspace2.pickDirectory()) === 'C:/keep');
});

/* ── 手机端弹窗内滑动穿透到底层背景 回归 ──────────────────────
 * 根因：遮罩/弹窗只是 fixed 定位，未切断滚动链：列表滚到底后多余手势继续传播
 * 给 document，页面（含正文）跟着滑动。修复用三层：弹窗打开时锁 body/html
 * overflow + overscroll-behavior:contain，遮罩 contain，列表独立滚动。
 */
await r.run(async (check) => {
  check('bundle 弹窗打开时锁 body 滚动', /body\.style\.overflow = "hidden"/.test(clientJs));
  check('bundle 弹窗打开时锁 html 滚动', /html\.style\.overflow = "hidden"/.test(clientJs));
  check('bundle 关闭时恢复原滚动样式', /body\.style\.overflow = prev\.bodyOverflow/.test(clientJs));
  check('bundle 列表区带 overscroll-behavior:contain', /overscrollBehavior: "contain"/.test(clientJs));
  check('bundle 列表区限定 touch-action:pan-y', /touchAction: "pan-y"/.test(clientJs));
  // iOS 兼容兜底：文档级 touchmove 拦截（起点不在列表里就 preventDefault）
  check('bundle 有文档级 touchmove 拦截（起点不在列表则阻断）',
    clientJs.includes('addEventListener("touchmove", onTouchMove') && clientJs.includes('dshweb-dir-list'));
  check('bundle 关闭时移除 touchmove 监听', clientJs.includes('removeEventListener("touchmove", onTouchMove'));

  const navData = {
    path: 'D:/projects', home: 'C:/Users/tester', workspaceRoot: 'C:/Users/tester/Documents/deepseek-harness',
    parent: 'D:/', crumbs: [], drives: [], entries: [], truncated: false,
  };
  const { registrations } = getSectionComponent({ remote: 'mobile' });
  const dirReg = registrations.find((x) => String(x.meta.name).includes('directoryFlow'));
  check('滚动穿透用例：目录选择器已注册', Boolean(dirReg));
  if (!dirReg) return;
  const out = collect(dirReg.comp({ open: true, listDirectory: () => Promise.resolve(navData), onPicked() {}, onCancel() {} }));
  check('滚动穿透用例：渲染无异常', out.errors.length === 0, out.errors.join(' | '));
  const scroller = out.nodes.filter((n) => n.props && n.props.className === 'dshweb-dir-list');
  check('滚动穿透用例：存在独立滚动列表容器', scroller.length === 1, `实际 ${scroller.length}`);
  if (scroller.length === 1) {
    check('滚动穿透用例：列表容器 overscroll 收口', scroller[0].props.style.overscrollBehavior === 'contain');
  }
  const modal = out.nodes.filter((n) => n.props && n.props.className === 'dshweb-dir-modal');
  check('滚动穿透用例：弹窗容器 overscroll 收口', modal.length === 1 && modal[0].props.style.overscrollBehavior === 'contain');
});

/* ── 域名白名单输入框自适应高度 回归 ──────────────────────────
 * 需求：默认占 2 行文本高度；内容变多时自动增高；最多 5 行；
 * 超过 5 行后高度固定，改为内部滚动条上下查看。
 * 实现：useLayoutEffect 里按 scrollHeight 计算，钳制在 [2 行, 5 行] 区间，
 * 超出上限时 overflow-y:auto，否则 hidden。
 */
await r.run(async (check) => {
  check('bundle 含白名单输入框自适应高度逻辑', clientJs.includes('HOSTS_MIN_HEIGHT') && clientJs.includes('HOSTS_MAX_HEIGHT'));
  check('bundle 用 scrollHeight 测量内容高度', clientJs.includes('el.scrollHeight'));
  check('bundle 高度按 2 行下限 / 5 行上限钳制',
    /Math\.max\(HOSTS_MIN_HEIGHT, Math\.min\(HOSTS_MAX_HEIGHT, needed\)\)/.test(clientJs));
  check('bundle 超限时切换为内部滚动条', /overflowY = needed > HOSTS_MAX_HEIGHT \? "auto" : "hidden"/.test(clientJs));
  check('bundle 白名单输入框禁用人工拖拽缩放', clientJs.includes('resize: "none"'));

  const out = renderSection({});
  check('白名单输入框渲染无异常', out.errors.length === 0, out.errors.join(' | '));
  const ta = out.nodes.filter((n) => n.props && n.props.className === 'dshweb-hosts-input');
  check('白名单输入框恰好一个', ta.length === 1, `实际 ${ta.length}`);
  if (ta.length !== 1) return;
  const p = ta[0].props;
  check('白名单输入框元素为 textarea', ta[0].type === 'textarea', String(ta[0].type));
  check('白名单输入框默认 2 行', p.rows === 2, String(p.rows));
  // 字号 12 × 行高 1.6 = 19.2px/行，盒模型 padding 16 + border 2（box-sizing: border-box）
  const lineHeightPx = 12 * 1.6;
  const minExpected = Math.round(lineHeightPx * 2 + 16 + 2);
  const maxExpected = Math.round(lineHeightPx * 5 + 16 + 2);
  check('白名单输入框最小高度 = 2 行', p.style.minHeight === minExpected, `${p.style.minHeight} vs ${minExpected}`);
  check('白名单输入框最大高度 = 5 行', p.style.maxHeight === maxExpected, `${p.style.maxHeight} vs ${maxExpected}`);
  check('白名单输入框初始不显示滚动条', p.style.overflowY === 'hidden', String(p.style.overflowY));
  check('白名单输入框高度先交给脚本计算', p.style.height === 'auto', String(p.style.height));
  check('白名单输入框绑定 ref（供测量 scrollHeight）', p.ref !== undefined);
});

/* ── m01467：HTTPS 共存 + HTTPS 接入地址一键复制 ─────────────── */
await r.run(async (check) => {
  // 静态结构：bundle 里存在 HTTPS 开关/端口/保存、HTTPS 地址行与复制逻辑
  check('bundle 含 HTTPS 开关文案', clientJs.includes('开启 HTTPS 监听') || clientJs.includes('Enable HTTPS listener'));
  check('bundle 含 HTTPS 默认端口 3181', clientJs.includes('3181'));
  check('bundle 含 HTTPS 配置提交（httpsEnabled/httpsPort）',
    clientJs.includes('httpsEnabled') && clientJs.includes('httpsPort'));
  check('bundle 含 HTTPS 接入地址字段标题', clientJs.includes('HTTPS 接入地址') || clientJs.includes('HTTPS Access URL'));
  check('bundle 含 HTTPS 地址一键复制处理', clientJs.includes('copyHttpsUrl'));
  check('bundle 含 httpsLanUrl 读取', clientJs.includes('httpsLanUrl'));
  check('bundle 不再把 HTTP 接入地址写成 https', !clientJs.includes('若已配置 TLS 证书则自动为 https'));

  // 渲染：默认（未开启 HTTPS）时只有一行接入地址，无 HTTPS 地址行
  const plain = renderSection({});
  check('默认渲染无异常', plain.errors.length === 0, plain.errors.join(' | '));
  check('默认渲染含 HTTP 接入地址标题', plain.allText.includes('接入地址'));
  check('默认渲染不含 HTTPS 接入地址行', !plain.allText.includes('HTTPS 接入地址'));

  // 用「锚点」注入而非绝对序号：RemoteControlSection 先消耗一个 tabState，
  // 组件又是 flatten 时才展开，绝对序号会漂移。这里先定位 AccessCard 的第一个
  // useState（初值是带 loading 的对象，唯一），再从该锚点按 AccessCard 内部序号注入：
  //   local 2 = accessUrl、local 9 = httpsEnabled、local 11 = httpsUrl
  function reactWithHttps() {
    const React = makeReact();
    let anchored = false;
    let local = 0;
    React.useState = (init) => {
      const value = typeof init === 'function' ? init() : init;
      // 锚点：第一个「带 loading 属性的对象」即 AccessCard 的 st
      if (!anchored && init && typeof init === 'object' && !Array.isArray(init) && init.loading === true) {
        anchored = true;
        local = 0;
      }
      if (anchored) {
        const i = local++;
        if (i === 2) return ['http://192.168.0.10:3180', () => {}];   // accessUrl
        if (i === 9) return [true, () => {}];                          // httpsEnabled
        if (i === 11) return ['https://192.168.0.10:3181', () => {}];  // httpsUrl
      }
      return [value, () => {}];
    };
    return React;
  }
  const { Section } = getSectionComponent({ react: reactWithHttps() });
  const node = Section({ ctx: { get: () => 'zh' } });
  const acc = { texts: [], props: [], nodes: [], types: [], errors: [] };
  flatten(node, acc);
  const allText = acc.texts.join(' ');
  check('HTTPS 渲染无异常', acc.errors.length === 0, acc.errors.join(' | '));
  check('开启 HTTPS 后含「HTTPS 接入地址」行', allText.includes('HTTPS 接入地址'));
  check('HTTPS 地址行显示 https 协议完整地址', allText.includes('https://192.168.0.10:3181'));
  check('HTTP 接入地址仍显示 http 协议', allText.includes('http://192.168.0.10:3180'));
  check('含 HTTPS 开关文案', allText.includes('HTTPS 协议') || allText.includes('HTTPS (coexists'));
  check('含两个「一键复制」按钮（HTTP + HTTPS）',
    acc.texts.filter((t) => t === '一键复制').length === 2,
    String(acc.texts.filter((t) => t === '一键复制').length));
});

