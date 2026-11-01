import { readFileSync } from "node:fs"

export interface Sample {
  t: number
  cpu: number[]
  mem: { usedGiB: number; totalGiB: number }
  swap: { usedGiB: number; totalGiB: number }
  net: { rxKiBps: number; txKiBps: number }
  load: number[]
}

export interface Proc {
  pid: number
  name: string
  user: string
  cpu: number
  mem: number
  threads: number
  state: string
  started: string
  command: string
}

export interface Metrics {
  host: string
  kernel: string
  uptime: string
  cores: number
  intervalMs: number
  samples: Sample[]
  processes: Proc[]
}

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d
}
function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : v == null ? d : String(v)
}

export function loadMetrics(path = "data/metrics.json"): Metrics {
  let raw: any = {}
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    raw = {}
  }
  const samples: Sample[] = (Array.isArray(raw.samples) ? raw.samples : []).map((s: any, i: number) => ({
    t: num(s?.t, i),
    cpu: Array.isArray(s?.cpu) ? s.cpu.map((c: unknown) => num(c)) : [],
    mem: { usedGiB: num(s?.mem?.usedGiB), totalGiB: num(s?.mem?.totalGiB, 1) },
    swap: { usedGiB: num(s?.swap?.usedGiB), totalGiB: num(s?.swap?.totalGiB, 0) },
    net: { rxKiBps: num(s?.net?.rxKiBps), txKiBps: num(s?.net?.txKiBps) },
    load: Array.isArray(s?.load) ? s.load.map((c: unknown) => num(c)) : [0, 0, 0],
  }))
  if (samples.length === 0) {
    samples.push({
      t: 0,
      cpu: [0],
      mem: { usedGiB: 0, totalGiB: 1 },
      swap: { usedGiB: 0, totalGiB: 0 },
      net: { rxKiBps: 0, txKiBps: 0 },
      load: [0, 0, 0],
    })
  }
  const processes: Proc[] = (Array.isArray(raw.processes) ? raw.processes : []).map((p: any) => ({
    pid: num(p?.pid),
    name: str(p?.name),
    user: str(p?.user),
    cpu: num(p?.cpu),
    mem: num(p?.mem),
    threads: num(p?.threads),
    state: str(p?.state),
    started: str(p?.started),
    command: str(p?.command),
  }))
  return {
    host: str(raw.host, "localhost"),
    kernel: str(raw.kernel),
    uptime: str(raw.uptime),
    cores: num(raw.cores, samples[0]!.cpu.length || 1),
    intervalMs: Math.max(10, num(raw.intervalMs, 100)),
    samples,
    processes,
  }
}
