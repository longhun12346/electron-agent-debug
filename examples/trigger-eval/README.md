# Skill 触发率评测

量一件事：用户说了一句真实的话，Claude Code 会不会调用 `electron-debug` 这个 Skill。这决定了 Skill 里写的所有内容能不能被用上，而宿主只靠 `SKILL.md` 里的 `description` 来决定。

## 做法

每个请求在一个临时的 Electron 项目里跑一次真实的 `claude -p`：

- 项目是 `examples/field-app` 的副本，看起来是 Electron 项目，除了被测的 Skill 没有别的项目级 Skill；被测 Skill 是 `skill/electron-debug` 的副本，只允许读取类工具（`Skill`、`Read`、`Glob`、`Grep`），不能改文件也不能跑命令。
- 只加载项目级设置（`--setting-sources project`），所以宿主自带的内置 Skill（`run`、`verify`、`debug` 等）仍然在场，它们会和被测 Skill 竞争，这是真实环境的一部分。
- 看宿主的前 N 次工具调用（默认 4）里有没有 `Skill` 调用了 `electron-debug`；一旦调用就停止，没有调用也在 N 次之后停止，所以每次运行只花一小部分真实任务的开销。
- 宿主没有调用 Skill 工具，而是自己去读 `electron-debug` 的 `SKILL.md`，会单独统计为“改读了 SKILL.md”，不算触发。

请求在 `queries.json`：10 条该触发、10 条近似但不该触发（打包、纯类型、重命名、写测试、概念问答、打包后的应用等），中英文各有，60% 标为 `train`，40% 标为 `validation`。按 agentskills.io 的建议，调描述时只看 `train`，最后用 `validation` 检查有没有过拟合。通过线按官方的 0.5：该触发的请求触发率达到 50%，不该触发的请求触发率为 0。

## 运行

```text
node examples/trigger-eval/run.mjs --claude <absolute-claude-executable> [options]
```

常用选项：

| 选项 | 作用 |
| --- | --- |
| `--variant current` | 用 `SKILL.md` 现在的描述（默认） |
| `--variant proposed` | 用 `descriptions/proposed.txt` 里的描述替换，不改仓库里的 `SKILL.md` |
| `--variant off` | 不装 Skill，作为基线：看看宿主自己会不会做出同样的事 |
| `--split train` | 只跑调参集 |
| `--reps 3` | 每个请求跑几次，默认 3 |
| `--only p1,n2` | 只跑指定请求 |
| `--out report.json` | 保存每次运行的完整记录 |
| `--no-early-stop` | 让每次运行跑完，用来量真实成本 |

在 Claude Code 桌面应用里启动时，进程会继承桌面会话的 `CLAUDE_CODE_*` 等变量，嵌套的宿主会因此报 “Not logged in”。脚本在启动宿主前已经清掉它们，`ANTHROPIC_*` 保留。

## 成本和解读

- 每次运行都要把宿主的系统提示、工具和全部 Skill 描述读一遍，提前停止并不能省掉这部分：试跑时每次约 0.3 到 0.6 美元（宿主自报），所以完整的一轮（20 个请求乘 3 次）要几十美元，先用 `--split train` 或 `--reps 2`。
- 同一个请求重复运行结果不一致是常态（试跑里同一句话触发了 1 次、另一次被宿主自带的 `run` Skill 抢走），所以每个请求至少跑 3 次，结论以比例为准，不要看单次。
- “没触发”不等于 Skill 没被用上：宿主常先调用内置 `run`，再 Glob `.claude/skills/*/SKILL.md` 并读取本 Skill（训练集两轮里 16 次未触发中有 13 次读过 `SKILL.md`）。`read SKILL.md instead` 一列单独统计这类情况；读过不代表照做了，要看 `--out` 里的 `detail`。
- 3 次重复只能看出大差距：两个描述在 18 次里差 2 次（61% 对 50%）属于噪声。比较描述时每条至少 5 次，并同时跑 `validation` 和 `--variant off`。
- 改描述后要和基线、旧描述在同一批请求、同一个模型上比较；模型不同，结论不能直接比。
- 这是针对 Claude Code 的评测，Codex 等其他宿主选择 Skill 的方式没有被覆盖。
