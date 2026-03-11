/**
 * Wordle 游戏核心逻辑
 */

// ===========================
// 游戏常量
// ===========================
let wordLength = 5;         // 每个单词的字母数量
const MAX_GUESSES = 6;      // 最多猜测次数

// ===========================
// 游戏状态
// ===========================
let targetWord = '';         // 当前答案
let currentRow = 0;          // 当前行（0-5）
let currentCol = 0;          // 当前列（0-4）
let gameOver = false;        // 游戏是否结束
let isRevealing = false;     // 翻转动画进行中，锁定输入
let boardState = [];         // 存储棋盘上每个格子的字母
let revealedHints = [];      // Hard Mode: 已揭示的提示 [{letter, index, state}]
let hardMode = false;        // Hard Mode 开关
let isCustomWord = false;    // 当前是否为自定义单词模式
let isMultiplayer = false;   // 多人模式标志

// ===========================
// DOM 元素引用
// ===========================
const boardEl = document.getElementById('board');
const messageContainer = document.getElementById('message-container');
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const restartBtn = document.getElementById('restart-btn');
const toggleDark = document.getElementById('toggle-dark');
const toggleHard = document.getElementById('toggle-hard');
const customWordInput = document.getElementById('custom-word-input');
const customWordBtn = document.getElementById('custom-word-btn');
const wordLengthSelector = document.getElementById('word-length-selector');

// Stats DOM 元素
const statsBtn = document.getElementById('stats-btn');
const statsModal = document.getElementById('stats-modal');
const statsClose = document.getElementById('stats-close');
const statPlayed = document.getElementById('stat-played');
const statWinPct = document.getElementById('stat-win-pct');
const statCurrentStreak = document.getElementById('stat-current-streak');
const statMaxStreak = document.getElementById('stat-max-streak');
const guessDistribution = document.getElementById('guess-distribution');
const statsClearBtn = document.getElementById('stats-clear-btn');

// Solver DOM 元素
const solverBtn = document.getElementById('solver-btn');
const solverPanel = document.getElementById('solver-panel');
const solverClose = document.getElementById('solver-close');
const solverStatus = document.getElementById('solver-status');
const solverResults = document.getElementById('solver-results');
const solverProgress = document.getElementById('solver-progress');
const solverProgressFill = document.getElementById('solver-progress-fill');
const solverProgressText = document.getElementById('solver-progress-text');
const solverRemaining = document.getElementById('solver-remaining');

// Solver 状态
let solverPossibleWords = [...ANSWER_LIST]; // 当前剩余可能答案
let solverIsAnalyzing = false;
let solverAnalysisId = 0;  // 用于取消过期的分析

// ===========================
// 初始化游戏
// ===========================
function initGame() {
    // 首次启动：随机选词
    targetWord = getRandomWord();
    isCustomWord = false;
    console.log('🎯 [Debug] 答案:', targetWord);

    // 初始化游戏状态
    resetGameState();

    // 生成棋盘 DOM
    createBoard();

    // 绑定事件（只在首次调用，后续 restart 不会重复绑定）
    bindKeyboard();
    bindPhysicalKeyboard();
    bindModalEvents();
    bindSettings();
    bindSolver();
    bindStats();
    bindScreenshot();

    // 加载保存的设置
    loadSettings();
}

/**
 * 随机从答案列表中选取一个单词
 */
function getRandomWord() {
    const index = Math.floor(Math.random() * ANSWER_LIST.length);
    return ANSWER_LIST[index].toUpperCase();
}

/**
 * 重置游戏状态（不重新绑定事件）
 */
function resetGameState() {
    currentRow = 0;
    currentCol = 0;
    gameOver = false;
    isRevealing = false;
    revealedHints = [];
    boardState = Array.from({ length: MAX_GUESSES }, () => Array(wordLength).fill(''));

    // 重置 Solver 状态
    solverPossibleWords = [...ANSWER_LIST];
    solverResults.innerHTML = '';
    solverStatus.textContent = '正在分析最佳猜测...';
    solverProgress.classList.add('hidden');
    if (solverRemaining) solverRemaining.textContent = ANSWER_LIST.length;

    // 自动运行 Solver 分析
    runSolverAnalysis();
}

/**
 * 重新开始游戏（新随机单词 + 重置棋盘和键盘）
 */
function restartGame(customWord) {
    if (customWord) {
        targetWord = customWord.toUpperCase();
        isCustomWord = true;
    } else {
        targetWord = getRandomWord();
        isCustomWord = false;
    }
    console.log('🎯 [Debug] 答案:', targetWord);

    resetGameState();
    createBoard();
    resetKeyboard();
    // 清除所有 toast 消息
    messageContainer.innerHTML = '';
}

/**
 * 切换单词长度并重新开始游戏
 * @param {number} len - 新的单词长度 (5/6/7)
 */
