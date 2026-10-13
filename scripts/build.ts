import autoprefixer from "autoprefixer";
import { build, context } from "esbuild";
import type { BuildOptions, Plugin } from "esbuild";
import { ESLint } from "eslint";
import postcss from "postcss";
import stylelint from "stylelint";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENTRY = "src/index.tsx";
// esbuild 以入口文件名命名产物（index.js / index.css），写入磁盘时再改成 on-wiki 需要的 gadget 名
const JS_OUTPUT = "index.js";
const CSS_OUTPUT = "index.css";
const JS_NAME = "Gadget-JSONViewer.js";
const CSS_NAME = "Gadget-JSONViewer.css";

/**
 * 产物头部声明（js 与 css 同文）：只携带生成警告与仓库地址。
 * JS 的 "use strict" 由 banner 显式携带：产物以 esm 裸语句形式交付，esbuild 不注入指令，
 * 而产物门禁要求文件以 "use strict" 开头。
 */
const BANNER = `/**
 * 本文件由 JSONViewer 仓库构建生成，请勿直接修改
 * 仓库地址：https://github.com/MoegirlPediaInterfaceAdmins/JSONViewer
 */`;

/**
 * 产物顶部的文件级 eslint-disable：列出打包产物（esbuild 输出 + preact/compat +
 * react18-json-view 运行时）无法满足、且 eslint --fix 也修不掉的规则。
 * 界面库用 base+browser 检查这些产物、不对这些规则放行，所以豁免必须随产物一起提交
 * （做法同 Navigation_popups 的 popups.js 顶部 banner）。凡在 dist 的 eslint 配置
 * 里已经关掉的规则不能写在这里，否则两侧叠加会变成 unused directive。
 */
const ESLINT_DISABLE = "/* eslint-disable eqeqeq, no-var, @stylistic/max-statements-per-line, no-param-reassign, no-use-before-define, prefer-rest-params, prefer-const, camelcase, logical-assignment-operators, no-unused-vars, no-cond-assign, no-func-assign, prefer-arrow-functions/prefer-arrow-functions, promise/prefer-await-to-then, no-labels, no-useless-assignment, promise/always-return, no-useless-escape, no-constant-binary-expression */";

const dev = process.argv.includes("--watch");
const checkIdempotent = process.argv.includes("--check-idempotent");

/**
 * dev 专用内联插件（style-loader 语义）：把每个 CSS 模块编译为向页面注入 `<style>` 的 JS 模块，
 * 开发调试时单个脚本即携带全部样式，无需另行加载 CSS 产物。注入顺序与模块求值顺序一致，
 * 也与生产产物中 CSS 的合并顺序相同，样式表现和线上一致。
 * 生产模式不注册该插件：CSS 单独打包，满足界面库 definition.yaml 需要 js 与 css 两份产物的部署要求。
 */
const cssInjectPlugin: Plugin = {
    name: "dev-css-inject",
    setup: (pluginBuild) => {
        // 用 textContent 注入，CSS 内即使出现 "</style>" 字面量也没有注入风险
        pluginBuild.onLoad({ filter: /\.css$/ }, async (args) => {
            const css = await fs.readFile(args.path, "utf8");
            const contents = `const css = ${JSON.stringify(css)};
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);`;
            return { contents, loader: "js" };
        });
    },
};

/** esbuild 公共构建选项。产物保持未压缩：唯一的压缩发生在界面库部署侧的 terser，
 * 避免同一份代码被压缩两次。
 * format esm 输出裸顶层语句、不带 IIFE 包裹：gadget 经 mw.loader.implement 下发，
 * 其函数作用域已经隔离顶层名。产物模式注入 banner，dev 模式注入 inline sourcemap。 */
const buildOptions = (outdir: string): BuildOptions => ({
    entryPoints: [path.join(root, ENTRY)],
    bundle: true,
    format: "esm",
    target: "es2020",
    // classic JSX runtime，与源码中的显式 React import 及 tsconfig 的 "jsx": "react" 对应
    jsx: "transform",
    outdir,
    // 仅做语法级优化，不压缩空白与标识符，产物保持可读。
    minifySyntax: true,
    // __DEV__ 按构建形态区分：dev watch 取 true，入口里为 safemode 调试写的 mw.loader.using 会被保留；
    // 发布构建取 false，配合上面的 minifySyntax 该分支整段消除，产物中不再含 mw.loader.using（依赖改由 definition.yaml 声明）。
    define: { __DEV__: dev ? "true" : "false" },
    ...dev
        ? { plugins: [cssInjectPlugin], sourcemap: "inline" }
        : { banner: { js: `${ESLINT_DISABLE}\n${BANNER}\n"use strict";`, css: BANNER } },
});

