import type { Metrics, Proc } from "./data.ts"

export type SortKey = "cpu" | "mem" | "pid" | "name"
export const SORT_ORDER: SortKey[] = ["cpu", "mem", "pid", "name"]
export const SORT_LABEL: Record<SortKey, string> = { cpu: "CPU%", mem: "MEM%", pid: "PID", name: "NAME" }

export class AppState {
  index = 0
  paused = false
  sortKey: SortKey = "cpu"
  selected = 0
  scroll = 0
  detailOpen = false
  sorted: Proc[] = []

  constructor(public m: Metrics) {
    this.resort()
  }

  get last(): number {
    return this.m.samples.length - 1
  }
  get finished(): boolean {
    return this.index >= this.last
  }

  /** Advance one sample; returns true if the state changed. */
  tick(): boolean {
    if (this.paused || this.finished) return false
    this.index++
    return true
  }

  togglePause() {
    this.paused = !this.paused
  }

  resort() {
    const key = this.sortKey
    const keepPid = this.sorted[this.selected]?.pid
    const list = [...this.m.processes]
    list.sort((a, b) => {
      let d = 0
      switch (key) {
        case "cpu":
          d = b.cpu - a.cpu
          break
        case "mem":
          d = b.mem - a.mem
          break
        case "pid":
          d = a.pid - b.pid
          break
        case "name":
          d = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          if (d === 0) d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
          break
      }
      return d !== 0 ? d : a.pid - b.pid
    })
    this.sorted = list
    if (keepPid !== undefined) {
      const i = list.findIndex((p) => p.pid === keepPid)
      this.selected = i >= 0 ? i : 0
    } else this.selected = 0
  }

  cycleSort() {
    const i = SORT_ORDER.indexOf(this.sortKey)
    this.sortKey = SORT_ORDER[(i + 1) % SORT_ORDER.length]!
    this.resort()
  }

  move(delta: number) {
    const n = this.sorted.length
    if (n === 0) return
    this.selected = Math.max(0, Math.min(n - 1, this.selected + delta))
  }
  moveTo(i: number) {
    const n = this.sorted.length
    if (n === 0) return
    this.selected = Math.max(0, Math.min(n - 1, i))
  }

  get selectedProc(): Proc | undefined {
    return this.sorted[this.selected]
  }
}
