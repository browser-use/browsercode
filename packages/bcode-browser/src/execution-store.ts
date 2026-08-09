import { SessionStore } from "./session-store"

export interface CellResult {
  readonly output: string
  readonly result: string
  readonly screenshots: readonly {
    readonly mime: "image/png" | "image/jpeg" | "image/webp"
    readonly base64: string
  }[]
}

export interface Cell {
  readonly id: string
  readonly sessionID: string
  promise: Promise<CellResult>
  output: string
  status: "running" | "completed" | "failed" | "interrupted"
  result?: CellResult
  error?: Error
}

const cells = new Map<string, Cell>()
const counters = new Map<string, number>()

export const start = (sessionID: string, run: (onChunk: (output: string) => void) => Promise<CellResult>) => {
  const next = (counters.get(sessionID) ?? 0) + 1
  counters.set(sessionID, next)
  const id = `${sessionID}:${next}`
  const cell = {
    id,
    sessionID,
    output: "",
    status: "running" as const,
  } as Cell
  cell.promise = run((output) => {
    cell.output = output
  }).then(
    (result) => {
      if (cell.status === "interrupted") return result
      cell.status = "completed"
      cell.result = result
      return result
    },
    (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (cell.status !== "interrupted") {
        cell.status = "failed"
        cell.error = failure
      }
      throw failure
    },
  )
  cell.promise.catch(() => {})
  cells.set(id, cell)
  return cell
}

export const get = (sessionID: string, id: string) => {
  const cell = cells.get(id)
  if (!cell || cell.sessionID !== sessionID) throw new Error(`Unknown browser_execute cell: ${id}`)
  return cell
}

export const wait = async (cell: Cell, yieldMs: number) => {
  if (cell.status !== "running") return cell
  await Promise.race([
    cell.promise.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, yieldMs)),
  ])
  return cell
}

export const interrupt = async (sessionID: string, id: string) => {
  const cell = get(sessionID, id)
  if (cell.status !== "running") return cell
  cell.status = "interrupted"
  await SessionStore.reset(sessionID)
  return cell
}

export const evict = async (sessionID: string) => {
  await Promise.all(
    [...cells.values()]
      .filter((cell) => cell.sessionID === sessionID && cell.status === "running")
      .map((cell) => interrupt(sessionID, cell.id)),
  )
  for (const [id, cell] of cells) {
    if (cell.sessionID === sessionID) cells.delete(id)
  }
  counters.delete(sessionID)
}

export * as ExecutionStore from "./execution-store"