/** 产物门禁：banner 位于文件头部、没有残留的模块语法、以换行符结尾 */
const assertArtifact = (name: string, text: string, isCss: boolean): void => {
    // JS 产物以 eslint-disable 行开头、CSS 产物以 banner 开头
    if (!text.startsWith(isCss ? BANNER : ESLINT_DISABLE)) {
        throw new Error(`${name}: banner 缺失或不位于文件头部`);
    }
    if (isCss ? /^\s*@import\b/m.test(text) : /^\s*(?:import|export)\b/m.test(text)) {
        throw new Error(`${name}: 产物中残留未打包的${isCss ? " @import" : " import/export"}语法`);
    }
    if (!text.endsWith("\n")) {
        throw new Error(`${name}: 产物必须以换行符结尾`);
    }
};

// esbuild 输出的是自家排版；按本仓 eslint 配置的 dist/** 块先 fix 再 verify 产物，
// 使产物满足与源码相同的排版与静态规则。
// banner 注释不会被 fixer 触碰，其后的 lint 语义保持原样。
const artifactFixer = new ESLint({ cwd: root, fix: true });
const artifactVerifier = new ESLint({ cwd: root });

/** 去掉 esbuild 残留在产物正文里的整行 eslint 指令注释（裸 // eslint-disable 会触发对端 no-unlimited-disable） */
const stripInlineDirectives = (text: string): string =>
    text.split("\n").filter((line) => !/^\s*\/\/\s*eslint-(?:disable|enable)\b/.test(line)).join("\n");

/** 对 JS 产物执行 eslint fix + verify：剩余错误即构建失败，并列出全部规则名便于排查 */
const lintArtifact = async (text: string): Promise<string> => {
    const [fixed] = await artifactFixer.lintText(stripInlineDirectives(text), { filePath: path.join(root, "dist", JS_NAME) });
    const artifact = typeof fixed.output === "string" ? fixed.output : text;
    const [verify] = await artifactVerifier.lintText(artifact, { filePath: path.join(root, "dist", JS_NAME) });
    if (verify.errorCount > 0) {
        const byRule = new Map<string, number>();
        for (const message of verify.messages) {
            const key = `${message.ruleId}（${message.line}:${message.column}）`;
            byRule.set(key, (byRule.get(key) ?? 0) + 1);
        }
        const summary = [...byRule.entries()].map(([rule, count]) => `${rule} ×${count}`).join("; ");
        throw new Error(`产物 lint 未通过：${summary}`);
    }
    return artifact;
};

/**
 * 按 .browserslistrc 声明的浏览器范围补齐 CSS 厂商前缀：产物兼容性以那份文件为依据，
 * 只有让 autoprefixer 消费它，产物兼容性才会随该文件的改动而更新。
 * dev 产物不走这条路径，因此只在发布构建中运行。
 */
const prefixStylesheet = async (css: string): Promise<string> => {
    const result = await postcss([autoprefixer]).process(css, { from: path.join(root, CSS_NAME), map: false });
    const [warning] = result.warnings();
    if (warning) {
        throw new Error(`postcss 警告：${warning.toString()}`);
    }
    return result.css;
};

/**
 * 对 CSS 产物执行 stylelint fix + verify：产物会被原样覆盖到界面代码库，需要自身就满足界面库的
 * stylelint 配置（standard + use-baseline，且 --max-warnings 0），因此先 --fix 再
 * 二次校验；仍有 error 或 warning 即构建失败。
 */
const lintStyleArtifact = async (text: string): Promise<string> => {
    const codeFilename = path.join(root, "dist", CSS_NAME);
    const fixed = await stylelint.lint({ code: text, codeFilename, fix: true });
    const artifact = typeof fixed.code === "string" ? fixed.code : text;
    const verify = await stylelint.lint({ code: artifact, codeFilename });
    const problems = verify.results[0]?.warnings ?? [];
    if (verify.errored || problems.length > 0) {
        const summary = problems.map((problem) => `${problem.rule}（${problem.line}:${problem.column}）`).join("; ") || "未知错误";
        throw new Error(`产物 CSS stylelint 未通过：${summary}`);
    }
    return artifact;
};

