/**
 * 示例插件:掷骰子(与 docs/plugin-development.md 第 6 节配套)。
 * 复制目录到 ~/.pi/writer/plugins/dice/ 后重启 pi-writer 即可装载;
 * 对话里让 agent「掷个骰子」触发 roll_dice 工具。
 */
export default function dicePlugin(pi) {
  pi.registerTool({
    name: "roll_dice",
    description: "掷一个 N 面骰子(默认 d20),返回点数和一句话的剧情随机提示。适合做不确定性判定。",
    inputSchema: {
      type: "object",
      properties: { sides: { type: "number", description: "骰面数,默认 20" } },
      additionalProperties: false,
    },
    execute: async (input) => {
      const sides = Math.max(2, Math.min(1000, Number(input?.sides) || 20));
      const roll = 1 + Math.floor(Math.random() * sides);
      const luck = roll >= sides ? "大成功" : roll === 1 ? "大失败" : "普通";
      return { result: `d${sides} = ${roll}(${luck})`, note: `建议以此roll点驱动剧情走向(${luck})` };
    },
  });
}
