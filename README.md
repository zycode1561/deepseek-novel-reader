# DeepSeek Harness 侧边栏小说阅读器

一个面向 DeepSeek Harness Web UI 的本地优先小说阅读插件。它既能读取本地 TXT、Markdown 和 EPUB，也能由 DSH Host 直接聚合 11 个内置书源、抓取章节并加入本地书库。在线功能使用跨平台 Node/TypeScript 实现，不安装、不启动 SoNovel，也不需要 Java/JRE。

> **持久化说明**：阅读进度、设置、书签与最近打开由插件 Host 半区持久化到 `$DSH_HOME/storages`（通过官方 `storage-domain` 设施），书正文存于 `$DSH_HOME/storages/novel-reader-books/`。因此即使 DSH Desktop 每次启动随机分配 Web 端口（origin 变化导致浏览器 localStorage/IndexedDB 分区失效），阅读进度也不会丢失；浏览器存储仅作为同会话快速缓存与降级后备。

## 1. 架构设计说明

### 技术选型

- **React 18 + TypeScript**：DeepSeek Harness 当前 Web Client 使用 React 18，客户端扩展以 `dsh.client` 包发布。
- **React Context**：阅读器状态是单面板、单书籍域，Context 足以提供强类型状态与动作，不引入额外状态库。
- **Cordis / DSH Slots**：客户端入口只占用可叠加的 `shell.overlay`；可回收的宿主布局桥接按阅读器宽度收窄会话框架，同时保留 DSH 原生工具详情栏。样式与桥接清理均挂入 `ctx.effect()`。
- **Host 半区持久化**：Host 半区通过 `storage-domain` 官方设施把阅读状态落盘到 `$DSH_HOME/storages`（与 DSH 端口无关），并通过 `webServer` 注册 `/dsh-novel-reader/state` 与 `/dsh-novel-reader/books/*` 路由桥接浏览器；书正文以独立 JSON 文件存放，避免大对象进入领域内存表。
- **localStorage + IndexedDB（降级缓存）**：localStorage 保存小型偏好、进度和书签的同会话镜像；IndexedDB 保存正文缓存。Host 不可达时（如纯浏览器嵌入）自动降级，功能不受影响。
- **本地 EPUB 2/3 解析**：浏览器内异步解包 EPUB，按 OPF spine 确定阅读顺序，优先使用 EPUB 3 NAV、回退 EPUB 2 NCX；只提取目录与文字正文，不加载出版物中的外部资源。
- **按章节渲染**：正文始终只渲染当前章节。文件超过 10MB 时仍不会把全书 DOM 一次性挂载，减少内存和布局开销。
- **原生在线书源引擎**：Host 使用内置 SoNovel 兼容规则和 Cheerio 完成搜索、目录、章节及分页提取；规则里的任意 JavaScript 永不执行，必要变换由具名 TypeScript 函数实现。
- **安全网络边界**：浏览器只访问同源 `/dsh-novel-reader/online/*` API。Host 逐次校验协议、来源主机、重定向和 DNS 结果，阻止 localhost、私网、链路本地与云元数据地址。
- **异步抓取任务**：章节抓取有来源级并发、随机间隔、超时、重试、进度和取消；单一搜索源失败不影响其它来源。

### 数据流

```mermaid
flowchart LR
  A[本地 File] --> B{格式分派}
  B -->|TXT / Markdown| C[编码检测与文本解析]
  B -->|EPUB 2 / 3| R[ZIP 解包 → OPF spine → NAV / NCX]
  R --> C
  C --> D[Reader Context]
  D --> E[目录]
  D --> F[正文]
  D --> G[书内搜索 / 书签 / 设置]
  S[在线搜书] --> T[Host 规则引擎]
  T --> U[受控 HTTP / DNS]
  U --> V[目录与章节]
  V --> D
  D --> H[(IndexedDB 正文缓存)]
  D --> I[(localStorage 会话镜像)]
  H <--> J[Host 书库路由 /dsh-novel-reader/books/*]
  I <--> K[Host 状态路由 /dsh-novel-reader/state]
  J <--> L[($DSH_HOME/storages/novel-reader-books/)]
  K <--> M[(storage-domain → $DSH_HOME/storages)]
  N[DSH shell.overlay] --> O[NovelReaderOverlay]
  O --> P[HostLayoutBridge]
  P --> Q[会话框架等宽回流]
  O --> D
```

