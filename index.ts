import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { realpath } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

/**
 * Goal tools
 *
 * Wraps OpenCode's built-in goal engine (the one behind `/goal`) as model
 * tools, and adds a durable goal list on top of it:
 *
 *   - `goal`       set/update/pause/resume/clear/status a goal, optionally on
 *                  another session in the same team tree.
 *   - `goal_list`  add/update/complete/remove tasks, list them, or `sync` the
 *                  built-in goal with the next unfinished task.
 *
 * The built-in engine is one goal per session, so the list is the queue: when
 * the judged goal completes, the sync loop marks it done, promotes the next
 * pending task to the built-in goal, and the goal engine keeps working.
 *
 * A goal change made by another agent injects a synthetic system message into
 * the target session. The built-in `/goal` kickoff already announces a new
 * objective; the notice adds who changed it and what happened.
 */

const OBJECTIVE_LIMIT = 4000
const LIST_PREFIX = "list:"
const SPACE_PREFIX = "space:"
const RESEARCH_PREFIX = "research:"
const MAX_SPACE_GOALS = 200
const MAX_DETAILS = 20_000
const MAX_HISTORY = 100

const INSTRUCTIONS = `## Goal tool and goal list
The \`goal\` tool drives OpenCode's goal engine (actions: set | update | pause | resume | clear | status).
- When work needs more than a trivial single step, set a short, verifiable objective before you start.
- The engine judges completion and auto-continues until the objective is met.
- Use \`goal_list\` for a queue of tasks: actions add | update | complete | remove | list | sync | clear.
- When a goal is met but more work remains (or new tasks arrive), call \`goal_list\` with action "sync"; it marks the finished task done and promotes the next pending one.
- You may target another session in the same team tree with sessionID (for example a child you coordinate). A goal change on another agent injects a system message there.
- A message from \`team_send\` or \`topology_auto_send\` that asks for a report also expects your goal list to be current.

## Goal space
\`goal_space\` is your session's detailed, long-form goal store. Use it for research plans, experiment protocols, hypotheses and results that are too long for one objective.
- add | update | complete | list | get | stats | archive.
- Each record keeps its full details, status, tags, links to a goal_list task or the built-in goal, the creator and assignee, and a history with the session/agent that changed it.
- Completion records the time and the agent/session that completed it (completedBy, completedAt). A parent may complete a record on behalf of a child.
- A session's goal space is isolated: only that session reads or edits it. The goal/goal_list tools may write a linked record into the target session's space when they set or complete a goal.

## Auto research
Do as many experiments as possible. Prefer delegating experiments to subagents (\`subagent\` / \`isolate_spawn\`) over running them all yourself.
- Before stopping to ask the user, write the next experiments into \`goal_space\` (status planned) and/or \`goal_list\`.
- Do all experiments that do not require a user decision. Only after that should you ask the user, with the evidence and the exact decision needed.
- If you are truly blocked on a user decision, call \`auto_research\` with action "blocked" and a one-line reason; that stops the automatic reminders.
- The plugin also inserts a reminder when you stop with open research work. Treat it as a prompt to continue, not as a user message.`

type GoalState = {
  id: string
  objective: string
  status: "active" | "paused" | "complete"
  reason?: string
  rounds?: number
  maxRounds?: number
  stalls?: number
  updatedAt?: number
}

type TaskStatus = "pending" | "active" | "done" | "blocked"

type Task = {
  id: string
  text: string
  status: TaskStatus
  note?: string
  /** Added with startNow:false: never auto-promoted, only an explicit sync/update starts it. */
  deferred?: boolean
  createdAt: number
  updatedAt: number
}

type GoalList = {
  sessionID: string
  tasks: Task[]
  activeTaskID?: string
  activeObjective?: string
  autoSync: boolean
  autoStart: boolean
  updatedAt: number
}

type SpaceStatus = "planned" | "active" | "paused" | "done" | "blocked" | "abandoned"

type SpaceEvent = {
  at: number
  action: "created" | "updated" | "started" | "paused" | "completed" | "blocked" | "reopened" | "delegated" | "note"
  by: string
  sessionID: string
  agent?: string
  note?: string
}

type SpaceGoal = {
  id: string
  title: string
  details: string
  status: SpaceStatus
  tags: string[]
  parentID?: string
  taskID?: string
  goalID?: string
  createdBy: string
  assignedTo?: string
  completedBy?: string
  completedByAgent?: string
  completedAt?: number
  result?: string
  history: SpaceEvent[]
  createdAt: number
  updatedAt: number
}

type GoalSpace = {
  sessionID: string
  goals: SpaceGoal[]
  lastGoalNoticeID?: string
  updatedAt: number
}

type ResearchState = {
  sessionID: string
  enabled: boolean
  blocked: boolean
  reason?: string
  blockedAt?: number
  nudges: number
  lastNudgeAt?: number
  lastUserAt?: number
  updatedAt: number
}

type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  location?: { directory?: string }
  title?: string
}

let contract: unknown

function goalContract() {
  if (contract) return contract as never
  contract = Rpc.define({
    id: "opencode.goal",
    methods: {
      get: {
        input: {
          type: "object",
          properties: { sessionID: { type: "string" } },
          required: ["sessionID"],
          additionalProperties: false,
        },
        output: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                objective: { type: "string" },
                status: { type: "string" },
                reason: { type: "string" },
                rounds: { type: "number" },
                maxRounds: { type: "number" },
                stalls: { type: "number" },
                boot: { type: "string" },
                updatedAt: { type: "number" },
              },
            },
          ],
        },
      },
    },
    events: {},
  })
  return contract as never
}

function describe(state: GoalState | null | undefined) {
  if (!state) return "No goal is set."
  const lines = [`status: ${state.status}`, `objective: ${state.objective}`]
  if (state.maxRounds !== undefined) lines.push(`round: ${state.rounds ?? 0}/${state.maxRounds}`)
  if (state.reason) lines.push(`reason: ${state.reason}`)
  return lines.join("\n")
}

function newTaskID() {
  return `task_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`
}

function emptyList(sessionID: string): GoalList {
  return {
    sessionID,
    tasks: [],
    autoSync: true,
    autoStart: true,
    updatedAt: Date.now(),
  }
}