function changeWordLength(len) {
    if (!switchWordLength(len)) return;
    wordLength = len;
    localStorage.setItem('wordle-word-length', len.toString());

    // 更新 UI
    updateWordLengthUI(len);

    // 更新自定义单词输入框
    customWordInput.maxLength = len;
    customWordInput.placeholder = `Enter a ${len}-letter word`;

    // 重新开始游戏
    restartGame();
    showMessage(`已切换到 ${len} 字母模式！`, 1000);
}

/**
 * 更新 Word Length 选择器按钮的 active 状态
 */
function updateWordLengthUI(len) {
    if (!wordLengthSelector) return;
    wordLengthSelector.querySelectorAll('.word-length-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.length) === len);
    });
}

/**
 * 重置虚拟键盘颜色
 */
function resetKeyboard() {
    document.querySelectorAll('.key').forEach(key => {
        key.removeAttribute('data-state');
    });
}

// ===========================
// 棋盘生成
// ===========================
function createBoard() {
    boardEl.innerHTML = '';
    // 动态调整格子尺寸：更多列 → 更小格子
    const tileSizes = { 5: 62, 6: 56, 7: 50 };
    const tileSize = tileSizes[wordLength] || 56;
    document.documentElement.style.setProperty('--tile-size', tileSize + 'px');
    if (wordLength >= 7) {
        document.documentElement.style.setProperty('--tile-font-size', '1.6rem');
    } else {
        document.documentElement.style.setProperty('--tile-font-size', '2rem');
    }
    boardEl.parentElement.style.maxWidth = (wordLength * tileSize + (wordLength - 1) * 5 + 20) + 'px';
    for (let r = 0; r < MAX_GUESSES; r++) {
        const rowEl = document.createElement('div');
        rowEl.classList.add('row');
        rowEl.setAttribute('data-row', r);
        rowEl.style.gridTemplateColumns = `repeat(${wordLength}, 1fr)`;
        for (let c = 0; c < wordLength; c++) {
            const tileEl = document.createElement('div');
            tileEl.classList.add('tile');
            tileEl.setAttribute('data-row', r);
            tileEl.setAttribute('data-col', c);
            rowEl.appendChild(tileEl);
        }
        boardEl.appendChild(rowEl);
    }
}

// ===========================
// 获取/设置格子
// ===========================
function getTile(row, col) {
    return boardEl.querySelector(`.tile[data-row="${row}"][data-col="${col}"]`);
}

function getRow(row) {
    return boardEl.querySelector(`.row[data-row="${row}"]`);
}

// ===========================
// 输入处理
// ===========================

/** 输入一个字母 */
function handleLetter(letter) {
    if (gameOver || isRevealing) return;
    // 观众/游戏未开始 → 禁止输入
    if (isMultiplayer && typeof Multiplayer !== 'undefined') {
        if (Multiplayer.isSpectator || !Multiplayer.gameStarted) return;
    }
    if (currentCol >= wordLength) return;

    const tile = getTile(currentRow, currentCol);
    tile.textContent = letter;
    tile.setAttribute('data-state', 'tbd');
    boardState[currentRow][currentCol] = letter;
    currentCol++;

    // 多人模式：广播候选框
    if (isMultiplayer && typeof Multiplayer !== 'undefined') {
        Multiplayer.broadcastBox();
    }
}

/** 删除最后一个字母 */
function handleBackspace() {
    if (gameOver || isRevealing) return;
    if (isMultiplayer && typeof Multiplayer !== 'undefined') {
        if (Multiplayer.isSpectator || !Multiplayer.gameStarted) return;
    }
    if (currentCol <= 0) return;

    currentCol--;
    const tile = getTile(currentRow, currentCol);
    tile.textContent = '';
    tile.removeAttribute('data-state');
    boardState[currentRow][currentCol] = '';

    // 多人模式：广播候选框
    if (isMultiplayer && typeof Multiplayer !== 'undefined') {
        Multiplayer.broadcastBox();
    }
}

/** 提交猜测 */
function handleEnter() {
    if (gameOver || isRevealing) return;
    if (isMultiplayer && typeof Multiplayer !== 'undefined') {
        if (Multiplayer.isSpectator || !Multiplayer.gameStarted) return;
    }

    // 检查是否填满5个字母
    if (currentCol < wordLength) {
        showMessage('字母不够！');
        shakeRow(currentRow);
        return;
    }

    const guess = boardState[currentRow].join('');

    // 验证猜测的词是否在合法猜测列表中
    if (!isValidWord(guess)) {
        showMessage('不在单词列表中');
        shakeRow(currentRow);
        return;
    }

    // Hard Mode 检查
    if (hardMode && currentRow > 0) {
        const hardModeError = checkHardMode(guess);
        if (hardModeError) {
            showMessage(hardModeError);
            shakeRow(currentRow);
            return;
        }
    }

    // ★ 多人模式：发送到服务器，由服务器评估
    if (isMultiplayer && typeof Multiplayer !== 'undefined') {
        isRevealing = true; // 锁定输入，防止重复提交
        Multiplayer.submitGuess(guess);
        return;
    }

    // 单人模式：本地评估
    const evaluation = evaluateGuess(guess);
    applyGuessResult(guess, evaluation);
}