### 状态结构

`ReaderContext` 持有以下域：

- `book`：当前 `Book`，包含源文本、章节和段落索引。
- `progressByBook`：以 `bookId` 为键的逐段阅读位置、章节位置与阅读秒数。
- `settings`：字体、字号、行距、主题、目录布局和缩进。
- `panel`：展开状态、280–600px 宽度、折叠按钮纵向位置、沉浸模式和工具栏可见性。
- `bookmarks` / `recents`：书签与最近 10 本书。
- `pendingParagraph`：目录、搜索或书签跳转后的待定位段落。

## 2. 项目目录结构

```text
dsh-novel-reader/
├── .codex-plugin/plugin.json        # 开发工作区元数据，不参与 DSH 运行
├── cordis.patch.yml                 # DSH bundle 配置层
├── package.json                     # dsh.bundle + dsh.client manifest
├── tsdown.config.ts                 # Host ESM + Web Client closure bundle
├── src/
│   ├── index.ts                     # Host 半区：storage-domain 持久化 + webServer 路由桥
│   ├── online/                      # 规则校验、网络引擎、任务注册表和 Host 路由
│   ├── shared/
│   │   ├── types.ts                 # 核心类型
│   │   ├── launcher-position.ts     # 折叠按钮位置校验、边界和拖拽阈值
│   │   ├── encoding.ts              # UTF-8 / GB18030 检测解码
│   │   ├── epub.ts                  # EPUB 2/3 解包、目录与正文解析
│   │   ├── parser.ts                # 目录与段落解析
│   │   ├── progress.ts              # 阅读进度
│   │   ├── search.ts                # 全文搜索
│   │   └── file.ts                  # 文件加载与体积降级
│   └── client/
│       ├── index.tsx                # shell.overlay 注册入口
│       ├── host-layout.ts           # 宿主会话框架同级布局桥接
│       ├── styles.ts                # 随插件生命周期注入的样式
│       ├── state/ReaderContext.tsx  # 状态和动作
│       ├── storage/                 # localStorage / IndexedDB
│       └── components/              # 侧栏、在线搜书、目录、正文、设置等
├── rules/main.json                  # 11 个内置 SoNovel 兼容书源
└── tests/                            # 解析、编码、在线引擎、安全和 UI API 单测
```

## 3. 核心类型定义

完整定义位于 `src/shared/types.ts`：

```ts
interface Book {
  id: string
  name: string
  format: 'txt' | 'markdown' | 'epub' | 'online'
  encoding: 'utf-8' | 'utf-8-bom' | 'gb18030'
  size: number
  content: string
  chapters: Chapter[]
  paragraphs: Paragraph[]
  largeFileMode: boolean
  origin?: { sourceId: string; sourceName: string; bookUrl: string; fetchedAt: number }
}

interface Chapter {
  id: string
  index: number
  title: string
  level: number
  start: number
  end: number
  paragraphStart: number
  paragraphEnd: number
}

interface Bookmark {
  id: string
  bookId: string
  chapterIndex: number
  paragraphIndex: number
  excerpt: string
  createdAt: number
}

interface ReaderSettings {
  fontSize: number
  fontFamily: 'system' | 'songti' | 'heiti' | 'kaiti' | 'serif'
  lineSpacing: 'compact' | 'comfortable' | 'relaxed'
  theme: 'light' | 'dark' | 'eye-care' | 'parchment'
  tocPosition: 'top' | 'left'
  firstLineIndent: boolean
  pageMode: 'scroll' | 'paged'
  footerDisplay: 'chapter-progress' | 'chapter-title'
}
```

## 4. 关键组件代码

