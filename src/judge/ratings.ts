// Pairwise ratings from human judgments. These functions are self-contained (no imports, no
// closures) because the report page embeds their source via Function.prototype.toString().

export type Winner = "a" | "b" | "tie" | "both_bad";

export interface Judgment {
  id: string;
  ts: string;
  judge: string;
  task: string;
  /** Entry ids: "<task>/<stack>/<model>" */
  a: string;
  b: string;
  winner: Winner;
  blind: boolean;
  notes?: string;
}

export interface Rating {
  key: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  bothBad: number;
}

/**
 * Bradley-Terry strengths via the MM algorithm, reported on an Elo-like scale (mean 1000,
 * 400 points = 10:1 odds). Ties count as half a win for each side. Every contestant gets one
 * virtual tie against a reference player, which keeps undefeated / winless ratings finite.
 * `keyOf` maps an entry id to the contestant it counts towards (e.g. model, or model@stack).
 */
export function bradleyTerry(judgments: Judgment[], keyOf: (entryId: string) => string): Rating[] {
  const REF = "\u0000ref";
  const stats = new Map<string, Rating>();
  const pairCount = new Map<string, Map<string, number>>();
  const winsHalf = new Map<string, number>();
  const stat = (k: string): Rating => {
    let s = stats.get(k);
    if (!s) {
      s = { key: k, rating: 0, games: 0, wins: 0, losses: 0, ties: 0, bothBad: 0 };
      stats.set(k, s);
    }
    return s;
  };
  const addGame = (x: string, y: string, wx: number) => {
    for (const [p, q, w] of [[x, y, wx], [y, x, 1 - wx]] as [string, string, number][]) {
      let m = pairCount.get(p);
      if (!m) pairCount.set(p, (m = new Map()));
      m.set(q, (m.get(q) ?? 0) + 1);
      winsHalf.set(p, (winsHalf.get(p) ?? 0) + w);
    }
  };

  for (const j of judgments) {
    const ka = keyOf(j.a);
    const kb = keyOf(j.b);
    if (ka === kb) continue; // e.g. same model on two stacks when rating by model
    const sa = stat(ka);
    const sb = stat(kb);
    sa.games++;
    sb.games++;
    if (j.winner === "a") (sa.wins++, sb.losses++, addGame(ka, kb, 1));
    else if (j.winner === "b") (sb.wins++, sa.losses++, addGame(ka, kb, 0));
    else {
      if (j.winner === "both_bad") (sa.bothBad++, sb.bothBad++);
      else (sa.ties++, sb.ties++);
      addGame(ka, kb, 0.5);
    }
  }
  const keys = [...stats.keys()];
  for (const k of keys) addGame(k, REF, 0.5);

  const p = new Map<string, number>([...keys, REF].map((k) => [k, 1]));
  for (let iter = 0; iter < 500; iter++) {
    let delta = 0;
    for (const k of keys) {
      let denom = 0;
      for (const [o, n] of pairCount.get(k) ?? []) denom += n / (p.get(k)! + p.get(o)!);
      const next = (winsHalf.get(k) ?? 0) / denom;
      delta = Math.max(delta, Math.abs(Math.log(next) - Math.log(p.get(k)!)));
      p.set(k, next);
    }
    if (delta < 1e-9) break;
  }
  const logs = keys.map((k) => Math.log10(p.get(k)!));
  const mean = logs.reduce((a, b) => a + b, 0) / (logs.length || 1);
  for (const k of keys) stats.get(k)!.rating = 1000 + 400 * (Math.log10(p.get(k)!) - mean);
  return [...stats.values()].sort((x, y) => y.rating - x.rating);
}