/**
 * 应用猜测结果（单人 / 多人共用）
 * @param {string} guess
 * @param {string[]} evaluation
 * @param {boolean} [mpWon]     多人模式由服务器判定
 * @param {string}  [mpAnswer]  多人模式由服务器提供答案（失败时）
 */
function applyGuessResult(guess, evaluation, mpWon, mpAnswer) {
    isRevealing = true;
    revealRow(currentRow, evaluation);

    // 记录提示信息（Hard Mode 用）
    recordHints(guess, evaluation);

    // 更新 Solver 的剩余可能答案
    updateSolverAfterGuess(guess, evaluation);

    const revealDuration = wordLength * 300 + 250;

    // 判断是否胜利
    const won = isMultiplayer ? !!mpWon : (guess === targetWord);
    const answer = isMultiplayer ? (mpAnswer || '') : targetWord;

    if (won) {
        setTimeout(() => {
            isRevealing = false;
            const messages = ['天才！', '太棒了！', '出色！', '不错！', '还行！', '好险！'];
            showMessage(messages[currentRow] || '你赢了！', 3000);
            bounceRow(currentRow);
            gameOver = true;
            if (!isCustomWord && !isMultiplayer) {
                recordGameResult(true, currentRow + 1);
                setTimeout(() => showStats(currentRow), 2000);
            }
        }, revealDuration);
        return;
    }

    currentRow++;
    currentCol = 0;

    if (currentRow >= MAX_GUESSES) {
        setTimeout(() => {
            isRevealing = false;
            showMessage(`答案: ${answer}`, 5000);
            gameOver = true;
            if (!isCustomWord && !isMultiplayer) {
                recordGameResult(false, 0);
                setTimeout(() => showStats(), 2500);
            }
        }, revealDuration);
    } else {
        setTimeout(() => {
            isRevealing = false;
        }, revealDuration);
    }
}

// ===========================
// Hard Mode 逻辑
// ===========================

/**
 * 记录已揭示的提示，供 Hard Mode 使用
 */
function recordHints(guess, evaluation) {
    for (let i = 0; i < wordLength; i++) {
        if (evaluation[i] === 'correct') {
            // 记录：第 i 位必须是 guess[i]
            revealedHints.push({ letter: guess[i], index: i, state: 'correct' });
        } else if (evaluation[i] === 'present') {
            // 记录：guess[i] 必须出现在猜测中（但不在第 i 位）
            revealedHints.push({ letter: guess[i], index: i, state: 'present' });
        }
    }
}

/**
 * 检查猜测是否满足 Hard Mode 规则
 * 返回 null 表示通过，否则返回错误消息字符串
 */
function checkHardMode(guess) {
    for (const hint of revealedHints) {
        if (hint.state === 'correct') {
            // 绿色提示：必须在同一位置使用同一字母
            if (guess[hint.index] !== hint.letter) {
                return `第 ${hint.index + 1} 个字母必须是 ${hint.letter}`;
            }
        } else if (hint.state === 'present') {
            // 黄色提示：该字母必须出现在猜测中
            if (!guess.includes(hint.letter)) {
                return `猜测中必须包含字母 ${hint.letter}`;
            }
        }
    }
    return null;
}

// ===========================
// 单词验证
// ===========================
function isValidWord(word) {
    return VALID_GUESSES.has(word.toLowerCase());
}

// ===========================
// 猜测评估（委托给共享 Judge 模块）
// ===========================
function evaluateGuess(guess) {
    return Judge.evaluateGuess(guess, targetWord);
}

// ===========================
// 翻转动画 & 颜色揭示
// ===========================
function revealRow(row, evaluation) {
    for (let col = 0; col < wordLength; col++) {
        const tile = getTile(row, col);
        const delay = col * 300;

        setTimeout(() => {
            tile.classList.add('flip');
            setTimeout(() => {
                tile.setAttribute('data-state', evaluation[col]);
            }, 250);
        }, delay);
    }

    // 翻转完毕后更新键盘颜色
    setTimeout(() => {
        updateKeyboard(boardState[row].join(''), evaluation);
    }, wordLength * 300);
}

// ===========================
// 键盘颜色更新
// ===========================
function updateKeyboard(guess, evaluation) {
    const priority = { 'correct': 3, 'present': 2, 'absent': 1 };

    for (let i = 0; i < wordLength; i++) {
        const letter = guess[i];
        const state = evaluation[i];
        const keyEl = document.querySelector(`.key[data-key="${letter}"]`);
        if (!keyEl) continue;

        const currentState = keyEl.getAttribute('data-state');
        const currentPriority = priority[currentState] || 0;
        const newPriority = priority[state] || 0;

        if (newPriority > currentPriority) {
            keyEl.setAttribute('data-state', state);
        }
    }
}

