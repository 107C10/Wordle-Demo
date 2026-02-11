# 🟩 Wordle - 猜单词游戏

一个基于纯 HTML + CSS + JavaScript 实现的 Wordle 猜词游戏，参考 [NYT Wordle](https://wordle.rd.nyt.net/) 的前端体验。

内置 **信息论 AI Solver**（基于 3Blue1Brown 方法），可为你推荐最佳猜测。

无需安装任何框架或依赖，双击 `index.html` 即可在浏览器中运行。

---

## 🎮 游戏规则

1. 每局游戏随机选取一个 **5 个字母** 的英文单词作为答案（刷新或重新开始后更换）
2. 你有 **6 次机会** 来猜出这个单词
3. 每次猜测后，方块颜色会给出提示：
   - 🟩 **绿色**：字母正确且位置正确
   - 🟨 **黄色**：字母在答案中但位置不对
   - ⬛ **灰色**：字母不在答案中
4. 虚拟键盘会同步更新颜色，帮助你排除/确认字母

---

## 📁 项目结构

```
wordle/
├── index.html          # 主页面（入口文件）
├── css/
│   └── style.css       # 所有样式
├── js/
│   ├── words.js        # 官方词库（2315 答案词 + 10657 猜测词）
│   ├── solver.js       # 信息论 Solver 核心算法
│   └── game.js         # 游戏核心逻辑 + Solver 集成
└── README.md           # 项目说明文档
```

---

## 📄 各文件详解

### `index.html` - 主页面

页面整体布局分为三大部分：

| 区域 | 说明 |
|------|------|
| **Header（顶栏）** | 左侧：帮助按钮（❓）+ AI Solver 按钮（💡）；中间：标题 "Wordle"；右侧：重新开始（↺）+ 设置（⚙️） |
| **Board（棋盘）** | 6 行 × 5 列的猜测网格，每个格子展示一个字母 |
| **Keyboard（键盘）** | 虚拟 QWERTY 键盘，包含 26 个字母键 + Enter + Backspace |

另外包含：
- **帮助弹窗**：点击帮助按钮显示游戏规则
- **设置弹窗**：包含 Dark Mode、Hard Mode、Custom Word 三项设置
- **Solver 面板**：点击💡按钮打开 AI 分析面板

---

### `css/style.css` - 样式文件

| 模块 | 功能 |
|------|------|
| **CSS 变量 & 主题** | 使用 CSS 自定义属性定义颜色方案，支持亮色/暗色主题切换 |
| **全局样式** | body 布局（`flexbox` 垂直居中）、字体设置 |
| **顶栏** | `flex` 三栏布局（左图标 - 中标题 - 右图标） |
| **棋盘** | `CSS Grid` 实现 6×5 网格布局 |
| **格子状态** | 不同 `data-state` 对应不同颜色（correct=绿, present=黄, absent=灰） |
| **动画** | `popIn`(输入弹跳)、`flipIn`(翻转揭示)、`shake`(无效输入抖动)、`bounce`(胜利跳跃) |
| **虚拟键盘** | `flex` 布局，按键支持状态颜色 |
| **弹窗** | 帮助弹窗 + 设置弹窗（包含 Toggle Switch 组件） |
| **Solver 面板** | 浮动面板样式、进度条、分析结果列表 |
| **响应式** | 适配不同屏幕尺寸，自动缩小格子和按键 |

---

### `js/words.js` - 官方词库

数据来源：NYT Wordle 官方词库（cfreshman 整理）。

| 变量 | 说明 |
|------|------|
| `ANSWER_LIST` | **答案候选列表**（2,315 个常用 5 字母单词），每局答案从中选取 |
| `EXTRA_GUESSES` | **额外合法猜测词**（10,657 个冷门但合法的 5 字母单词） |
| `VALID_GUESSES` | **合法猜测集合**（`Set` 类型，= ANSWER_LIST + EXTRA_GUESSES，共约 12,972 词） |

词库的两层结构天然区分了**常用词**（ANSWER_LIST）和**冷门词**（EXTRA_GUESSES）。

---

### `js/solver.js` - 信息论 Solver ⭐

基于 [3Blue1Brown 的信息论方法](https://www.3blue1brown.com/lessons/wordle) 实现。

#### 核心思想

每次猜测后，Wordle 返回一个颜色模式（3^5 = 243 种可能）。最佳猜测 = 使得颜色模式的**期望信息量（entropy）最大**的词。

$$H = -\sum_{i=1}^{243} p_i \cdot \log_2(p_i)$$

其中 $p_i$ 是第 $i$ 种颜色模式出现的概率。

#### 关键函数

| 函数 | 功能 |
|------|------|
| `getPattern(guess, target)` | 计算猜测词与目标词的模式码（0-242） |
| `calculateEntropy(guess, possibleWords)` | 计算一个猜测词的期望信息量 |
| `filterWords(guess, patternCode, possibleWords)` | 根据已知反馈过滤剩余候选词 |
| `getBestGuesses(possibleAnswers, allGuesses, topN)` | 返回信息量最高的前 N 个推荐猜测 |

#### 模式编码

每个格子的状态用 0/1/2 表示（absent/present/correct），整体模式用三进制编码为 0-242 的整数。

---

### `js/game.js` - 游戏核心逻辑

#### 1. 游戏状态管理
```
targetWord         → 当前答案
currentRow         → 当前行（0-5）
currentCol         → 当前列（0-4）
gameOver           → 是否结束
boardState         → 二维数组，记录每格字母
solverPossibleWords → Solver 的剩余候选答案
```

#### 2. 猜测评估算法 `evaluateGuess(guess)`
**两遍扫描法**（正确处理重复字母）：
1. **第一遍**：找出所有位置完全正确的字母 → `correct`（绿色）
2. **第二遍**：对剩余字母，检查是否存在于答案其他位置 → `present`（黄色）或 `absent`（灰色）

#### 3. Solver 集成
- 每次猜测后自动调用 `updateSolverAfterGuess()` 过滤候选词
- 点击💡按钮打开 Solver 面板，点击「分析」异步计算最佳猜测
- 分批计算避免阻塞 UI，实时显示进度条

---

## ⚙️ 功能一览

| 功能 | 说明 |
|------|------|
| 🎯 基础 Wordle | 6 次机会猜 5 字母单词，颜色反馈 |
| 🔄 重新开始 | 随机换词并重置棋盘 |
| 🌙 Dark Mode | 亮/暗主题切换，偏好保存到 localStorage |
| 💪 Hard Mode | 已揭示的绿色字母必须在同位置使用，黄色字母必须出现 |
| ✏️ Custom Word | 输入自定义单词（必须在词库中），给朋友猜 |
| 💡 AI Solver | 基于信息论推荐最佳猜测，显示期望信息量 |
| ⌨️ 双键盘 | 支持物理键盘和虚拟键盘 |
| 📱 响应式 | 适配手机、平板、桌面 |

---

## 🚀 如何运行

### 方法一：直接打开（最简单）
双击 `index.html` 文件，浏览器会自动打开游戏。

### 方法二：使用 VS Code Live Server
1. 在 VS Code 中安装 **Live Server** 扩展
2. 右键 `index.html` → 选择 "Open with Live Server"
3. 浏览器自动打开并支持热更新

### 方法三：使用 Python 简易服务器
```bash
cd wordle
python -m http.server 8080
```
然后访问 `http://localhost:8080`

---

## 🛠️ 技术要点

| 技术 | 用途 |
|------|------|
| HTML5 语义化标签 | 页面结构 (`header`, `main`, `button`) |
| CSS Grid | 棋盘 6×5 网格布局 |
| CSS Flexbox | 键盘行布局、整体页面布局 |
| CSS 自定义属性 | 主题色管理，方便切换亮/暗模式 |
| CSS 动画 (`@keyframes`) | 弹入、翻转、抖动、跳跃等视觉反馈 |
| DOM 操作 | 动态生成棋盘、更新格子状态 |
| 事件监听 | 键盘事件 (`keydown`)、点击事件 (`click`) |
| `localStorage` | 持久化存储主题、Hard Mode 偏好 |
| `Set` 数据结构 | 高效的单词验证（O(1) 查找） |
| 信息论 / Entropy | Solver 核心算法 |
| `async/await` + 分批计算 | Solver 异步运行避免 UI 阻塞 |

---

## 📝 待开发功能

- [ ] 游戏统计（胜率、连胜等）
- [ ] 分享结果（生成方块 emoji）
- [ ] 多种单词长度支持
- [ ] 后端 API + 数据库
- [ ] 多语言支持

---

## 📜 License

仅供学习使用。
