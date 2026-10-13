# JSONViewer for MoegirlPedia

萌娘百科站内小工具 JSONViewer 的独立源码仓库。

- 将站内 JSON 页面与标题含 `json` 的纯文本页面替换为可折叠、带主题的交互式 JSON 树视图。
- 支持暗色主题自动探测与跟随切换。
- 支持用户设定全局变量改变主题。

参与开发需要 Node 24.11 或更高的 24.x 版本。

## 命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | watch 模式：`dist/dev/` 下产出未压缩 + inline sourcemap 的单文件产物（CSS 以 `<style>` 注入打包进 JS），改动即时重建 |
| `npm run build` | 产出未压缩的发布产物 `dist/Gadget-JSONViewer.js`（esm 裸顶层语句，顶部自带 `eslint-disable` banner）与 `dist/Gadget-JSONViewer.css`（按 `.browserslistrc` 补齐厂商前缀，并经 stylelint 修正）；两者都自带产物门禁断言 |
| `npm test` | 依次执行 build、typecheck、lint、lint:css、test:unit、test:idempotent 门禁 |

## 发布流程

1. 发布：代码合入 `master` 且 CI 通过后，打并推送 `v*` tag；Release 工作流自动构建、校验并上传 assets（`Gadget-JSONViewer.js`、`Gadget-JSONViewer.css`、`sha256sums.txt`）。每个 tag 对应一次构建，js 与 css 成对产出。
2. 合入界面代码库：从该 tag 的 [releases](https://github.com/MoegirlPediaInterfaceAdmins/JSONViewer/releases) assets 取出 js 与 css，覆盖到 [界面代码库](https://github.com/MoegirlPediaInterfaceAdmins/MoegirlPediaInterfaceCodes) `src/gadgets/JSONViewer/` 下的同名文件，提交后走界面代码库自己的 CI。产物自带 lint 豁免（js 顶部的 eslint-disable banner、css 已经过 stylelint），无需改动界面库的 lint 配置。产物不再自带 `mw.loader.using`，而是假定其运行时依赖 `mediawiki.api` 已在该小工具 `definition.yaml` 的 `dependencies` 中声明，由 ResourceLoader 先行加载（`jquery` 为基础模块，无需声明）。

## 配置接口

其他脚本或用户 JS 通过全局变量配置本工具：

```js
window.jsonViewerTheme = 'default' | 'a11y' | 'github' | 'vscode' | 'atom' | 'winter-is-coming'; // 主题，默认 vscode
window.jsonViewerDark = true; // 强制暗色模式；false 或不设则按皮肤自动探测并跟随切换
```

本工具在加载时会为这些属性安装响应式访问器，并在赋值发生时重新渲染，因此无需关心 `common.js` 与小工具之间的脚本加载顺序。
