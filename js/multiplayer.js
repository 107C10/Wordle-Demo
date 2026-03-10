/**
 * Multiplayer 模块 — 多人游戏客户端逻辑
 * 支持 versus（对抗）和 coop（合作）两种模式
 * 角色：选手（player）和观众（spectator）
 * 选手席最多 4 人，观众席无上限
 */
const Multiplayer = (function () {

    // ─── 状态 ─────────────────────────────────────
    let socket = null;
    let currentRoomId = null;
    let myNickname = '';
    let roomWordLength = 5;
    let roomMode = 'versus';        // 'versus' | 'coop'
    let myRole = 'player';          // 'player' | 'spectator'
    let roomGameStarted = false;
    let myHostId = null;            // 当前房主的 socketId
    let lastSeatCount = 0;          // 最近一次席位数
    let lastMaxSeats = 4;           // 最大席位数
    let opponents = {};             // socketId -> { nickname, card, boardEl, statusEl, currentRow }
    let spectatorTarget = null;     // 观众当前查看的选手 socketId
    let playerHistories = {};       // socketId -> { nickname, guesses: [{guess, evaluation}] }

    // ─── DOM 引用 ─────────────────────────────────
    const roomModal         = document.getElementById('room-modal');
    const roomClose         = document.getElementById('room-close');
    const nicknameInput     = document.getElementById('room-nickname');
    const roomCreateBtn     = document.getElementById('room-create-btn');
    const roomJoinBtn       = document.getElementById('room-join-btn');
    const roomCodeInput     = document.getElementById('room-code-input');
    const roomInfo          = document.getElementById('room-info');
    const roomCodeDisplay   = document.getElementById('room-code-display');
    const roomCopyBtn       = document.getElementById('room-copy-btn');
    const roomPlayerCount   = document.getElementById('room-player-count');
    const roomModeDisplay   = document.getElementById('room-mode-display');
    const roomRoleDisplay   = document.getElementById('room-role-display');
    const roomLeaveBtn      = document.getElementById('room-leave-btn');
    const roomStartBtn      = document.getElementById('room-start-btn');
    const multiplayerBtn    = document.getElementById('multiplayer-btn');
    const opponentsContainer = document.getElementById('opponents-container');
    const modeSelector      = document.getElementById('room-mode-selector');
    const waitingMessage    = document.getElementById('waiting-message');
    const spectatorBar      = document.getElementById('spectator-bar');
    const spectatorViewName = document.getElementById('spectator-view-name');

    // Play Again overlay
    const playAgainOverlay         = document.getElementById('play-again-overlay');
    const playAgainBtn             = document.getElementById('play-again-btn');
    const playAgainLeaveBtn        = document.getElementById('play-again-leave-btn');
    const playAgainStatus          = document.getElementById('play-again-status');
    const playAgainPlayerActions   = document.getElementById('play-again-player-actions');
    const playAgainSpectatorActions= document.getElementById('play-again-spectator-actions');
    const playAgainJoinSeatBtn     = document.getElementById('play-again-join-seat-btn');
    const playAgainSpectatorLeaveBtn = document.getElementById('play-again-spectator-leave-btn');

    // 房间弹窗中的字母长度选择
    const roomWordLengthBtns = document.querySelectorAll('#room-word-length .word-length-btn');
    let selectedWordLength = 5;

    // ─── 初始化 ────────────────────────────────────
    function init() {
        const savedNick = localStorage.getItem('wordle-nickname');
        if (savedNick) nicknameInput.value = savedNick;
        bindUI();
    }

    function bindUI() {
        // 打开房间弹窗
        multiplayerBtn.addEventListener('click', () => {
            if (currentRoomId) {
                if (confirm('你已在房间中，是否退出当前房间？')) {
                    leaveRoom();
                }
                return;
            }
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

        function syncWordLengthUI() {
            selectedWordLength = wordLength;
            roomWordLengthBtns.forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.length) === wordLength);
            });
        }

        // 模式选择器
        if (modeSelector) {
            modeSelector.querySelectorAll('.mode-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    modeSelector.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });
        }

        // 创建房间
        roomCreateBtn.addEventListener('click', () => {
            const nick = getNickname();
            if (!nick) return;
            const mode = getSelectedMode();
            ensureConnected();
            socket.emit('create-room', { nickname: nick, wordLength: selectedWordLength, mode });
        });

        // 加入房间
        roomJoinBtn.addEventListener('click', () => {
            const nick = getNickname();
            if (!nick) return;
            const code = roomCodeInput.value.trim();
            if (!code || code.length !== 4) {
                showMessage('请输入 4 位房间码');
                return;
            }
            ensureConnected();
            socket.emit('join-room', { roomId: code, nickname: nick });
        });

        // 退出房间
        roomLeaveBtn.addEventListener('click', leaveRoom);

        // 复制房间码
        if (roomCopyBtn) {
            roomCopyBtn.addEventListener('click', () => {
                if (!currentRoomId) return;
                navigator.clipboard.writeText(currentRoomId).then(() => {
                    showMessage('房间码已复制！', 1500);
                }).catch(() => {
                    const ta = document.createElement('textarea');
                    ta.value = currentRoomId;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    showMessage('房间码已复制！', 1500);
                });
            });
        }

        // 房主开始游戏
        if (roomStartBtn) {
            roomStartBtn.addEventListener('click', () => {
                if (!currentRoomId || !socket) return;
                socket.emit('start-game', { roomId: currentRoomId });
            });
        }

        // Play Again 按钮（选手投票再来一局）
        if (playAgainBtn) {
            playAgainBtn.addEventListener('click', () => {
                if (!currentRoomId || !socket) return;
                socket.emit('vote-play-again', { roomId: currentRoomId });
                playAgainBtn.disabled = true;
                playAgainBtn.textContent = '已投票';
            });
        }

        // Play Again 退出房间（选手）
        if (playAgainLeaveBtn) {
            playAgainLeaveBtn.addEventListener('click', () => {
                leaveRoom();
            });
        }

        // 观众加入选手席
        if (playAgainJoinSeatBtn) {
            playAgainJoinSeatBtn.addEventListener('click', () => {
                if (!currentRoomId || !socket) return;
                socket.emit('join-seat', { roomId: currentRoomId });
            });
        }

        // 观众退出房间
        if (playAgainSpectatorLeaveBtn) {
            playAgainSpectatorLeaveBtn.addEventListener('click', () => {
                leaveRoom();
            });
        }
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

    function getSelectedMode() {
        if (!modeSelector) return 'versus';
        const active = modeSelector.querySelector('.mode-btn.active');
        return active ? active.dataset.mode : 'versus';
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
        socket.on('game-started', onGameStarted);
        socket.on('role-changed', onRoleChanged);
        socket.on('spectator-to-player', onSpectatorToPlayer);

        // ── 游戏事件 ──
        socket.on('box-updated', onBoxUpdated);
        socket.on('guess-result', onGuessResult);
        socket.on('player-guess', onPlayerGuess);
        socket.on('spectator-guess', onSpectatorGuess);
        socket.on('coop-guess', onCoopGuess);
        socket.on('round-over', onRoundOver);
        socket.on('play-again-vote', onPlayAgainVote);
        socket.on('new-round', onNewRound);
    }

    // ─── 房间事件处理 ─────────────────────────────

    function onRoomCreated({ roomId, state, role }) {
        myRole = role || 'player';
        enterRoom(roomId, state);
        showMessage(`房间已创建: ${roomId}`, 3000);
    }

    function onRoomJoined({ roomId, state, role }) {
        myRole = role || 'player';
        enterRoom(roomId, state);
        const roleText = myRole === 'spectator' ? '（观众）' : '';
        showMessage(`已加入房间 ${roomId} ${roleText}`, 2000);
    }

    function onRoomError({ message }) {
        isRevealing = false;
        showMessage(message || '房间操作失败', 3000);
    }

    function onPlayerJoined({ socketId, nickname, role }) {
        const roleText = role === 'spectator' ? '（观众）' : '';
        showMessage(`${nickname} 加入了房间${roleText}`, 2000);

        if (role === 'player') {
            addOpponent(socketId, nickname);
        }
        // 观众不在 opponents 面板显示（但计入总数）
        updatePlayerCount();
        updateStartButton();
    }

    function onPlayerLeft({ socketId, nickname, newHostId, wasPlayer }) {
        showMessage(`${nickname} 离开了房间`, 2000);
        if (wasPlayer !== false) {
            removeOpponent(socketId);
        }
        // 更新房主
        if (newHostId) {
            myHostId = newHostId;
        }
        updatePlayerCount();
        updateStartButton();
    }

    function onPlayerDisconnected({ socketId, nickname, role }) {
        showMessage(`${nickname} 断线了`, 2000);
        if (role === 'player') {
            const opp = opponents[socketId];
            if (opp && opp.statusEl) {
                opp.statusEl.textContent = '断线';
                opp.statusEl.style.color = 'orange';
            }
        }
    }

    function onPlayerReconnected({ socketId, oldSocketId, nickname, role }) {
        showMessage(`${nickname} 重连了`, 2000);
        if (role === 'player' && oldSocketId && opponents[oldSocketId]) {
            const opp = opponents[oldSocketId];
            opp.card.id = 'opp-' + socketId;
            opp.statusEl.textContent = '进行中';
            opp.statusEl.style.color = '';
            opp.statusEl.classList.remove('won', 'lost');
            opponents[socketId] = opp;
            delete opponents[oldSocketId];

            // 更新 spectator tracking
            if (playerHistories[oldSocketId]) {
                playerHistories[socketId] = playerHistories[oldSocketId];
                delete playerHistories[oldSocketId];
            }
            if (spectatorTarget === oldSocketId) {
                spectatorTarget = socketId;
            }
        }
    }

    function onGameStarted({ state }) {
        roomGameStarted = true;
        hideWaitingMessage();
        hideStartButton();
        showMessage('游戏开始！', 2000);
    }

    function onRoleChanged({ role, state }) {
        myRole = role;
        if (role === 'player') {
            // 从观众变成选手
            document.body.classList.remove('spectator-mode');
            hideSpectatorBar();
            spectatorTarget = null;

            // 重置游戏
            resetGameState();
            createBoard();
            resetKeyboard();
            targetWord = '';
            gameOver = false;

            // 重建对手面板
            rebuildOpponents(state);
            updateRoleDisplay();
            showMessage('你已成为选手！', 2000);
        }
        updatePlayerCount();
    }

    function onSpectatorToPlayer({ socketId, nickname }) {
        // 某个观众变成了选手 → 给他建面板
        addOpponent(socketId, nickname);
        updatePlayerCount();
    }

    function onRoomRejoined({ roomId, state, myHistory, role }) {
        showMessage('已重连到房间', 2000);

        currentRoomId = roomId;
        roomWordLength = state.wordLength;
        roomMode = state.mode || 'versus';
        roomGameStarted = state.gameStarted;
        myRole = role || 'player';
        isMultiplayer = true;

        if (wordLength !== roomWordLength) {
            changeWordLength(roomWordLength);
        } else {
            resetGameState();
            createBoard();
            resetKeyboard();
        }
        targetWord = '';

        if (myRole === 'player') {
            // 选手：恢复自己的棋盘
            if (roomMode === 'coop') {
                if (state.coopHistory && state.coopHistory.length > 0) {
                    for (let r = 0; r < state.coopHistory.length; r++) {
                        const { guess, evaluation, nickname: guesser } = state.coopHistory[r];
                        applyCoopRow(r, guess, evaluation, guesser);
                    }
                    currentRow = state.coopHistory.length;
                    currentCol = 0;
                }
            } else {
                if (myHistory && myHistory.length > 0) {
                    for (let r = 0; r < myHistory.length; r++) {
                        const { guess, evaluation } = myHistory[r];
                        for (let c = 0; c < roomWordLength; c++) {
                            const tile = getTile(r, c);
                            tile.textContent = guess[c];
                            tile.setAttribute('data-state', evaluation[c]);
                            boardState[r][c] = guess[c];
                        }
                        updateKeyboard(guess, evaluation);
                    }
                    currentRow = myHistory.length;
                    currentCol = 0;

                    const lastEval = myHistory[myHistory.length - 1].evaluation;
                    if (lastEval.every(e => e === 'correct') || myHistory.length >= 6) {
                        gameOver = true;
                    }
                }
            }
        } else {
            // 观众：恢复观战视角
            setupSpectatorMode(state);
        }

        // 显示房间 UI
        setHostState(state);
        showRoomUI(roomId, state);

        // 重建对手面板
        rebuildOpponents(state);

        // 如果没开始，显示等待界面
        if (!roomGameStarted) {
            showWaitingMessage();
        }

        // 如果本轮已结束，显示 play again
        if (state.roundOver) {
            showPlayAgainUI(state.roundAnswer);
        }
    }

    function onRejoinFailed({ message }) {
        showMessage(message || '重连失败', 3000);
        resetToSinglePlayer();
    }

    function resetToSinglePlayer() {
        currentRoomId = null;
        roomMode = 'versus';
        myRole = 'player';
        roomGameStarted = false;
        myHostId = null;
        isMultiplayer = false;
        spectatorTarget = null;
        playerHistories = {};

        roomInfo.classList.add('hidden');
        opponentsContainer.classList.add('hidden');
        opponentsContainer.innerHTML = '';
        opponents = {};
        hidePlayAgainUI();
        hideWaitingMessage();
        hideSpectatorBar();
        hideStartButton();
        document.body.classList.remove('multiplayer-active', 'spectator-mode');
        restartGame();
    }

    // ─── 进入 / 离开房间 ──────────────────────────

    function enterRoom(roomId, state) {
        currentRoomId = roomId;
        roomWordLength = state.wordLength;
        roomMode = state.mode || 'versus';
        roomGameStarted = state.gameStarted;
        isMultiplayer = true;

        roomModal.classList.add('hidden');

        if (wordLength !== roomWordLength) {
            changeWordLength(roomWordLength);
        } else {
            restartGame();
        }
        targetWord = '';

        setHostState(state);
        showRoomUI(roomId, state);

        // 对手面板
        opponentsContainer.classList.remove('hidden');
        rebuildOpponents(state);

        document.body.classList.add('multiplayer-active');

        if (myRole === 'spectator') {
            setupSpectatorMode(state);
        }

        // 游戏尚未开始 → 显示等待
        if (!roomGameStarted) {
            showWaitingMessage();
        }
    }

    function rebuildOpponents(state) {
        opponentsContainer.innerHTML = '';
        opponents = {};
        playerHistories = {};

        for (const [sid, player] of Object.entries(state.players)) {
            // 选手：其他选手是对手面板；观众：所有选手都是面板
            if (myRole === 'player' && sid === socket.id) continue;

            addOpponent(sid, player.nickname);

            // 恢复对手历史
            if (state.history && state.history[sid]) {
                playerHistories[sid] = {
                    nickname: player.nickname,
                    guesses: state.history[sid]
                };
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
            if (player.disconnected) {
                const opp = opponents[sid];
                if (opp && opp.statusEl) {
                    opp.statusEl.textContent = '断线';
                    opp.statusEl.style.color = 'orange';
                }
            }
        }

        updatePlayerCount();
    }

    function showRoomUI(roomId, state) {
        roomCodeDisplay.textContent = roomId;
        if (roomModeDisplay) {
            roomModeDisplay.textContent = (state.mode || roomMode) === 'coop' ? '合作' : '对抗';
        }
        updateRoleDisplay();
        updateStartButton();
        roomInfo.classList.remove('hidden');
    }

    function updateRoleDisplay() {
        if (roomRoleDisplay) {
            roomRoleDisplay.textContent = myRole === 'spectator' ? '观众' : '选手';
        }
    }

    function updateStartButton() {
        if (!roomStartBtn) return;
        if (!currentRoomId || !socket) {
            roomStartBtn.classList.add('hidden');
            return;
        }
        // 仅房主、游戏未开始时显示
        const room = null; // 我们无法直接访问 room，用 state 判断
        if (!roomGameStarted && isHost()) {
            roomStartBtn.classList.remove('hidden');
            // 按钮禁用状态由选手人数控制
            const playerCount = Object.keys(opponents).length + (myRole === 'player' ? 1 : 0);
            roomStartBtn.disabled = playerCount < 2;
        } else {
            roomStartBtn.classList.add('hidden');
        }
    }

    function isHost() {
        return socket && myHostId === socket.id;
    }

    function setHostState(state) {
        if (state && state.hostId) {
            myHostId = state.hostId;
        }
    }

    function leaveRoom() {
        if (!currentRoomId) return;

        if (socket && socket.connected) {
            socket.emit('leave-room', { roomId: currentRoomId });
        }

        resetToSinglePlayer();
        showMessage('已退出房间', 2000);
    }

    // ─── 等待/开始 UI ─────────────────────────────

    function showWaitingMessage() {
        if (!waitingMessage) return;
        if (isHost()) {
            waitingMessage.textContent = '等待更多选手加入后点击"开始游戏"';
        } else if (myRole === 'spectator') {
            waitingMessage.textContent = '等待房主开始游戏... (观战模式)';
        } else {
            waitingMessage.textContent = '等待房主开始游戏...';
        }
        waitingMessage.classList.remove('hidden');
    }

    function hideWaitingMessage() {
        if (waitingMessage) waitingMessage.classList.add('hidden');
    }

    function hideStartButton() {
        if (roomStartBtn) roomStartBtn.classList.add('hidden');
    }

    // ─── 观众模式 ─────────────────────────────────

    function setupSpectatorMode(state) {
        document.body.classList.add('spectator-mode');
        showSpectatorBar();

        // 选择第一个选手作为默认视角
        const playerIds = Object.keys(state.players);
        if (playerIds.length > 0) {
            spectatorTarget = playerIds[0];
            spectatorSwitchView(spectatorTarget, state);
        }
    }

    function showSpectatorBar() {
        if (spectatorBar) spectatorBar.classList.remove('hidden');
    }

    function hideSpectatorBar() {
        if (spectatorBar) spectatorBar.classList.add('hidden');
    }

    function spectatorSwitchView(targetId, state) {
        spectatorTarget = targetId;

        // 高亮选中的面板
        for (const [sid, opp] of Object.entries(opponents)) {
            opp.card.classList.toggle('spectator-selected', sid === targetId);
        }

        // 更新观众视角名称
        const targetName = opponents[targetId] ? opponents[targetId].nickname : '未知';
        if (spectatorViewName) {
            spectatorViewName.textContent = targetName;
        }

        // 清空并重绘主棋盘
        resetGameState();
        createBoard();
        resetKeyboard();
        gameOver = false;

        // 从 playerHistories 或 state.history 恢复
        const hist = playerHistories[targetId];
        if (hist && hist.guesses) {
            for (let r = 0; r < hist.guesses.length; r++) {
                const { guess, evaluation } = hist.guesses[r];
                for (let c = 0; c < roomWordLength; c++) {
                    const tile = getTile(r, c);
                    tile.textContent = guess[c];
                    tile.setAttribute('data-state', evaluation[c]);
                    boardState[r][c] = guess[c];
                }
                updateKeyboard(guess, evaluation);
            }
            currentRow = hist.guesses.length;
            currentCol = 0;
        }
    }

    // ─── 对手面板 ─────────────────────────────────

    function addOpponent(socketId, nickname) {
        if (opponents[socketId]) return;

        const card = document.createElement('div');
        card.classList.add('opponent-card');
        card.id = 'opp-' + socketId;

        // 观众点击切换视角
        if (myRole === 'spectator') {
            card.classList.add('spectator-clickable');
            card.addEventListener('click', () => {
                spectatorSwitchView(socketId, null);
            });
        }

        const nameEl = document.createElement('div');
        nameEl.classList.add('opponent-nickname');
        nameEl.textContent = nickname;
        card.appendChild(nameEl);

        const boardEl = document.createElement('div');
        boardEl.classList.add('opponent-board');
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
        statusEl.textContent = roomGameStarted ? '进行中' : '等待中';
        card.appendChild(statusEl);

        opponentsContainer.appendChild(card);
        opponents[socketId] = { nickname, card, boardEl, statusEl, currentRow: 0 };

        // 初始化 playerHistories
        if (!playerHistories[socketId]) {
            playerHistories[socketId] = { nickname, guesses: [] };
        }
    }

    function removeOpponent(socketId) {
        const opp = opponents[socketId];
        if (!opp) return;
        opp.card.remove();
        delete opponents[socketId];
        delete playerHistories[socketId];

        // 如果观众正在看这个选手，切换到下一个
        if (spectatorTarget === socketId) {
            const others = Object.keys(opponents);
            if (others.length > 0) {
                spectatorSwitchView(others[0], null);
            }
        }
    }

    function updatePlayerCount() {
        const playerCount = Object.keys(opponents).length + (myRole === 'player' ? 1 : 0);
        const label = `选手 ${playerCount}/4`;
        roomPlayerCount.textContent = label;
    }

    // ─── 对手棋盘更新 ────────────────────────────

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
                // 观众可以看到字母
                if (myRole === 'spectator' && candidateRow[c] !== '*') {
                    tile.textContent = candidateRow[c];
                }
            } else {
                tile.removeAttribute('data-state');
                tile.textContent = '';
            }
        }

        // 如果观众正在看这个选手的主视角，也更新主棋盘
        if (myRole === 'spectator' && spectatorTarget === socketId) {
            const mainTile = getTile(row, 0);
            if (mainTile) {
                for (let c = 0; c < roomWordLength; c++) {
                    const t = getTile(row, c);
                    if (!t) continue;
                    if (candidateRow[c] && candidateRow[c] !== '*') {
                        t.textContent = candidateRow[c];
                        t.setAttribute('data-state', 'tbd');
                        boardState[row][c] = candidateRow[c];
                    } else {
                        t.textContent = '';
                        t.removeAttribute('data-state');
                        boardState[row][c] = '';
                    }
                }
            }
        }
    }

    function onPlayerGuess({ socketId, evaluation, row, won, gameOver: go }) {
        // 选手收到其他选手的猜测（不含字母，只有颜色）
        applyOpponentGuess(socketId, null, evaluation);
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

    function onSpectatorGuess({ socketId, nickname, guess, evaluation, row, won, gameOver: go }) {
        // 观众收到选手的猜测（含字母）
        // 记录历史
        if (!playerHistories[socketId]) {
            playerHistories[socketId] = { nickname, guesses: [] };
        }
        playerHistories[socketId].guesses.push({ guess, evaluation });

        // 更新对手面板（观众面板显示字母）
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

        // 如果正在看这个选手的主视角，更新主棋盘
        if (spectatorTarget === socketId) {
            for (let c = 0; c < roomWordLength; c++) {
                const tile = getTile(row, c);
                if (!tile) continue;
                tile.textContent = guess[c];
                tile.setAttribute('data-state', evaluation[c]);
                boardState[row][c] = guess[c];
            }
            updateKeyboard(guess, evaluation);
            currentRow = row + 1;
            currentCol = 0;

            // 更新 solver
            if (typeof updateSolverAfterGuess === 'function') {
                updateSolverAfterGuess(guess, evaluation);
            }
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
            // 观众可以看到字母，选手只看颜色
            if (guess && myRole === 'spectator') {
                tile.textContent = guess[c];
            }
            tile.setAttribute('data-state', evaluation[c]);
        }
        opp.currentRow++;
    }

    // ─── 自己的猜测结果（versus 选手）──────────────

    function onGuessResult({ evaluation, won, gameOver: go, answer }) {
        applyGuessResult(
            boardState[currentRow].join(''),
            evaluation,
            won,
            go && !won ? answer : undefined
        );
    }

    // ─── 合作模式事件 ─────────────────────────────

    function onCoopGuess({ guess, evaluation, nickname, socketId: guesserSid, row, won, roundOver, answer }) {
        // 合作模式：所有人共享一个棋盘（包括观众）
        applyCoopRow(row, guess, evaluation, nickname);

        // 更新 solver
        if (typeof updateSolverAfterGuess === 'function') {
            updateSolverAfterGuess(guess, evaluation);
        }

        if (won) {
            isRevealing = false;
            gameOver = true;
        } else if (roundOver) {
            isRevealing = false;
            gameOver = true;
            if (answer) showMessage(`答案: ${answer}`, 5000);
        } else {
            isRevealing = false;
        }
    }

    function applyCoopRow(row, guess, evaluation, guesserNickname) {
        for (let c = 0; c < roomWordLength; c++) {
            const tile = getTile(row, c);
            if (!tile) continue;
            tile.textContent = guess[c];
            tile.setAttribute('data-state', evaluation[c]);
            boardState[row][c] = guess[c];
        }
        updateKeyboard(guess, evaluation);
        currentRow = row + 1;
        currentCol = 0;

        const boardRow = boardEl.children[row];
        if (boardRow) {
            let tag = boardRow.querySelector('.coop-guesser-tag');
            if (!tag) {
                tag = document.createElement('span');
                tag.classList.add('coop-guesser-tag');
                boardRow.appendChild(tag);
            }
            tag.textContent = guesserNickname;
        }
    }

    // ─── 全局结束 & 再来一局 ──────────────────────

    function onRoundOver({ won, answer, mode, players, seatCount, maxSeats }) {
        gameOver = true;
        isRevealing = false;
        lastSeatCount = seatCount;
        lastMaxSeats = maxSeats;

        if (myRole === 'player') {
            if (mode === 'versus' && players && socket) {
                const myInfo = players[socket.id];
                if (myInfo) {
                    if (myInfo.won) {
                        recordGameResult(true, currentRow + 1, true);
                    } else {
                        recordGameResult(false, 0, true);
                    }
                }

                let results = [];
                for (const [sid, info] of Object.entries(players)) {
                    const isMe = sid === socket.id;
                    const name = isMe ? '你' : info.nickname;
                    results.push(`${name}: ${info.won ? '✓' : '✗'}`);
                }
                showMessage(results.join('   '), 5000);
            } else if (mode === 'coop' && players && socket) {
                const myInfo = players[socket.id];
                if (myInfo) {
                    if (myInfo.won) {
                        recordGameResult(true, currentRow, true);
                    } else {
                        recordGameResult(false, 0, true);
                    }
                }
            }
        }

        showPlayAgainUI(answer);
    }

    function onPlayAgainVote({ voteCount, totalNeeded, seatCount, maxSeats }) {
        if (playAgainStatus) {
            playAgainStatus.textContent = `${voteCount}/${totalNeeded} 选手已投票`;
        }
        // 更新观众席位信息
        const seatInfo = document.getElementById('play-again-seat-info');
        if (seatInfo && typeof seatCount === 'number' && typeof maxSeats === 'number') {
            seatInfo.textContent = `当前选手人数: ${seatCount}/${maxSeats}`;
            const joinBtn = document.getElementById('play-again-join-seat-btn');
            if (joinBtn) {
                joinBtn.disabled = seatCount >= maxSeats;
            }
        }
    }

    function onNewRound({ state }) {
        hidePlayAgainUI();
        roomMode = state.mode || 'versus';
        roomGameStarted = state.gameStarted;
        setHostState(state);

        // 重置游戏
        resetGameState();
        createBoard();
        resetKeyboard();
        targetWord = '';
        gameOver = false;
        isRevealing = false;

        // 重建对手面板
        rebuildOpponents(state);

        if (myRole === 'spectator') {
            // 观众继续观战
            setupSpectatorMode(state);
        }

        showMessage('新一轮开始！', 2000);
    }

    function showPlayAgainUI(answer) {
        if (!playAgainOverlay) return;
        const answerEl = playAgainOverlay.querySelector('#play-again-answer');
        if (answerEl && answer) {
            answerEl.textContent = `答案: ${answer}`;
        }

        // 根据角色显示不同按钮
        if (myRole === 'player') {
            if (playAgainPlayerActions) playAgainPlayerActions.style.display = '';
            if (playAgainSpectatorActions) playAgainSpectatorActions.style.display = 'none';
            if (playAgainBtn) {
                playAgainBtn.disabled = false;
                playAgainBtn.textContent = '再来一局';
            }
        } else {
            if (playAgainPlayerActions) playAgainPlayerActions.style.display = 'none';
            if (playAgainSpectatorActions) playAgainSpectatorActions.style.display = '';
            // 显示席位信息
            const seatInfo = document.getElementById('play-again-seat-info');
            if (seatInfo) {
                seatInfo.textContent = `当前选手人数: ${lastSeatCount}/${lastMaxSeats}`;
            }
            const joinBtn = document.getElementById('play-again-join-seat-btn');
            if (joinBtn) {
                joinBtn.disabled = lastSeatCount >= lastMaxSeats;
            }
        }

        if (playAgainStatus) {
            playAgainStatus.textContent = '';
        }
        playAgainOverlay.classList.remove('hidden');
    }

    function hidePlayAgainUI() {
        if (playAgainOverlay) playAgainOverlay.classList.add('hidden');
    }

    // ─── 公开 API ─────────────────────────────────

    function broadcastBox() {
        if (!socket || !currentRoomId || myRole !== 'player' || !roomGameStarted) return;
        socket.emit('update-box', {
            roomId: currentRoomId,
            row: currentRow,
            candidateRow: boardState[currentRow]
        });
    }

    function submitGuess(guess) {
        if (!socket || !currentRoomId || myRole !== 'player' || !roomGameStarted) return;
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
        get connected() { return socket && socket.connected; },
        get mode() { return roomMode; },
        get isSpectator() { return myRole === 'spectator'; },
        get gameStarted() { return roomGameStarted; }
    };

})();