// ===========================
// 动画效果
// ===========================
function shakeRow(row) {
    const rowEl = getRow(row);
    rowEl.classList.add('shake');
    rowEl.addEventListener('animationend', () => {
        rowEl.classList.remove('shake');
    }, { once: true });
}

function bounceRow(row) {
    for (let col = 0; col < wordLength; col++) {
        const tile = getTile(row, col);
        setTimeout(() => {
            tile.classList.add('bounce');
        }, col * 100);
    }
}

// ===========================
// 消息提示
// ===========================
function showMessage(text, duration = 1500) {
    const toast = document.createElement('div');
    toast.classList.add('toast');
    toast.textContent = text;
    messageContainer.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => {
            toast.classList.add('fade-out');
            toast.addEventListener('animationend', () => {
                toast.remove();
            });
        }, duration);
    }
}

// ===========================
// 事件绑定
// ===========================

/** 绑定虚拟键盘点击 */
function bindKeyboard() {
    document.querySelectorAll('.key').forEach(key => {
        key.addEventListener('click', () => {
            const k = key.getAttribute('data-key');
            if (k === 'ENTER') {
                handleEnter();
            } else if (k === 'BACKSPACE') {
                handleBackspace();
            } else {
                handleLetter(k);
            }
        });
    });
}

/** 绑定物理键盘 */
function bindPhysicalKeyboard() {
    document.addEventListener('keydown', (e) => {
        // 如果焦点在任何输入框中，不拦截键盘事件
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
        // 如果有模态框打开（含房间弹窗、设置、帮助等），不拦截
        const anyModalOpen = document.querySelector('.modal:not(.hidden)') || document.querySelector('.play-again-overlay:not(.hidden)');
        if (anyModalOpen) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const key = e.key;

        if (key === 'Enter') {
            handleEnter();
        } else if (key === 'Backspace') {
            handleBackspace();
        } else if (/^[a-zA-Z]$/.test(key)) {
            handleLetter(key.toUpperCase());
        }
    });
}

/** 帮助弹窗 & 设置弹窗 */
function bindModalEvents() {
    helpBtn.addEventListener('click', () => {
        helpModal.classList.remove('hidden');
    });
    helpClose.addEventListener('click', () => {
        helpModal.classList.add('hidden');
    });
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal.classList.add('hidden');
    });

    settingsBtn.addEventListener('click', () => {
        if (typeof Multiplayer !== 'undefined' && Multiplayer.updateSettingsUI) {
            Multiplayer.updateSettingsUI();
        }
        settingsModal.classList.remove('hidden');
    });
    settingsClose.addEventListener('click', () => {
        settingsModal.classList.add('hidden');
    });
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) settingsModal.classList.add('hidden');
    });

    // 重新开始按钮
    restartBtn.addEventListener('click', () => {
        if (isMultiplayer && typeof Multiplayer !== 'undefined') {
            Multiplayer.leaveRoom();
            return;
        }
        restartGame();
        showMessage('新游戏已开始！', 1000);
    });
}

/** 绑定设置面板交互 */
function bindSettings() {
    // Dark Theme 切换
    toggleDark.addEventListener('change', () => {
        if (toggleDark.checked) {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('wordle-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('wordle-theme', 'light');
        }
    });

    // Hard Mode 切换（仅在游戏未开始或已结束时允许修改）
    toggleHard.addEventListener('change', () => {
        if (currentRow > 0 && !gameOver) {
            showMessage('游戏进行中不能修改 Hard Mode', 2000);
            toggleHard.checked = hardMode;
            return;
        }
        hardMode = toggleHard.checked;
        localStorage.setItem('wordle-hard-mode', hardMode ? 'true' : 'false');
    });

    // Custom Word
    customWordBtn.addEventListener('click', () => {
        startCustomWord();
    });
    customWordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            startCustomWord();
        }
    });

    // Word Length 选择（仅在游戏未开始或已结束时允许修改）
    if (wordLengthSelector) {
        wordLengthSelector.querySelectorAll('.word-length-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const len = parseInt(btn.dataset.length);
                if (len === wordLength) return;
                if (currentRow > 0 && !gameOver) {
                    showMessage('游戏进行中不能切换字母数量', 2000);
                    return;
                }
                if (!WORD_DATA[len]) {
                    showMessage(`${len} 字母词库未加载`, 2000);
                    return;
                }
                changeWordLength(len);
            });
        });
    }
}

/**
 * 启动 Custom Word 模式
 */