/** 单次构建（write: false 在内存产出），执行产物门禁（含 JS 的 eslint fix/verify 与 CSS 的 stylelint fix/verify），返回两份产物的字节内容 */
const buildOnce = async (outdir: string): Promise<{ js: Buffer; css: Buffer }> => {
    const result = await build({ ...buildOptions(outdir), write: false, metafile: true });
    // 断言：metafile 中 esbuild 产出必须恰为 index.js 与 index.css，防止意外的 code-split 或附加产物
    const outputs = Object.keys(result.metafile.outputs).map((file) => path.basename(file)).sort();
    const expected = [CSS_OUTPUT, JS_OUTPUT].sort();
    if (outputs.length !== expected.length || outputs.some((name, index) => name !== expected[index])) {
        throw new Error(`产物清单异常：期望 [${expected.join(", ")}]，实际 [${outputs.join(", ")}]`);
    }
    const js = result.outputFiles.find((file) => file.path.endsWith(JS_OUTPUT));
    const css = result.outputFiles.find((file) => file.path.endsWith(CSS_OUTPUT));
    if (!js || !css) {
        throw new Error("产物文件缺失：未在 outputFiles 中找到 JS 或 CSS");
    }
    const cssText = await lintStyleArtifact(await prefixStylesheet(Buffer.from(css.contents).toString("utf8")));
    const jsText = await lintArtifact(Buffer.from(js.contents).toString("utf8"));
    assertArtifact(JS_NAME, jsText, false);
    assertArtifact(CSS_NAME, cssText, true);
    return { js: Buffer.from(jsText, "utf8"), css: Buffer.from(cssText, "utf8") };
};

/** 体积报告：未压缩产物的原始与 gzip 字节（gzip 仅供参考，站内最终尺寸由部署侧 terser 压缩决定） */
const reportSizes = async (outdir: string, artifacts: { js: Buffer; css: Buffer }): Promise<void> => {
    for (const [name, buffer] of [[JS_NAME, artifacts.js], [CSS_NAME, artifacts.css]] as const) {
        const gzipped = await gzipAsync(buffer);
        const label = `${path.relative(root, outdir)}${path.sep}${name}`.split(path.sep).join("/");
        console.log(`${label}: ${buffer.length} bytes (gzip ${gzipped.length} bytes)`);
    }
};

try {
    if (dev) {
        const ctx = await context(buildOptions(path.join(root, "dist", "dev")));
        await ctx.watch();
        console.log(`${ENTRY} -> dist/dev/ (未压缩 + inline sourcemap)，监听改动中，Ctrl+C 退出`);
    } else if (checkIdempotent) {
        // 幂等门禁：连续两次构建到临时目录，逐字节比对；
        // dist 下已有产物时顺带比对（npm test 中 build 门禁刚产出，理应一致）
        const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), "jsonviewer-build-"));
        const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "jsonviewer-build-"));
        try {
            const first = await buildOnce(dir1);
            const second = await buildOnce(dir2);
            for (const [name, a, b] of [[JS_NAME, first.js, second.js], [CSS_NAME, first.css, second.css]] as const) {
                if (!a.equals(b)) {
                    throw new Error(`${name}: 连续两次构建产物不一致`);
                }
                const onDisk = await fs.readFile(path.join(root, "dist", name)).catch(() => null);
                if (onDisk !== null && !onDisk.equals(a)) {
                    throw new Error(`${name}: dist 中已存在的产物与本次构建不一致`);
                }
            }
            console.log(`Idempotency check passed (${first.js.length} bytes js, ${first.css.length} bytes css)`);
        } finally {
            await fs.rm(dir1, { recursive: true, force: true });
            await fs.rm(dir2, { recursive: true, force: true });
        }
    } else {
        const outdir = path.join(root, "dist");
        const artifacts = await buildOnce(outdir);
        await fs.mkdir(outdir, { recursive: true });
        await fs.writeFile(path.join(outdir, JS_NAME), artifacts.js);
        await fs.writeFile(path.join(outdir, CSS_NAME), artifacts.css);
        await reportSizes(outdir, artifacts);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