async function canonical(path: string | undefined) {
  if (!path) return ""
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

export default Plugin.define({
  id: "goal-tools",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as {
      autoInstruct?: boolean
      allowSubagents?: boolean
      autoSync?: boolean
      autoSyncIntervalMs?: number
      autoResearch?: boolean
      autoResearchCooldownSeconds?: number
      autoResearchMaxNudges?: number
    }
    const autoInstruct = options.autoInstruct !== false
    const allowSubagents = options.allowSubagents !== false
    const autoSync = options.autoSync !== false
    const autoSyncIntervalMs = Math.max(1000, Math.min(Number(options.autoSyncIntervalMs ?? 10_000), 300_000))
    const autoResearch = options.autoResearch !== false
    const autoResearchCooldownSeconds = Math.max(
      5,
      Math.min(Number(options.autoResearchCooldownSeconds ?? 90), 3600),
    )
    const autoResearchMaxNudges = Math.max(1, Math.min(Number(options.autoResearchMaxNudges ?? 3), 20))

    let dead = false
    let syncing = false

    const read = async (sessionID: string): Promise<GoalState | null | undefined> => {
      try {
        const goal = ctx.rpc(goalContract()) as { get(input: { sessionID: string }): Promise<GoalState | null> }
        return await goal.get({ sessionID })
      } catch {
        return undefined
      }
    }

    const run = async (sessionID: string, text: string) => {
      await ctx.session.command({ sessionID, name: "goal", text })
    }

    const info = async (sessionID: string): Promise<SessionInfo> => {
      return (await ctx.session.get({ sessionID })) as unknown as SessionInfo
    }

    const rootOf = async (sessionID: string) => {
      let current = await info(sessionID)
      for (let guard = 0; guard < 64; guard++) {
        if (!current.parentID) return current
        current = await info(current.parentID)
      }
      throw new Error("session parent chain is too deep")
    }

    const sameTree = async (a: string, b: string) => {
      const rootA = await rootOf(a)
      const rootB = await rootOf(b)
      return rootA.id === rootB.id
    }

    const listKey = (sessionID: string) => LIST_PREFIX + sessionID

    const readList = async (sessionID: string): Promise<GoalList> => {
      const stored = (await ctx.storage.get(listKey(sessionID))) as unknown as GoalList | undefined
      if (!stored || !Array.isArray(stored.tasks)) return emptyList(sessionID)
      return {
        sessionID,
        tasks: stored.tasks.map((task) => ({
          id: String(task.id),
          text: String(task.text),
          status: (["pending", "active", "done", "blocked"].includes(task.status) ? task.status : "pending") as TaskStatus,
          // Must survive readList: saveList serialises whatever readList returned,
          // so dropping it here makes any list write silently un-defer the task.
          ...(task.deferred ? { deferred: true } : {}),
          ...(task.note ? { note: String(task.note) } : {}),
          createdAt: Number(task.createdAt ?? Date.now()),
          updatedAt: Number(task.updatedAt ?? Date.now()),
        })),
        ...(stored.activeTaskID ? { activeTaskID: stored.activeTaskID } : {}),
        ...(stored.activeObjective ? { activeObjective: stored.activeObjective } : {}),
        autoSync: stored.autoSync !== false,
        autoStart: stored.autoStart !== false,
        updatedAt: Number(stored.updatedAt ?? Date.now()),
      }
    }

    const saveList = async (list: GoalList) => {
      list.updatedAt = Date.now()
      await ctx.storage.set(listKey(list.sessionID), JSON.parse(JSON.stringify(list)) as never)
    }


    // ---------------------------------------------------------------------
    // Goal space (detailed, per-session goal records)
    // ---------------------------------------------------------------------

    const spaceKey = (sessionID: string) => SPACE_PREFIX + sessionID
    const researchKey = (sessionID: string) => RESEARCH_PREFIX + sessionID

    const newSpaceID = () => `goal_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`

    const emptySpace = (sessionID: string): GoalSpace => ({ sessionID, goals: [], updatedAt: Date.now() })

    const readSpace = async (sessionID: string): Promise<GoalSpace> => {
      const stored = (await ctx.storage.get(spaceKey(sessionID))) as unknown as GoalSpace | undefined
      if (!stored || !Array.isArray(stored.goals)) return emptySpace(sessionID)
      return {
        sessionID,
        goals: stored.goals.map((goal) => ({
          id: String(goal.id),
          title: String(goal.title ?? ""),
          details: String(goal.details ?? ""),
          status: (["planned", "active", "paused", "done", "blocked", "abandoned"].includes(goal.status)
            ? goal.status
            : "planned") as SpaceStatus,
          tags: Array.isArray(goal.tags) ? goal.tags.map(String) : [],
          ...(goal.parentID ? { parentID: String(goal.parentID) } : {}),
          ...(goal.taskID ? { taskID: String(goal.taskID) } : {}),
          ...(goal.goalID ? { goalID: String(goal.goalID) } : {}),
          createdBy: String(goal.createdBy ?? sessionID),
          ...(goal.assignedTo ? { assignedTo: String(goal.assignedTo) } : {}),
          ...(goal.completedBy ? { completedBy: String(goal.completedBy) } : {}),
          ...(goal.completedByAgent ? { completedByAgent: String(goal.completedByAgent) } : {}),
          ...(goal.completedAt ? { completedAt: Number(goal.completedAt) } : {}),
          ...(goal.result ? { result: String(goal.result) } : {}),
          history: Array.isArray(goal.history) ? goal.history.slice(-MAX_HISTORY).map((entry) => ({
            at: Number(entry.at ?? Date.now()),
            action: String(entry.action ?? "note") as SpaceEvent["action"],
            by: String(entry.by ?? sessionID),
            sessionID: String(entry.sessionID ?? entry.by ?? sessionID),
            ...(entry.agent ? { agent: String(entry.agent) } : {}),
            ...(entry.note ? { note: String(entry.note) } : {}),
          })) : [],
          createdAt: Number(goal.createdAt ?? Date.now()),
          updatedAt: Number(goal.updatedAt ?? Date.now()),
        })),
        ...(stored.lastGoalNoticeID ? { lastGoalNoticeID: String(stored.lastGoalNoticeID) } : {}),
        updatedAt: Number(stored.updatedAt ?? Date.now()),
      }
    }

    const saveSpace = async (space: GoalSpace) => {
      space.updatedAt = Date.now()
      await ctx.storage.set(spaceKey(space.sessionID), JSON.parse(JSON.stringify(space)) as never)
    }

    const actor = async (sessionID: string) => {
      try {
        const session = await info(sessionID)
        return { sessionID, agent: session.agent }
      } catch {
        return { sessionID }
      }
    }

    const spaceEvent = async (
      action: SpaceEvent["action"],
      by: string,
      note?: string,
    ): Promise<SpaceEvent> => {
      const who = await actor(by)
      return {
        at: Date.now(),
        action,
        by,
        sessionID: who.sessionID,
        ...(who.agent ? { agent: who.agent } : {}),
        ...(note ? { note } : {}),
      }
    }

    const resetResearch = async (sessionID: string, reason?: string) => {
      const state = await readResearch(sessionID)
      state.blocked = false
      state.reason = undefined
      state.blockedAt = undefined
      state.nudges = 0
      state.lastNudgeAt = undefined
      state.updatedAt = Date.now()
      await saveResearch(state)
      if (reason) console.log(`[goal-tools] auto-research reset for ${sessionID}: ${reason}`)
    }

    const spaceAdd = async (
      caller: string,
      input: {
        title?: string
        details?: string
        status?: string
        tags?: string[]
        parentID?: string
        taskID?: string
        goalID?: string
        assignedTo?: string
      },
    ) => {
      const title = String(input.title ?? "").trim()
      if (!title) throw new Error("title is required")
      const space = await readSpace(caller)
      if (space.goals.length >= MAX_SPACE_GOALS)
        throw new Error(`goal space limit reached (${MAX_SPACE_GOALS} records)`)
      const status = (input.status ?? "planned") as SpaceStatus
      if (!["planned", "active", "paused", "done", "blocked", "abandoned"].includes(status))
        throw new Error(`invalid status "${input.status}"`)
      if (input.assignedTo) {
        await info(input.assignedTo)
        if (!(await sameTree(caller, input.assignedTo)))
          throw new Error(`assignedTo ${input.assignedTo} is outside this team tree`)
      }
      const now = Date.now()
      const record: SpaceGoal = {
        id: newSpaceID(),
        title,
        details: String(input.details ?? title).slice(0, MAX_DETAILS),
        status,
        tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean).slice(0, 20) : [],
        ...(input.parentID ? { parentID: String(input.parentID) } : {}),
        ...(input.taskID ? { taskID: String(input.taskID) } : {}),
        ...(input.goalID ? { goalID: String(input.goalID) } : {}),
        createdBy: caller,
        ...(input.assignedTo ? { assignedTo: String(input.assignedTo) } : {}),
        history: [await spaceEvent("created", caller, `created ${status}`)],
        createdAt: now,
        updatedAt: now,
      }
      if (status === "done") {
        record.completedBy = caller
        record.completedByAgent = (await actor(caller)).agent
        record.completedAt = now
      }
      space.goals.push(record)
      await saveSpace(space)
      await resetResearch(caller, "new goal-space record")
      return record
    }

    const spaceGet = async (caller: string, goalID: string) => {
      const space = await readSpace(caller)
      return space.goals.find((goal) => goal.id === goalID)
    }

    const spaceUpdate = async (
      caller: string,
      goalID: string,
      patch: {
        title?: string
        details?: string
        status?: SpaceStatus
        tags?: string[]
        parentID?: string
        taskID?: string
        goalID?: string
        assignedTo?: string
        result?: string
        note?: string
        completedBy?: string
      },
    ) => {
      const space = await readSpace(caller)
      const record = space.goals.find((goal) => goal.id === goalID)
      if (!record) throw new Error(`goal-space record ${goalID} not found`)
      if (patch.title !== undefined) {
        const title = String(patch.title).trim()
        if (!title) throw new Error("title must not be empty")
        record.title = title
      }
      if (patch.details !== undefined) record.details = String(patch.details).slice(0, MAX_DETAILS)
      if (patch.tags !== undefined) record.tags = patch.tags.map(String).filter(Boolean).slice(0, 20)
      if (patch.parentID !== undefined) record.parentID = String(patch.parentID) || undefined
      if (patch.taskID !== undefined) record.taskID = String(patch.taskID) || undefined
      if (patch.goalID !== undefined) record.goalID = String(patch.goalID) || undefined
      if (patch.assignedTo !== undefined) {
        const assigned = String(patch.assignedTo).trim()
        if (assigned) {
          await info(assigned)
          if (!(await sameTree(caller, assigned))) throw new Error(`assignedTo ${assigned} is outside this team tree`)
          record.assignedTo = assigned
        } else {
          delete record.assignedTo
        }
      }
      if (patch.result !== undefined) record.result = String(patch.result).slice(0, MAX_DETAILS)
      if (patch.status !== undefined) {
        if (!["planned", "active", "paused", "done", "blocked", "abandoned"].includes(patch.status))
          throw new Error(`invalid status "${patch.status}"`)
        record.status = patch.status
        if (patch.status === "done") {
          record.completedAt = record.completedAt ?? Date.now()
          record.completedBy = patch.completedBy ?? record.completedBy ?? caller
          record.completedByAgent = (await actor(record.completedBy)).agent
        } else if (patch.status === "active" || patch.status === "planned") {
          record.completedAt = undefined
          record.completedBy = undefined
          record.completedByAgent = undefined
        }
      }
      if (patch.completedBy !== undefined) record.completedBy = String(patch.completedBy)
      record.history.push(await spaceEvent("updated", caller, patch.note))
      record.history = record.history.slice(-MAX_HISTORY)
      record.updatedAt = Date.now()
      await saveSpace(space)
      if (record.status === "active" || record.status === "planned") await resetResearch(caller, "goal-space update")
      return record
    }

    const spaceComplete = async (
      caller: string,
      goalID: string,
      input: { result?: string; completedBy?: string; note?: string },
    ) => {
      const space = await readSpace(caller)
      const record = space.goals.find((goal) => goal.id === goalID)
      if (!record) throw new Error(`goal-space record ${goalID} not found`)
      const completedBy = String(input.completedBy ?? caller).trim() || caller
      if (completedBy !== caller) {
        await info(completedBy)
        if (!(await sameTree(caller, completedBy))) throw new Error(`completedBy ${completedBy} is outside this team tree`)
      }
      record.status = "done"
      record.completedBy = completedBy
      record.completedByAgent = (await actor(completedBy)).agent
      record.completedAt = Date.now()
      if (input.result !== undefined) record.result = String(input.result).slice(0, MAX_DETAILS)
      record.history.push(await spaceEvent("completed", completedBy, input.note ?? input.result?.slice(0, 200)))
      record.history = record.history.slice(-MAX_HISTORY)
      record.updatedAt = Date.now()
      await saveSpace(space)
      return record
    }

    const renderSpace = async (caller: string, limits: { status?: string; tag?: string; limit?: number } = {}) => {
      const space = await readSpace(caller)
      let goals = space.goals
      if (limits.status) goals = goals.filter((goal) => goal.status === limits.status)
      if (limits.tag) goals = goals.filter((goal) => goal.tags.includes(limits.tag!))
      if (limits.limit !== undefined) goals = goals.slice(-Math.max(1, Math.min(limits.limit, 200)))
      const lines = [`goal space · ${caller} · ${space.goals.length} record(s)`, ""]
      if (goals.length === 0) {
        lines.push("No records. Use action \"add\" with a title and optional long details.")
        return lines.join("\n")
      }
      for (const goal of goals) {
        lines.push(
          `[${goal.id}] ${goal.status} · ${goal.title}${goal.tags.length ? ` · tags=${goal.tags.join(",")}` : ""}`,
        )
        if (goal.details && goal.details !== goal.title) lines.push(goal.details.slice(0, 1200))
        const links = [
          goal.taskID ? `task=${goal.taskID}` : "",
          goal.goalID ? `goal=${goal.goalID}` : "",
          goal.assignedTo ? `assigned=${goal.assignedTo}` : "",
        ].filter(Boolean)
        if (links.length) lines.push(`links: ${links.join(" · ")}`)
        if (goal.completedBy)
          lines.push(
            `completed: ${goal.completedBy}${goal.completedByAgent ? ` (${goal.completedByAgent})` : ""}${goal.completedAt ? ` at ${new Date(goal.completedAt).toISOString()}` : ""}`,
          )
        if (goal.result) lines.push(`result: ${goal.result.slice(0, 600)}`)
        lines.push("")
      }
      return lines.join("\n").trimEnd()
    }

    const spaceStats = async (caller: string) => {
      const space = await readSpace(caller)
      const byStatus: Record<string, number> = {}
      const byCompleted: Record<string, number> = {}
      const byCompletedAgent: Record<string, number> = {}
      for (const goal of space.goals) {
        byStatus[goal.status] = (byStatus[goal.status] ?? 0) + 1
        if (goal.completedBy) byCompleted[goal.completedBy] = (byCompleted[goal.completedBy] ?? 0) + 1
        if (goal.completedByAgent)
          byCompletedAgent[goal.completedByAgent] = (byCompletedAgent[goal.completedByAgent] ?? 0) + 1
      }
      const recent = space.goals
        .filter((goal) => goal.completedAt)
        .toSorted((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
        .slice(0, 10)
        .map((goal) => ({
          id: goal.id,
          title: goal.title,
          completedBy: goal.completedBy,
          completedByAgent: goal.completedByAgent,
          completedAt: goal.completedAt,
        }))
      return {
        sessionID: caller,
        total: space.goals.length,
        byStatus,
        byCompleted,
        byCompletedAgent,
        recent,
        open: space.goals.filter((goal) => goal.status === "planned" || goal.status === "active").length,
        updatedAt: space.updatedAt,
      }
    }

    /** Create/update the detailed record for a built-in goal. */
    const upsertGoalRecord = async (
      target: string,
      goal: GoalState | null | undefined,
      caller: string,
      action: string,
      taskID?: string,
    ) => {
      if (!goal) return undefined
      const space = await readSpace(target)
      let record = space.goals.find((item) => item.goalID === goal.id)
      if (!record) {
        const now = Date.now()
        record = {
          id: newSpaceID(),
          title: goal.objective.slice(0, 400),
          details: goal.objective.slice(0, MAX_DETAILS),
          status: goal.status === "complete" ? "done" : goal.status === "paused" ? "paused" : "active",
          tags: ["goal"],
          ...(taskID ? { taskID } : {}),
          goalID: goal.id,
          createdBy: caller,
          assignedTo: target,
          ...(goal.status === "complete"
            ? { completedBy: target, completedByAgent: (await actor(target)).agent, completedAt: goal.updatedAt ?? now }
            : {}),
          history: [await spaceEvent(goal.status === "complete" ? "completed" : "created", caller, action)],
          createdAt: now,
          updatedAt: now,
        }
        if (goal.status === "complete" && goal.reason) record.result = goal.reason
        space.goals.push(record)
      } else {
        const before = record.status
        record.status = goal.status === "complete" ? "done" : goal.status === "paused" ? "paused" : "active"
        record.assignedTo = record.assignedTo ?? target
        if (taskID) record.taskID = taskID
        if (goal.status === "complete") {
          record.completedBy = record.completedBy ?? target
          record.completedByAgent = record.completedByAgent ?? (await actor(record.completedBy)).agent
          record.completedAt = record.completedAt ?? goal.updatedAt ?? Date.now()
          if (goal.reason) record.result = goal.reason
        }
        if (record.status !== before) {
          record.history.push(
            await spaceEvent(
              record.status === "done" ? "completed" : record.status === "paused" ? "paused" : "updated",
              caller,
              action,
            ),
          )
        }
        record.updatedAt = Date.now()
      }
      record.history = record.history.slice(-MAX_HISTORY)
      await saveSpace(space)
      return record
    }

    const completeGoalRecord = async (target: string, goal: GoalState | null | undefined) => {
      if (!goal) return undefined
      const space = await readSpace(target)
      let record = space.goals.find((item) => item.goalID === goal.id)
      if (!record) {
        record = await upsertGoalRecord(target, goal, target, "goal completed")
        return record
      }
      if (record.status === "done") return record
      record.status = "done"
      record.completedBy = record.completedBy ?? target
      record.completedByAgent = record.completedByAgent ?? (await actor(record.completedBy)).agent
      record.completedAt = record.completedAt ?? goal.updatedAt ?? Date.now()
      if (goal.reason) record.result = goal.reason
      record.history.push(await spaceEvent("completed", target, "built-in goal judged complete"))
      record.history = record.history.slice(-MAX_HISTORY)
      record.updatedAt = Date.now()
      await saveSpace(space)
      return record
    }

    const linkGoalStatus = async (target: string, goal: GoalState | null | undefined, action: string) => {
      if (!goal) return undefined
      const space = await readSpace(target)
      const record = space.goals.find((item) => item.goalID === goal.id)
      if (!record) return undefined
      if (goal.status === "paused" && record.status !== "paused") {
        record.status = "paused"
        record.history.push(await spaceEvent("paused", target, action))
      } else if (goal.status === "active" && record.status === "paused") {
        record.status = "active"
        record.history.push(await spaceEvent("reopened", target, action))
      } else if (action === "clear") {
        record.status = "abandoned"
        record.history.push(await spaceEvent("updated", target, "goal cleared"))
      }
      record.history = record.history.slice(-MAX_HISTORY)
      record.updatedAt = Date.now()
      await saveSpace(space)
      return record
    }

    // ---------------------------------------------------------------------
    // Auto research
    // ---------------------------------------------------------------------

    const readResearch = async (sessionID: string): Promise<ResearchState> => {
      const stored = (await ctx.storage.get(researchKey(sessionID))) as unknown as ResearchState | undefined
      if (!stored) {
        return {
          sessionID,
          enabled: autoResearch,
          blocked: false,
          nudges: 0,
          updatedAt: Date.now(),
        }
      }
      return {
        sessionID,
        enabled: stored.enabled !== false,
        blocked: stored.blocked === true,
        ...(stored.reason ? { reason: String(stored.reason) } : {}),
        ...(stored.blockedAt ? { blockedAt: Number(stored.blockedAt) } : {}),
        nudges: Number(stored.nudges ?? 0),
        ...(stored.lastNudgeAt ? { lastNudgeAt: Number(stored.lastNudgeAt) } : {}),
        ...(stored.lastUserAt ? { lastUserAt: Number(stored.lastUserAt) } : {}),
        updatedAt: Number(stored.updatedAt ?? Date.now()),
      }
    }

    const saveResearch = async (state: ResearchState) => {
      state.updatedAt = Date.now()
      await ctx.storage.set(researchKey(state.sessionID), JSON.parse(JSON.stringify(state)) as never)
    }

    const AUTO_RESEARCH_MESSAGE = `[auto-research] You stopped. Before asking the user or ending the turn:
1. List 1-3 concrete experiments or checks that can be done now without a user decision.
2. Record them in your goal space with goal_space (status "planned") and/or in goal_list.
3. Delegate independent experiments to subagents with subagent / isolate_spawn; do not run them all yourself.
4. Continue with the experiments. Only after exhausting all independent work should you ask the user, and then state what you already tried and the exact decision needed.
If you are truly blocked on a user decision, call auto_research with action "blocked" and a one-line reason; that stops these reminders.
This is an automated auto-research reminder, not the human user.`

    const lastTurnInfo = async (sessionID: string) => {
      try {
        const messages = (await ctx.session.context({ sessionID })) as unknown as Array<{
          type?: string
          time?: { created?: number }
          content?: Array<{ type?: string; text?: string }>
          text?: string
          metadata?: Record<string, unknown>
        }>
        let lastAssistant = ""
        let lastRealUserAt = 0
        for (const message of messages) {
          if (message.type === "user" && !message.metadata?.source) {
            lastRealUserAt = Math.max(lastRealUserAt, Number(message.time?.created ?? 0))
          }
          if (message.type !== "assistant") continue
          const text = (message.content ?? [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text!)
            .join("\n")
          if (text.trim()) lastAssistant = text
        }
        return { lastAssistant, lastRealUserAt }
      } catch {
        return { lastAssistant: "", lastRealUserAt: 0 }
      }
    }

    const looksLikeAskingUser = (text: string) =>
      /\b(would you like|which (option|approach|direction)|choose|let me know|do you want|should i|please (choose|confirm)|options?|next steps?)\b/i.test(
        text,
      ) || text.trim().endsWith("?")

    const nudgeResearch = async (sessionID: string, why: string) => {
      const state = await readResearch(sessionID)
      const now = Date.now()
      if (state.lastNudgeAt && now - state.lastNudgeAt < autoResearchCooldownSeconds * 1000)
        return { nudged: false, reason: "cooldown" }
      const inbox = (await ctx.session.synthetic({
        sessionID,
        text: AUTO_RESEARCH_MESSAGE,
        description: "auto-research reminder",
        metadata: { source: "auto-research", why },
        delivery: "queue",
      })) as unknown as { id?: string }
      state.lastNudgeAt = now
      state.nudges += 1
      await saveResearch(state)
      console.log(`[goal-tools] auto-research nudge ${sessionID} (${why})`)
      return { nudged: true, inboxID: inbox?.id ?? null, nudges: state.nudges }
    }

    const maybeNudge = async (sessionID: string, background: unknown) => {
      if (!autoResearch || dead) return
      const state = await readResearch(sessionID)
      if (!state.enabled || state.blocked) return
      if (Array.isArray(background)) {
        const busy = background.some((work: any) => work?.sessionID === sessionID && work?.kind === "subagent")
        if (busy) return
      }
      const goal = await read(sessionID)
      if (goal === undefined) return
      if (goal?.status === "active" || goal?.status === "paused") return

      const [space, list, turn] = await Promise.all([readSpace(sessionID), readList(sessionID), lastTurnInfo(sessionID)])
      if (turn.lastRealUserAt > (state.lastUserAt ?? 0)) {
        state.lastUserAt = turn.lastRealUserAt
        state.nudges = 0
        if (state.blocked) {
          state.blocked = false
          state.reason = undefined
          state.blockedAt = undefined
        }
      }
      const hasContext = space.goals.length > 0 || list.tasks.length > 0 || goal !== null
      if (!hasContext) return
      const openWork =
        space.goals.some((record) => record.status === "planned" || record.status === "active") ||
        list.tasks.some((task) => task.status !== "done")
      const askingUser = looksLikeAskingUser(turn.lastAssistant)
      if (!openWork && !askingUser) return
      if (state.nudges >= autoResearchMaxNudges) return
      await saveResearch(state)
      await nudgeResearch(sessionID, askingUser ? "asked the user with open research context" : "open research work")
    }

    const researchStatus = async (sessionID: string) => {
      const [state, space, list, goal] = await Promise.all([
        readResearch(sessionID),
        readSpace(sessionID),
        readList(sessionID),
        read(sessionID),
      ])
      return {
        sessionID,
        enabled: state.enabled,
        blocked: state.blocked,
        ...(state.reason ? { reason: state.reason } : {}),
        nudges: state.nudges,
        ...(state.lastNudgeAt ? { lastNudgeAt: state.lastNudgeAt } : {}),
        spaceRecords: space.goals.length,
        openSpaceRecords: space.goals.filter((record) => record.status === "planned" || record.status === "active").length,
        openTasks: list.tasks.filter((task) => task.status !== "done").length,
        goal: goal ? { status: goal.status, objective: goal.objective } : null,
      }
    }

    const setResearch = async (
      sessionID: string,
      patch: { enabled?: boolean; blocked?: boolean; reason?: string },
    ) => {
      const state = await readResearch(sessionID)
      if (patch.enabled !== undefined) state.enabled = Boolean(patch.enabled)
      if (patch.blocked !== undefined) {
        state.blocked = Boolean(patch.blocked)
        state.reason = patch.blocked ? String(patch.reason ?? "blocked on a user decision") : undefined
        state.blockedAt = patch.blocked ? Date.now() : undefined
        if (!patch.blocked) state.nudges = 0
      }
      await saveResearch(state)
      return state
    }

    /**
     * If the judged goal is complete but the session still has open work, tell
     * the agent to update the goal instead of treating "goal met" as the end.
     */
    const notifyGoalMet = async (sessionID: string, goal: GoalState) => {
      const space = await readSpace(sessionID)
      const list = await readList(sessionID)
      if (space.lastGoalNoticeID === goal.id) return { notified: false, reason: "already notified" }
      const openRecords = space.goals.filter(
        (record) => record.goalID !== goal.id && (record.status === "planned" || record.status === "active"),
      )
      const openTasks = list.tasks.filter((task) => task.status === "pending" || task.status === "active")
      if (openRecords.length === 0 && openTasks.length === 0) return { notified: false, reason: "no open work" }
      // The list auto-sync will promote a pending task and the goal engine's
      // kickoff is itself the "update the goal" message. Avoid a duplicate.
      // Deferred tasks are invisible to that promotion, so they must not
      // suppress the notice: a completed goal plus a parked task would go
      // silent (no notice, no promotion) until someone called sync explicitly.
      if (autoSync && openTasks.some((task) => task.status === "pending" && !task.deferred))
        return { notified: false, reason: "goal-list promotion will update the goal" }
      const lines = [
        `[goal-met] The goal "${goal.objective}" was judged complete.`,
        `But this session still has ${openRecords.length} open goal-space record(s) and ${openTasks.length} open goal-list task(s).`,
      ]
      if (openRecords.length > 0) {
        lines.push("Open goal-space records:")
        for (const record of openRecords.slice(0, 8))
          lines.push(`- ${record.id} | ${record.status} | ${record.title}`)
      }
      if (openTasks.length > 0) {
        lines.push("Open goal-list tasks:")
        for (const task of openTasks.slice(0, 8)) lines.push(`- ${task.id} | ${task.status} | ${task.text}`)
      }
      lines.push(
        "",
        "Do not stop at goal met. Update the active goal now:",
        "- mark the finished record done with goal_space action \"complete\";",
        "- set the next concrete objective with goal action \"set\", or promote the next task with goal_list action \"sync\";",
        "- record the new experiment in the goal space and continue, delegating independent experiments to subagents.",
        "This is an automated goal-met reminder, not the human user.",
      )
      await ctx.session.synthetic({
        sessionID,
        text: lines.join("\n"),
        description: "goal met but open work remains",
        metadata: { source: "goal-met", goalID: goal.id },
        delivery: "queue",
      })
      space.lastGoalNoticeID = goal.id
      await saveSpace(space)
      console.log(`[goal-tools] goal-met notice ${sessionID} (${openRecords.length} records / ${openTasks.length} tasks)`)
      return { notified: true, openRecords: openRecords.length, openTasks: openTasks.length }
    }

    let syncingSpaces = false
    const syncSpacesOnce = async () => {
      if (dead || syncingSpaces) return
      syncingSpaces = true
      try {
        const entries: Array<{ key: string; value: unknown }> = []
        let after: string | undefined
        for (let page = 0; page < 20; page++) {
          const result = (await ctx.storage.scan({ prefix: SPACE_PREFIX, after, limit: 200 })) as unknown as {
            entries: Array<{ key: string; value: unknown }>
            next?: string
          }
          entries.push(...result.entries)
          if (!result.next) break
          after = result.next
        }
        for (const entry of entries) {
          if (dead) break
          const space = entry.value as GoalSpace
          if (!space || !Array.isArray(space.goals) || space.goals.length === 0) continue
          try {
            const session = await info(space.sessionID)
            if ((await canonical(session.location?.directory)) !== (await canonical(ctx.location.directory))) continue
            const goal = await read(space.sessionID)
            if (goal === undefined) continue
            if (goal === null) {
              // The built-in `/goal clear` (and any clear that does not go through
              // changeControl) removes the session goal without touching the goal
              // space, and syncList's retirement branch never sees a goal to
              // complete. A mirror record still bound to a built-in goal id can
              // never be reopened once the goal is gone, so close it here;
              // otherwise it stays `active` for a goal that no longer exists.
              const stranded = space.goals.filter(
                (record) =>
                  record.goalID && (record.status === "active" || record.status === "planned"),
              )
              if (stranded.length > 0) {
                const list = await readList(space.sessionID)
                const retiredAt = Date.now()
                for (const record of stranded) {
                  const task = list.tasks.find((item) => item.id === record.taskID)
                  if (task?.status === "done") {
                    // The cleared goal had finished its work: this is a
                    // completion that only the missing hook failed to record.
                    record.status = "done"
                    record.completedBy = record.completedBy ?? space.sessionID
                    record.completedByAgent =
                      record.completedByAgent ?? (await actor(record.completedBy)).agent
                    record.completedAt = record.completedAt ?? retiredAt
                    record.result = record.result ?? "goal cleared outside the goal tool"
                    record.history.push(
                      await spaceEvent("completed", space.sessionID, "goal cleared outside the goal tool"),
                    )
                  } else {
                    // The goal vanished while its task was still open: that is
                    // an abandonment, not a completion, so it must not carry a
                    // completedAt and must not look like finished work.
                    record.status = "abandoned"
                    record.result =
                      record.result ?? "goal cleared outside the goal tool while work was open"
                    record.history.push(
                      await spaceEvent("updated", space.sessionID, "goal cleared outside the goal tool"),
                    )
                  }
                  record.history = record.history.slice(-MAX_HISTORY)
                  record.updatedAt = retiredAt
                }
                await saveSpace(space)
                console.log(
                  `[goal-tools] reconciled ${stranded.length} stranded goal-space record(s) for ${space.sessionID}`,
                )
              }
              continue
            }
            if (goal.status === "paused") {
              await linkGoalStatus(space.sessionID, goal, "goal paused")
              continue
            }
            if (goal.status === "complete") {
              await completeGoalRecord(space.sessionID, goal)
              await notifyGoalMet(space.sessionID, goal)
              continue
            }
            // Active goal: record it if it was set outside the goal tool
            // (for example the built-in /goal command).
            if (!space.goals.some((record) => record.goalID === goal.id))
              await upsertGoalRecord(space.sessionID, goal, space.sessionID, "observed active goal")
          } catch {
            // session may be deleted
          }
        }
      } catch (error) {
        console.error("[goal-tools] goal-space sync failed:", error)
      } finally {
        syncingSpaces = false
      }
    }

    // ---------------------------------------------------------------------
    // Synthetic messages / notifications
    // ---------------------------------------------------------------------

    const notify = async (target: string, caller: string, text: string, kind: string) => {
      try {
        await ctx.session.synthetic({
          sessionID: target,
          text,
          description: `goal ${kind} from ${caller}`,
          metadata: { goalTools: { from: caller, kind } },
          delivery: "steer",
        })
      } catch {
        // target may be gone
      }
    }

    const authorized = async (caller: string, target: string, action: string) => {
      const targetInfo = await info(target)
      if (!allowSubagents && targetInfo.parentID) throw new Error("goals are disabled for subagent sessions")
      if (!(await sameTree(caller, target))) throw new Error(`target ${target} is outside this team tree`)
    }

    const setObjective = async (
      caller: string,
      target: string,
      objective: string,
      action: "set" | "update",
      notifyTarget: boolean,
    ) => {
      await authorized(caller, target, action)
      const list = await readList(target)
      await run(target, objective)
      const after = await read(target)
      const bound = list.tasks.find((task) => task.text === objective && task.status !== "done")
      list.activeObjective = objective
      // Naming a task in `goal set`/assign is an explicit instruction to work on
      // it, so a pending task is started here and loses `deferred`. Leaving it
      // pending+deferred while `activeTaskID` points at it produced two states
      // that contradict each other: nothing would ever flip the task to active,
      // and `complete` without a taskID had to fall back to an unrelated task.
      if (bound && bound.status === "pending") {
        bound.status = "active"
        delete bound.deferred
        bound.updatedAt = Date.now()
      }
      list.activeTaskID = bound?.id
      // Replacing the objective unbinds whatever the old goal was working on.
      // Leaving that task `active` strands it: syncList only retires a goal when
      // the *bound* task is done, and activeTaskID is now undefined, so the tick
      // reports `active` forever and `goal_list complete` cannot clear the goal.
      for (const task of list.tasks) {
        if (task.status === "active" && task !== bound) {
          task.status = "pending"
          task.updatedAt = Date.now()
        }
      }
      await saveList(list)
      await upsertGoalRecord(target, after, caller, `goal ${action}`)
      await resetResearch(target, `goal ${action}`)
      if (notifyTarget && caller !== target) {
        await notify(
          target,
          caller,
          [
            `[goal-update from ${caller}] Another agent changed your session goal.`,
            `action: ${action}`,
            `objective: ${objective}`,
            `status: ${after?.status ?? "unknown"}`,
            "",
            "Keep working toward it. When the goal is met or new tasks arrive, call goal_list with action \"sync\".",
          ].join("\n"),
          action,
        )
      }
      return { after, list }
    }

    const changeControl = async (caller: string, target: string, action: "pause" | "resume" | "clear", notifyTarget: boolean) => {
      await authorized(caller, target, action)
      const list = await readList(target)
      const before = await read(target)
      await run(target, action)
      const after = await read(target)
      await linkGoalStatus(target, action === "clear" ? before : after, action)
      if (action === "clear") {
        list.activeTaskID = undefined
        list.activeObjective = undefined
      }
      if (action === "resume") {
        if (!list.activeObjective && after?.objective) list.activeObjective = after.objective
      }
      await saveList(list)
      if (notifyTarget && caller !== target) {
        const verb = action === "pause" ? "paused" : action === "resume" ? "resumed" : "cleared"
        await notify(
          target,
          caller,
          [
            `[goal-update from ${caller}] Your session goal was ${verb} by another agent.`,
            after ? describe(after) : "No goal is set.",
            "",
            "Continue from the current goal state; use goal_list to keep the task queue current.",
          ].join("\n"),
          action,
        )
      }
      return { after, list }
    }

    /**
     * Reconcile the built-in goal with the task queue:
     *   - a complete goal finishes the active task and promotes the next pending one
     *   - no goal (or autoStart with a fresh list) starts the first pending task
     *   - a manual goal change is adopted instead of overwritten
     */
    const syncList = async (target: string, caller: string, trigger: "manual" | "auto", allowDeferred = false) => {
      const list = await readList(target)
      if (list.tasks.length === 0) return { action: "empty" as const, list }
      let goal = await read(target)
      if (goal === undefined) return { action: "unreadable" as const, list }

      const active = list.activeTaskID ? list.tasks.find((task) => task.id === list.activeTaskID) : undefined

      // Promote `next` into the session goal and bind it to the list. Shared by
      // the "goal just finished" and the "bound task already done" paths so a
      // completed task always hands the queue over in the same call.
      const activate = async (next: Task) => {
        next.status = "active"
        next.deferred = undefined
        next.updatedAt = Date.now()
        list.activeTaskID = next.id
        list.activeObjective = next.text
        await saveList(list)
        await run(target, next.text)
        const promoted = await read(target)
        await upsertGoalRecord(target, promoted, caller, "promoted from goal list", next.id)
        if (trigger === "auto" && caller !== target) {
          await notify(
            target,
            caller,
            `[goal-list] Promoted the next task to the session goal:\n${next.text}`,
            "promote",
          )
        }
        return { action: "promoted" as const, list, goal, task: next }
      }

      // The judged goal finished: mark its task done before doing anything else.
      if (active && active.status !== "done" && goal?.status === "complete") {
        active.status = "done"
        active.updatedAt = Date.now()
        list.activeTaskID = undefined
        list.activeObjective = undefined
        await completeGoalRecord(target, goal)
      }

      // A manually changed active goal wins over the queue.
      if (goal?.status === "active" && list.activeObjective && goal.objective !== list.activeObjective) {
        const match = list.tasks.find((task) => task.status !== "done" && task.text === goal.objective)
        list.activeTaskID = match?.id
        list.activeObjective = goal.objective
        if (match) {
          match.status = "active"
          delete match.deferred
          match.updatedAt = Date.now()
        }
        await saveList(list)
        return { action: "adopted" as const, list, goal }
      }

      if (goal?.status === "active") {
        const bound = list.activeTaskID ? list.tasks.find((task) => task.id === list.activeTaskID) : undefined
        if (!bound || bound.status !== "done") {
          if (!list.activeTaskID) {
            const match = list.tasks.find((task) => task.status !== "done" && task.text === goal.objective)
            if (match) {
              match.status = "active"
              delete match.deferred
              match.updatedAt = Date.now()
              list.activeTaskID = match.id
              list.activeObjective = goal.objective
              await saveList(list)
            }
          }
          return { action: "active" as const, list, goal }
        }
        // The bound task finished without the judge completing the goal: retire it
        // and fall through, so the next pending task is promoted in this same call.
        // Returning here would leave a ready task waiting for the next 10 s tick.
        list.activeTaskID = undefined
        list.activeObjective = undefined
        await saveList(list)
        // Retirement by a finished bound task is still a completion of the
        // built-in goal: close its goal-space mirror before the goal is cleared,
        // otherwise the record stays `active` for a goal that no longer exists.
        await completeGoalRecord(target, goal)
        await run(target, "clear")
        goal = await read(target)
      }

      if (goal?.status === "paused") {
        await saveList(list)
        return { action: "paused" as const, list, goal }
      }

      // The list claims a task is active, but the session has no goal: the goal was
      // cleared from outside the queue, or a promotion crashed between saveList and
      // run. With autoStart on, restart the bound task instead of leaving a list
      // that reports `active` while the goal engine has nothing to work on.
      if (goal === null && list.autoStart && list.activeTaskID) {
        const bound = list.tasks.find((task) => task.id === list.activeTaskID)
        if (bound && bound.status === "active") return await activate(bound)
      }

      // The bound task is done but its goal is already gone, so the retirement
      // branch above never saw a `complete` goal to act on. Drop the pointer
      // here: a list that binds a finished task with no goal is an orphan.
      if (goal === null && list.activeTaskID) {
        const bound = list.tasks.find((task) => task.id === list.activeTaskID)
        if (bound && bound.status === "done") {
          list.activeTaskID = undefined
          list.activeObjective = undefined
        }
      }

      // No goal, or the previous one completed.
      // A deferred task is invisible to implicit promotion (autoSync, add, complete,
      // update); only an explicit goal_list sync/update may start it.
      const next = list.tasks.find(
        (task) => task.status === "pending" && (allowDeferred || !task.deferred),
      )
      if (!next) {
        await saveList(list)
        return { action: "complete" as const, list, goal }
      }
      if (goal?.status === "complete" || list.autoStart) {
        next.status = "active"
        next.deferred = undefined
        next.updatedAt = Date.now()
        list.activeTaskID = next.id
        list.activeObjective = next.text
        await saveList(list)
        await run(target, next.text)
        const promoted = await read(target)
        await upsertGoalRecord(target, promoted, caller, "promoted from goal list", next.id)
        if (trigger === "auto" && caller !== target) {
          await notify(
            target,
            caller,
            `[goal-list] Promoted the next task to the session goal:\n${next.text}`,
            "promote",
          )
        }
        return { action: "promoted" as const, list, goal, task: next }
      }
      await saveList(list)
      return { action: "idle" as const, list, goal }
    }

    const addTasks = async (target: string, texts: string[], startNow: boolean | undefined) => {
      const list = await readList(target)
      const now = Date.now()
      const added: Task[] = []
      for (const raw of texts) {
        const text = String(raw ?? "").trim()
        if (!text) continue
        const task: Task = {
          id: newTaskID(),
          text,
          status: "pending",
          deferred: startNow === false ? true : undefined,
          createdAt: now,
          updatedAt: now,
        }
        list.tasks.push(task)
        added.push(task)
      }
      await saveList(list)
      if (added.length > 0) await resetResearch(target, "new goal-list tasks")
      let synced: Awaited<ReturnType<typeof syncList>> | undefined
      if (added.length > 0 && startNow !== false) {
        const current = await read(target)
        if (!current || current.status === "complete") synced = await syncList(target, target, "manual")
      }
      return { list: synced?.list ?? (await readList(target)), added, synced }
    }

    const updateTask = async (target: string, taskID: string, patch: { text?: string; status?: TaskStatus; note?: string }) => {
      const list = await readList(target)
      const task = list.tasks.find((item) => item.id === taskID)
      if (!task) throw new Error(`task ${taskID} not found`)
      let retiredGoal = false
      let startedGoal = false
      if (patch.text !== undefined) {
        const text = String(patch.text).trim()
        if (!text) throw new Error("task text must not be empty")
        task.text = text
      }
      if (patch.status !== undefined) {
        if (!["pending", "active", "done", "blocked"].includes(patch.status))
          throw new Error(`invalid task status ${patch.status}`)
        task.status = patch.status
        if (patch.status === "active") {
          // An explicit status change is the documented way to start a task
          // added with startNow:false, so clear the flag and bind the goal.
          delete task.deferred
          list.activeTaskID = task.id
          list.activeObjective = task.text
          startedGoal = true
        }
        // Keep the pointer on a done task so syncList can retire its goal.
        if (patch.status === "done" && list.activeTaskID === task.id) retiredGoal = true
      }
      if (patch.note !== undefined) {
        if (patch.note) task.note = String(patch.note)
        else delete task.note
      }
      task.updatedAt = Date.now()
      await saveList(list)
      if (startedGoal) {
        await run(target, task.text)
        await upsertGoalRecord(target, await read(target), target, "started from goal list", task.id)
        return readList(target)
      }
      if (retiredGoal) return (await syncList(target, target, "manual")).list
      return list
    }

    const completeTask = async (target: string, taskID: string | undefined, promote: boolean) => {
      const list = await readList(target)
      const goal = await read(target)
      // Prefer the task the goal names when no pointer survived. Falling back to
      // "the first task that is not done" completed an unrelated queued task in
      // the S2 probe (goal = B, but A was completed because the binding was lost).
      const named = goal?.objective
        ? list.tasks.find((task) => task.status !== "done" && task.text === goal.objective)
        : undefined
      const id = taskID || list.activeTaskID || named?.id || list.tasks.find((task) => task.status !== "done")?.id
      const task = list.tasks.find((item) => item.id === id)
      if (!task) throw new Error("no task to complete")
      task.status = "done"
      // Keep the queue's pointer on the completed task even when it was recovered
      // by objective: syncList retires the goal only when the *bound* task is
      // done, so a missing pointer would leave the goal active on a done task.
      if (!list.activeTaskID) {
        list.activeTaskID = task.id
        list.activeObjective = task.text
      }
      task.updatedAt = Date.now()
      // Keep activeTaskID pointing at the done task: syncList retires the goal
      // in that case instead of returning {action:"active"} forever.
      await saveList(list)
      const synced = promote ? await syncList(target, target, "manual") : undefined
      return { task, list: synced?.list ?? list, synced }
    }

    const removeTask = async (target: string, taskID: string) => {
      const list = await readList(target)
      const index = list.tasks.findIndex((task) => task.id === taskID)
      if (index === -1) throw new Error(`task ${taskID} not found`)
      const [task] = list.tasks.splice(index, 1)
      if (list.activeTaskID === taskID) {
        list.activeTaskID = undefined
        list.activeObjective = undefined
      }
      await saveList(list)
      return { list, task }
    }

    const renderList = async (target: string) => {
      const list = await readList(target)
      const goal = await read(target)
      const lines = [`goal list · ${target} · ${list.tasks.length} task(s) · autoSync=${list.autoSync}`, ""]
      if (goal) lines.push(`active goal: [${goal.status}] ${goal.objective}`, "")
      else lines.push("active goal: (none)", "")
      if (list.tasks.length === 0) {
        lines.push("No tasks. Use action \"add\" with tasks: [\"...\"].")
        return lines.join("\n")
      }
      for (const task of list.tasks) {
        const marker = task.id === list.activeTaskID ? "*" : " "
        const parked = task.deferred && task.status === "pending" ? " | deferred: starts only on sync" : ""
        lines.push(`${marker} ${task.id} | ${task.status} | ${task.text}${task.note ? ` | note: ${task.note}` : ""}${parked}`)
      }
      return lines.join("\n")
    }

    const renderLists = async (rootID: string) => {
      const entries: Array<{ key: string; value: unknown }> = []
      let after: string | undefined
      for (let page = 0; page < 20; page++) {
        const result = (await ctx.storage.scan({ prefix: LIST_PREFIX, after, limit: 200 })) as unknown as {
          entries: Array<{ key: string; value: unknown }>
          next?: string
        }
        entries.push(...result.entries)
        if (!result.next) break
        after = result.next
      }
      const lines: string[] = []
      for (const entry of entries) {
        const list = entry.value as GoalList
        if (!list || !Array.isArray(list.tasks) || list.tasks.length === 0) continue
        let session: SessionInfo
        try {
          session = await info(list.sessionID)
        } catch {
          continue
        }
        let current: SessionInfo = session
        let root: SessionInfo = session
        for (let guard = 0; guard < 64; guard++) {
          if (!current.parentID) {
            root = current
            break
          }
          current = await info(current.parentID)
        }
        if (root.id !== rootID) continue
        const pending = list.tasks.filter((task) => task.status !== "done").length
        lines.push(`${list.sessionID} | ${pending} open / ${list.tasks.length} | active: ${list.activeTaskID ?? "-"}`)
      }
      return lines.length ? lines.join("\n") : "No goal lists in this team tree."
    }

    const toolFail = (error: unknown) => ({
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
    })

    // ---------------------------------------------------------------------
    // Tools
    // ---------------------------------------------------------------------

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "goal",
        description:
          "Create, replace, inspect, pause, resume or clear a session goal (OpenCode's goal engine keeps working until a judge says it is met). " +
          "Use action=set as soon as a task needs more than one step; use set again to change the objective. " +
          "Pass sessionID to change another agent's goal in the same team tree; that injects a system message there.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["set", "update", "pause", "resume", "clear", "status"],
              description:
                "set/update: create or replace the goal. pause/resume: stop or continue the goal loop. clear: delete the goal. status: read it.",
            },
            objective: {
              type: "string",
              description: "Required for action=set/update. One short, verifiable sentence describing the outcome.",
            },
            sessionID: {
              type: "string",
              description: "Target session (default: this session). Use a child/parent/sibling ID in the same team tree.",
            },
            notify: {
              type: "boolean",
              description: "Inject a system message describing the change (default true when targeting another session).",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        // Direct tool: the TUI agent must be able to call it without going through Code Mode.
        options: { codemode: false },
        execute: async (input, context) => {
          const args = (input ?? {}) as {
            action?: string
            objective?: string
            sessionID?: string
            notify?: boolean
          }
          const action = String(args.action ?? "").toLowerCase()
          const caller = context.sessionID
          const target = args.sessionID?.trim() || caller
          const fail = (message: string) => ({ content: `Error: ${message}` })

          try {
            if (action === "status") {
              if (target !== caller) await authorized(caller, target, "status")
              return { content: describe(await read(target)) }
            }

            if (action === "set" || action === "update") {
              const objective = String(args.objective ?? "").trim()
              if (!objective) return fail("objective is required for action=set")
              if (objective.length > OBJECTIVE_LIMIT)
                return fail(`objective is ${objective.length} characters; the limit is ${OBJECTIVE_LIMIT}`)

              if (!allowSubagents && target === caller) {
                try {
                  const me = await info(caller)
                  if (me.parentID) return fail("goals are disabled for subagent sessions")
                } catch {}
              }

              const before = await read(target)
              const result = await setObjective(caller, target, objective, action, args.notify !== false)
              const replaced =
                before && before.status !== "complete" && before.objective !== objective
                  ? `\nreplaced objective: ${before.objective}`
                  : ""
              return { content: `Goal ${action === "update" ? "updated" : "set"}.\n${describe(result.after)}${replaced}` }
            }

            if (action === "pause" || action === "resume" || action === "clear") {
              const result = await changeControl(caller, target, action, args.notify !== false)
              if (action === "clear") return { content: "Goal cleared." }
              return { content: `Goal ${action}d.\n${describe(result.after)}` }
            }

            return fail(`unknown action "${args.action}"; expected set, update, pause, resume, clear or status`)
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error))
          }
        },
      })

      editor.add({
        name: "goal_list",
        description:
          "Maintain a durable task list for a session and keep it in sync with the built-in goal. " +
          "add queues tasks, complete marks one done, sync promotes the next pending task to the active goal, update edits a task, remove deletes one. " +
          "A parent may edit a child's list with sessionID. When a goal is met but tasks remain, sync is the correct action.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["add", "update", "complete", "remove", "list", "sync", "clear"],
              description: "add | update | complete | remove | list | sync | clear",
            },
            sessionID: { type: "string", description: "Target session (default: this session); must be in the same team tree." },
            tasks: {
              type: "array",
              items: { type: "string" },
              description: "For add: new task descriptions (in order).",
            },
            task: { type: "string", description: "For add: a single task description." },
            taskID: { type: "string", description: "For update/complete/remove: task ID (default: active or first open)." },
            text: { type: "string", description: "For update: replacement text." },
            status: {
              type: "string",
              enum: ["pending", "active", "done", "blocked"],
              description: "For update: new status.",
            },
            note: { type: "string", description: "For update: free-form note." },
            startNow: {
              type: "boolean",
              description:
                "For add: mark the new tasks deferred and promote the first when no goal is active (default true). " +
                "With false every task in the batch stays parked until an explicit sync starts the first one.",
            },
            promote: { type: "boolean", description: "For complete: promote the next task (default true)." },
            clearGoal: { type: "boolean", description: "For clear: also clear the active goal." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const args = (input ?? {}) as any
          const action = String(args.action ?? "").toLowerCase()
          const caller = context.sessionID
          const target = args.sessionID?.trim() || caller
          try {
            if (target !== caller) await authorized(caller, target, action)
            const targetInfo = await info(target)
            if (!allowSubagents && targetInfo.parentID) throw new Error("goals are disabled for subagent sessions")

            if (action === "list") {
              return { content: await renderList(target) }
            }
            if (action === "add") {
              const texts = Array.isArray(args.tasks) ? args.tasks.map(String) : args.task ? [String(args.task)] : []
              if (texts.length === 0) throw new Error("tasks (array) or task (string) is required for add")
              const result = await addTasks(target, texts, args.startNow)
              const lines = [
                `Added ${result.added.length} task(s) to ${target}.`,
                ...result.added.map((task) => `- ${task.id} | ${task.text}`),
              ]
              if (result.synced) lines.push(`sync: ${result.synced.action}`)
              return { content: lines.join("\n") }
            }
            if (action === "update") {
              if (!args.taskID) throw new Error("taskID is required for update")
              const list = await updateTask(target, String(args.taskID), {
                ...(args.text !== undefined ? { text: String(args.text) } : {}),
                ...(args.status !== undefined ? { status: args.status } : {}),
                ...(args.note !== undefined ? { note: String(args.note) } : {}),
              })
              return { content: `Updated task.\n\n${await renderList(target)}` }
            }
            if (action === "complete") {
              const result = await completeTask(target, args.taskID ? String(args.taskID) : undefined, args.promote !== false)
              const lines = [`Completed task ${result.task.id}: ${result.task.text}`]
              if (result.synced) lines.push(`sync: ${result.synced.action}${result.synced.task ? ` -> ${result.synced.task.text}` : ""}`)
              return { content: lines.join("\n") }
            }
            if (action === "remove") {
              if (!args.taskID) throw new Error("taskID is required for remove")
              await removeTask(target, String(args.taskID))
              return { content: `Removed task.\n\n${await renderList(target)}` }
            }
            if (action === "sync") {
              const result = await syncList(target, caller, "manual", true)
              if (result.action === "promoted")
                return { content: `Promoted next task to the goal.\n${describe(await read(target))}` }
              if (result.action === "complete") return { content: "All tasks are done; no pending task to promote." }
              if (result.action === "unreadable") return { content: "Goal engine is unavailable; task list is unchanged." }
              return { content: `sync: ${result.action}.\n${describe(await read(target))}` }
            }
            if (action === "clear") {
              const list = await readList(target)
              list.tasks = []
              list.activeTaskID = undefined
              list.activeObjective = undefined
              await saveList(list)
              if (args.clearGoal) await run(target, "clear")
              return { content: "Goal list cleared." }
            }
            throw new Error(`unknown action "${args.action}"; use add, update, complete, remove, list, sync or clear`)
          } catch (error) {
            return toolFail(error)
          }
        },
      })

      editor.add({
        name: "goal_tree",
        description: "Show goal lists for every session in this team tree (open/total tasks and active task).",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, context) => {
          try {
            const root = await rootOf(context.sessionID)
            return { content: await renderLists(root.id) }
          } catch (error) {
            return toolFail(error)
          }
        },
      })

      editor.add({
        name: "goal_space",
        description:
          "Store detailed, long-form goals for THIS session: research plans, experiment protocols, hypotheses and results. " +
          "The goal space is isolated per session. Each record has a long details field, status, tags, links to a goal_list task or the built-in goal, " +
          "creator/assignee, and a history. Completion records completedBy (session/agent) and completedAt. " +
          "Use add to write the plan, update to enrich it, complete when another agent finishes it, stats to see counts.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["add", "update", "complete", "list", "get", "stats", "archive"],
            },
            goalID: { type: "string", description: "Record ID for update/complete/get/archive." },
            title: { type: "string", description: "Short title (required for add)." },
            details: { type: "string", description: "Long plan / experiment protocol / hypothesis / result." },
            status: {
              type: "string",
              enum: ["planned", "active", "paused", "done", "blocked", "abandoned"],
              description: "For add/update.",
            },
            tags: { type: "array", items: { type: "string" } },
            parentID: { type: "string", description: "Optional parent goal-space record." },
            taskID: { type: "string", description: "Optional goal_list task link." },
            goalIDLink: { type: "string", description: "Optional built-in goal link (goal ID)." },
            assignedTo: { type: "string", description: "Optional agent/session assigned to this goal." },
            result: { type: "string", description: "Result / evidence for complete." },
            note: { type: "string", description: "History note." },
            completedBy: {
              type: "string",
              description: "For complete: the session that accomplished it (default: this session).",
            },
            filterStatus: {
              type: "string",
              enum: ["planned", "active", "paused", "done", "blocked", "abandoned"],
              description: "For list.",
            },
            filterTag: { type: "string", description: "For list." },
            limit: { type: "number", description: "For list (max 200)." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const args = (input ?? {}) as any
          const action = String(args.action ?? "").toLowerCase()
          const caller = context.sessionID
          try {
            if (args.sessionID && String(args.sessionID) !== caller)
              throw new Error("goal space is isolated per session; use your own sessionID")
            if (action === "add") {
              const record = await spaceAdd(caller, {
                title: args.title,
                details: args.details,
                status: args.status,
                tags: args.tags,
                parentID: args.parentID,
                taskID: args.taskID,
                goalID: args.goalIDLink,
                assignedTo: args.assignedTo,
              })
              return { content: `Added goal-space record ${record.id}.\n\n${await renderSpace(caller, { limit: 20 })}` }
            }
            if (action === "update") {
              if (!args.goalID) throw new Error("goalID is required for update")
              const record = await spaceUpdate(caller, String(args.goalID), {
                ...(args.title !== undefined ? { title: String(args.title) } : {}),
                ...(args.details !== undefined ? { details: String(args.details) } : {}),
                ...(args.status !== undefined ? { status: args.status } : {}),
                ...(args.tags !== undefined ? { tags: args.tags } : {}),
                ...(args.parentID !== undefined ? { parentID: String(args.parentID) } : {}),
                ...(args.taskID !== undefined ? { taskID: String(args.taskID) } : {}),
                ...(args.goalIDLink !== undefined ? { goalID: String(args.goalIDLink) } : {}),
                ...(args.assignedTo !== undefined ? { assignedTo: String(args.assignedTo) } : {}),
                ...(args.result !== undefined ? { result: String(args.result) } : {}),
                ...(args.completedBy !== undefined ? { completedBy: String(args.completedBy) } : {}),
                ...(args.note !== undefined ? { note: String(args.note) } : {}),
              })
              return { content: `Updated goal-space record ${record.id} (${record.status}).` }
            }
            if (action === "complete") {
              if (!args.goalID) throw new Error("goalID is required for complete")
              const record = await spaceComplete(caller, String(args.goalID), {
                result: args.result !== undefined ? String(args.result) : undefined,
                completedBy: args.completedBy !== undefined ? String(args.completedBy) : undefined,
                note: args.note !== undefined ? String(args.note) : undefined,
              })
              return { content: `Completed goal-space record ${record.id} by ${record.completedBy} at ${new Date(record.completedAt ?? Date.now()).toISOString()}.` }
            }
            if (action === "list") {
              return {
                content: await renderSpace(caller, {
                  status: args.filterStatus,
                  tag: args.filterTag,
                  limit: args.limit,
                }),
              }
            }
            if (action === "get") {
              if (!args.goalID) throw new Error("goalID is required for get")
              const record = await spaceGet(caller, String(args.goalID))
              if (!record) throw new Error(`goal-space record ${args.goalID} not found`)
              return { content: JSON.stringify(record, null, 2) }
            }
            if (action === "stats") return { content: JSON.stringify(await spaceStats(caller), null, 2) }
            if (action === "archive") {
              if (!args.goalID) throw new Error("goalID is required for archive")
              const record = await spaceUpdate(caller, String(args.goalID), { status: "abandoned", note: "archived" })
              return { content: `Archived goal-space record ${record.id}.` }
            }
            throw new Error(`unknown action "${args.action}"; use add, update, complete, list, get, stats or archive`)
          } catch (error) {
            return toolFail(error)
          }
        },
      })

      editor.add({
        name: "auto_research",
        description:
          "Control the automatic research reminders for this session. When you would stop with open research work, the plugin inserts a reminder " +
          "to record experiments in goal_space, delegate them to subagents, and continue instead of asking the user. " +
          "Use action=blocked when a decision truly requires the user (this stops reminders); resume when unblocked. " +
          "The goal space and goal list reset the blocked state when new work is recorded.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status", "on", "off", "blocked", "resume", "nudge"] },
            reason: { type: "string", description: "Why you are blocked on a user decision." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const args = (input ?? {}) as any
          const action = String(args.action ?? "").toLowerCase()
          try {
            if (action === "status") return { content: JSON.stringify(await researchStatus(context.sessionID), null, 2) }
            if (action === "on") {
              await setResearch(context.sessionID, { enabled: true })
              return { content: "Auto research reminders enabled." }
            }
            if (action === "off") {
              await setResearch(context.sessionID, { enabled: false })
              return { content: "Auto research reminders disabled." }
            }
            if (action === "blocked") {
              const reason = String(args.reason ?? "").trim() || "blocked on a user decision"
              await setResearch(context.sessionID, { blocked: true, reason })
              return { content: `Auto research paused: ${reason}` }
            }
            if (action === "resume") {
              await setResearch(context.sessionID, { blocked: false })
              return { content: "Auto research resumed." }
            }
            if (action === "nudge") {
              const result = await nudgeResearch(context.sessionID, "manual")
              return { content: result.nudged ? `Nudged (${result.inboxID ?? "queued"}).` : `Not nudged: ${result.reason}` }
            }
            throw new Error(`unknown action "${args.action}"; use status, on, off, blocked, resume or nudge`)
          } catch (error) {
            return toolFail(error)
          }
        },
      })
    })

    if (autoInstruct) {
      await ctx.session.hook("context", (event: any) => {
        if (!event.tools || !("goal" in event.tools)) return
        event.system.push({ type: "text", text: INSTRUCTIONS })
      })
    }

    if (autoResearch) {
      try {
        await ctx.session.hook("experimental.idle", async (event: any) => {
          if (dead) return
          try {
            await maybeNudge(event.sessionID, event.background)
          } catch (error) {
            console.error("[goal-tools] auto-research idle hook failed:", error)
          }
        })
      } catch (error) {
        console.error("[goal-tools] experimental.idle hook unavailable; auto-research nudges disabled:", error)
      }
    }

    // ---------------------------------------------------------------------
    // Auto-sync loop: goals complete, pending tasks remain
    // ---------------------------------------------------------------------

    const autoSyncOnce = async () => {
      if (dead || syncing) return
      syncing = true
      try {
        const entries: Array<{ key: string; value: unknown }> = []
        let after: string | undefined
        for (let page = 0; page < 20; page++) {
          const result = (await ctx.storage.scan({ prefix: LIST_PREFIX, after, limit: 200 })) as unknown as {
            entries: Array<{ key: string; value: unknown }>
            next?: string
          }
          entries.push(...result.entries)
          if (!result.next) break
          after = result.next
        }
        for (const entry of entries) {
          if (dead) break
          const list = entry.value as GoalList
          if (!list || !Array.isArray(list.tasks) || list.tasks.length === 0 || list.autoSync === false) continue
          // A bound task that is already done must still be retired, so an all-done
          // list is not skippable while activeTaskID points at a finished task.
          const boundDone = list.activeTaskID
            ? list.tasks.some((task) => task.id === list.activeTaskID && task.status === "done")
            : false
          if (!boundDone && list.tasks.every((task) => task.status === "done" || task.deferred)) continue
          try {
            const session = await info(list.sessionID)
            if ((await canonical(session.location?.directory)) !== (await canonical(ctx.location.directory))) continue
            const result = await syncList(list.sessionID, list.sessionID, "auto")
            if (result.action === "promoted")
              console.log(`[goal-tools] promoted next task for ${list.sessionID}: ${result.task?.text}`)
          } catch {
            // session may be deleted
          }
        }
      } catch (error) {
        console.error("[goal-tools] auto-sync failed:", error)
      } finally {
        syncing = false
      }
    }

    const timer = setInterval(() => {
      if (autoSync) void autoSyncOnce()
      void syncSpacesOnce()
    }, autoSyncIntervalMs)
    if (autoSync) void autoSyncOnce()
    void syncSpacesOnce()

    // ---------------------------------------------------------------------
    // RPC for deterministic tests / other plugins
    // ---------------------------------------------------------------------

    const objectOutput = { type: "object", additionalProperties: true } as const
    const toolsContract = Rpc.define({
      id: "goaltools",
      methods: {
        state: {
          input: {
            type: "object",
            properties: { sessionID: { type: "string" } },
            required: ["sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        list: {
          input: {
            type: "object",
            properties: { sessionID: { type: "string" } },
            required: ["sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        add: {
          input: {
            type: "object",
            properties: {
              fromSessionID: { type: "string" },
              sessionID: { type: "string" },
              tasks: { type: "array", items: { type: "string" } },
              startNow: { type: "boolean" },
            },
            required: ["fromSessionID", "sessionID", "tasks"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        sync: {
          input: {
            type: "object",
            properties: { fromSessionID: { type: "string" }, sessionID: { type: "string" } },
            required: ["fromSessionID", "sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        complete: {
          input: {
            type: "object",
            properties: {
              fromSessionID: { type: "string" },
              sessionID: { type: "string" },
              taskID: { type: "string" },
              promote: { type: "boolean" },
            },
            required: ["fromSessionID", "sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        assign: {
          input: {
            type: "object",
            properties: {
              fromSessionID: { type: "string" },
              sessionID: { type: "string" },
              objective: { type: "string" },
              notify: { type: "boolean" },
            },
            required: ["fromSessionID", "sessionID", "objective"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        space: {
          input: {
            type: "object",
            properties: { sessionID: { type: "string" }, status: { type: "string" }, tag: { type: "string" }, limit: { type: "number" } },
            required: ["sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        spaceAdd: {
          input: {
            type: "object",
            properties: { fromSessionID: { type: "string" }, sessionID: { type: "string" }, input: { type: "object", additionalProperties: true } },
            required: ["fromSessionID", "sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        spaceUpdate: {
          input: {
            type: "object",
            properties: {
              fromSessionID: { type: "string" },
              sessionID: { type: "string" },
              goalID: { type: "string" },
              input: { type: "object", additionalProperties: true },
            },
            required: ["fromSessionID", "sessionID", "goalID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        spaceComplete: {
          input: {
            type: "object",
            properties: {
              fromSessionID: { type: "string" },
              sessionID: { type: "string" },
              goalID: { type: "string" },
              result: { type: "string" },
              completedBy: { type: "string" },
              note: { type: "string" },
            },
            required: ["fromSessionID", "sessionID", "goalID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        spaceStats: {
          input: {
            type: "object",
            properties: { sessionID: { type: "string" } },
            required: ["sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        research: {
          input: {
            type: "object",
            properties: { sessionID: { type: "string" } },
            required: ["sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        researchSet: {
          input: {
            type: "object",
            properties: {
              sessionID: { type: "string" },
              enabled: { type: "boolean" },
              blocked: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
        nudge: {
          input: {
            type: "object",
            properties: { sessionID: { type: "string" }, reason: { type: "string" } },
            required: ["sessionID"],
            additionalProperties: false,
          },
          output: objectOutput,
        },
      },
      events: {},
    })

    const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value ?? null))
    void ctx.rpc
      .register(toolsContract, {
        state: async (input: any) => {
          const goal = await read(input.sessionID)
          const list = await readList(input.sessionID)
          return jsonSafe({ goal: goal ?? null, list })
        },
        list: async (input: any) => jsonSafe(await readList(input.sessionID)),
        add: async (input: any) => {
          await authorized(input.fromSessionID, input.sessionID, "add")
          return jsonSafe(await addTasks(input.sessionID, input.tasks.map(String), input.startNow))
        },
        sync: async (input: any) => {
          await authorized(input.fromSessionID, input.sessionID, "sync")
          return jsonSafe(await syncList(input.sessionID, input.fromSessionID, "manual", true))
        },
        // Mirror of the goal_list `complete` action so probes and scripts can
        // drive the retirement path without going through an LLM turn.
        complete: async (input: any) => {
          await authorized(input.fromSessionID, input.sessionID, "complete")
          return jsonSafe(
            await completeTask(
              input.sessionID,
              input.taskID ? String(input.taskID) : undefined,
              input.promote !== false,
            ),
          )
        },
        assign: async (input: any) => {
          const result = await setObjective(input.fromSessionID, input.sessionID, String(input.objective), "set", input.notify !== false)
          return jsonSafe({ goal: result.after ?? null, list: result.list })
        },
        space: async (input: any) => {
          try {
            return jsonSafe(await readSpace(input.sessionID))
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
        spaceAdd: async (input: any) => {
          try {
            if (String(input.fromSessionID) !== String(input.sessionID))
              throw new Error("goal space is isolated per session")
            return jsonSafe(await spaceAdd(input.sessionID, input.input ?? input))
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
        spaceUpdate: async (input: any) => {
          try {
            if (String(input.fromSessionID) !== String(input.sessionID))
              throw new Error("goal space is isolated per session")
            return jsonSafe(await spaceUpdate(input.sessionID, input.goalID, input.input ?? {}))
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
        spaceComplete: async (input: any) => {
          try {
            if (String(input.fromSessionID) !== String(input.sessionID))
              throw new Error("goal space is isolated per session")
            return jsonSafe(
              await spaceComplete(input.sessionID, input.goalID, {
                result: input.result,
                completedBy: input.completedBy,
                note: input.note,
              }),
            )
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
        spaceStats: async (input: any) => {
          try {
            return jsonSafe(await spaceStats(input.sessionID))
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
        research: async (input: any) => {
          try {
            return jsonSafe(await researchStatus(input.sessionID))
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
        researchSet: async (input: any) => {
          try {
            return jsonSafe(
              await setResearch(input.sessionID, {
                enabled: input.enabled,
                blocked: input.blocked,
                reason: input.reason,
              }),
            )
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
        nudge: async (input: any) => {
          try {
            return jsonSafe(await nudgeResearch(input.sessionID, input.reason ?? "manual RPC"))
          } catch (error) {
            return jsonSafe({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      .then(() => console.log(`[goal-tools] loaded · autoSync=${autoSync} every ${autoSyncIntervalMs}ms`))
      .catch((error: unknown) => console.error("[goal-tools] rpc registration failed:", error))

    return async () => {
      dead = true
      if (timer) clearInterval(timer)
      console.log("[goal-tools] unloaded")
    }
  },
})