function startCustomWord() {
    const word = customWordInput.value.trim().toUpperCase();

    if (word.length !== wordLength) {
        showMessage(`请输入 ${wordLength} 个字母的单词`, 2000);
        return;
    }

    if (!/^[A-Z]+$/.test(word)) {
        showMessage('只能包含英文字母', 2000);
        return;
    }

    // 验证自定义单词是否在词库中
    if (!isValidWord(word)) {
        showMessage('该单词不在词库中，请换一个', 2000);
        return;
    }

    // 关闭设置弹窗
    settingsModal.classList.add('hidden');
    customWordInput.value = '';

    // 多人合作模式：发送自定义单词到服务器开始游戏
    if (isMultiplayer && typeof Multiplayer !== 'undefined' && Multiplayer.roomId && Multiplayer.mode === 'coop') {
        Multiplayer.startCustomWord(word);
        return;
    }

    // 单机模式：用自定义单词重新开始游戏
    restartGame(word);
    showMessage('Custom Word 模式已开始！', 1500);
}

/**
 * 加载保存的设置
 */
function loadSettings() {
    // 主题
    const savedTheme = localStorage.getItem('wordle-theme');
    if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        toggleDark.checked = true;
    }

    // Hard Mode
    const savedHard = localStorage.getItem('wordle-hard-mode');
    if (savedHard === 'true') {
        hardMode = true;
        toggleHard.checked = true;
    }

    // Word Length
    const savedLength = localStorage.getItem('wordle-word-length');
    if (savedLength && WORD_DATA[parseInt(savedLength)]) {
        const len = parseInt(savedLength);
        if (len !== wordLength) {
            changeWordLength(len);
        }
    }
}

// ===========================
// Solver 集成
// ===========================

/**
 * 绑定 Solver 面板交互
 */
function bindSolver() {
    // 切换 Solver 面板
    solverBtn.addEventListener('click', () => {
        const isHidden = solverPanel.classList.contains('hidden');
        if (isHidden) {
            solverPanel.classList.remove('hidden');
            solverBtn.classList.add('active');
            solverRemaining.textContent = solverPossibleWords.length;
        } else {
            solverPanel.classList.add('hidden');
            solverBtn.classList.remove('active');
        }
    });

    // 关闭 Solver
    solverClose.addEventListener('click', () => {
        solverPanel.classList.add('hidden');
        solverBtn.classList.remove('active');
    });
}

/**
 * 猜测后更新 Solver 的可能答案池
 */
function updateSolverAfterGuess(guess, evaluation) {
    const patternCode = WordleSolver.encodePattern(evaluation);
    solverPossibleWords = WordleSolver.filterWords(
        guess.toLowerCase(),
        patternCode,
        solverPossibleWords
    );

    // 更新 UI
    if (solverRemaining) {
        solverRemaining.textContent = solverPossibleWords.length;
    }

    // 清除旧的分析结果，自动重新分析
    solverResults.innerHTML = '';
    solverStatus.textContent = `剩余 ${solverPossibleWords.length} 个候选词 · 正在分析...`;
    runSolverAnalysis();
}

/**
 * 运行 Solver 分析
 */
async function runSolverAnalysis() {
    // 取消任何正在进行的分析
    const thisAnalysisId = ++solverAnalysisId;

    if (gameOver) {
        solverStatus.textContent = '游戏已结束';
        return;
    }

    if (solverPossibleWords.length === 0) {
        solverStatus.textContent = '没有匹配的候选词';
        return;
    }

    if (solverPossibleWords.length === 1) {
        solverStatus.textContent = '答案已确定！';
        renderSolverResults([{
            word: solverPossibleWords[0],
            entropy: 0,
            isAnswer: true
        }]);
        return;
    }

    // 开始分析
    solverIsAnalyzing = true;
    solverProgress.classList.remove('hidden');
    solverProgressFill.style.width = '0%';
    solverProgressText.textContent = '0%';
    solverStatus.textContent = `正在分析 ${solverPossibleWords.length} 个候选词...`;
    solverResults.innerHTML = '';

    try {
        // 构建 Hard Mode 过滤函数
        const hardModeFilter = (hardMode && revealedHints.length > 0)
            ? (word) => checkHardMode(word) === null
            : null;

        const results = await WordleSolver.getBestGuesses(
            solverPossibleWords,
            [...VALID_GUESSES],
            5,
            (progress) => {
                if (thisAnalysisId !== solverAnalysisId) return; // 已过期
                const pct = Math.round(progress * 100);
                solverProgressFill.style.width = pct + '%';
                solverProgressText.textContent = pct + '%';
            },
            hardModeFilter
        );

        // 检查此分析是否仍然有效
        if (thisAnalysisId !== solverAnalysisId) return;

        renderSolverResults(results);
        solverStatus.textContent = `分析完成 · 共 ${solverPossibleWords.length} 个候选词`;
    } catch (e) {
        if (thisAnalysisId === solverAnalysisId) {
            solverStatus.textContent = '分析出错: ' + e.message;
        }
    } finally {
        if (thisAnalysisId === solverAnalysisId) {
            solverIsAnalyzing = false;
            solverProgress.classList.add('hidden');
        }
    }
}

/**
 * 渲染 Solver 分析结果
 */
