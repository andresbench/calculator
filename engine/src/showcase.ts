/**
 * Reading an Enka.Network showcase in the page (PUBLISH_PLAN, П6).
 *
 * The site is static: it gets the showcase's JSON through the Enka proxy
 * (`enka.andresbench.moe`) and reads it here. Every decision that takes data
 * was made in `tools/ef/profile.py` and arrives as tables in the bundle
 * (`bundle.showcase`): Enka's `templateId` → our weapon and gear, essence
 * term families, the column rule's offset. What is left is lookups and the
 * shape of a `RosterEntry`.
 *
 * This is the second reader of a showcase; the first, `profile.py:
 * extract`, feeds the local roster. They are kept equal the way the two
 * `.rot` parsers are: `profile.py parity` writes synthetic showcases with
 * `extract`'s answers, and `showcase.test.ts` holds this file to them. If
 * they drift, one of the two is wrong, and the test says so.
 */

import type { Bundle, RosterEntry, RosterWeapon, ShowcaseTables, WeaponColumn } from './bundle.js';

/** The fields of an Enka `charData` entry that are read. Everything is optional: it is someone else's JSON. */
export interface ShowcaseCharacter {
  templateId?: number;
  variantId?: string | null;
  level?: number | null;
  potentialLevel?: number | null;
  skillInfo?: { levelInfo?: Array<{ skillId?: string; skillLevel?: number | null }> } | null;
  talent?: { attrNodes?: string[] | null; latestPassiveSkillNodes?: string[] | null } | null;
  weapon?: {
    templateId?: number | null;
    weaponLv?: number | null;
    refineLv?: number | null;
    breakthroughLv?: number | null;
    attachedGem?: {
      templateId?: number | null;
      domainId?: number | null;
      totalCost?: number | null;
      terms?: Array<{ termNumId?: number | null; cost?: number | null }> | null;
    } | null;
  } | null;
  equip?: Array<{ key?: number; value?: { templateid?: number | null } | null }> | null;
}

/** The API's answer: `GET /api/ef/uid/<UID>`. */
export interface ShowcasePayload {
  uid?: string | number;
  ttl?: number;
  playerInfo?: { businessCard?: { name?: string } | null; charData?: ShowcaseCharacter[] | null } | null;
}

/**
 * One character as `extract` returns it — the shape the parity cases
 * compare. `toRosterEntry` turns it into what the engine reads.
 */
export interface ShowcaseRecord {
  key: string;
  level: number | null;
  potential: number | null;
  skills?: Partial<Record<'basic' | 'battle' | 'combo' | 'ultimate', number | null>>;
  talentNodes?: { attribute: number; passive: number[] };
  weapon?: {
    name: string | null;
    level: number | null;
    rank: number;
    breakthrough: number | null;
    template_id: number;
    essence?: NonNullable<RosterWeapon['essence']>;
    unresolved?: true;
    columns: Record<string, WeaponColumn> | null;
  };
  gear?: Array<{ slot: number | null; name: string | null; set: string | null; template_id: number; unresolved?: true }>;
}

// ------------------------------------------------------------------ source

/** The Endfield showcase link (`profile.py: SHOWCASE_RE`). */
const SHOWCASE_RE = /enka\.network\/ef\/(\d+)/;
const UID_RE = /^\d{6,12}$/;

/** A UID from a bare number or a showcase link; an account link is a different page (`profile.py: parse_source`). */
export function uidFromSource(value: string): { uid: string } | { failure: 'account_link' | 'bad_source' } {
  const text = (value ?? '').trim();
  if (UID_RE.test(text)) return { uid: text };
  const match = SHOWCASE_RE.exec(text);
  if (match) return { uid: match[1]! };
  if (text.includes('enka.network/u/')) return { failure: 'account_link' };
  return { failure: 'bad_source' };
}

// ------------------------------------------------------------------ reading

/** Operator by `variantId` (only the Endministrator has one), else by the `skillId` prefix (`identify_operator`). */
function identify(char: ShowcaseCharacter, byId: ReadonlyMap<string, string>): string | null {
  const variant = char.variantId;
  if (variant && byId.has(variant)) return byId.get(variant)!;
  for (const entry of char.skillInfo?.levelInfo ?? []) {
    const match = /^(chr_\d+_[a-z0-9]+)/.exec(entry.skillId ?? '');
    if (match && byId.has(match[1]!)) return byId.get(match[1]!)!;
  }
  return null;
}

