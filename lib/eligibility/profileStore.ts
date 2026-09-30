// Loads BURN's OPTIONAL private profile from Supabase and merges it over the
// public-safe defaults in burnProfile.ts. Nothing depends on it being present. The repo is public, so sensitive facts (ownership,
// contract values, revenue, live applications, entity names) live in the
// `burn_profile` table, which only the server (service-role key) can read.
// Everything here is pure or takes the Supabase client as an argument, so it is
// covered by test/profileStore.test.ts without a database.

import { BURN_PROFILE, type ActiveCommitment, type CountryPresence } from "./burnProfile";
import { TECHNOLOGIES, type Technology } from "./types";

export type BurnProfile = typeof BURN_PROFILE;

// Minimal shape of the Supabase client we use — lets tests pass a fake.
export interface ProfileDb {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: number): { maybeSingle(): PromiseLike<{ data: { profile?: unknown } | null; error: { message: string } | null }> };
    };
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && isFinite(v);
const strArr = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isStr) ? (v as string[]) : null);

const PRESENCE = ["manufacturing", "assembly", "local_entity", "market"] as const;
const COMMITMENT_STATUS = ["active", "applied_confirm_status", "past"] as const;

// How each top-level key of the profile is validated. An override value that
// fails its check is ignored (and reported), never half-applied.
type Check = (v: unknown, ignored: string[], key: string) => { ok: true; value: unknown } | { ok: false };
const ok = (value: unknown) => ({ ok: true as const, value });
const bad = { ok: false as const };

const simple = (test: (v: unknown) => boolean): Check => (v) => (test(v) ? ok(v) : bad);

const CHECKS: Record<keyof BurnProfile, Check> = {
  name: simple(isStr),
  orgType: simple((v) => isStr(v) && v.length > 0),
  groupFoundedYear: simple(isNum),
  headcount: simple(isNum),
  foreignControlledSubsidiaries: simple((v) => typeof v === "boolean"),
  unitsSoldToDate: simple(isNum),
  annualRevenueUsd: simple((v) => v === null || isNum(v)),
  maxCofinancingPct: simple((v) => v === null || isNum(v)),
  prefinancingCapacityUsd: simple((v) => v === null || isNum(v)),
  carbonFinanceRaisedUsd: simple((v) => v === null || isNum(v)),
  minWorthwhileAwardUsd: simple(isNum),
  maxRealisticAskUsd: simple(isNum),
  minDaysToApply: simple(isNum),
  expansionCountries: (v) => { const a = strArr(v); return a ? ok(a) : bad; },
  notes: (v) => {
    if (!isObj(v)) return bad;
    const out = { ...BURN_PROFILE.notes };
    for (const k of Object.keys(out) as (keyof typeof out)[]) if (isStr(v[k])) out[k] = v[k] as string;
    return ok(out);
  },
  technologies: (v) => {
    if (!isObj(v)) return bad;
    const pick = (x: unknown, fallback: Technology[]) => {
      const a = strArr(x);
      return a ? (a.filter((t) => (TECHNOLOGIES as readonly string[]).includes(t)) as Technology[]) : fallback;
    };
    return ok({ main: pick(v.main, BURN_PROFILE.technologies.main), limited: pick(v.limited, BURN_PROFILE.technologies.limited) });
  },
  bestKnownIsoTier: (v) => {
    if (!isObj(v)) return bad;
    const out: Record<string, number | null> = {};
    for (const [k, t] of Object.entries(v)) if (t === null || isNum(t)) out[k] = t;
    return ok(out);
  },
  countries: (v, ignored) => {
    if (!Array.isArray(v)) return bad;
    const out: CountryPresence[] = [];
    v.forEach((c, i) => {
      if (isObj(c) && isStr(c.name) && (PRESENCE as readonly string[]).includes(c.presence as string)) {
        out.push({
          name: c.name,
          presence: c.presence as CountryPresence["presence"],
          ...(isStr(c.entity) ? { entity: c.entity } : {}),
          ...(typeof c.localEntity === "boolean" ? { localEntity: c.localEntity } : {}),
          ...(isNum(c.sinceYear) ? { sinceYear: c.sinceYear } : {}),
        });
      } else ignored.push(`countries[${i}]`);
    });
    return ok(out);
  },
  activeCommitments: (v, ignored) => {
    if (!Array.isArray(v)) return bad;
    const out: ActiveCommitment[] = [];
    v.forEach((c, i) => {
      const countries = isObj(c) ? strArr(c.countries) : null;
      if (isObj(c) && isStr(c.programme) && countries && (COMMITMENT_STATUS as readonly string[]).includes(c.status as string)) {
        out.push({
          programme: c.programme,
          countries,
          technologies: (strArr(c.technologies) ?? []).filter((t) => (TECHNOLOGIES as readonly string[]).includes(t)) as Technology[],
          status: c.status as ActiveCommitment["status"],
          ...(isStr(c.note) ? { note: c.note } : {}),
        });
      } else ignored.push(`activeCommitments[${i}]`);
    });
    return ok(out);
  },
};

// Merges `override` (the private profile JSON) over `defaults`. Unknown keys and
// values of the wrong type are skipped and listed in `ignored` so a typo in the
// Supabase table shows up in the logs instead of silently changing results.
export function mergeProfile(defaults: BurnProfile, override: unknown): { profile: BurnProfile; applied: string[]; ignored: string[] } {
  const profile: Record<string, unknown> = { ...defaults };
  const applied: string[] = [];
  const ignored: string[] = [];
  if (!isObj(override)) return { profile: profile as BurnProfile, applied, ignored };
  for (const [key, value] of Object.entries(override)) {
    const check = (CHECKS as Record<string, Check | undefined>)[key];
    if (!check) { ignored.push(key); continue; }
    const result = check(value, ignored, key);
    if (result.ok) { profile[key] = result.value; applied.push(key); } else ignored.push(key);
  }
  return { profile: profile as BurnProfile, applied, ignored };
}

export interface LoadedProfile {
  profile: BurnProfile;
  source: "database" | "default";
  ignored: string[];
  reason?: string; // why the defaults were used
}

// Reads row id=1 of `burn_profile` with the server's (service-role) client.
export async function loadProfile(db: ProfileDb): Promise<LoadedProfile> {
  const fallback = (reason: string): LoadedProfile => ({ profile: BURN_PROFILE, source: "default", ignored: [], reason });
  try {
    const { data, error } = await db.from("burn_profile").select("profile").eq("id", 1).maybeSingle();
    if (error) return fallback(error.message);
    if (!data) return fallback("no row with id = 1 in burn_profile");
    const merged = mergeProfile(BURN_PROFILE, data.profile);
    if (merged.applied.length === 0) return { ...fallback("burn_profile row is empty or has no valid keys"), ignored: merged.ignored };
    return { profile: merged.profile, source: "database", ignored: merged.ignored };
  } catch (e) {
    return fallback((e as Error).message);
  }
}
