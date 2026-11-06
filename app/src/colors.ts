/** One palette for elements and stack counters, shared by every screen. */

export const ELEMENT_COLOR: Record<string, string> = {
  Physical: '#c9c4bb',
  Heat: '#ff7a45',
  Cryo: '#4fc3f7',
  Electric: '#b388ff',
  Nature: '#8bc34a',
};

/** Infliction counters take their element's colour; Vulnerable has its own. */
export const STACK_COLOR: Record<string, string> = {
  ...ELEMENT_COLOR,
  Vulnerable: '#d8a25a',
};