function renderSolverResults(results) {
    solverResults.innerHTML = '';

    results.forEach((item, index) => {
        const div = document.createElement('div');
        div.classList.add('solver-result-item');

        const wordSpan = document.createElement('span');
        wordSpan.classList.add('solver-result-word');
        wordSpan.textContent = item.word;

        const infoSpan = document.createElement('span');
        infoSpan.classList.add('solver-result-info');

        const entropySpan = document.createElement('span');
        entropySpan.classList.add('solver-result-entropy');
        entropySpan.textContent = item.entropy.toFixed(2) + ' bits';

        infoSpan.appendChild(entropySpan);

        if (item.isAnswer) {
            const badge = document.createElement('span');
            badge.classList.add('solver-result-badge');
            badge.textContent = '候选';
            infoSpan.appendChild(badge);
        }

        // 快捷填充按钮
        const fillBtn = document.createElement('button');
        fillBtn.classList.add('solver-fill-btn');
        fillBtn.textContent = '填入';
        fillBtn.title = '将此单词填入当前行';
        fillBtn.addEventListener('click', () => {
            fillWordFromSolver(item.word.toUpperCase());
        });
        infoSpan.appendChild(fillBtn);

        div.appendChild(wordSpan);
        div.appendChild(infoSpan);
        solverResults.appendChild(div);
    });
}

/**
 * 从 Solver 建议快捷填入单词到当前行
 */
function fillWordFromSolver(word) {
    if (gameOver || isRevealing) return;

    // 先清空当前行
    for (let c = 0; c < wordLength; c++) {
        const tile = getTile(currentRow, c);
        tile.textContent = '';
        tile.removeAttribute('data-state');
        boardState[currentRow][c] = '';
    }
    currentCol = 0;

    // 填入新单词
    for (let c = 0; c < wordLength; c++) {
        const tile = getTile(currentRow, c);
        tile.textContent = word[c];
        tile.setAttribute('data-state', 'tbd');
        boardState[currentRow][c] = word[c];
    }
    currentCol = wordLength;
}

// ===========================
// Statistics 统计
// ===========================

/**
 * 获取默认统计数据
 */
function getDefaultStats() {
    return {
        played: 0,
        won: 0,
        currentStreak: 0,
        maxStreak: 0,
        distribution: [0, 0, 0, 0, 0, 0]  // 1-6 次猜中的分布
    };
}

/**
 * 从 localStorage 加载统计数据
 * @param {boolean} [mp] - 是否加载多人模式统计
 */
function loadStats(mp) {
    const key = mp ? 'wordle-mp-stats' : 'wordle-stats';
    try {
        const saved = localStorage.getItem(key);
        if (saved) return JSON.parse(saved);
    } catch (e) {}
    return getDefaultStats();
}

/**
 * 保存统计数据到 localStorage
 * @param {object} stats
 * @param {boolean} [mp] - 是否保存多人模式统计
 */
function saveStats(stats, mp) {
    const key = mp ? 'wordle-mp-stats' : 'wordle-stats';
    localStorage.setItem(key, JSON.stringify(stats));
}

/**
 * 记录一局游戏结果
 * @param {boolean} won - 是否胜利
 * @param {number} guesses - 用了几次猜对（1-6），失败则为 0
 * @param {boolean} [mp] - 是否多人模式
 */
function recordGameResult(won, guesses, mp) {
    const stats = loadStats(mp);
    stats.played++;
    if (won) {
        stats.won++;
        stats.currentStreak++;
        if (stats.currentStreak > stats.maxStreak) {
            stats.maxStreak = stats.currentStreak;
        }
        if (guesses >= 1 && guesses <= 6) stats.distribution[guesses - 1]++;
    } else {
        stats.currentStreak = 0;
    }
    saveStats(stats, mp);
}

/**
 * 渲染统计面板
 * @param {number} [highlightRow] - 高亮的行号（0-based）
 */
function renderStats(highlightRow) {
    const stats = loadStats(isMultiplayer);
    const winPct = stats.played > 0 ? Math.round((stats.won / stats.played) * 100) : 0;

    statPlayed.textContent = stats.played;
    statWinPct.textContent = winPct;
    statCurrentStreak.textContent = stats.currentStreak;
    statMaxStreak.textContent = stats.maxStreak;

    // Guess Distribution
    guessDistribution.innerHTML = '';
    const maxCount = Math.max(...stats.distribution, 1);

    for (let i = 0; i < 6; i++) {
        const row = document.createElement('div');
        row.classList.add('guess-dist-row');

        const label = document.createElement('span');
        label.classList.add('guess-dist-label');
        label.textContent = i + 1;

        const bar = document.createElement('div');
        bar.classList.add('guess-dist-bar');
        const widthPct = Math.max((stats.distribution[i] / maxCount) * 100, 7);
        bar.style.width = widthPct + '%';
        bar.textContent = stats.distribution[i];

        if (highlightRow !== undefined && highlightRow === i) {
            bar.classList.add('highlight');
        }

        row.appendChild(label);
        row.appendChild(bar);
        guessDistribution.appendChild(row);
    }
}