const STATIC = /^.+ \[[LMS]\]$/;

/** Each weapon component's column from the essence (`weapon.py: essence_columns`, via `export.py: weapon_columns`). */
function essenceColumns(
  bundle: Bundle,
  tables: ShowcaseTables,
  weapon: NonNullable<ShowcaseRecord['weapon']>,
): Record<string, WeaponColumn> | null {
  const record = weapon.name ? bundle.weapons[weapon.name] : undefined;
  const terms = weapon.essence?.terms ?? [];
  if (!record || terms.length === 0) return null;
  const rank = weapon.rank || 1;
  const components = record.components.filter((component) => component.valuesByRank.length > 0);
  const used = new Set<number>();
  const out: Record<string, WeaponColumn> = {};
  components.forEach((component, index) => {
    const family = component.tag || component.key.replace(/ \[[LMS]\]$/, '');
    const isStatic = STATIC.test(component.key);
    const columns = component.valuesByRank[0]!.length;
    let match: { at: number; confidence: WeaponColumn['confidence']; via: string } | null = null;
    for (let at = 0; at < terms.length; at += 1) {
      const known = tables.termFamilies[String(terms[at]!.term)];
      if (!used.has(at) && known && known.family === family) {
        match = { at, confidence: known.confidence, via: `term ${terms[at]!.term} — ${family}` };
        break;
      }
    }
    if (!match && index < terms.length && !used.has(index)) {
      const term = terms[index]!;
      if (!(String(term.term) in tables.termFamilies)) {
        match = { at: index, confidence: 'inferred', via: `term ${term.term} not recognised, taken by position` };
      }
    }
    if (!match) {
      out[component.key] = { column: null, confidence: 'unknown', via: `no term of family ${family}` };
      return;
    }
    used.add(match.at);
    const cost = terms[match.at]!.cost || 0;
    const offset = isStatic ? tables.statColumnOffset : rank;
    out[component.key] = {
      column: Math.max(1, Math.min(columns, cost + offset)),
      confidence: match.confidence,
      via: match.via,
      cost,
    };
  });
  return out;
}

/** One showcase character → `extract`'s record, or `null` for an operator not in the data. */
export function readCharacter(char: ShowcaseCharacter, bundle: Bundle, tables: ShowcaseTables): ShowcaseRecord | null {
  const byId = new Map(Object.values(bundle.operators).filter((operator) => operator.id).map((operator) => [operator.id, operator.key]));
  const key = identify(char, byId);
  if (key == null) return null;

  const record: ShowcaseRecord = { key, level: char.level ?? null, potential: char.potentialLevel ?? null };

  const skills: NonNullable<ShowcaseRecord['skills']> = {};
  for (const entry of char.skillInfo?.levelInfo ?? []) {
    for (const [suffix, kind] of Object.entries(tables.skillKinds)) {
      if ((entry.skillId ?? '').endsWith(suffix)) skills[kind] = entry.skillLevel ?? null;
    }
  }
  if (Object.keys(skills).length > 0) record.skills = skills;

  // Talent nodes open one by one, apart from elite (measurements, #59).
  const talent = char.talent;
  if (talent && Object.keys(talent).length > 0) {
    const passive = new Map<number, number>();
    for (const node of talent.latestPassiveSkillNodes ?? []) {
      const found = /passive_skill_(\d+)_(\d+)$/.exec(node);
      if (found) passive.set(Number(found[1]), Math.max(passive.get(Number(found[1])) ?? 0, Number(found[2])));
    }
    const length = passive.size > 0 ? Math.max(...passive.keys()) + 1 : 0;
    record.talentNodes = {
      attribute: (talent.attrNodes ?? []).length,
      passive: Array.from({ length }, (_, index) => passive.get(index) ?? 0),
    };
  }

  const weapon = char.weapon;
  if (weapon && weapon.templateId != null) {
    const name = tables.weapons[String(weapon.templateId)] ?? null;
    const read: NonNullable<ShowcaseRecord['weapon']> = {
      name,
      level: weapon.weaponLv ?? null,
      // refineLv is the refinement rank; the game counts from 1, the API from 0.
      rank: (weapon.refineLv || 0) + 1,
      breakthrough: weapon.breakthroughLv ?? null,
      template_id: weapon.templateId,
      columns: null,
    };
    const gem = weapon.attachedGem;
    if (gem && Object.keys(gem).length > 0) {
      read.essence = {
        template_id: gem.templateId ?? null,
        domain_id: gem.domainId ?? null,
        total_cost: gem.totalCost ?? null,
        terms: (gem.terms ?? []).map((term) => ({ term: term.termNumId ?? null, cost: term.cost ?? null })),
      };
    }
    if (name == null) read.unresolved = true;
    read.columns = essenceColumns(bundle, tables, read);
    record.weapon = read;
  }

  const pieces: NonNullable<ShowcaseRecord['gear']> = [];
  for (const slot of char.equip ?? []) {
    const template = slot.value?.templateid;
    if (template == null) continue;
    const item = tables.gear[String(template)];
    pieces.push({
      slot: slot.key ?? null,
      name: item?.name ?? null,
      set: item?.set ?? null,
      template_id: template,
      ...(item ? {} : { unresolved: true as const }),
    });
  }
  if (pieces.length > 0) record.gear = pieces;

  return record;
}

