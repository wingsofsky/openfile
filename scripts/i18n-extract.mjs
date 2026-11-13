#!/usr/bin/env node
/**
 * 界面文案抽取 / 包裹（一次性 codemod + 持续抽键）：
 *   node scripts/i18n-extract.mjs --wrap      # 把 src/components、src/viewers、src/App.tsx 里的中文文案包成 t("…")，并补 import
 *   node scripts/i18n-extract.mjs --keys      # 抽出所有 t("…") 的键（含上下文）到 stdout（JSON），给译者
 *   node scripts/i18n-extract.mjs --missing   # 对照 src/i18n/en.ts，列出还没有英文的键
 *   node scripts/i18n-extract.mjs --import en.json [--overwrite]   # 把译者交回的 {中文: English} 合并进 src/i18n/en.ts：校验占位符一致、丢掉源码里不存在的键与未译值；已有条目默认保留（--overwrite 才覆盖）；按源码出现顺序排
 *
 * 包裹规则（宁可漏、不能错——数据串绝不能翻）：
 *   1. JSX 文本节点含中文 → {t("…")}（首尾行内空格保留为 {" "}）
 *   2. title / placeholder / aria-label / aria-description / alt 属性的中文字面量 → {t("…")}
 *   3. JSX 大括号里只经 ?: / || / ?? / && / () 到达的中文字面量与模板串 → t("…") / t("…{0}…", [x])
 *   4. React setter 调用（setXxx("…")）的中文字面量与模板串 → 同上（它们最终会渲染）
 *   5. 变量名以 LABEL 结尾的对象字面量的中文值 → t("…")
 *   不碰：=== / !== 比较、switch case、className、console.*、对象键、import、lib 目录（数据格式与错误消息）。
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const CJK = /[㐀-鿿！-～　-〿]/;
const ATTRS = new Set(["title", "placeholder", "aria-label", "aria-description", "alt", "label"]);
const BRIDGE = new Set([ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.ParenthesizedExpression]);
const OK_BINARY = new Set([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken]);

function files() {
  const out = [];
  for (const dir of ["src/components", "src/viewers"]) {
    for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith(".tsx") && !f.endsWith(".test.tsx")) out.push(path.join(root, dir, f));
  }
  out.push(path.join(root, "src/App.tsx"));
  return out.filter((f) => fs.existsSync(f));
}

// Wrapping stays limited to UI files. Explicit t() calls in shared helpers must
// still be collected, or --import silently drops their translations.
function keyFiles() {
  const out = files();
  const seen = new Set(out);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "i18n") visit(file);
      else if (entry.isFile() && /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file) && !seen.has(file)) out.push(file);
    }
  };
  visit(path.join(root, "src"));
  return out;
}

const esc = (s) => JSON.stringify(s);
const collapse = (s) => s.replace(/\s+/g, " ").trim();

/** 字面量的祖先链是否只经 ?: / || / ?? / && / () 到达 JsxExpression（= 结果会被渲染） */
function rendersInJsx(node) {
  let n = node.parent;
  while (n) {
    if (ts.isJsxExpression(n)) {
      // 挂在属性上：只有 title / placeholder / aria-* / alt 是文案；className 等一律不是
      if (n.parent && ts.isJsxAttribute(n.parent)) return ATTRS.has(n.parent.name.getText());
      return true;
    }
    if (BRIDGE.has(n.kind)) {
      n = n.parent;
      continue;
    }
    if (ts.isBinaryExpression(n) && OK_BINARY.has(n.operatorToken.kind)) {
      n = n.parent;
      continue;
    }
    return false;
  }
  return false;
}

function isSetterArg(node) {
  const p = node.parent;
  return ts.isCallExpression(p) && p.arguments.includes(node) && ts.isIdentifier(p.expression) && /^set[A-Z]/.test(p.expression.text);
}

function isLabelObjectValue(node) {
  const p = node.parent;
  if (!ts.isPropertyAssignment(p) || p.initializer !== node) return false;
  let n = p.parent;
  if (!ts.isObjectLiteralExpression(n)) return false;
  n = n.parent;
  while (n && (ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isParenthesizedExpression(n))) n = n.parent;
  return ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /LABEL$|_TEXT$|_HINT$/.test(n.name.text);
}

/** 包裹点所在作用域里是否已有叫 t 的参数 / 变量（tasks.map((t) => …) 这种），有则用别名 tr */
function tShadowed(node) {
  let n = node.parent;
  while (n) {
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) if (paramBinds(p.name, "t")) return true;
    }
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      for (const st of n.statements) {
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (paramBinds(d.name, "t")) return true;
      }
    }
    n = n.parent;
  }
  return false;
}
function paramBinds(name, id) {
  if (ts.isIdentifier(name)) return name.text === id;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return name.elements.some((e) => !ts.isOmittedExpression(e) && paramBinds(e.name, id));
  return false;
}