- `NovelReaderOverlay.tsx`：同级右栏、展开/收起、拖拽宽度、折叠按钮纵向拖拽、快捷键、可切换的章节名称/章节进度底栏与视图切换。
- `FileLoader.tsx`：本地文件选择、加载反馈、错误提示和最近文件。
- `TableOfContents.tsx`：可搜索目录、当前章节高亮、左侧常驻或独立面板模式。
- `ReaderBody.tsx`：当前章节按段落渲染、搜索词高亮、逐段位置追踪，以及上下滚动/仿微信读书左右分页。
- `SettingsPanel.tsx`：12–32px 字号、5 种字体、3 档行距、4 套主题和目录布局。
- `SearchPanel.tsx`：全书搜索，Enter/Shift+Enter 导航，最多返回 500 条。
- `OnlineSearchPanel.tsx`：聚合搜书、来源信息、抓取进度、重试、取消与完成后自动阅读。
- `BookmarksPanel.tsx`：逐段书签的查看、跳转和删除。

## 5. 工具函数

- `decodeNovelBuffer()`：先检查 UTF-8 BOM，再用严格 UTF-8 解码，失败后回退 GB18030（覆盖 GBK/GB2312）。
- `parseEpubBuffer()`：校验 ZIP 安全边界，读取 container.xml 与 OPF，按 spine 提取 XHTML 正文，并从 EPUB 3 NAV 或 EPUB 2 NCX 建立分层目录；目录不可用时回退正文标题。
- `parseBookText()`：识别“第 X 章/回/节”“Chapter X”“1. 标题”“001 标题”和 Markdown `#`–`###`。
- `calculateProgress()`：基于全局段落索引计算当前章节和全书百分比。
- `searchBook()`：在段落索引中定位结果，返回章节、段落与摘要坐标。
- `loadBookFromFile()`：格式、体积、编码和解析的统一错误边界。

体积策略：10MB 以下正常加载；10–50MB 启用按章节渲染提示；超过 50MB 拒绝并建议拆卷。即使缓存因配额失败，本次会话仍可继续阅读。

## 6. 平台集成代码

`package.json` 同时声明：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-layout"
      ],
      "platform": "web"
    }
  }
}
```

`cordis.patch.yml` 把包加入 profile；`src/client/index.tsx` 使用：

```ts
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay',
  id: 'dsh-novel-reader',
  order: 90,
}, ReaderSlot))
```

DSH 仍处于 Developer Preview，本项目锁定 `0.1.0-rc.6` 客户端契约。平台升级后应先运行类型检查和 Web 冒烟测试。

## 6.1 DSH Desktop 适配说明

插件对 DSH Desktop 三种壳模式做了针对性适配（无需配置，自动生效）：

- **advanced / extended（桌面自有 frame）**：宿主把 `shell.overlay` 层设在 `z-index:1000`，与应用级弹窗（设置、附件选择器等同为 `z-index:1000`）同层时按 DOM 顺序反而压住弹窗，导致阅读器盖住设置界面。插件将叠加层压到 `z-index:60`（帧内 UI 之上、应用弹窗之下）。
- **compatibility / extended（transform + 裁剪包含块）**：宿主给 overlay 层同时加 `transform` 与 `overflow:hidden`。插件不再缩窄整个 frame 或把阅读器移出 overlay，而是在宿主三栏网格末尾追加一个阅读器专用轨道；对话区照常回流，overlay 保持完整宽度，因此不会再露出黑色/玻璃窗口背景。布局桥还会监听宿主的侧栏、详情栏与窗口尺寸变化，自动重挂阅读器轨道。
- **快捷键隔离**：应用级弹窗（`[aria-modal="true"]`）打开时，阅读器不响应翻页、搜索、展开/收起等快捷键，键盘输入完全交给弹窗。
- **折叠按钮定位**：右侧“阅读”按钮以当前 `shell.overlay` 可视区域为坐标系，自动避开 Desktop 标题栏；窗口缩放或切换壳模式后按相对位置重新布局。

## 7. 安装、运行与打包

### 本地开发

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

在已安装 `dsh` CLI 的环境中，把本目录加入一个 profile：

```bash
dsh plugin --profile reader add ./deepseek-novel-reader
dsh --profile reader --dump-config
dsh --profile reader web
```

如果从 Git 仓库安装，pnpm 10+ 默认禁止依赖运行 `prepare`。需要在该 profile 的 `pnpm-workspace.yaml` 明确允许：

```yaml
allowBuilds:
  dsh-novel-reader: true
