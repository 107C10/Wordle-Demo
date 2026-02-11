/**
 * Wordle Solver - 基于 3Blue1Brown 信息论方法
 * 
 * 核心思想：
 * 对于每个可能的猜测词，计算其"期望信息量"（entropy）。
 * 每次猜测后，Wordle 会返回一个颜色模式（3^N 种可能，N为字母数）。
 * 信息量 = -Σ p(pattern) * log2(p(pattern))
 * 选择信息量最大的词作为最佳猜测。
 * 
 * 支持 5/6/7 字母等任意长度。
 * 参考: https://www.3blue1brown.com/lessons/wordle
 */

const WordleSolver = (() => {
    /**
     * 预计算 3 的幂数组
     * @param {number} len - 单词长度
     * @returns {number[]}
     */
    function getPow3(len) {
        const pow = [];
        let v = 1;
        for (let i = 0; i < len; i++) {
            pow.push(v);
            v *= 3;
        }
        return pow;
    }

    /**
     * 将猜测结果 evaluation 编码为整数
     * correct=2, present=1, absent=0
     */
    function encodePattern(evaluation) {
        const len = evaluation.length;
        const pow3 = getPow3(len);
        let code = 0;
        for (let i = 0; i < len; i++) {
            const val = evaluation[i] === 'correct' ? 2 : evaluation[i] === 'present' ? 1 : 0;
            code += val * pow3[len - 1 - i];
        }
        return code;
    }

    /**
     * 将整数模式码解码为颜色数组
     * @param {number} code - 模式码
     * @param {number} len - 单词长度
     */
    function decodePattern(code, len) {
        const pow3 = getPow3(len);
        const pattern = [];
        for (let i = 0; i < len; i++) {
            const val = Math.floor(code / pow3[len - 1 - i]) % 3;
            pattern.push(val === 2 ? 'correct' : val === 1 ? 'present' : 'absent');
        }
        return pattern;
    }

    /**
     * 给定一个猜测词和一个目标词，计算会产生的颜色模式码
     */
    function getPattern(guess, target) {
        const len = guess.length;
        const pow3 = getPow3(len);
        const result = new Array(len).fill(0);
        const targetLetters = target.split('');
        const guessLetters = guess.split('');
        const used = new Array(len).fill(false);

        // 第一遍：标记正确位置
        for (let i = 0; i < len; i++) {
            if (guessLetters[i] === targetLetters[i]) {
                result[i] = 2;
                used[i] = true;
                guessLetters[i] = null;
            }
        }

        // 第二遍：标记存在但位置不对
        for (let i = 0; i < len; i++) {
            if (guessLetters[i] === null) continue;
            for (let j = 0; j < len; j++) {
                if (!used[j] && guessLetters[i] === targetLetters[j]) {
                    result[i] = 1;
                    used[j] = true;
                    break;
                }
            }
        }

        // 编码为整数
        let code = 0;
        for (let i = 0; i < len; i++) {
            code += result[i] * pow3[len - 1 - i];
        }
        return code;
    }

    /**
     * 计算一个猜测词的期望信息量（entropy）
     * 
     * @param {string} guess - 猜测词
     * @param {string[]} possibleWords - 当前剩余的可能答案
     * @returns {number} 期望信息量（bits）
     */
    function calculateEntropy(guess, possibleWords) {
        const patternCount = Math.pow(3, guess.length);
        const patternCounts = new Int32Array(patternCount);
        const total = possibleWords.length;

        // 对每个可能的目标词，计算猜测会产生的模式
        for (let i = 0; i < total; i++) {
            const pattern = getPattern(guess, possibleWords[i]);
            patternCounts[pattern]++;
        }

        // 计算 entropy = -Σ p * log2(p)
        let entropy = 0;
        for (let i = 0; i < patternCount; i++) {
            if (patternCounts[i] > 0) {
                const p = patternCounts[i] / total;
                entropy -= p * Math.log2(p);
            }
        }

        return entropy;
    }

    /**
     * 根据猜测和反馈，过滤剩余可能的答案
     */
    function filterWords(guess, patternCode, possibleWords) {
        return possibleWords.filter(word => {
            return getPattern(guess, word) === patternCode;
        });
    }

    /**
     * 获取前N个最佳猜测
     * 
     * @param {string[]} possibleAnswers - 当前可能的答案
     * @param {string[]} allGuesses - 所有可猜测的词
     * @param {number} topN - 返回前N个
     * @param {Function} progressCallback - 进度回调
     * @param {Function} [candidateFilter] - 可选的候选词过滤函数（如 Hard Mode 约束）
     * @returns {Promise<Array<{word: string, entropy: number, isAnswer: boolean}>>}
     */
    async function getBestGuesses(possibleAnswers, allGuesses, topN = 5, progressCallback = null, candidateFilter = null) {
        // 只剩1个词，直接返回
        if (possibleAnswers.length <= 1) {
            return possibleAnswers.map(w => ({
                word: w,
                entropy: 0,
                isAnswer: true
            }));
        }

        // 只剩2个词，任选一个即可
        if (possibleAnswers.length === 2) {
            return possibleAnswers.map(w => ({
                word: w,
                entropy: 1,
                isAnswer: true
            }));
        }

        // 决定候选猜测词池
        let candidateGuesses;
        if (possibleAnswers.length <= 20) {
            candidateGuesses = [...new Set([...possibleAnswers, ...ANSWER_LIST])];
        } else if (possibleAnswers.length <= 100) {
            candidateGuesses = [...ANSWER_LIST];
        } else {
            candidateGuesses = [...ANSWER_LIST];
        }

        // 如果有候选过滤函数（如 Hard Mode），过滤候选猜测
        if (candidateFilter) {
            candidateGuesses = candidateGuesses.filter(w => candidateFilter(w.toUpperCase()));
        }

        const results = [];
        const total = candidateGuesses.length;
        const possibleSet = new Set(possibleAnswers);

        // 分批计算以避免阻塞 UI
        const BATCH_SIZE = 50;
        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batchEnd = Math.min(i + BATCH_SIZE, total);
            for (let j = i; j < batchEnd; j++) {
                const guess = candidateGuesses[j];
                const entropy = calculateEntropy(guess, possibleAnswers);
                results.push({
                    word: guess,
                    entropy: entropy,
                    isAnswer: possibleSet.has(guess)
                });
            }

            // 让 UI 有机会更新
            if (progressCallback) {
                progressCallback(Math.min(batchEnd / total, 1));
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // 排序：信息量大的优先，相同时答案词优先
        results.sort((a, b) => {
            if (Math.abs(b.entropy - a.entropy) > 0.001) {
                return b.entropy - a.entropy;
            }
            return (b.isAnswer ? 1 : 0) - (a.isAnswer ? 1 : 0);
        });

        return results.slice(0, topN);
    }

    /**
     * 格式化模式码为 emoji 展示
     * @param {number} patternCode - 模式码
     * @param {number} len - 单词长度
     */
    function patternToEmoji(patternCode, len) {
        const pattern = decodePattern(patternCode, len);
        return pattern.map(s => s === 'correct' ? '🟩' : s === 'present' ? '🟨' : '⬜').join('');
    }

    // 公共 API
    return {
        getPattern,
        calculateEntropy,
        filterWords,
        getBestGuesses,
        encodePattern,
        decodePattern,
        patternToEmoji
    };
})();