function alreadyWrapped(node) {
  const p = node.parent;
  return ts.isCallExpression(p) && ts.isIdentifier(p.expression) && (p.expression.text === "t" || p.expression.text === "tr");
}

/** 模板串 → 键 + 参数：`剩 ${x}%` → ["剩 {0}%", ["x"]] */
function templateToKey(tpl, sf) {
  const args = [];
  let key = tpl.head.text;
  tpl.templateSpans.forEach((span, i) => {
    args.push(span.expression.getText(sf));
    key += `{${i}}` + span.literal.text;
  });
  return [key, args];
}

function planFile(file, src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  let needsTr = false;
  const fn = (node) => {
    if (tShadowed(node)) {
      needsTr = true;
      return "tr";
    }
    return "t";
  };
  const keys = new Map(); // key → context
  const ctx = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${path.relative(root, file)}:${line + 1}`;
  };
  const addKey = (k, node) => {
    if (!keys.has(k)) keys.set(k, ctx(node));
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      if (CJK.test(raw) && raw.trim()) {
        const text = collapse(raw);
        const lead = /^[ \t]+\S/.test(raw) && !raw.startsWith("\n") ? '{" "}' : "";
        const trail = /\S[ \t]+$/.test(raw) && !raw.endsWith("\n") && !/\n[ \t]*$/.test(raw) ? '{" "}' : "";
        const before = raw.match(/^\s*/)[0].includes("\n") ? raw.match(/^\s*/)[0] : "";
        const after = raw.match(/\s*$/)[0].includes("\n") ? raw.match(/\s*$/)[0] : "";
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `${before}${lead}{${fn(node)}(${esc(text)})}${trail}${after}` });
        addKey(text, node);
      }
      return;
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && ATTRS.has(node.name.getText(sf)) && CJK.test(node.initializer.text)) {
      edits.push({ start: node.initializer.getStart(sf), end: node.initializer.getEnd(), text: `{${fn(node)}(${esc(node.initializer.text)})}` });
      addKey(node.initializer.text, node);
      return;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CJK.test(node.text) && !alreadyWrapped(node)) {
      const p = node.parent;
      const isAttrValue = ts.isJsxAttribute(p);
      if (!isAttrValue && (rendersInJsx(node) || isSetterArg(node) || isLabelObjectValue(node))) {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `${fn(node)}(${esc(node.text)})` });
        addKey(node.text, node);
      }
      return;
    }
    if (ts.isTemplateExpression(node) && CJK.test(node.head.text + node.templateSpans.map((sp) => sp.literal.text).join("")) && !alreadyWrapped(node)) {
      if (rendersInJsx(node) || isSetterArg(node)) {
        const [key, args] = templateToKey(node, sf);
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `${fn(node)}(${esc(key)}, [${args.join(", ")}])` });
        addKey(key, node);
        return; // 不再进入模板内部
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { src, sf, edits, keys, needsTr };
}

function applyEdits(src, edits) {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function ensureImport(file, src, needsTr = false) {
  const names = needsTr ? "t, t as tr" : "t";
  const existing = src.match(/^import\s*\{([^}]*)\}\s*from\s*"([^"]*i18n)";\n/m);
  if (existing) {
    const have = existing[1].split(",").map((x) => x.trim()).filter(Boolean);
    const want = new Set(have);
    want.add("t");
    if (needsTr) want.add("t as tr");
    if (want.size === have.length) return src;
    return src.replace(existing[0], `import { ${[...want].join(", ")} } from "${existing[2]}";\n`);
  }
  const rel = path.relative(path.dirname(file), path.join(root, "src/i18n")).split(path.sep).join("/");
  const spec = rel.startsWith(".") ? rel : `./${rel}`;
  const line = `import { ${names} } from "${spec}";\n`;
  // 放在最后一个 import 之后
  const imports = [...src.matchAll(/^import[^\n]*\n/gm)];
  if (imports.length === 0) return line + src;
  const last = imports[imports.length - 1];
  const at = last.index + last[0].length;
  return src.slice(0, at) + line + src.slice(at);
}

/** 现有源码里 t("…") 的键（不改文件） */
function collectKeys() {
  const all = new Map();
  for (const file of keyFiles()) {
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "t" || node.expression.text === "tr") && node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
        const k = node.arguments[0].text;
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (!all.has(k)) all.set(k, `${path.relative(root, file)}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return all;
}

