# goal-tools

让 agent / subagent 自己设置、修改、暂停、恢复、删除 OpenCode 的 session goal，
并在 goal 之上维护一个可持久化的 **goal list**（任务队列）。用户只需要提需求，
不必手敲 `/goal`。

它没有重新实现 goal 引擎：`set/update/pause/resume/clear` 走内置 `goal` 命令，
状态、judge、自动续跑、50 轮上限、停滞 3 次暂停、`/goal` 弹窗全部沿用内置实现。
`goal_list` 是插件自己的任务队列，用内置 goal 作为“当前正在做的那一项”。

## 工具

| 工具 | 作用 |
| --- | --- |
| `goal` | `action`: `set` / `update` / `pause` / `resume` / `clear` / `status`。可传 `sessionID` 改同一 team tree 里另一个 agent 的 goal。 |
| `goal_list` | `action`: `add` / `update` / `complete` / `remove` / `list` / `sync` / `clear`。可传 `sessionID` 操作子 agent 的队列。 |
| `goal_tree` | 列出当前 team tree 里所有 session 的 goal list（open/total、active task）。 |
| `goal_space` | 当前 session 的详细 goal 仓库：add / update / complete / list / get / stats / archive。 |
| `auto_research` | 自动研究提醒开关：status / on / off / blocked / resume / nudge。 |

### goal_list 的关键行为

- `add` 把任务加入 `pending`；如果没有活动 goal，默认立即把第一条提升为 goal
  （`startNow: false` 可关闭）。
- `sync` 把内置 goal 和队列对齐：
  - goal 被 judge 判定 `complete` → 当前任务标记 `done`，自动把下一条 `pending`
    提升为新的 goal；
  - 没有 goal → 自动启动第一条 pending（`autoStart`，默认 true）；
  - 用户手动改了 objective → 采用新 objective，不覆盖；
  - goal `paused` → 不动队列。
- 自动同步循环每 10 秒跑一次（`autoSyncIntervalMs`），所以“goal 完成但还有任务”
  不需要用户再发提示，下一项会自动继续。也可以随时手动 `sync`。
- `add … startNow:false` 会把整批任务标成 `deferred`：autoSync 从不启动它们，只有
  显式 `sync` 才启动第一条；`goal_list list` 会显示
  `deferred: starts only on sync`。`goal set` / `assign` 显式点名一个 deferred
  任务时，会把它启动并清除标记（显式指令优先）。
- goal 被 judge 判定 `complete`、但队列里只剩 deferred 任务时，会收到
  `[goal-met]` 提醒（不会再出现“既不提醒也不推进”的静默卡住）。
- 每条任务有 `pending / active / done / blocked` 状态和可选 `note`。

### goal space（详细版 goal）

`goal` 存的是短 objective；`goal_space` 存的是同一件事的**详细长期版本**：研究计划、实验协议、假设、结果、标签、子目标、关联的 goal_list task / 内置 goal，以及完整 history。

- **按 session 隔离**：每个 session 一份 `space:<sessionID>`。`goal_space` 只能读写自己的 space；父 agent 不能直接看/改子 agent 的 space（可以要求子 agent 自己写，或在父的记录里用 `assignedTo` / `completedBy` 记录协作关系）。
- **记录完成者、时间、session**：`complete` 写入 `completedBy`（sessionID）、`completedByAgent`（agent 名）、`completedAt`、`result`，并追加 history。父 agent 可以用 `completedBy: "<childSessionID>"` 记录“这个目标是某个子 agent 完成的”。
- **自动镜像**：`goal` / `goal_list` 设置目标时，会在目标 session 的 goal space 里创建/更新一条详细记录（`goalID` / `taskID` 关联）；judge 判定 complete 后自动标记 done，记录完成时间/agent。
- **goal-met 提醒**：TUI 显示 `goal met` 时，如果 goal space 里还有 planned/active 记录，或 goal list 里还有未完成任务（且 autoSync 没有马上 promote 下一项），自动插入一条 `[goal-met]` 消息，要求 agent 更新 goal，而不是把“goal met”当成结束。
- 统计：`stats` 返回总数、按状态、按完成 session、按完成 agent、最近完成。

```jsonc
// add
{ "action": "add", "title": "GaLore rank ablation",
  "details": "Run ranks 32/64/128 x 10 seeds; record loss, memory, wall clock.",
  "status": "planned", "tags": ["galore", "ablation"] }

// complete on behalf of a child
{ "action": "complete", "goalID": "goal_...", "completedBy": "ses_child",
  "result": "child ran 10 seeds; rank 64 best" }
```

### Auto research

`auto_research` 由 goal-tools 的 idle hook 驱动：