/**
 * 显示统计面板
 */
function showStats(highlightRow) {
    renderStats(highlightRow);
    statsModal.classList.remove('hidden');
}

/**
 * 清除统计数据
 */
function clearStats() {
    localStorage.removeItem(isMultiplayer ? 'wordle-mp-stats' : 'wordle-stats');
    renderStats();
}

/**
 * 绑定统计面板交互
 */
function bindStats() {
    statsBtn.addEventListener('click', () => {
        renderStats();
        statsModal.classList.remove('hidden');
    });
    statsClose.addEventListener('click', () => {
        statsModal.classList.add('hidden');
    });
    statsModal.addEventListener('click', (e) => {
        if (e.target === statsModal) statsModal.classList.add('hidden');
    });
    statsClearBtn.addEventListener('click', () => {
        if (confirm('确定要清除所有统计数据吗？')) {
            clearStats();
        }
    });
}

// ===========================
// 截图分享功能
// ===========================

/**
 * 截取游戏区域（标题 + 棋盘 + 键盘）并复制到剪贴板
 * 只截取中间内容区域，不含左右空白，呈竖屏比例
 */
function takeScreenshot() {
    const header = document.getElementById('header');
    const game = document.getElementById('game');

    // 读取当前主题
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = isDark ? '#121213' : '#ffffff';
    const textColor = isDark ? '#ffffff' : '#000000';

    // 创建临时容器，组合 header + board + keyboard
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
        display: inline-block;
        background: ${bgColor};
        color: ${textColor};
        padding: 0 0 24px 0;
        width: 420px;
        box-sizing: border-box;
    `;

    // 克隆完整 header（保留所有按钮）
    const headerClone = header.cloneNode(true);
    headerClone.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid ${isDark ? '#3a3a3c' : '#d3d6da'};
        width: 100%;
        box-sizing: border-box;
    `;
    // 复制 header 内部元素样式
    copyHeaderStyles(header, headerClone, textColor);
    wrapper.appendChild(headerClone);

    // 克隆棋盘
    const boardContainer = document.getElementById('board-container');
    const boardClone = boardContainer.cloneNode(true);
    boardClone.style.cssText = 'display: flex; justify-content: center; margin: 16px auto 16px auto;';
    wrapper.appendChild(boardClone);

    // 克隆键盘
    const keyboard = document.getElementById('keyboard');
    const kbClone = keyboard.cloneNode(true);
    kbClone.style.cssText = 'margin: 0 auto; padding: 0 8px;';
    wrapper.appendChild(kbClone);

    // 把临时容器挂到 body（不可见位置）
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';
    document.body.appendChild(wrapper);

    // 确保克隆元素继承样式
    copyComputedStyles(boardContainer, boardClone);
    copyComputedStyles(keyboard, kbClone);

    // 使用 html2canvas 渲染
    html2canvas(wrapper, {
        backgroundColor: isDark ? '#121213' : '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false
    }).then(canvas => {
        // 移除临时容器
        document.body.removeChild(wrapper);

        // 转换为 Blob 并复制到剪贴板
        canvas.toBlob(blob => {
            if (!blob) {
                showMessage('截图失败', 2000);
                return;
            }

            // 尝试复制到剪贴板
            if (navigator.clipboard && navigator.clipboard.write) {
                const item = new ClipboardItem({ 'image/png': blob });
                navigator.clipboard.write([item]).then(() => {
                    showMessage('截图已复制到剪贴板！', 2000);
                }).catch(err => {
                    console.error('剪贴板写入失败:', err);
                    fallbackDownload(canvas);
                });
            } else {
                // 不支持剪贴板 API，直接下载
                fallbackDownload(canvas);
            }
        }, 'image/png');
    }).catch(err => {
        document.body.removeChild(wrapper);
        console.error('截图失败:', err);
        showMessage('截图失败', 2000);
    });
}

/**
 * 复制 header 内部元素的计算样式到克隆节点
 */