/** 读 src/i18n/en.ts 的字典（走 TS AST，不 eval） */
function readEnDict() {
  const file = path.join(root, "src/i18n/en.ts");
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dict = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "en" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const p of node.initializer.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.name) || ts.isNoSubstitutionTemplateLiteral(p.name)) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer))) {
          dict.set(p.name.text, p.initializer.text);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return dict;
}
/** 键与值里的占位符集合（{0} / {name}），顺序无关 */
const placeholders = (s) => [...s.matchAll(/\{[0-9A-Za-z_]+\}/g)].map((m) => m[0]).sort().join(" ");
function writeEnDict(entries) {
  const head = [
    "/**",
    ' * 英文字典：键 = 中文原文（源码里 t("…") 的参数），值 = 英文。',
    " * 由 scripts/i18n-extract.mjs --import 从译者交回的 JSON 合并生成，按源码出现顺序排；人工改动直接改本文件，再次 --import 时保留（--overwrite 才覆盖）。",
    " * 缺的键回退中文（--missing 列出）；占位符 {0} / {name} 原样保留。",
    " */",
    "export const en: Record<string, string> = {",
  ].join("\n");
  const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
  fs.writeFileSync(path.join(root, "src/i18n/en.ts"), `${head}\n${body}\n};\n`);
}

const mode = process.argv[2] ?? "--keys";
if (mode === "--wrap") {
  let total = 0;
  for (const file of files()) {
    const raw = fs.readFileSync(file, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const lf = raw.replace(/\r\n/g, "\n");
    const { edits, needsTr } = planFile(file, lf);
    if (edits.length === 0) continue;
    const out = ensureImport(file, applyEdits(lf, edits), needsTr);
    fs.writeFileSync(file, out.replace(/\n/g, eol));
    total += edits.length;
    console.log(`${path.relative(root, file)}: ${edits.length} 处`);
  }
  console.log(`共包裹 ${total} 处`);
} else if (mode === "--keys") {
  const all = collectKeys();
  console.log(JSON.stringify([...all.entries()].map(([key, where]) => ({ key, where })), null, 1));
} else if (mode === "--missing") {
  const all = collectKeys();
  const have = new Set(readEnDict().keys());
  const missing = [...all.keys()].filter((k) => !have.has(k));
  console.log(`${missing.length} / ${all.size} 缺英文`);
  for (const k of missing) console.log(`  ${k}`);
} else if (mode === "--import") {
  const jsonFile = process.argv[3];
  if (!jsonFile || jsonFile.startsWith("--")) {
    console.error("用法: --import <en.json> [--overwrite]");
    process.exit(2);
  }
  const overwrite = process.argv.includes("--overwrite");
  const incoming = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  const all = collectKeys();
  const have = readEnDict();
  const fresh = new Map();
  const report = { added: 0, replaced: 0, kept: 0, unknown: [], placeholder: [], untranslated: [], cjk: [], stale: [] };
  for (const [k, raw] of Object.entries(incoming)) {
    const v = typeof raw === "string" ? raw : ""; // 不 trim：英文常需要中文全角标点不需要的前导空格（" (current)"）
    if (!all.has(k)) {
      report.unknown.push(k);
      continue;
    }
    if (!v.trim() || v === k) {
      report.untranslated.push(`${k} → ${v}`);
      continue;
    }
    if (CJK.test(v)) report.cjk.push(`${k} → ${v}`); // 数据契约词（执行者: / 渠道: / 记忆/）可以保留中文，但要人眼复核
    if (placeholders(k) !== placeholders(v)) {
      report.placeholder.push(`${k} → ${v}`);
      continue;
    }
    if (have.has(k) && !overwrite) {
      report.kept++;
      continue;
    }
    report[have.has(k) ? "replaced" : "added"]++;
    fresh.set(k, v);
  }
  const entries = [];
  for (const k of all.keys()) {
    const v = fresh.get(k) ?? have.get(k);
    if (v !== undefined) entries.push([k, v]);
  }
  for (const [k, v] of have) if (!all.has(k)) report.stale.push(`${k} → ${v}`);
  writeEnDict(entries);
  console.log(`新增 ${report.added}，覆盖 ${report.replaced}，保留已有 ${report.kept}；词典 ${entries.length} / 源码 ${all.size} 键`);
  const dump = (label, arr) => {
    if (!arr.length) return;
    console.log(`${label}（${arr.length}）：`);
    for (const x of arr) console.log(`  ${x}`);
  };
  dump("源码里没有这个键，已忽略", report.unknown);
  dump("占位符不一致，已跳过", report.placeholder);
  dump("未译（空或与原文相同），已跳过", report.untranslated);
  dump("译文含中文（数据契约词可保留，请复核）", report.cjk);
  dump("源码里已不存在，已从词典移除", report.stale);
} else {
  console.error("用法: --wrap | --keys | --missing | --import <en.json> [--overwrite]");
  process.exit(2);
}
