/**
 * dshweb 客户端运行时（远程接入：接入 / 远程设备 两页签）
 *
 * 由工作区清空事故后的部署产物 lib/client.raw.js 反推恢复（2026-11-12），
 * 与 esbuild --external react/react/jsx-runtime 兼容：react-dom 与
 * @deepseek-ai/dsh-client-ui-primitives 用裸 require，esbuild 原样保留，
 * 运行时由宿主 __ModuleLoader__ staticModules 解析。
 */
import * as React from 'react';

let ReactDOM = null;
try {
  ReactDOM = require('react-dom');
} catch (e) {
  ReactDOM = null;
}
let UI_PRIMITIVES = null;
try {
  UI_PRIMITIVES = require('@deepseek-ai/dsh-client-ui-primitives');
} catch (e) {
  UI_PRIMITIVES = null;
}
var HostModal = UI_PRIMITIVES && UI_PRIMITIVES.Modal;
var API_BASE = (function() {
  try {
    if (typeof document !== "undefined" && document.baseURI) {
      return new URL("api/dshweb/", document.baseURI).toString();
    }
    return "/api/dshweb/";
  } catch (e) {
    return "/api/dshweb/";
  }
})();
function api(path, options) {
  return fetch(API_BASE + path, options).then(function(res) {
    if (!res.ok) {
      return res.text().then(function(text) {
        var msg = "HTTP " + res.status;
        try {
          var parsed = JSON.parse(text);
          if (parsed && (parsed.reason || parsed.message || parsed.error)) msg = parsed.reason || parsed.message || parsed.error;
        } catch (e) {
        }
        throw new Error(msg);
      });
    }
    return res.json();
  });
}
function resolveLang(ctx) {
  try {
    if (ctx && typeof ctx.get === "function") {
      var locale = ctx.get("locale");
      var lang = locale && (locale.lang || locale.locale || locale);
      if (typeof lang === "string") return lang.toLowerCase().startsWith("en") ? "en" : "zh";
    }
  } catch (e) {
  }
  try {
    var nav = (navigator.language || "zh").toLowerCase();
    return nav.startsWith("en") ? "en" : "zh";
  } catch (e) {
    return "zh";
  }
}
var inject = ["slots", "locale", "connection"];
function apply(ctx) {
  if (typeof window !== "undefined") {
    window.__DSH_CLIENT_CTX__ = ctx;
  }
  var slots = null;
  try {
    if (ctx && typeof ctx.get === "function") {
      slots = ctx.get("slots");
    } else if (ctx && ctx.slots) {
      slots = ctx.slots;
    }
  } catch (e) {
  }
  if (!slots || typeof slots.inject !== "function") return;
  slots.inject("settings.section", function() {
    var unregister = slots.register(
      {
        name: "settings.section",
        id: "dshweb-remote-control",
        order: 151,
        label: function() {
          return resolveLang(ctx) === "en" ? "Remote Connect" : "远程连接";
        }
      },
      RemoteControlSection
    );
    return function() {
      if (typeof unregister === "function") unregister();
    };
  });
  slots.inject("settings.section.icon", function() {
    var unregister = slots.register(
      {
        name: "settings.section.icon",
        id: "dshweb-remote-control",
        order: 151,
        label: function() {
          return resolveLang(ctx) === "en" ? "Remote Connect" : "远程连接";
        }
      },
      SectionIcon
    );
    return function() {
      if (typeof unregister === "function") unregister();
    };
  });
  try {
    installDirectoryFlow(ctx, slots);
  } catch (e) {
    if (typeof console !== "undefined" && console.warn) console.warn("[dshweb] directoryFlow:", e);
  }
}
var C = {
  cardBg: "var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.06))",
  fieldBg: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1))",
  border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))",
  fieldBorder: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
  primaryText: "var(--dsw-alias-label-primary, inherit)",
  secondaryText: "var(--dsw-alias-label-secondary, #888)",
  tertiaryText: "var(--dsw-alias-label-tertiary, #888)",
  blue: "#2563eb",
  green: "#10b981",
  red: "#ef4444"
};
function inputStyle(extra) {
  return Object.assign(
    {
      height: 38,
      background: C.fieldBg,
      border: C.fieldBorder,
      borderRadius: 8,
      padding: "0 12px",
      color: "inherit",
      fontSize: 14,
      outline: "none",
      boxSizing: "border-box"
    },
    extra || {}
  );
}
function Card(props) {
  return React.createElement(
    "div",
    {
      style: {
        background: C.cardBg,
        border: C.border,
        borderRadius: 12,
        padding: "14px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 12
      }
    },
    React.createElement(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
      React.createElement("span", { style: { fontSize: 16, lineHeight: "20px" } }, props.icon),
      React.createElement(
        "span",
        { style: { fontSize: 15, fontWeight: 600, color: C.primaryText } },
        props.title
      ),
      props.badge || null,
      props.headerRight ? React.createElement(
        "span",
        { style: { marginLeft: "auto", display: "inline-flex", alignItems: "center" } },
        props.headerRight
      ) : null
    ),
    props.desc ? React.createElement(
      "div",
      { style: { fontSize: 12, color: C.tertiaryText, lineHeight: 1.5, marginTop: -4 } },
      props.desc
    ) : null,
    props.children || null
  );
}
function Badge(configured, lang) {
  return React.createElement(
    "span",
    {
      style: {
        fontSize: 12,
        color: configured ? C.green : C.tertiaryText,
        background: configured ? "rgba(16,185,129,0.12)" : "transparent",
        padding: "2px 8px",
        borderRadius: 12,
        fontWeight: 500
      }
    },
    configured ? lang === "en" ? "Configured" : "已配置" : lang === "en" ? "Not set" : "未配置"
  );
}
function Field(label, control, hint) {
  return React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 6 } },
    React.createElement("label", { style: { fontSize: 12, fontWeight: 600, color: C.primaryText } }, label),
    control,
    hint ? React.createElement("span", { style: { fontSize: 11, color: C.tertiaryText } }, hint) : null
  );
}
function Btn(label, onClick, opts) {
  opts = opts || {};
  var children = opts.icon ? [React.createElement(opts.icon, { key: "i" }), label] : label;
  return React.createElement(
    "button",
    {
      type: "button",
      onClick,
      disabled: Boolean(opts.disabled),
      style: {
        height: 38,
        padding: "0 16px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: opts.primary ? C.blue : opts.danger ? "rgba(239,68,68,0.1)" : "var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.1))",
        color: opts.primary ? "#fff" : opts.danger ? C.red : C.secondaryText,
        border: opts.primary ? "none" : opts.danger ? "1px solid rgba(239,68,68,0.2)" : "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        cursor: opts.disabled ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
        boxShadow: opts.primary ? "0 2px 6px rgba(37,99,235,0.3)" : "none",
        opacity: opts.disabled ? 0.6 : 1
      }
    },
    children
  );
}
function HomeIcon() {
  return React.createElement(
    "svg",
    {
      style: { width: 18, height: 18, flexShrink: 0 },
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round"
    },
    React.createElement("path", { d: "M3 10.5 12 3l9 7.5" }),
    React.createElement("path", { d: "M5 9.5V21h5v-6h4v6h5V9.5" })
  );
}
function EyeIcon(show) {
  var PATH_OPEN = "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z";
  var PATH_CLOSED = "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z";
  return React.createElement(
    "svg",
    { style: { width: 18, height: 18, fill: "currentColor" }, viewBox: "0 0 24 24" },
    React.createElement("path", { d: show ? PATH_OPEN : PATH_CLOSED })
  );
}
function NativePwdStyle() {
  return React.createElement("style", {
    dangerouslySetInnerHTML: {
      __html: "input.dshweb-pwd-input::-ms-reveal, input.dshweb-pwd-input::-ms-clear, input.dshweb-pwd-input::-webkit-credentials-auto-fill-button, input.dshweb-pwd-input::-webkit-contacts-auto-fill-button { display: none !important; width: 0 !important; height: 0 !important; visibility: hidden !important; pointer-events: none !important; }"
    }
  });
}
function Note(text) {
  return React.createElement("p", { style: { fontSize: 12, color: C.blue, margin: 0 } }, text);
}
function NetworkIcon() {
  return React.createElement(
    "svg",
    {
      width: 17,
      height: 17,
      viewBox: "0 0 32 32",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.98,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      style: { flexShrink: 0, display: "block" }
    },
    React.createElement("circle", { cx: 16, cy: 16, r: 13.5 }),
    React.createElement("ellipse", { cx: 16, cy: 16, rx: 5.74, ry: 13.5 }),
    React.createElement("path", { d: "M2.6 17.9h26.8" })
  );
}
function DevicesIcon() {
  return React.createElement(
    "svg",
    {
      width: 17,
      height: 17,
      viewBox: "0 0 32 32",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.98,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      style: { flexShrink: 0, display: "block" }
    },
    // 桌面显示器
    React.createElement("rect", { x: 3, y: 5, width: 19, height: 14, rx: 2 }),
    React.createElement("path", { d: "M12.5 19v4" }),
    React.createElement("path", { d: "M8 23h9" }),
    // 手机
    React.createElement("rect", { x: 24, y: 11, width: 5, height: 12, rx: 1.5 }),
    React.createElement("path", { d: "M25.5 21h2" })
  );
}
function CopyIcon() {
  return React.createElement(
    "svg",
    { style: { width: 13, height: 13, fill: "currentColor", flexShrink: 0 }, viewBox: "0 0 24 24", "aria-hidden": "true" },
    React.createElement("path", { d: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" })
  );
}
function CheckIcon() {
  return React.createElement(
    "svg",
    { style: { width: 13, height: 13, fill: "currentColor", flexShrink: 0 }, viewBox: "0 0 24 24", "aria-hidden": "true" },
    React.createElement("path", { d: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" })
  );
}
function SectionIcon(props) {
  var size = props && props.size || 16;
  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 32 32",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      style: { display: "block", flexShrink: 0 }
    },
    // 放大居中的大地球：外圈 + 经线椭圆 + 略低于圆心的赤道线（无箭头）
    React.createElement("circle", { cx: 16, cy: 16, r: 13.5 }),
    React.createElement("ellipse", { cx: 16, cy: 16, rx: 5.74, ry: 13.5 }),
    React.createElement("path", { d: "M2.6 17.9h26.8" })
  );
}
var DIR_SLOTS = [
  "conversation.hero.workspace.directoryFlow",
  "sidebar.workspaces.directoryFlow"
];
function isRemoteBrowser() {
  try {
    if (typeof document === "undefined" || !document.documentElement) return false;
    var v = document.documentElement.getAttribute("data-remote");
    return v === "mobile" || v === "desktop";
  } catch (e) {
    return false;
  }
}
function dirList(p, signal) {
  return api(
    "directory/list?path=" + encodeURIComponent(p || ""),
    signal ? { signal } : void 0
  );
}
function dirCreate(p, name) {
  return api("directory/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p, name })
  }).then(function(r) {
    return r.path;
  });
}
function DshwebDirectoryFlow(props) {
  props = props || {};
  var open = props.open;
  var listDirectory = props.listDirectory || dirList;
  var createDirectory = props.createDirectory || dirCreate;
  var onPicked = props.onPicked;
  var onCancel = props.onCancel;
  var pathState = React.useState("");
  var path = pathState[0];
  var setPath = pathState[1];
  var pathRef = React.useRef("");
  React.useEffect(function() {
    pathRef.current = path;
  }, [path]);
  var dataState = React.useState({ path: "", home: "", workspaceRoot: "", parent: null, crumbs: [], entries: [], truncated: false });
  var data = dataState[0];
  var setData = dataState[1];
  var loadingState = React.useState(false);
  var loading = loadingState[0];
  var setLoading = loadingState[1];
  var errState = React.useState("");
  var err = errState[0];
  var setErr = errState[1];
  var nameState = React.useState("");
  var newName = nameState[0];
  var setNewName = nameState[1];
  var hiddenState = React.useState(false);
  var showHidden = hiddenState[0];
  var setShowHidden = hiddenState[1];
  var addrState = React.useState("");
  var addrDraft = addrState[0];
  var setAddrDraft = addrState[1];
  var driveMenuState = React.useState(false);
  var driveMenuOpen = driveMenuState[0];
  var setDriveMenuOpen = driveMenuState[1];
  var backStackRef = React.useRef([]);
  var doneRef = React.useRef(false);
  var portalHostRef = React.useRef(null);
  if (typeof document !== "undefined" && document.body) {
    portalHostRef.current = document.body;
  }
  function report(msg) {
    setErr(msg);
  }
  function load(p) {
    setLoading(true);
    setErr("");
    Promise.resolve().then(function() {
      return listDirectory(p);
    }).then(function(d) {
      setData(d || {});
      if (d && d.path) setPath(d.path);
      setLoading(false);
    }).catch(function(e) {
      setLoading(false);
      report("读取目录失败：" + String(e && e.message || e));
    });
  }
  function navigate(p) {
    if (!p) return;
    var cur = pathRef.current;
    var stack = backStackRef.current;
    if (cur && cur !== p && stack[stack.length - 1] !== cur) {
      stack.push(cur);
      if (stack.length > 32) stack.shift();
    }
    setPath(p);
  }
  function goBack() {
    var prev = backStackRef.current.pop();
    if (prev) setPath(prev);
  }
  function finish(p) {
    if (doneRef.current) return;
    doneRef.current = true;
    if (p && typeof onPicked === "function") onPicked(p);
    else if (typeof onCancel === "function") onCancel();
  }
  // open 由 false→true 时重置「已上报 outcome」标记与返回历史栈（否则第二次打开
  // 会残留上次会话的栈，「返回」退回早已离开的目录）；[open, path] 变化时重新拉取列表
  React.useEffect(function() {
    if (open) {
      doneRef.current = false;
      backStackRef.current = [];
    }
  }, [open]);
  React.useEffect(function() {
    if (!open) return;
    load(path || "");
  }, [open, path]);
  React.useEffect(function() {
    if (data && data.path) setAddrDraft(data.path);
  }, [data && data.path]);
  // 手机端「文件夹已全部显示仍能滑动底层背景」：弹窗打开期间锁住页面滚动。
  // 三层切断滚动链（缺一层 iOS 就会漏）：
  //   1) body/html overflow:hidden —— 页面容器不再可滚；
  //   2) 遮罩与弹窗 overscroll-behavior:contain + 列表自身 touch-action:pan-y
  //      —— 滚到边界时的多余手势不冒泡给文档；
  //   3) 文档级 touchmove 兜底 —— iOS 的背景滚动容器往往是 #root 内层 div，
  //      第 1 层锁不到它；起点不在目录列表里的手势一律 preventDefault。
  React.useEffect(function() {
    if (!open) return;
    if (typeof document === "undefined") return;
    var body = document.body;
    var html = document.documentElement;
    if (!body || !html) return;
    var prev = {
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
      htmlOverflow: html.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
    };
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "contain";
    html.style.overflow = "hidden";
    html.style.overscrollBehavior = "contain";
    // 兜底（iOS Safari 对 touch-action 支持不完全，且背景滚动容器可能是 #root
    // 内部的 div 而非 body）：文档级 touchmove 拦截 —— 手势起点不在目录列表里
    // 就 preventDefault，页面背景因此一动都不动；列表内放行给原生惯性滚动。
    var onTouchMove = function(ev) {
      var node = ev && ev.target;
      while (node && node !== document.body) {
        if (node.classList && node.classList.contains("dshweb-dir-list")) return;
        node = node.parentNode;
      }
      if (ev.cancelable) ev.preventDefault();
    };
    var supportsListener = typeof document.addEventListener === "function";
    if (supportsListener) document.addEventListener("touchmove", onTouchMove, { passive: false });
    return function() {
      body.style.overflow = prev.bodyOverflow;
      body.style.overscrollBehavior = prev.bodyOverscroll;
      html.style.overflow = prev.htmlOverflow;
      html.style.overscrollBehavior = prev.htmlOverscroll;
      if (supportsListener) document.removeEventListener("touchmove", onTouchMove, { passive: false });
    };
  }, [open]);
  if (!open) return null;
  var crumbs = data && data.crumbs || [];
  var drives = data && data.drives || [];
  var entries = (data && data.entries || []).filter(function(e) {
    return showHidden || !e.hidden;
  });
  var currentPath = data && data.path || path || data && data.home || "";
  var disabled = Boolean(props.busy) || loading;
  var submitAddr = function() {
    var v = (addrDraft || "").trim();
    if (!v) return;
    setDriveMenuOpen(false);
    navigate(v);
  };
  var navBar = React.createElement(
    "div",
    {
      style: {
        padding: "8px 12px",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
        borderBottom: C.border
      }
    },
    Btn("根目录", function() {
      var wsRoot = data && data.workspaceRoot;
      if (wsRoot) {
        navigate(wsRoot);
        return;
      }
      var crumbs2 = data && data.crumbs || [];
      if (crumbs2.length > 0 && crumbs2[0].path) navigate(crumbs2[0].path);
      else if (data && data.home) navigate(data.home);
    }, { disabled: disabled || !(data && data.path), icon: HomeIcon }),
    Btn("↑ 上级目录", function() {
      if (data && data.parent) navigate(data.parent);
      else if (data && data.workspaceRoot) navigate(data.workspaceRoot);
      else if (data && data.home) navigate(data.home);
    }, { disabled: disabled || !(data && data.parent) }),
    Btn("← 返回", function() {
      goBack();
    }, {
      disabled: disabled || !(backStackRef.current && backStackRef.current.length > 0)
    })
  );
  var addrBar = React.createElement(
    "div",
    {
      style: {
        padding: "8px 12px",
        display: "flex",
        gap: 6,
        alignItems: "center",
        borderBottom: C.border,
        position: "relative"
      }
    },
    React.createElement("input", {
      className: "dshweb-dir-addr",
      type: "text",
      value: addrDraft,
      placeholder: "输入盘符或路径，如 D:\\ 然后回车",
      onChange: function(ev) {
        setAddrDraft(ev && ev.target ? ev.target.value : "");
      },
      onKeyDown: function(ev) {
        if (ev && ev.key === "Enter") {
          if (ev.preventDefault) ev.preventDefault();
          submitAddr();
        }
      },
      style: inputStyle({ flex: 1, minWidth: 0, height: 34, fontSize: 13 })
    }),
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": "选择盘符",
        onClick: function() {
          setDriveMenuOpen(!driveMenuOpen);
        },
        style: {
          minHeight: 34,
          minWidth: 34,
          padding: "0 8px",
          borderRadius: 8,
          border: C.border,
          background: C.fieldBg,
          color: C.primaryText,
          fontSize: 14,
          cursor: "pointer"
        }
      },
      "▾"
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: function() {
          setShowHidden(!showHidden);
        },
        style: {
          minHeight: 34,
          minWidth: 34,
          padding: "0 8px",
          borderRadius: 8,
          border: C.border,
          background: C.fieldBg,
          color: C.primaryText,
          fontSize: 13,
          cursor: "pointer"
        }
      },
      showHidden ? React.createElement(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
        React.createElement("path", { d: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" }),
        React.createElement("circle", { cx: 12, cy: 12, r: 2.6 }),
        React.createElement("line", { x1: 4, y1: 20, x2: 20, y2: 4 })
      ) : React.createElement(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
        React.createElement("path", { d: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" }),
        React.createElement("circle", { cx: 12, cy: 12, r: 2.6 })
      )
    ),
    driveMenuOpen ? React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          right: 12,
          top: 46,
          zIndex: 10,
          background: C.cardBg,
          border: C.border,
          borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
          padding: 6,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 120
        }
      },
      (drives || []).map(function(d) {
        return React.createElement(
          "button",
          {
            key: "drive-" + d,
            type: "button",
            onClick: function() {
              setDriveMenuOpen(false);
              navigate(d + "\\");
            },
            style: {
              textAlign: "left",
              background: "transparent",
              border: "none",
              color: C.primaryText,
              fontSize: 13,
              padding: "8px 10px",
              borderRadius: 6,
              cursor: "pointer"
            }
          },
          "💾 " + d + " 盘"
        );
      })
    ) : null
  );
  var listArea = React.createElement(
    "div",
    {
      className: "dshweb-dir-list",
      style: {
        flex: 1,
        overflowY: "auto",
        minHeight: 140,
        padding: "4px 12px",
        overscrollBehavior: "contain",
        WebkitOverflowScrolling: "touch",
        touchAction: "pan-y"
      }
    },
    loading ? React.createElement("div", { style: { padding: 24, textAlign: "center", color: C.tertiaryText, fontSize: 13 } }, "加载中…") : err ? React.createElement("div", { style: { padding: 24, textAlign: "center", color: C.red, fontSize: 13 } }, err) : entries.length === 0 ? React.createElement("div", { style: { padding: 24, textAlign: "center", color: C.tertiaryText, fontSize: 13 } }, "（此目录没有子文件夹）") : entries.map(function(e) {
      return React.createElement(
        "div",
        {
          key: "e-" + e.path,
          style: { display: "flex", alignItems: "center", gap: 8, borderBottom: C.border, padding: "2px 0" }
        },
        React.createElement(
          "button",
          {
            type: "button",
            onClick: function() {
              navigate(e.path);
            },
            style: {
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              textAlign: "left",
              background: "transparent",
              border: "none",
              color: C.primaryText,
              fontSize: 14,
              cursor: "pointer",
              wordBreak: "break-all"
            }
          },
          "📂 " + e.name
        ),
        Btn("选择", function() {
          finish(e.path);
        }, { primary: true, disabled })
      );
    })
  );
  var overlay = React.createElement(
    "div",
    {
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 2147483646,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
        boxSizing: "border-box",
        // 注意：这里不能写 touchAction:"none" —— touch-action 会与祖先求交，
        // 会把弹窗内部列表的纵向滚动一起废掉。手势落点落在遮罩上时改由
        // 文档级 touchmove 拦截处理（见 open 期间的滚动锁 effect）。
        overscrollBehavior: "contain"
      }
    },
    React.createElement(
      "div",
      {
        className: "dshweb-dir-modal",
        style: {
          width: "min(560px, 96vw)",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          background: C.cardBg,
          border: C.border,
          borderRadius: 14,
          boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
          overflow: "hidden",
          overscrollBehavior: "contain",
          touchAction: "pan-y"
        }
      },
      React.createElement(
        "div",
        { style: { padding: "14px 16px", borderBottom: C.border, display: "flex", alignItems: "center", gap: 8 } },
        React.createElement("span", { style: { fontSize: 18 } }, "📁"),
        React.createElement("span", { style: { fontSize: 15, fontWeight: 600, color: C.primaryText, flex: 1 } }, "选择工作区文件夹"),
        Btn("✕", function() {
          if (typeof onCancel === "function") onCancel();
        })
      ),
      navBar,
      addrBar,
      listArea,
      err ? React.createElement("div", { style: { padding: "4px 12px", fontSize: 12, color: C.red } }, err) : null,
      React.createElement(
        "div",
        { style: { padding: "10px 12px", display: "flex", gap: 8, borderTop: C.border } },
        React.createElement("input", {
          className: "dshweb-dir-new",
          type: "text",
          value: newName,
          placeholder: "新建文件夹名称",
          onChange: function(ev) {
            setNewName(ev && ev.target ? ev.target.value : "");
          },
          style: inputStyle({ flex: 1, minWidth: 0 })
        }),
        Btn("新建", function() {
          var n = (newName || "").trim();
          if (!n) {
            report("请输入文件夹名称");
            return;
          }
          setLoading(true);
          setErr("");
          Promise.resolve().then(function() {
            return createDirectory(currentPath, n);
          }).then(function(p) {
            setNewName("");
            setLoading(false);
            if (p) finish(p);
            else load(currentPath);
          }).catch(function(e) {
            setLoading(false);
            report("新建失败：" + String(e && e.message || e));
          });
        }, { disabled })
      ),
      React.createElement(
        "div",
        { style: { padding: "12px", display: "flex", gap: 8, justifyContent: "flex-end", borderTop: C.border, flexWrap: "wrap" } },
        Btn("取消", function() {
          if (typeof onCancel === "function") onCancel();
        }),
        Btn("选择当前目录", function() {
          finish(currentPath);
        }, { primary: true, disabled: disabled || !currentPath })
      )
    )
  );
  if (ReactDOM && typeof ReactDOM.createPortal === "function" && portalHostRef.current) {
    return ReactDOM.createPortal(overlay, portalHostRef.current);
  }
  return overlay;
}
/**
 * 远程浏览器上禁用「宿主系统目录选择器」。
 *
 * Bug（远程端偶发弹文件夹）：官方 ui-directory-picker-native 会在本 Peer 被授权
 * directoryPicker/pick 时，往同一个 directoryFlow 空位注册一个 renderless 组件，
 * 它的唯一行为就是调用 ctx.uiWorkspace.pickDirectory() —— 在远程浏览器里这会走
 * typert RPC 落到宿主机，弹出**宿主机**的文件夹对话框（用户看到的是「桌面端突然
 * 弹出文件夹」，手机端更是完全看不到这个框）。
 *
 * 正常情况下我们用 priority -1 遮蔽它（slot 规则：priority 升序、最低者渲染），
 * 但空位被 ui-workspace 反复声明（其条目挂载/重挂载）时，双方 inject 回调的
 * 执行顺序不保证；在「我们还没注册、名额暂时被 native 占住」的极短窗口里，
 * 只要 owner 的 open 恰好变 true，native 就会立刻 pick() 弹框 —— 这正是偶发。
 *
 * 因此再加一道确定性护栏：远程浏览器里把 uiWorkspace.pickDirectory 换成
 * 立即 resolve(null)。native 拿到 null 只会走 onCancel（owner 关闭流程），
 * 绝不再触达宿主机；真正的选择交互由本插件自绘的 DshwebDirectoryFlow 提供。
 * 仅 data-remote 存在（经网关的远程页面）时生效，本机桌面 GUI 直连核心不受影响。
 */