- 当 session 真的要停下来时，如果还有 open research work（goal space 的 planned/active 记录、goal list 未完成任务、active goal，或最后一条回复在给用户列选项/提问），自动插入一条 `[auto-research]` synthetic 消息。
- 消息要求：列出 1-3 个现在能做的实验 → 写入 `goal_space` / `goal_list` → **派给 subagent / isolate_spawn**（不要自己全做）→ 继续。
- 只有把所有不依赖用户的实验做完，才允许问用户；问的时候要说明已经试过什么、需要用户决定的精确问题。
- 如果确实被用户决策阻塞，agent 调 `auto_research` action `blocked` + reason；提醒停止。新增 goal-space 记录、goal-list 任务或新 goal 会重置 blocked；新的真实用户消息也会重置。
- 每个用户 turn 最多 `autoResearchMaxNudges` 次（默认 3），冷却 `autoResearchCooldownSeconds`（默认 90s），避免循环。
- 系统提示词（goal-tools、multi-agent-topology、subagent-isolation、team-space）和全局 `AGENTS.md` 都加入了 auto research 鼓励。

### 跨 agent 直接改 goal

`goal` 和 `goal_list` 都接受 `sessionID`。父 agent 可以：

```jsonc
// 直接给子 agent 设 goal，不要求子 agent 同意
{ "action": "set", "sessionID": "ses_child", "objective": "Run the test suite and report" }

// 直接给子 agent 加任务队列
{ "action": "add", "sessionID": "ses_child", "tasks": ["Fix the parser", "Run tests", "Report"] }
```

`set/update` 由别的 agent 发起时，会向目标 session 注入一条 synthetic 系统消息：

```text
[goal-update from <caller>] Another agent changed your session goal.
action: set
objective: ...
status: active
Keep working toward it. When the goal is met or new tasks arrive, call goal_list with action "sync".
```

内置 `/goal` 的 kickoff 也会出现；这条通知补充“是谁改的”。`pause/resume/clear`
跨 agent 调用时同样注入通知。

## 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `autoInstruct` | `true` | 注入 goal/goal_list 使用说明；只在当前 agent 真的有 `goal` 工具时注入。 |
| `allowSubagents` | `true` | 允许子会话设置 goal。设为 `false` 可禁止。 |
| `autoSync` | `true` | 自动把完成的 goal 推进到下一项。 |
| `autoSyncIntervalMs` | `10000` | 自动同步周期（goal list 与 goal space）。 |
| `autoResearch` | `true` | 启用 idle 时的自动研究提醒。 |
| `autoResearchCooldownSeconds` | `90` | 同一 session 两次提醒的最小间隔。 |
| `autoResearchMaxNudges` | `3` | 每个真实用户 turn 最多提醒次数。 |

## RPC（测试 / 其它插件）

RPC id `goaltools`：

- `state {sessionID}` → `{goal, list}`
- `list {sessionID}` → `GoalList`
- `add {fromSessionID, sessionID, tasks, startNow?}` → `{list, added, synced}`
- `sync {fromSessionID, sessionID}` → `{action, list, goal, task?}`
- `assign {fromSessionID, sessionID, objective, notify?}` → 直接设 goal
- `space {sessionID}` / `spaceAdd` / `spaceUpdate` / `spaceComplete` / `spaceStats` → goal space
- `research {sessionID}` / `researchSet` / `nudge` → auto-research 状态/提醒

## 已知边界

- 内置引擎仍是 **一个 session 一个 goal**；goal list 是队列，不是并行 goal。
- goal 状态按 session 存在内置引擎的全局 KV 里；跨目录读取通过内置 RPC 完成。
- 自动同步只会在目标 session 所在 location 的插件实例上执行，避免多 location
  重复推进。
- 一个 goal 被手动 `clear` 后，如果队列里还有 pending 且 `autoStart=true`，下一轮
  自动同步会重新启动第一条 pending；想保持“无 goal”状态时请把 `autoStart`
  设为 false 或清空队列。

## 验收

- 2026-11-20，`goal_list` 两条任务 `echo ONE` → `echo TWO`：
  judge 第一次 complete 后自动 promote 第二条，第二次 complete 后两条都变
  `done`，`activeTaskID=null`（RPC `goaltools/state` 轮询记录）。
- 跨 agent `assign`：父 agent 直接给子 session 设 objective，goal 立即 active，
  子 session 出现 `[goal-update from ...]` synthetic。
- 2026-11-20，`test/e2e_space.py`：父/子 space 隔离、child 作为 `completedBy`
  记录、goal 自动镜像并在 judge complete 后标记 done、open record 触发
  `[goal-met]` 提醒。
- 2026-11-20，`test/e2e_research.py`：idle 自动插入 `[auto-research]`，
  `blocked` 后不再插入，新 goal-space 记录重置 blocked 并再次提醒。
- 2026-11-20，`test/e2e_tui.py`：真实 TUI 里模型自己调用 `goal_space add`、
  `auto_research off`、`goal_list add`；API 断言记录、长 details、任务和
  auto-research 状态。
