/**
 * Judge 模块 — 猜测评估（共享模块，同时支持浏览器和 Node.js）
 *
 * 浏览器端: 暴露全局 Judge 对象
 * Node.js:  module.exports = Judge
 */
const Judge = (function () {

    /**
     * 评估猜测结果
     * @param {string} guess  - 玩家猜测的单词（大写）
     * @param {string} target - 目标答案（大写）
     * @returns {string[]} 每个字母的状态: 'correct' | 'present' | 'absent'
     */
    function evaluateGuess(guess, target) {
        const len = target.length;
        const result = Array(len).fill('absent');
        const targetLetters = target.split('');
        const guessLetters  = guess.split('');
        const used = Array(len).fill(false);

        // 第一遍：标记正确位置 (green)
        for (let i = 0; i < len; i++) {
            if (guessLetters[i] === targetLetters[i]) {
                result[i] = 'correct';
                used[i] = true;
                guessLetters[i] = null;
            }
        }

        // 第二遍：标记存在但位置不对 (yellow)
        for (let i = 0; i < len; i++) {
            if (guessLetters[i] === null) continue;
            for (let j = 0; j < len; j++) {
                if (!used[j] && guessLetters[i] === targetLetters[j]) {
                    result[i] = 'present';
                    used[j] = true;
                    break;
                }
            }
        }

        return result;
    }

    return { evaluateGuess: evaluateGuess };
})();

// Node.js 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Judge;
}
