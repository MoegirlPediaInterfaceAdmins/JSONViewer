import { configs } from "@annangela/eslint-config";

// 脚本与配置文件共用的 node 规则：受信环境豁免 + 按 engines 指定的版本门槛
const nodeScriptRules = {
    // Running in trusted environment (same exemptions as Navigation_popups)
    "security/detect-unsafe-regex": "off",
    "security/detect-object-injection": "off",
    "security/detect-non-literal-fs-filename": "off",
    "security/detect-non-literal-regexp": "off",
    "security/detect-child-process": "off",
    "n/no-extraneous-import": "off",
    "n/no-process-exit": "off",

    // Node version specified in package.json (same wiring as Navigation_popups)
    "n/no-unsupported-features/es-builtins": ["error", { version: ">=24.11.0" }],
    "n/no-unsupported-features/node-builtins": ["error", { version: ">=24.11.0" }],
    "n/no-unsupported-features/es-syntax": ["error", { version: ">=24.11.0" }],
};

/** @type { import("eslint").Linter.Config[] } */
export default [
    {
        // Global ignores (exclusive object). Note: neither src/ nor dist/ may
        // appear here — files listed in a global-ignores object are excluded
        // from every other config entry as well.
        ignores: [
            "node_modules",
            "coverage",
            "**/.*/**",
            // dev 构建产物（未压缩 + inline sourcemap）只是本地调试文件，不参与产物门禁；
            // 门禁只针对发布产物 dist/Gadget-JSONViewer.{js,css}
            "dist/dev",
        ],
    },
    {
        ...configs.base,
    },
    {
        // Sources: full strict typescript-eslint set (strict-type-checked +
        // stylistic-type-checked, as shipped by @annangela/eslint-config).
        ...configs.typescript,
        files: [
            "src/**/*.ts",
            "src/**/*.tsx",
            "tests/**/*.ts",
        ],
        languageOptions: {
            ...configs.typescript.languageOptions,
            globals: {
                ...configs.browser.languageOptions.globals,
                // MediaWiki 运行时全局（类型一侧由 types-mediawiki 提供，这里兜底 no-undef）
                mw: false,
                mediaWiki: false,
                // 入口的整段逻辑包在 $(() => …) 中（jQuery ready 简写），不能删
                $: false,
                jQuery: false,
                // 由 esbuild define 注入的编译期常量；no-undef 兜底，类型见 src/env.d.ts
                __DEV__: false,
            },
        },
        rules: {
            ...configs.typescript.rules,
        },
    },
    {
        // 产物会覆盖到界面代码库，界面库用 base+browser 检查它（做法同 Navigation_popups）。
        // 因此本块只镜像对端规则集：仅保留对端在 browser / 全局范围内本就关闭的规则，
        // 其余产物满足不了的规则一律写进产物顶部的 eslint-disable banner（见 scripts/build.ts）。
        // 配置与 banner 不可重复声明同一条规则，否则未被触发的一侧会变成 unused directive。
        ...configs.browser,
        files: [
            "dist/**/*",
        ],
        linterOptions: {
            // 产物顶部的 eslint-disable banner 列出的规则都是“确实触发但不可自动修复”，
            // 若开启未使用指令检测，eslint --fix 会把其中个别条目当作 unused 删掉，反而使该规则
            // 在产物中重新报错；对生成物关掉此检测，让 banner 原样保留（与覆盖后的目标校验一致）。
            reportUnusedDisableDirectives: "off",
        },
        languageOptions: {
            ...configs.browser.languageOptions,
            globals: {
                ...configs.browser.languageOptions.globals,
                mw: false,
                mediaWiki: false,
                $: false,
                jQuery: false,
            },
        },
        rules: {
            // 与界面库对 browser 文件一致的全局关闭：留在配置里、不写进 banner
            "@stylistic/no-mixed-operators": "off",
            "promise/prefer-await-to-callbacks": "off",
        },
    },
    {
        ...configs.node,
        files: [
            "eslint.config.js",
            "commitlint.config.mjs",
            "vitest.config.ts",
        ],
        rules: {
            ...configs.node.rules,
            ...nodeScriptRules,
        },
    },
    {
        // scripts/*.ts 是以 Node 24 原生 type stripping 直接运行的 TypeScript：
        // 解析器复用 configs.typescript 的实例（类型信息经 projectService 由 tsc 门禁把守），
        // 运行时规则与全局沿用 node 块
        files: [
            "scripts/**/*.ts",
        ],
        ...configs.node,
        languageOptions: {
            ...configs.node.languageOptions,
            parser: configs.typescript.languageOptions.parser,
            parserOptions: {
                projectService: true,
            },
        },
        rules: {
            ...configs.node.rules,
            ...nodeScriptRules,
        },
    },
    {
        // House type-conversion convention: Boolean(x) → !!x, Number(x) → +x.
        // The selector matches call sites only, so property accesses like
        // Number.MAX_SAFE_INTEGER stay legal.
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector: "CallExpression[callee.name='Boolean']",
                    message: "Use !! instead of Boolean().",
                },
                {
                    selector: "CallExpression[callee.name='Number']",
                    message: "Use unary + instead of Number().",
                },
            ],
        },
    },
];
