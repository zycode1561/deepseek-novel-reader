# DeepSeek Harness 小说阅读器

面向 DeepSeek Harness Web / Desktop 的侧边栏阅读插件，支持本地小说、在线书源和番茄小说独立阅读。

## 功能

- **本地书库**：读取 TXT、Markdown 和无 DRM 的 EPUB，支持 UTF-8 / GB18030 编码、章节识别和目录导航。
- **在线阅读**：内置 11 个小说书源，支持聚合搜书、按章加载、章节预读，以及整本抓取并导出 UTF-8 TXT。
- **自定义书源**：导入、编辑、测试和导出 AnyReader / 亦搜小说书源。
- **番茄小说**：扫码登录后直接浏览书架、继续阅读；可将手机云端章节进度单向同步到阅读器，电脑端段落位置独立保存。
- **阅读管理**：书内搜索、书签、最近阅读、逐段进度恢复；本地与番茄阅读位置分别保留。
- **阅读体验**：滚动 / 左右分页、沉浸模式、字体字号和行距调整、四套主题、可配置快捷键。
- **侧栏交互**：拖拽调整宽度和折叠按钮位置；顶部导航悬停展开，移开 300 毫秒后整体收起，正文不跳动，支持键盘与触屏操作。

## 安装

需要已配置 profile 的 DeepSeek Harness、Node.js **22.19+** 和 pnpm。下方的 `reader` 是示例 profile 名称，请替换为实际使用的名称。

### 从源码安装

```bash
git clone https://github.com/zycode1561/deepseek-novel-reader.git
cd deepseek-novel-reader
pnpm install
pnpm pack
dsh plugin --profile reader add ./dsh-novel-reader-0.4.1.tgz
```

`pnpm pack` 会自动构建并生成安装包。

### 已有安装包

在安装包所在目录执行：

```bash
dsh plugin --profile reader add ./dsh-novel-reader-0.4.1.tgz
```

安装或更新后，完整重启 DSH Desktop；Web 端重新启动原 profile。点击界面右侧的“阅读”按钮打开阅读器。
