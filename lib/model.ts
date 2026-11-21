// The token radar's model (radar-2): one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// every other pre-token protocol the radar can rank: the early rows the radar exists to find. A
// protocol is pre-token when its record carries no token (no market cap, no CoinGecko id, no symbol).
// Live-token protocols are kept apart and shown as the market's own values, never mixed into the
// ranked board; they also serve as the comparables the model prices the pre-token ones against.
//
// Implied value follows only from the snapshot's own figures:
//
//   compMultiple = the category's median mcap/TVL among live-token protocols, shrunk toward the
//                  global median (5 protocols of prior weight) and clamped to [0.05, 1.5];
//                  a category with no live-token comparables uses the global median.
//   growthMult   = 1 + clamp(change_7d, -50, 100) / 100 x 0.5
//   maturityMult = 0.55 + min(age_days, 730) / 730 x 0.45   (age unknown: 365 days)
//   chainMult    = 1 + 0.03 x min(chains - 1, 5)
//   implied      = max(1, round(tvl_usd x compMultiple x growthMult x maturityMult x chainMult))
//
// The constants are stated in the dashboard, and the dashboard recomputes every row from the same
// figures, so the page and board.json visibly agree. No protocol name is ever special-cased: the
// same function scores every row, and the same function derives every farm plan from the protocol's
// category, chains, TVL and age.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_bonus: number;
  chain_bonus_max: number;
  comp_min: number;
  comp_max: number;
  comp_shrink: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 730,
  unknown_age_days: 365,
  chain_bonus: 0.03,
  chain_bonus_max: 5,
  comp_min: 0.05,
  comp_max: 1.5,
  comp_shrink: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Categories that are wrapped, staked or bridged products rather than protocols awaiting a launch. */
export const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    comp_multiple: number;
    comp_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  comp_multiple: number;
  comp_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  mcap_tvl: number | null;
  change_7d: number | null;
}

/** One category's comparables: the multiple the model prices it at, and how many live tokens back it. */
export interface CompEntry {
  multiple: number;
  count: number;
}

/** Everything the dashboard needs: the board, the live set, the comparables and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  global_comp_count: number;
  comps: Record<string, CompEntry>;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array; the middle value, or the mean of the two middle ones. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is one the board may rank: pre-token, not a wrapped/staked/bridged product, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)) && !VERSIONED.test(p.name);
}

/**
 * The comparables table: for every category, the median mcap/TVL of its live-token protocols,
 * shrunk toward the global median so a category with one or two tokens cannot set an extreme price.
 * Returns the table, the global median, and how many live tokens back it.
 */
export function buildComps(snapshot: Snapshot, model: ModelConstants): { comps: Record<string, CompEntry>; globalMultiple: number; globalCount: number } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  all.sort((a, b) => a - b);
  const globalMedian = all.length > 0 ? median(all) : 0.2;
  const globalMultiple = Math.min(model.comp_max, Math.max(model.comp_min, round4(globalMedian)));
  const comps: Record<string, CompEntry> = {};
  const keys = [...byCategory.keys()].sort();
  for (const key of keys) {
    const ratios = byCategory.get(key)!;
    ratios.sort((a, b) => a - b);
    const catMedian = median(ratios);
    const shrunk = (ratios.length * catMedian + model.comp_shrink * globalMedian) / (ratios.length + model.comp_shrink);
    comps[key] = { multiple: round4(Math.min(model.comp_max, Math.max(model.comp_min, shrunk))), count: ratios.length };
  }
  return { comps, globalMultiple, globalCount: all.length };
}

/** The multiple one protocol's category prices at, or the global multiple when it has no comparables. */
export function compMultipleFor(p: SnapshotProtocol, comps: Record<string, CompEntry>, globalMultiple: number): { multiple: number; count: number } {
  const entry = p.category === null ? undefined : comps[p.category];
  if (entry === undefined) return { multiple: globalMultiple, count: 0 };
  return { multiple: entry.multiple, count: entry.count };
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  comps: Record<string, CompEntry>,
  globalMultiple: number,
): { implied: number; compMultiple: number; compCount: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, count } = compMultipleFor(protocol, comps, globalMultiple);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_bonus_max);
  const chainMult = 1 + model.chain_bonus * extraChains;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult * chainMult));
  return { implied, compMultiple: multiple, compCount: count, growthPct, growthMult, maturityMult, chainMult, age };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const { comps, globalMultiple } = buildComps(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watchlist.has(p.slug) || isRankable(p));
  const scored = chosen.map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, comps, globalMultiple);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      comp_multiple: s.v.compMultiple,
      comp_count: s.v.compCount,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      chain_multiplier: round4(s.v.chainMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 10_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Gas for a first transaction on the protocol's main chain, in the words a farmer budgets with. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $5 to $15 of gas';
  if (c === 'solana' || c === 'sui' || c === 'aptos') return 'under $1 of gas';
  return 'about $1 to $3 of gas';
}

/** The category's core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('exchange'))
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('yield'))
    return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and hold the position.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged trade.`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one position in an active market.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('payment')) return `Hold $${capital} in ${name} on ${chain} and make one payment through it.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('governance')) return `Deposit $${capital} into ${name} on ${chain} and vote in its next active proposal.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index token on ${chain} and hold it.`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${name}'s chain and use one of its apps.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name}'s shielded pool on ${chain} and keep the note.`;
  if (c.includes('ai')) return `Deposit $${capital} into ${name} on ${chain} and run one of its agents.`;
  if (c.includes('launchpad')) return `Commit $${capital} to ${name}'s current allocation on ${chain}.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second action: a deeper position, so the plan is more than one deposit. */
function deepenFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const top = Math.max(25, Math.round(capital / 4));
  if (c.includes('dex') || c.includes('exchange')) return `Swap $${top} through ${name}'s pool once a week so the wallet shows trading activity as well as liquidity.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Borrow $${top} against the supply, hold it a week, then repay it in full so the wallet shows both sides of the market.`;
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('basis'))
    return `Add $${top} to a second ${name} vault on ${chain} so the position spans more than one strategy.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Close the hedge after two weeks and open a fresh one, keeping total margin near $${capital}.`;
  if (c.includes('rwa')) return `Hold through one yield distribution, then reinvest the payout into the same asset.`;
  if (c.includes('restak') || c.includes('staking')) return `Restake the first rewards back through ${name} instead of withdrawing them.`;
  if (c.includes('prediction')) return `Place a second position in a different market once the first one settles.`;
  if (c.includes('insurance')) return `Extend the cover by one more period before the first one lapses.`;
  if (c.includes('governance')) return `Vote in a second proposal and leave a short comment in the protocol's forum.`;
  if (c.includes('chain')) return `Use a second app on the chain with $${top} so the wallet is active in more than one place.`;
  return `Top the position up by $${top} after two weeks so the activity spans more than one snapshot.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  return [
    {
      text: `Set up a fresh wallet holding only the funds you plan to farm, and fund it with gas on ${chain}.`,
      cost: `${gas} for the first transaction`,
      time: '10 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: deepenFor(p, capital, chain),
      cost: `about $${Math.max(25, Math.round(capital / 4))} of extra capital and ${gas}`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a swap, a borrow or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    comp_multiple: row.model.comp_multiple,
    comp_count: row.model.comp_count,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { comps, globalMultiple, globalCount } = buildComps(snapshot, model);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: globalMultiple,
    global_comp_count: globalCount,
    comps,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100 the gate needs`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