function copyHeaderStyles(source, target, textColor) {
    // 复制 h1 标题样式
    const srcH1 = source.querySelector('h1');
    const tgtH1 = target.querySelector('h1');
    if (srcH1 && tgtH1) {
        const cs = window.getComputedStyle(srcH1);
        tgtH1.style.fontFamily = cs.fontFamily;
        tgtH1.style.fontSize = cs.fontSize;
        tgtH1.style.fontWeight = cs.fontWeight;
        tgtH1.style.letterSpacing = cs.letterSpacing;
        tgtH1.style.textTransform = cs.textTransform;
        tgtH1.style.color = textColor;
        tgtH1.style.margin = '0';
        tgtH1.style.padding = '0';
    }

    // 复制各区域的 flex 布局
    ['header-left', 'header-center', 'header-right'].forEach(cls => {
        const srcDiv = source.querySelector('.' + cls);
        const tgtDiv = target.querySelector('.' + cls);
        if (srcDiv && tgtDiv) {
            const cs = window.getComputedStyle(srcDiv);
            tgtDiv.style.display = cs.display;
            tgtDiv.style.alignItems = cs.alignItems;
            tgtDiv.style.gap = cs.gap;
            tgtDiv.style.flex = cs.flex;
            if (cls === 'header-center') {
                tgtDiv.style.justifyContent = 'center';
            }
        }
    });

    // 复制按钮样式
    const srcBtns = source.querySelectorAll('.icon-btn');
    const tgtBtns = target.querySelectorAll('.icon-btn');
    srcBtns.forEach((sb, i) => {
        if (tgtBtns[i]) {
            const cs = window.getComputedStyle(sb);
            tgtBtns[i].style.background = 'none';
            tgtBtns[i].style.border = 'none';
            tgtBtns[i].style.color = textColor;
            tgtBtns[i].style.cursor = 'default';
            tgtBtns[i].style.padding = cs.padding;
            tgtBtns[i].style.width = cs.width;
            tgtBtns[i].style.height = cs.height;
            tgtBtns[i].style.display = 'flex';
            tgtBtns[i].style.alignItems = 'center';
            tgtBtns[i].style.justifyContent = 'center';
        }
    });

    // SVG 继承颜色
    target.querySelectorAll('svg').forEach(svg => {
        svg.style.stroke = textColor;
    });
}

/**
 * 递归复制关键计算样式到克隆节点
 */
function copyComputedStyles(source, target) {
    // 复制所有 tile 的背景色和文字颜色
    const sourceTiles = source.querySelectorAll('.tile');
    const targetTiles = target.querySelectorAll('.tile');
    sourceTiles.forEach((st, i) => {
        if (targetTiles[i]) {
            const cs = window.getComputedStyle(st);
            targetTiles[i].style.backgroundColor = cs.backgroundColor;
            targetTiles[i].style.color = cs.color;
            targetTiles[i].style.borderColor = cs.borderColor;
            targetTiles[i].style.width = cs.width;
            targetTiles[i].style.height = cs.height;
            targetTiles[i].style.fontSize = cs.fontSize;
            targetTiles[i].style.fontWeight = cs.fontWeight;
            targetTiles[i].style.display = 'flex';
            targetTiles[i].style.alignItems = 'center';
            targetTiles[i].style.justifyContent = 'center';
            targetTiles[i].style.border = `2px solid ${cs.borderColor}`;
            targetTiles[i].style.boxSizing = 'border-box';
            targetTiles[i].style.textTransform = 'uppercase';
            targetTiles[i].style.fontFamily = 'Arial, sans-serif';
        }
    });

    // 复制键盘按键样式
    const sourceKeys = source.querySelectorAll('.key');
    const targetKeys = target.querySelectorAll('.key');
    sourceKeys.forEach((sk, i) => {
        if (targetKeys[i]) {
            const cs = window.getComputedStyle(sk);
            targetKeys[i].style.backgroundColor = cs.backgroundColor;
            targetKeys[i].style.color = cs.color;
            targetKeys[i].style.borderRadius = cs.borderRadius;
            targetKeys[i].style.fontSize = cs.fontSize;
            targetKeys[i].style.fontWeight = cs.fontWeight;
            targetKeys[i].style.padding = cs.padding;
            targetKeys[i].style.minWidth = cs.minWidth;
            targetKeys[i].style.height = cs.height;
            targetKeys[i].style.border = 'none';
            targetKeys[i].style.fontFamily = 'Arial, sans-serif';
            targetKeys[i].style.cursor = 'default';
        }
    });

    // 复制 row 样式
    const sourceRows = source.querySelectorAll('.row, .keyboard-row');
    const targetRows = target.querySelectorAll('.row, .keyboard-row');
    sourceRows.forEach((sr, i) => {
        if (targetRows[i]) {
            const cs = window.getComputedStyle(sr);
            targetRows[i].style.display = cs.display;
            targetRows[i].style.gap = cs.gap;
            targetRows[i].style.gridTemplateColumns = cs.gridTemplateColumns;
            targetRows[i].style.justifyContent = cs.justifyContent || 'center';
            targetRows[i].style.marginBottom = cs.marginBottom || '4px';
        }
    });
}

/**
 * 降级方案：下载截图为 PNG 文件
 */
function fallbackDownload(canvas) {
    const link = document.createElement('a');
    link.download = `wordle-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showMessage('截图已下载！', 2000);
}

/**
 * 绑定截图按钮
 */
function bindScreenshot() {
    const screenshotBtn = document.getElementById('screenshot-btn');
    if (screenshotBtn) {
        screenshotBtn.addEventListener('click', () => {
            screenshotBtn.blur();
            takeScreenshot();
        });
    }
}

// ===========================
// 启动游戏
// ===========================
initGame();