function neutralizeHostPicker(ctx) {
  if (!isRemoteBrowser()) return;
  try {
    var svc = null;
    try {
      svc = ctx && typeof ctx.get === "function" ? ctx.get("uiWorkspace") : null;
    } catch (e) {
      svc = null;
    }
    if (!svc && ctx) svc = ctx.uiWorkspace || null;
    if (!svc || typeof svc.pickDirectory !== "function") return;
    if (svc.__dshwebPickGuarded) return;
    var noop = function() {
      return Promise.resolve(null);
    };
    try {
      Object.defineProperty(svc, "pickDirectory", {
        configurable: true,
        writable: true,
        value: noop
      });
    } catch (e) {
      svc.pickDirectory = noop;
    }
    svc.__dshwebPickGuarded = true;
  } catch (e) {
    if (typeof console !== "undefined" && console.warn) console.warn("[dshweb] host picker guard:", e);
  }
}
function installDirectoryFlow(ctx, slots) {
  if (!isRemoteBrowser()) return;
  // 先关掉宿主机弹框通路，再注册自绘选择器；顺序不可颠倒。
  neutralizeHostPicker(ctx);
  var injected = function() {
    return {
      listDirectory: function(p, signal) {
        return dirList(p, signal);
      },
      createDirectory: function(p, name) {
        return dirCreate(p, name);
      }
    };
  };
  DIR_SLOTS.forEach(function(hole) {
    slots.inject(hole, function() {
      var unregister = slots.register(
        // priority 必须低于官方 native 占位（其优先级缺省为 0）：slot 规则是
        // 「priority 升序、最低者渲染」，-1000 让我们在任何重新声明/重新挂载的
        // 竞争中稳定胜出，避免 native 短暂上位后立刻弹出宿主机文件夹框。
        { name: hole, priority: -1000, inject: injected },
        DshwebDirectoryFlow
      );
      return function() {
        if (typeof unregister === "function") unregister();
      };
    });
  });
}
var TABS = [
  { id: "access", zh: "接入", en: "Access" },
  { id: "security", zh: "远程设备", en: "Remote Devices" }
];
var TAB_KEY = "dshweb-settings-tab";
function loadTab() {
  try {
    var saved = localStorage.getItem(TAB_KEY);
    if (saved === "access" || saved === "security") return saved;
  } catch (e) {
  }
  return "access";
}
function tabIcon(id) {
  if (id === "access") return NetworkIcon();
  if (id === "security") return DevicesIcon();
  return "";
}
var PWD_LOCAL_KEY = "dshweb-saved-password";
function pwdStore() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch (e) {
  }
  try {
    if (typeof sessionStorage !== "undefined" && sessionStorage) return sessionStorage;
  } catch (e) {
  }
  return null;
}
function loadSavedPassword() {
  try {
    var s = pwdStore();
    return s && s.getItem(PWD_LOCAL_KEY) || "";
  } catch (e) {
    return "";
  }
}
function saveSavedPassword(v) {
  try {
    var s = pwdStore();
    if (s) s.setItem(PWD_LOCAL_KEY, v);
  } catch (e) {
  }
}
function AccessCard(props) {
  var lang = props.lang;
  var en = lang === "en";
  var state = React.useState({ loading: true });
  var st = state[0];
  var setSt = state[1];
  var portState = React.useState("3180");
  var port = portState[0];
  var setPort = portState[1];
  var urlState = React.useState("");
  var accessUrl = urlState[0];
  var setAccessUrl = urlState[1];
  var copiedState = React.useState(false);
  var copied = copiedState[0];
  var setCopied = copiedState[1];
  var pwdState = React.useState(function() {
    return loadSavedPassword();
  });
  var password = pwdState[0];
  var setPassword = pwdState[1];
  var showPwdState = React.useState(false);
  var showPwd = showPwdState[0];
  var setShowPwd = showPwdState[1];
  var pairState = React.useState(null);
  var pair = pairState[0];
  var setPair = pairState[1];
  var nowState = React.useState(Date.now());
  var now = nowState[0];
  var setNow = nowState[1];
  var hostsTextState = React.useState("");
  var hostsText = hostsTextState[0];
  var setHostsText = hostsTextState[1];
  // HTTPS 与 HTTP 共存：开关、独立端口、HTTPS 接入地址、复制反馈。
  // 初值刻意用 false/"3181"/""，避免 test/client-ui.mjs 的 reactWithState
  // 启发式（首个空数组 → devices、其后首个 null → currentDeviceId）误判。
  // 缺省开启（与服务端默认一致；status 回来后以 d.httpsEnabled 为准）。
  // 注意：初值不可为 [] 或 null，避免与 test/client-ui.mjs 的 reactWithState 启发式冲突。
  var httpsEnabledState = React.useState(true);
  var httpsEnabled = httpsEnabledState[0];
  var setHttpsEnabled = httpsEnabledState[1];
  var httpsPortState = React.useState("3181");
  var httpsPort = httpsPortState[0];
  var setHttpsPort = httpsPortState[1];
  var httpsUrlState = React.useState("");
  var httpsUrl = httpsUrlState[0];
  var setHttpsUrl = httpsUrlState[1];
  var httpsCopiedState = React.useState(false);
  var httpsCopied = httpsCopiedState[0];
  var setHttpsCopied = httpsCopiedState[1];
  // 域名白名单输入框：默认 2 行高，随内容自动增高，最多 5 行，超出后固定高度改由滚动条查看
  var HOSTS_FONT_SIZE = 12;
  var HOSTS_LINE_HEIGHT = 1.6;
  var HOSTS_BOX_PAD = 16;
  var HOSTS_BOX_BORDER = 2;
  var HOSTS_MIN_HEIGHT = Math.round(HOSTS_FONT_SIZE * HOSTS_LINE_HEIGHT * 2 + HOSTS_BOX_PAD + HOSTS_BOX_BORDER);
  var HOSTS_MAX_HEIGHT = Math.round(HOSTS_FONT_SIZE * HOSTS_LINE_HEIGHT * 5 + HOSTS_BOX_PAD + HOSTS_BOX_BORDER);
  var hostsRef = React.useRef(null);
  React.useLayoutEffect(function() {
    var el = hostsRef.current;
    if (!el) return;
    el.style.height = "auto";
    var needed = el.scrollHeight + HOSTS_BOX_BORDER;
    el.style.height = Math.max(HOSTS_MIN_HEIGHT, Math.min(HOSTS_MAX_HEIGHT, needed)) + "px";
    el.style.overflowY = needed > HOSTS_MAX_HEIGHT ? "auto" : "hidden";
  }, [hostsText]);
  var msgState = React.useState("");
  var msg = msgState[0];
  var setMsg = msgState[1];
  var isLoopback = function(h) {
    return !h || /^(127\.|localhost$|\[?::1\]?$|0\.0\.0\.0$)/i.test(h);
  };
  var applyStatus = function(d) {
    setSt(d);
    setPort(String(d.port || 3180));
    setHttpsEnabled(Boolean(d.httpsEnabled));
    setHttpsPort(String(d.httpsPort || 3181));
    setHttpsUrl(d.httpsLanUrl || "");
    if (!hostsText && Array.isArray(d.trustedHosts) && d.trustedHosts.length) {
      setHostsText(d.trustedHosts.join("\n"));
    }
    if (d.lanUrl) {
      setAccessUrl(d.lanUrl);
      return;
    }
    var host = "";
    try {
      host = String(location.hostname || "");
    } catch (e) {
      host = "";
    }
    if (!isLoopback(host)) {
      setAccessUrl((location.protocol === "https:" ? "https" : "http") + "://" + host + ":" + (d.port || 3180));
      return;
    }
    setAccessUrl("");
    var gwPort = d.port || 3180;
    try {
      fetch("http://127.0.0.1:" + gwPort + "/api/dshweb/status").then(function(r) {
        return r.ok ? r.json() : null;
      }).then(function(g) {
        if (g && g.lanUrl) setAccessUrl(g.lanUrl);
      }).catch(function() {
      });
    } catch (e) {
    }
  };
  React.useEffect(function() {
    api("status").then(applyStatus).catch(function(e) {
      setSt({ error: e.message });
    });
    api("pair-code").then(function(r) {
      if (r && r.valid && r.code) setPair(r);
    }).catch(function() {
    });
  }, []);
  React.useEffect(function() {
    if (!pair) return void 0;
    var t = setInterval(function() {
      var n = Date.now();
      if (!pair.expiresAt || pair.expiresAt - n <= 0) {
        setPair(null);
        clearInterval(t);
        return;
      }
      setNow(n);
    }, 1e3);
    return function() {
      clearInterval(t);
    };
  }, [pair]);
  var notify = function(m) {
    setMsg(m);
    setTimeout(function() {
      setMsg("");
    }, 4e3);
  };
  // 通用复制：value 为待复制文本，setter 为复制成功态开关（HTTP/HTTPS 两行复用）
  var copyText = function(value, setter) {
    if (!value) return;
    var done = function() {
      setter(true);
      setTimeout(function() {
        setter(false);
      }, 1800);
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(value).then(done, function() {
        });
        return;
      }
    } catch (e) {
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (e) {
    }
  };
  var copyUrl = function() {
    copyText(accessUrl, setCopied);
  };
  var copyHttpsUrl = function() {
    copyText(httpsUrl, setHttpsCopied);
  };
  var savePort = function() {
    var p = parseInt(port, 10);
    if (!(p > 0 && p < 65536)) {
      notify(en ? "Port must be 1-65535" : "端口需为 1-65535");
      return;
    }
    api("config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: p })
    }).then(function(d) {
      notify(d.ok ? (en ? "Port saved, gateway reloaded :" : "端口已保存，网关已重载 :") + d.port : "失败: " + (d.error || ""));
      if (d.ok) {
        api("status").then(function(s) {
          setPort(String(s.port || d.port || port));
          setAccessUrl(s.lanUrl || "");
          setHttpsUrl(s.httpsLanUrl || "");
        }).catch(function() {
        });
      }
    }).catch(function(e) {
      notify("失败: " + e.message);
    });
  };
  var saveHttps = function() {
    var p = parseInt(httpsPort, 10);
    if (!(p > 0 && p < 65536)) {
      notify(en ? "HTTPS port must be 1-65535" : "HTTPS 端口需为 1-65535");
      return;
    }
    api("config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ httpsEnabled: httpsEnabled, httpsPort: p })
    }).then(function(d) {
      notify(d.ok ? (en ? "HTTPS saved, gateway reloaded" : "HTTPS 设置已保存，网关已重载") : "失败: " + (d.error || ""));
      if (d.ok) {
        api("status").then(function(s) {
          if (!s) return;
          if (typeof s.httpsEnabled === "boolean") setHttpsEnabled(s.httpsEnabled);
          if (s.httpsPort) setHttpsPort(String(s.httpsPort));
          setHttpsUrl(s.httpsLanUrl || "");
        }).catch(function() {});
      }
    }).catch(function(e) {
      notify("失败: " + e.message);
    });
  };
  var savePassword = function() {
    if (password.length < 6) {
      notify(en ? "Password must be at least 6 characters" : "口令不少于 6 位");
      return;
    }
    api("config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    }).then(function() {
      saveSavedPassword(password);
      notify(en ? "Password saved (kept in the box, hidden by default)" : "口令已保存（保留在输入框，默认隐藏）");
    }).catch(function(e) {
      notify("失败: " + e.message);
    });
  };
  var pairRemain = pair && pair.expiresAt ? pair.expiresAt - now : 0;
  var pairAlive = Boolean(pair && pair.code) && pairRemain > 0 && pair.reason !== "locked" && pair.reason !== "used";
  var fmtRemain = function(ms) {
    var s = Math.max(0, Math.ceil(ms / 1e3));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m > 0 ? m + ":" + (r < 10 ? "0" + r : r) : r + "s";
  };
  var genPair = function() {
    api("pair-code", { method: "POST" }).then(function(d) {
      setPair(d);
      setNow(Date.now());
    }).catch(function(e) {
      notify("失败: " + e.message);
    });
  };
  var reloadGw = function() {
    api("reload", { method: "POST" }).then(function(d) {
      notify(d.ok ? (en ? "Gateway reloaded :" : "网关已热重载 :") + (d.port || "") : "失败: " + (d.error || ""));
    }).catch(function(e) {
      notify("失败: " + e.message);
    });
  };
  var saveTrustedHosts = function() {
    var hosts = hostsText.split(/\r?\n/).map(function(s) {
      return s.trim();
    }).filter(Boolean);
    api("config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trustedHosts: hosts })
    }).then(function(d) {
      if (d && d.ok) {
        if (Array.isArray(d.trustedHosts)) setHostsText(d.trustedHosts.join("\n"));
        notify(en ? "Trusted domains saved, gateway reloaded" : "域名白名单已保存，网关已重载");
      } else {
        notify("失败: " + (d && d.error || ""));
      }
    }).catch(function(e) {
      notify("失败: " + e.message);
    });
  };
  var hostsInput = React.createElement("textarea", {
    className: "dshweb-hosts-input",
    ref: hostsRef,
    value: hostsText,
    rows: 2,
    spellCheck: false,
    placeholder: en ? "dsh.example.com\nxxx.tailnet.ts.net" : "dsh.example.com\nxxx.tailnet.ts.net",
    onChange: function(e) {
      setHostsText(e.target.value);
    },
    style: inputStyle({
      width: "100%",
      height: "auto",
      minHeight: HOSTS_MIN_HEIGHT,
      maxHeight: HOSTS_MAX_HEIGHT,
      fontFamily: "Consolas, Menlo, monospace",
      fontSize: HOSTS_FONT_SIZE,
      lineHeight: HOSTS_LINE_HEIGHT,
      padding: "8px 12px",
      resize: "none",
      overflowY: "hidden"
    })
  });
  var pwdInput = React.createElement(
    "div",
    { style: { position: "relative", flex: "1 1 220px", minWidth: 200, display: "flex", alignItems: "center" } },
    React.createElement("input", {
      className: "dshweb-pwd-input",
      type: showPwd ? "text" : "password",
      value: password,
      placeholder: st.hasPassword ? en ? "•••••••• (configured, enter new to update)" : "•••••••• (已配置，输入新口令可覆盖)" : en ? "At least 6 characters" : "≥6 位永久口令",
      onChange: function(e) {
        setPassword(e.target.value);
      },
      style: inputStyle({ width: "100%", padding: "0 38px 0 12px" })
    }),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: function() {
          setShowPwd(!showPwd);
        },
        title: showPwd ? en ? "Hide" : "隐藏" : en ? "Show" : "显示",
        style: {
          position: "absolute",
          right: 8,
          background: "transparent",
          border: "none",
          color: C.secondaryText,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 4
        }
      },
      EyeIcon(showPwd)
    )
  );
  return Card({
    icon: NetworkIcon(),
    title: en ? "Access" : "接入",
    badge: Badge(Boolean(st.hasPassword), lang),
    // m05019：删除「接入」下方说明小字（用户明确要求），其余字段提示按逐项处理
    children: React.createElement(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 14 } },
      NativePwdStyle(),
      st.loading && !st.error ? React.createElement("div", { style: { fontSize: 13, color: C.tertiaryText } }, en ? "Loading…" : "加载中…") : null,
      st.error ? React.createElement("p", { style: { color: C.red, fontSize: 13, margin: 0 } }, st.error) : null,
      // 端口
      Field(
        en ? "HTTP Port" : "HTTP 端口",
        React.createElement(
          "div",
          { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          React.createElement("input", {
            value: port,
            onChange: function(e) {
              setPort(e.target.value);
            },
            style: inputStyle({ width: 110 })
          }),
          Btn(en ? "Save & Reload" : "保存并重载", savePort, { primary: true })
        ),
        en ? "Default 3180 (HTTP); changing it soft-restarts the gateway. HTTPS uses the port below." : "默认 3180（HTTP），修改后网关自动软重启。HTTPS 使用下方独立端口。"
      ),
      // HTTPS 共存开关 + 独立端口（默认 3181，可设置，改后网关软重载）
      Field(
        en ? "HTTPS (coexists with HTTP)" : "HTTPS 协议（与 HTTP 共存）",
        React.createElement(
          "div",
          { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          React.createElement(
            "label",
            { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", color: C.primaryText } },
            React.createElement("input", {
              type: "checkbox",
              checked: httpsEnabled,
              onChange: function(e) {
                setHttpsEnabled(e.target.checked);
              },
              style: { width: 16, height: 16, cursor: "pointer", accentColor: C.blue }
            }),
            en ? "Enable HTTPS listener" : "开启 HTTPS 监听"
          ),
          React.createElement("input", {
            value: httpsPort,
            onChange: function(e) {
              setHttpsPort(e.target.value);
            },
            disabled: !httpsEnabled,
            title: en ? "HTTPS port" : "HTTPS 端口",
            style: inputStyle({ width: 90, opacity: httpsEnabled ? 1 : 0.5 })
          }),
          Btn(en ? "Save & Reload" : "保存并重载", saveHttps, { primary: true })
        ),
        en
          ? "Default port 3181; HTTP on the port above stays available. A self-signed cert is generated automatically."
          : "默认端口 3181；上方 HTTP 端口仍可同时使用。证书自动生成（自签，首次访问需信任）。"
      ),
      // 永久口令（保存后保留在输入框，默认隐藏，可点开显示）
      Field(
        en ? "Permanent password" : "永久口令",
        React.createElement(
          "div",
          { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          pwdInput,
          Btn(en ? "Save" : "保存", savePassword, { primary: true })
        )
        // m05019：删除「永久口令」下方说明小字
      ),
      // 配对码
      Field(
        en ? "Pairing code" : "配对码",
        React.createElement(
          "div",
          { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          Btn(en ? "Generate 6-digit code" : "生成 6 位动态配对码", genPair),
          pair && pair.code && pairAlive ? React.createElement("code", { style: { fontSize: 16, fontWeight: 600, color: C.primaryText } }, pair.code) : null,
          pair && pair.code && pairAlive ? React.createElement(
            "span",
            { style: { fontSize: 12, color: C.tertiaryText } },
            (en ? "Valid for " : "剩余有效 ") + fmtRemain(pairRemain)
          ) : null
        ),
        en ? "Click Generate. Valid for 5 minutes." : "点击生成，5分钟内有效。"
      ),
      // 接入地址：完整 IP:端口（服务端下发）+ 一键复制
      Field(
        en ? "Access URL" : "接入地址",
        React.createElement(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", maxWidth: "100%" } },
          React.createElement(
            "code",
            {
              style: {
                fontSize: 13,
                color: C.primaryText,
                background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1))",
                border: C.fieldBorder,
                borderRadius: 8,
                padding: "9px 12px",
                lineHeight: "20px",
                minWidth: 0,
                flex: "1 1 auto",
                overflowWrap: "anywhere",
                userSelect: "all"
              }
            },
            accessUrl || (st.loading && !st.error ? "…" : "http://<局域网 IP>:" + port)
          ),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: copyUrl,
              title: en ? "Copy access URL" : "复制接入地址",
              disabled: !accessUrl,
              // m05838：与「保存并重载」「保存」按钮（Btn primary）同款样式——蓝底白字；
              // 复制成功瞬间仍切绿色成功态。
              style: {
                height: 38,
                padding: "0 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                background: copied ? "rgba(16,185,129,0.15)" : C.blue,
                color: copied ? C.green : "#fff",
                border: copied ? "1px solid rgba(16,185,129,0.4)" : "none",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: accessUrl ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
                flexShrink: 0,
                boxShadow: copied ? "none" : "0 2px 6px rgba(37,99,235,0.3)",
                opacity: accessUrl ? 1 : 0.6
              }
            },
            copied ? CheckIcon() : CopyIcon(),
            copied ? en ? "Copied" : "已复制" : en ? "Copy" : "一键复制"
          )
        ),
        en ? "Open this full LAN address on the external device (HTTP)." : "在手机 / 平板浏览器打开此完整地址（HTTP 协议）。"
      ),
      // HTTPS 接入地址：单独一行，仅在 HTTPS 监听已就绪时显示，可一键复制
      httpsEnabled && httpsUrl ? Field(
        en ? "HTTPS Access URL" : "HTTPS 接入地址",
        React.createElement(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", maxWidth: "100%" } },
          React.createElement(
            "code",
            {
              style: {
                fontSize: 13,
                color: C.primaryText,
                background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1))",
                border: C.fieldBorder,
                borderRadius: 8,
                padding: "9px 12px",
                lineHeight: "20px",
                minWidth: 0,
                flex: "1 1 auto",
                overflowWrap: "anywhere",
                userSelect: "all"
              }
            },
            httpsUrl
          ),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: copyHttpsUrl,
              title: en ? "Copy HTTPS access URL" : "复制 HTTPS 接入地址",
              disabled: !httpsUrl,
              style: {
                height: 38,
                padding: "0 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                background: httpsCopied ? "rgba(16,185,129,0.15)" : C.blue,
                color: httpsCopied ? C.green : "#fff",
                border: httpsCopied ? "1px solid rgba(16,185,129,0.4)" : "none",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: httpsUrl ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
                flexShrink: 0,
                boxShadow: httpsCopied ? "none" : "0 2px 6px rgba(37,99,235,0.3)",
                opacity: httpsUrl ? 1 : 0.6
              }
            },
            httpsCopied ? CheckIcon() : CopyIcon(),
            httpsCopied ? en ? "Copied" : "已复制" : en ? "Copy" : "一键复制"
          )
        ),
        en ? "Self-signed certificate: browser will warn on first visit; proceed/trust to connect." : "自签证书：首次访问浏览器会提示不安全，选择继续 / 信任即可连接。"
      ) : null,
      // 域名白名单：允许经反向代理 / 端口转发使用的自定义域名远程接入
      Field(
        en ? "Trusted domains" : "域名白名单",
        React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 8 } },
          hostsInput,
          Btn(en ? "Save trusted domains" : "保存域名白名单", saveTrustedHosts, { primary: true })
        ),
        en ? "One domain per line. Only bare hostnames are matched (port ignored). Localhost and direct IP access are always allowed; other domains are rejected to prevent DNS rebinding. Applies when accessing via a reverse proxy or port forwarding." : "每行一个域名；只按裸主机名匹配（忽略端口）。localhost 与 IP 直连始终放行，其余域名一律拒绝以防 DNS-Rebinding。适用于通过反向代理或端口转发远程接入的场景。"
      ),
      // 维护
      Field(en ? "Maintenance" : "维护", Btn(en ? "Reload gateway" : "重载网关", reloadGw, { primary: true })),
      msg ? Note(msg) : null
    )
  });
}
function SecurityCard(props) {
  var lang = props.lang;
  var en = lang === "en";
  var canDelete = !isRemoteBrowser();
  var confirmState = React.useState(null);
  var confirm = confirmState[0];
  var setConfirm = confirmState[1];
  var devicesState = React.useState([]);
  var devices = devicesState[0];
  var setDevices = devicesState[1];
  var currentState = React.useState(null);
  var currentDeviceId = currentState[0];
  var setCurrentDeviceId = currentState[1];
  var msgState = React.useState("");
  var msg = msgState[0];
  var setMsg = msgState[1];
  var refresh = function() {
    return api("devices").then(function(d) {
      setDevices(Array.isArray(d) ? d : []);
    });
  };
  React.useEffect(function() {
    refresh().catch(function() {
    });
    api("status").then(function(d) {
      setCurrentDeviceId(d && d.currentDeviceId ? d.currentDeviceId : null);
    }).catch(function() {
    });
  }, []);
  var showMsg = function(text) {
    setMsg(text);
    setTimeout(function() {
      setMsg("");
    }, 3e3);
  };
  var runDeleteOne = function(id) {
    return api("delete-device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    }).then(function(r) {
      if (r && r.ok === false) {
        showMsg(r.message || (en ? "Failed" : "删除失败"));
        return;
      }
      return refresh().then(function() {
        showMsg(en ? "Device deleted" : "已删除设备");
      });
    }).catch(function(e) {
      showMsg((en ? "Failed: " : "删除失败：") + e.message);
    });
  };
  var runDeleteAllRemote = function() {
    return api("delete-remote-devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }).then(function(r) {
      if (r && r.ok === false) {
        showMsg(r.message || (en ? "Failed" : "删除失败"));
        return;
      }
      return refresh().then(function() {
        showMsg(en ? "Remote devices deleted" : "已删除远程设备");
      });
    }).catch(function(e) {
      showMsg((en ? "Failed: " : "删除失败：") + e.message);
    });
  };
  var deleteOne = function(id) {
    setConfirm({
      mode: "one",
      id,
      text: en ? "Delete this device and revoke its access?" : "确定删除这台设备并撤销其访问权限吗？",
      onYes: function() {
        setConfirm(null);
        runDeleteOne(id);
      },
      onNo: function() {
        setConfirm(null);
      }
    });
  };
  var deleteAllRemote = function() {
    setConfirm({
      mode: "all",
      text: en ? "Delete all remote devices and revoke their access?" : "确定一键删除所有远程设备并撤销其访问权限吗？",
      onYes: function() {
        setConfirm(null);
        runDeleteAllRemote();
      },
      onNo: function() {
        setConfirm(null);
      }
    });
  };
  var headerRightConfirmed = !HostModal && confirm && confirm.mode === "all";
  var headerRight = canDelete ? headerRightConfirmed ? React.createElement(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 6 } },
    React.createElement(
      "span",
      { style: { fontSize: 12, color: C.secondaryText } },
      confirm.text
    ),
    Btn(en ? "Cancel" : "取消", function() {
      setConfirm(null);
    }),
    Btn(en ? "Delete" : "删除", confirm.onYes, { danger: true })
  ) : React.createElement(
    "button",
    {
      type: "button",
      className: "dshweb-del-all",
      onClick: deleteAllRemote,
      disabled: devices.length === 0,
      title: en ? "Delete all remote devices" : "一键删除所有远程设备",
      style: {
        padding: "4px 10px",
        border: "1px solid rgba(239,68,68,0.4)",
        borderRadius: 6,
        background: "transparent",
        color: "var(--dsw-alias-label-error, #ef4444)",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
        cursor: devices.length === 0 ? "not-allowed" : "pointer",
        opacity: devices.length === 0 ? 0.5 : 1
      }
    },
    en ? "Delete remote devices" : "删除远程设备"
  ) : null;
  var rows = devices.length === 0 ? React.createElement(
    "div",
    { style: { fontSize: 13, color: C.tertiaryText, padding: "4px 0" } },
    "📭 " + (en ? "No devices yet" : "暂无设备")
  ) : React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 6 } },
    devices.map(function(d) {
      var isCurrent = currentDeviceId && d.id === currentDeviceId;
      var meta = d.remote === "mobile" ? en ? "Mobile" : "移动端" : en ? "Desktop" : "桌面端";
      if (d.ip) meta += " \xB7 " + d.ip;
      var rowConfirm = !HostModal && confirm && confirm.mode === "one" && confirm.id === d.id;
      var delBtn = rowConfirm ? React.createElement(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 5 } },
        Btn(en ? "Cancel" : "取消", function() {
          setConfirm(null);
        }),
        Btn(en ? "Delete" : "删除", confirm.onYes, { danger: true })
      ) : canDelete && !isCurrent ? React.createElement(
        "button",
        {
          type: "button",
          className: "dshweb-del-device",
          onClick: function() {
            deleteOne(d.id);
          },
          title: en ? "Delete device" : "删除设备",
          "aria-label": en ? "Delete device" : "删除设备",
          style: {
            width: 24,
            height: 24,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            border: "1px solid rgba(239,68,68,0.4)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--dsw-alias-label-error, #ef4444)",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer"
          }
        },
        "\xD7"
      ) : null;
      return React.createElement(
        "div",
        {
          key: d.id,
          style: {
            fontSize: 13,
            color: C.primaryText,
            padding: "8px 10px",
            background: isCurrent ? "rgba(16,185,129,0.12)" : C.fieldBg,
            border: isCurrent ? "1px solid " + C.green : C.fieldBorder,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap"
          }
        },
        React.createElement(
          "span",
          null,
          "📱 " + (d.name || (en ? "Device" : "设备")),
          isCurrent ? React.createElement(
            "span",
            { style: { fontSize: 11, color: C.green, marginLeft: 6, fontWeight: 600 } },
            en ? "(this device)" : "（当前设备）"
          ) : null,
          // m05019：对所有「已在线」设备作出标记（devices 端点按 sessions.json 派生 d.online）
          d.online ? React.createElement(
            "span",
            {
              className: "dshweb-online-badge",
              style: { fontSize: 11, color: C.green, marginLeft: 6, fontWeight: 600 }
            },
            "● " + (en ? "Online" : "在线")
          ) : null
        ),
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" } },
          React.createElement(
            "span",
            { style: { fontSize: 11, color: C.tertiaryText } },
            meta + " \xB7 " + new Date(d.pairedAt).toLocaleString()
          ),
          delBtn
        )
      );
    })
  );
  var hostDialog = HostModal ? React.createElement(HostModal, {
    open: Boolean(confirm),
    onClose: function() {
      setConfirm(null);
    },
    title: en ? "Delete device" : "删除设备",
    closeLabel: en ? "Close" : "关闭",
    description: confirm ? confirm.text : "",
    footer: React.createElement(
      "div",
      { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
      Btn(en ? "Cancel" : "取消", function() {
        setConfirm(null);
      }),
      Btn(en ? "Delete" : "删除", confirm ? confirm.onYes : function() {
      }, { danger: true })
    )
  }) : null;
  return React.createElement(
    React.Fragment,
    null,
    Card({
      icon: DevicesIcon(),
      title: en ? "Remote Devices" : "远程设备",
      desc: en ? "All devices ever signed in via a password or pairing code. Green dot marks devices currently online." : "所有通过配对码或口令登录过的设备，绿色圆点标记当前在线设备。",
      headerRight,
      children: React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        rows,
        msg ? Note(msg) : null
      )
    }),
    hostDialog
  );
}
function RemoteControlSection(props) {
  var ctx = props && props.ctx || typeof window !== "undefined" && window.__DSH_CLIENT_CTX__ || null;
  var lang = resolveLang(ctx);
  var en = lang === "en";
  var tabState = React.useState(loadTab);
  var activeTab = tabState[0];
  var setActiveTab = tabState[1];
  var switchTab = function(tab) {
    setActiveTab(tab);
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch (e) {
    }
  };
  var hint = en ? "External devices visit the gateway address below to use the official DSH Web UI identical to desktop." : "手机 / 平板等外部设备访问下方网关地址即可使用与桌面完全一致的官方 Web 界面。";
  var tabBar = React.createElement(
    "div",
    {
      style: {
        display: "flex",
        gap: 14,
        borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
        marginTop: 4,
        overflowX: "auto",
        overflowY: "hidden",
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none"
      }
    },
    TABS.map(function(item) {
      var isActive = activeTab === item.id;
      return React.createElement(
        "button",
        {
          key: item.id,
          type: "button",
          onClick: function() {
            switchTab(item.id);
          },
          style: {
            background: "transparent",
            border: "none",
            outline: "none",
            padding: "6px 2px 8px 2px",
            fontSize: 13,
            fontWeight: isActive ? 600 : 400,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: isActive ? C.primaryText : C.tertiaryText,
            borderBottom: isActive ? "2px solid var(--dsw-alias-label-primary, #111827)" : "2px solid transparent",
            marginBottom: -1,
            transition: "all 0.2s ease"
          }
        },
        tabIcon(item.id),
        en ? item.en : item.zh
      );
    })
  );
  function tabPanel(id, content) {
    return React.createElement(
      "div",
      { style: { display: activeTab === id ? "flex" : "none", flexDirection: "column", gap: 16, marginTop: 16 } },
      content
    );
  }
  return React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column" } },
    React.createElement("p", { style: { fontSize: 12, color: C.tertiaryText, margin: 0, lineHeight: 1.6 } }, hint),
    tabBar,
    tabPanel("access", React.createElement(AccessCard, { lang })),
    tabPanel("security", React.createElement(SecurityCard, { lang }))
  );
}

export { inject, apply };
export default apply;
