/**
 * Which damage rows a step deals. Row tagging comes from the real bundle,
 * because `export.py` decides it, and the test must see exactly that.
 */

import { expect, it } from 'vitest';

import { stepHits, type SkillType } from '../src/index.js';

import { bundle as data, describeWithBundle } from './support/bundle.js';

const labels = (operator: string, type: SkillType, kind: string, sequence: number | null = null) => {
  const skill = data!.operators[operator]!.skills.find((item) => item.type === type)!;
  return stepHits(skill, { kind: kind as never, sequence }).map((hit) => `${hit.role}:${hit.row.label}`);
};

describeWithBundle('stepHits on the real bundle', () => {
  it('Mi Fu: three named moves are BS1, BS2, BS3', () => {
    expect(labels('Mi Fu', 'Battle Skill', 'BS', 2)).toEqual(['hit:Trail and Mangle DMG Multiplier']);
  });

  it('Rossi: CS1 and CS2 by SEQ, the per-stack bonus rides along', () => {
    expect(labels('Rossi', 'Combo Skill', 'CS', 1)).toEqual([
      'hit:SEQ 1 DMG Multiplier',
      'perStack:Bonus DMG Multiplier per Infliction Stack',
    ]);
    expect(labels('Rossi', 'Combo Skill', 'CS', 2)).toEqual([
      'hit:SEQ 2 DMG Multiplier',
      'perStack:Bonus DMG Multiplier per Infliction Stack',
    ]);
  });

  it('a basic chain is every sequence, a finisher is the finisher', () => {
    expect(labels('Chen Qianyu', 'Basic Attack', 'FS')).toHaveLength(5);
    expect(labels('Chen Qianyu', 'Basic Attack', 'FIN')).toEqual(['hit:Finisher ATK Multiplier']);
  });

  it('BA > FS splits one chain: BA up to the Final Strike, FS the last sequence', () => {
    const chen = data!.operators['Chen Qianyu']!.skills.find((item) => item.type === 'Basic Attack')!;
    const ba = stepHits(chen, { kind: 'BA', sequence: null }).map((hit) => hit.row.label);
    const fs = stepHits(chen, { kind: 'FS', sequence: null }, { chained: true }).map((hit) => hit.row.label);
    expect(ba).toHaveLength(4);
    expect(fs).toEqual(['BATK SEQ 5 Multiplier']);
  });

  it('Si: the record ratio is not damage, the per-stack increase is', () => {
    expect(labels('Si', 'Battle Skill', 'BS', 1)).toEqual(['hit:DMG Multiplier']);
    expect(labels('Si', 'Combo Skill', 'CS')).toEqual([
      'hit:DMG Multiplier',
      'perStack:Multiplier Increase per Stack Consumed or Absorbed',
    ]);
  });

  it('hit counts come from the skill text: Chen\'s ult is six slashes and a final strike', () => {
    const counts = (operator: string, type: SkillType, kind: string) => {
      const skill = data!.operators[operator]!.skills.find((item) => item.type === type)!;
      return Object.fromEntries(stepHits(skill, { kind: kind as never, sequence: null }).map((hit) => [hit.row.label, hit.count]));
    };
    expect(counts('Chen Qianyu', 'Ultimate', 'ULT')).toEqual({ 'Slash Multiplier': 6, 'Final Strike DMG Multiplier': 1 });
    expect(counts('Akekuri', 'Combo Skill', 'CS')).toEqual({ 'DMG Multiplier per SEQ': 2 });
    // Rossi's "two-sequence slash" is already split into SEQ 1 and SEQ 2 rows.
    expect(counts('Rossi', 'Ultimate', 'ULT')).toMatchObject({ 'SEQ 1 Slash DMG Multiplier': 1, 'SEQ 2 Slash DMG Multiplier': 1 });
    // "per Beat" with no number in the text is unknown, not one.
    expect(counts('Liino', 'Ultimate', 'ULT')['DMG Multiplier per Beat']).toBeNull();
  });
});