/**
 * A record → the roster entry the engine builds from (`export.py:
 * export_roster`). What the showcase carries is `profile`; elite is not in
 * it, so it stays a default, marked as one.
 */
export function toRosterEntry(record: ShowcaseRecord): RosterEntry {
  const skills = record.skills ?? {};
  return {
    key: record.key,
    rosterName: null,
    level: record.level ?? 90,
    elite: 4,
    eliteUncertain: true,
    potential: record.potential ?? 0,
    skills: {
      basic: skills.basic ?? 1,
      battle: skills.battle ?? 1,
      combo: skills.combo ?? 1,
      ultimate: skills.ultimate ?? 1,
    },
    ...(record.talentNodes ? { talentNodes: record.talentNodes } : {}),
    weapon: record.weapon
      ? {
          name: record.weapon.name,
          level: record.weapon.level,
          rank: record.weapon.rank,
          breakthrough: record.weapon.breakthrough,
          essence: record.weapon.essence ?? null,
          columns: record.weapon.columns,
        }
      : null,
    gear: (record.gear ?? []).map((piece) => ({ slot: piece.slot ?? -1, name: piece.name, set: piece.set })),
    provenance: {
      level: record.level != null ? 'profile' : 'default',
      elite: 'default',
      potential: record.potential != null ? 'profile' : 'default',
      skills: record.skills ? 'profile' : 'default',
      weapon: record.weapon ? 'profile' : 'default',
      gear: record.gear ? 'profile' : 'default',
    },
  };
}

export interface ShowcaseRead {
  uid: string | null;
  nickname: string | null;
  /** Seconds Enka caches the showcase: a change in game shows after it. */
  ttl: number | null;
  entries: Record<string, RosterEntry>;
  /** `templateId`s of characters not in the data (the game is newer than it). */
  unknown: number[];
  /** Weapons and gear the tables do not know, by operator. */
  unresolved: string[];
}

/** A whole showcase: its characters as roster entries, and what could not be read. */
export function readShowcase(payload: ShowcasePayload, bundle: Bundle): ShowcaseRead {
  const tables = bundle.showcase;
  const out: ShowcaseRead = {
    uid: payload.uid != null ? String(payload.uid) : null,
    nickname: payload.playerInfo?.businessCard?.name ?? null,
    ttl: payload.ttl ?? null,
    entries: {},
    unknown: [],
    unresolved: [],
  };
  if (!tables) return out;
  for (const char of payload.playerInfo?.charData ?? []) {
    const record = readCharacter(char, bundle, tables);
    if (!record) {
      if (char.templateId != null) out.unknown.push(char.templateId);
      continue;
    }
    out.entries[record.key] = toRosterEntry(record);
    if (record.weapon?.unresolved) out.unresolved.push(`${record.key}: weapon templateId ${record.weapon.template_id}`);
    for (const piece of record.gear ?? []) {
      if (piece.unresolved) out.unresolved.push(`${record.key}: gear templateId ${piece.template_id}`);
    }
  }
  out.unresolved.sort();
  return out;
}