```

更安全的分发方式是交付已构建 tarball：

```bash
pnpm run build
pnpm pack
dsh plugin --profile reader add ./dsh-novel-reader-0.2.0.tgz
```

### 使用

1. 启动 DSH Web UI 后，点击右侧“阅读”按钮；收起状态下也可沿右侧边缘上下拖动它，位置会自动保存。
2. 选择 `.txt`、`.md`、`.markdown` 或无 DRM 的 `.epub` 文件；也可点“在线搜书”，选择结果后点“加入书库并阅读”。
3. 拖动面板左边缘调整宽度；展开状态和宽度会自动保存。
4. 工具栏“搜书”用于在线聚合搜索，“搜索”用于当前书全文搜索；`Ctrl/Cmd+F` 行为仍是书内搜索。`Esc` 返回正文。
5. 点击正文空白/文本区域切换沉浸模式。

## 版本范围

### MVP（本仓库已完成）

- TXT / Markdown、本地编码检测、章节解析与目录过滤
- EPUB 2/3、本地异步解包、OPF spine 阅读顺序、EPUB 3 NAV / EPUB 2 NCX 目录与 fragment 分章
- 侧栏展开/收起、280–600px 宽度拖拽、折叠按钮纵向拖拽、状态恢复和过渡动画
- 逐段进度、双进度条、最近 10 本、书签、上/下一章
- 字体/字号/行距/主题、底部章节名称/进度显示、全文搜索、快捷键和沉浸模式
- 上下滚动与左右分页两种阅读方式，设置自动保存
- 10MB 大文件按章节渲染、50MB 上限与存储失败降级
- Host 原生聚合搜书、短期 opaque 结果 ID、异步章节抓取、进度/重试/取消和在线书籍稳定 ID
- 书源/重定向/DNS SSRF 防护、同源 API、可配置并发/超时/限流/代理和 11 个内置书源

### V1.0（建议下一阶段）

- 超大文件流式解码与虚拟段落列表
- 按日/周阅读时长统计和导出
- Playwright 宿主级视觉回归测试

## 在线引擎配置

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| `searchConcurrency` | 6 | 同时搜索的书源数 |
| `chapterConcurrency` | 20 | 同一抓取任务的章节并发上限 |
| `requestTimeoutMs` | 15000 | 单请求超时 |
| `searchTimeoutMs` | 60000 | 整次聚合搜索超时 |
| `maxRetries` | 3 | 章节失败后的最大重试次数 |
| `minRequestIntervalMs` / `maxRequestIntervalMs` | 200 / 400 | 每章请求前随机等待区间 |
| `maxSearchResults` | 100 | 聚合结果上限 |
| `proxyUrl` | 未设置 | 可选 HTTP/HTTPS 代理 |

非法数值、反向间隔、无效规则或非 HTTP(S) 代理会让插件明确加载失败。

## 隐私与网络

本地文件不会上传，EPUB 也不会加载出版物中的外部资源。只有使用“在线搜书”时，Host 才会直接请求选中的第三方书源；浏览器不会直连书源。在线内容没有可用性、准确性或持续服务保证，插件不会绕过登录、限流或 Cloudflare 验证。DNS 与重定向只允许内置规则声明的书源主机；为兼容 Clash 等 TUN/Fake-IP 环境，这些已授权主机可以解析到代理保留网段 `198.18.0.0/15`，其他本机、局域网、链路本地和元数据地址仍会被拒绝。正文、进度、书签和设置保留在当前设备的 DSH Host 存储中，并在浏览器存储中保留会话缓存。

## 许可证与归属

自 `0.2.0` 起，因内置并改写 SoNovel 规则与设计，本项目整体按 [AGPL-3.0](./LICENSE) 发布。原 MIT 版权与许可声明、SoNovel 归属和对应源码说明见 [NOTICE](./NOTICE)。npm 包同时包含 `src/`、`tests/`、规则和构建配置；完整源码也持续发布在本仓库。

## 参考

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DSH 插件开发文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
- [SoNovel（AGPL-3.0）](https://github.com/freeok/so-novel)
