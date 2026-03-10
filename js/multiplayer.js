/**
 * Multiplayer 模块 — 多人游戏客户端逻辑
 * 管理 Socket.IO 连接、房间 UI、对手面板
 */
const Multiplayer = (function () {

    // ─── 状态 ─────────────────────────────────────
    let socket = null;
    let currentRoomId = null;
    let myNickname = '';
    let roomWordLength = 5;
    let opponents = {};       // socketId -> { nickname, boardEl }

    // ─── DOM ──────────────────────────────────────
    const roomModal       = document.getElementById('room-modal');
    const roomClose       = document.getElementById('room-close');
    const nicknameInput   = document.getElementById('room-nickname');
    const roomCreateBtn   = document.getElementById('room-create-btn');
    const roomJoinBtn     = document.getElementById('room-join-btn');
    const roomCodeInput   = document.getElementById('room-code-input');
    const roomInfo        = document.getElementById('room-info');
    const roomCodeDisplay = document.getElementById('room-code-display');
    const roomPlayerCount = document.getElementById('room-player-count');
    const roomLeaveBtn    = document.getElementById('room-leave-btn');
    const multiplayerBtn  = document.getElementById('multiplayer-btn');
    const opponentsContainer = document.getElementById('opponents-container');

    // 房间弹窗中的字母长度选择
    const roomWordLengthBtns = document.querySelectorAll('#room-word-length .word-length-btn');
    let selectedWordLength = 5;

    // ─── 初始化 ────────────────────────────────────
    function init() {
        // 从 localStorage 恢复昵称
        const savedNick = localStorage.getItem('wordle-nickname');
        if (savedNick) nicknameInput.value = savedNick;

        bindUI();
    }

    function bindUI() {
        // 打开房间弹窗（按钮现在在设置面板中）
        multiplayerBtn.addEventListener('click', () => {
            if (currentRoomId) {
                // 已在房间中，弹出确认
                if (confirm('你已在房间中，是否退出当前房间？')) {
                    leaveRoom();
                }
                return;
            }
            // 关闭设置弹窗，打开房间弹窗
            const settingsModal = document.getElementById('settings-modal');
            if (settingsModal) settingsModal.classList.add('hidden');
            syncWordLengthUI();
            roomModal.classList.remove('hidden');
        });

        // 关闭弹窗
        roomClose.addEventListener('click', () => roomModal.classList.add('hidden'));
        roomModal.addEventListener('click', (e) => {
            if (e.target === roomModal) roomModal.classList.add('hidden');
        });

        // 字母长度选择
        roomWordLengthBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                roomWordLengthBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedWordLength = parseInt(btn.dataset.length);
            });
        });

        // 打开房间弹窗时同步当前字母长度选择器
        function syncWordLengthUI() {
            selectedWordLength = wordLength;
            roomWordLengthBtns.forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.length) === wordLength);
            });
        }

        // 创建房间
        roomCreateBtn.addEventListener('click', () => {
            const nick = getNickname();
            if (!nick) return;
            ensureConnected();
            socket.emit('create-room', { nickname: nick, wordLength: selectedWordLength });
        });

        // 加入房间
        roomJoinBtn.addEventListener('click', () => {
            const nick = getNickname();
            if (!nick) return;
            const code = roomCodeInput.value.trim().toUpperCase();
            if (!code || code.length !== 6) {
                showMessage('请输入 6 位房间码');
                return;
            }
            ensureConnected();
            socket.emit('join-room', { roomId: code, nickname: nick });
        });

        // 退出房间
        roomLeaveBtn.addEventListener('click', leaveRoom);
    }

    function getNickname() {
        const nick = nicknameInput.value.trim();
        if (!nick) {
            showMessage('请输入昵称');
            nicknameInput.focus();
            return null;
        }
        localStorage.setItem('wordle-nickname', nick);
        myNickname = nick;
        return nick;
    }

    // ─── Socket.IO 连接 ───────────────────────────
    function ensureConnected() {
        if (socket && socket.connected) return;

        socket = io({
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });

        socket.on('connect', () => {
            console.log('[MP] 已连接:', socket.id);
            // 如果之前在房间中，尝试重连
            if (currentRoomId && myNickname) {
                console.log('[MP] 尝试重连房间:', currentRoomId);
                socket.emit('rejoin-room', {
                    roomId: currentRoomId,
                    nickname: myNickname
                });
            }
        });

        socket.on('disconnect', () => {
            console.log('[MP] 连接断开');
            if (currentRoomId) {
                showMessage('连接断开，正在重连...', 3000);
            }
        });

        socket.on('reconnect_failed', () => {
            if (currentRoomId) {
                showMessage('重连失败，已退出房间', 3000);
                resetToSinglePlayer();
            }
        });

        // ── 房间事件 ──
        socket.on('room-created', onRoomCreated);
        socket.on('room-joined', onRoomJoined);
        socket.on('room-rejoined', onRoomRejoined);
        socket.on('rejoin-failed', onRejoinFailed);
        socket.on('room-error', onRoomError);
        socket.on('player-joined', onPlayerJoined);
        socket.on('player-left', onPlayerLeft);
        socket.on('player-disconnected', onPlayerDisconnected);
        socket.on('player-reconnected', onPlayerReconnected);

        // ── 游戏事件 ──
        socket.on('box-updated', onBoxUpdated);
        socket.on('guess-result', onGuessResult);
        socket.on('player-guess', onPlayerGuess);
    }

    // ─── 房间事件处理 ─────────────────────────────

    function onRoomCreated({ roomId, state }) {
        enterRoom(roomId, state);
        showMessage(`房间已创建: ${roomId}`, 3000);
    }

    function onRoomJoined({ roomId, state }) {
        enterRoom(roomId, state);
        showMessage(`已加入房间 ${roomId}`, 2000);
    }

    function onRoomError({ message }) {
        // 如果提交猜测时发生错误，解锁输入
        isRevealing = false;
        showMessage(message || '房间操作失败', 3000);
    }

    function onPlayerJoined({ socketId, nickname }) {
        showMessage(`${nickname} 加入了房间`, 2000);
        addOpponent(socketId, nickname);
        updatePlayerCount();
    }

    function onPlayerLeft({ socketId, nickname }) {
        showMessage(`${nickname} 离开了房间`, 2000);
        removeOpponent(socketId);
        updatePlayerCount();
    }

    function onPlayerDisconnected({ socketId, nickname }) {
        showMessage(`${nickname} 断线了`, 2000);
        const opp = opponents[socketId];
        if (opp) {
            opp.statusEl.textContent = '断线';
            opp.statusEl.style.color = 'orange';
        }
    }

    function onPlayerReconnected({ socketId, oldSocketId, nickname }) {
        showMessage(`${nickname} 重连了`, 2000);
        // 将旧 socketId 的对手数据迁移到新 socketId
        if (oldSocketId && opponents[oldSocketId]) {
            const opp = opponents[oldSocketId];
            opp.card.id = 'opp-' + socketId;
            opp.statusEl.textContent = '进行中';
            opp.statusEl.style.color = '';
            opp.statusEl.classList.remove('won', 'lost');
            opponents[socketId] = opp;
            delete opponents[oldSocketId];
        }
    }

    function onRoomRejoined({ roomId, state, myHistory }) {
        showMessage('已重连到房间', 2000);

        // 重建房间状态
        currentRoomId = roomId;
        roomWordLength = state.wordLength;
        isMultiplayer = true;

        // 切换字母长度
        if (wordLength !== roomWordLength) {
            changeWordLength(roomWordLength);
        } else {
            // 重置棋盘但不获取新答案（多人模式无本地答案）
            resetGameState();
            createBoard();
            resetKeyboard();
        }
        targetWord = '';

        // 恢复自己的棋盘
        if (myHistory && myHistory.length > 0) {
            for (let r = 0; r < myHistory.length; r++) {
                const { guess, evaluation } = myHistory[r];
                for (let c = 0; c < roomWordLength; c++) {
                    const tile = getTile(r, c);
                    tile.textContent = guess[c];
                    tile.setAttribute('data-state', evaluation[c]);
                    boardState[r][c] = guess[c];
                }
                // 更新键盘颜色
                updateKeyboard(guess, evaluation);
            }
            currentRow = myHistory.length;
            currentCol = 0;

            // 检查游戏是否已结束
            const lastEval = myHistory[myHistory.length - 1].evaluation;
            if (lastEval.every(e => e === 'correct')) {
                gameOver = true;
            } else if (myHistory.length >= 6) {
                gameOver = true;
            }
        }

        // 显示房间 UI
        roomCodeDisplay.textContent = roomId;
        roomInfo.classList.remove('hidden');
        opponentsContainer.classList.remove('hidden');
        opponentsContainer.innerHTML = '';
        opponents = {};

        // 重建对手面板
        for (const [sid, player] of Object.entries(state.players)) {
            if (sid !== socket.id) {
                addOpponent(sid, player.nickname);
                if (state.history && state.history[sid]) {
                    state.history[sid].forEach(({ guess, evaluation }) => {
                        applyOpponentGuess(sid, guess, evaluation);
                    });
                }
                if (player.gameOver) {
                    const opp = opponents[sid];
                    if (opp) {
                        opp.statusEl.textContent = player.won ? '✓ 猜对了' : '✗ 失败';
                        opp.statusEl.classList.add(player.won ? 'won' : 'lost');
                    }
                }
            }
        }
        updatePlayerCount();
    }

    function onRejoinFailed({ message }) {
        showMessage(message || '重连失败', 3000);
        resetToSinglePlayer();
    }

    function resetToSinglePlayer() {
        currentRoomId = null;
        isMultiplayer = false;
        roomInfo.classList.add('hidden');
        opponentsContainer.classList.add('hidden');
        opponentsContainer.innerHTML = '';
        opponents = {};
        restartGame();
    }

    // ─── 进入 / 离开房间 ──────────────────────────

    function enterRoom(roomId, state) {
        currentRoomId = roomId;
        roomWordLength = state.wordLength;
        isMultiplayer = true;

        // 关闭弹窗
        roomModal.classList.add('hidden');

        // 切换字母长度 & 重启游戏
        if (wordLength !== roomWordLength) {
            changeWordLength(roomWordLength);
        } else {
            restartGame();
        }

        // 在多人模式下不需要本地答案（由服务器持有）
        targetWord = '';

        // 显示房间信息栏
        roomCodeDisplay.textContent = roomId;
        roomInfo.classList.remove('hidden');

        // 显示对手面板
        opponentsContainer.classList.remove('hidden');
        opponentsContainer.innerHTML = '';
        opponents = {};

        // 添加已有的其他玩家
        for (const [sid, player] of Object.entries(state.players)) {
            if (sid !== socket.id) {
                addOpponent(sid, player.nickname);
                // 恢复已有历史
                if (state.history && state.history[sid]) {
                    state.history[sid].forEach(({ guess, evaluation }) => {
                        applyOpponentGuess(sid, guess, evaluation);
                    });
                }
            }
        }

        updatePlayerCount();
    }

    function leaveRoom() {
        if (!currentRoomId) return;

        if (socket && socket.connected) {
            socket.emit('leave-room', { roomId: currentRoomId });
        }

        currentRoomId = null;
        isMultiplayer = false;

        // 隐藏房间信息和对手面板
        roomInfo.classList.add('hidden');
        opponentsContainer.classList.add('hidden');
        opponentsContainer.innerHTML = '';
        opponents = {};

        // 恢复单人模式
        restartGame();
        showMessage('已退出房间', 2000);
    }

    // ─── 对手面板 ─────────────────────────────────

    function addOpponent(socketId, nickname) {
        if (opponents[socketId]) return;

        const card = document.createElement('div');
        card.classList.add('opponent-card');
        card.id = 'opp-' + socketId;

        const nameEl = document.createElement('div');
        nameEl.classList.add('opponent-nickname');
        nameEl.textContent = nickname;
        card.appendChild(nameEl);

        const boardEl = document.createElement('div');
        boardEl.classList.add('opponent-board');
        // 创建 6 行 x N 列迷你棋盘
        for (let r = 0; r < MAX_GUESSES; r++) {
            const row = document.createElement('div');
            row.classList.add('opponent-row');
            row.style.gridTemplateColumns = `repeat(${roomWordLength}, 1fr)`;
            for (let c = 0; c < roomWordLength; c++) {
                const tile = document.createElement('div');
                tile.classList.add('opponent-tile');
                row.appendChild(tile);
            }
            boardEl.appendChild(row);
        }
        card.appendChild(boardEl);

        const statusEl = document.createElement('div');
        statusEl.classList.add('opponent-status');
        statusEl.textContent = '进行中';
        card.appendChild(statusEl);

        opponentsContainer.appendChild(card);
        opponents[socketId] = { nickname, card, boardEl, statusEl, currentRow: 0 };
    }

    function removeOpponent(socketId) {
        const opp = opponents[socketId];
        if (!opp) return;
        opp.card.remove();
        delete opponents[socketId];
    }

    function updatePlayerCount() {
        const count = Object.keys(opponents).length + 1; // +1 for self
        roomPlayerCount.textContent = `${count}/8`;
    }

    // ─── 对手棋盘更新 ────────────────────────────

    /** 对手候选框更新（实时输入广播） */
    function onBoxUpdated({ socketId, row, candidateRow }) {
        const opp = opponents[socketId];
        if (!opp) return;

        const rowEl = opp.boardEl.children[row];
        if (!rowEl) return;

        for (let c = 0; c < roomWordLength; c++) {
            const tile = rowEl.children[c];
            if (!tile) continue;
            if (candidateRow[c]) {
                tile.setAttribute('data-state', 'tbd');
            } else {
                tile.removeAttribute('data-state');
            }
        }
    }

    /** 对手提交猜测后的结果 */
    function onPlayerGuess({ socketId, guess, evaluation, row, won, gameOver: go }) {
        applyOpponentGuess(socketId, guess, evaluation);
        const opp = opponents[socketId];
        if (!opp) return;

        if (won) {
            opp.statusEl.textContent = '✓ 猜对了';
            opp.statusEl.classList.add('won');
        } else if (go) {
            opp.statusEl.textContent = '✗ 失败';
            opp.statusEl.classList.add('lost');
        }
    }

    function applyOpponentGuess(socketId, guess, evaluation) {
        const opp = opponents[socketId];
        if (!opp) return;

        const rowEl = opp.boardEl.children[opp.currentRow];
        if (!rowEl) return;

        for (let c = 0; c < roomWordLength; c++) {
            const tile = rowEl.children[c];
            if (!tile) continue;
            tile.textContent = guess[c];
            tile.setAttribute('data-state', evaluation[c]);
        }

        opp.currentRow++;
    }

    // ─── 自己的游戏事件 ──────────────────────────

    /** 服务器返回自己的猜测结果 */
    function onGuessResult({ evaluation, won, gameOver: go, answer }) {
        // 调用 game.js 的 applyGuessResult
        applyGuessResult(
            boardState[currentRow].join(''),
            evaluation,
            won,
            go && !won ? answer : undefined
        );
    }

    // ─── 公开 API ─────────────────────────────────

    /** 广播当前候选框状态 */
    function broadcastBox() {
        if (!socket || !currentRoomId) return;
        socket.emit('update-box', {
            roomId: currentRoomId,
            row: currentRow,
            candidateRow: boardState[currentRow]
        });
    }

    /** 提交猜测到服务器 */
    function submitGuess(guess) {
        if (!socket || !currentRoomId) return;
        socket.emit('submit-guess', {
            roomId: currentRoomId,
            guess: guess
        });
    }

    // ─── 启动 ─────────────────────────────────────
    init();

    return {
        broadcastBox,
        submitGuess,
        leaveRoom,
        get roomId() { return currentRoomId; },
        get connected() { return socket && socket.connected; }
    };

})();
