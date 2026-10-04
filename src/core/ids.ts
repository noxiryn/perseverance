let counter = 0;

/** Short unique id (unique within a session and practically unique across saved projects). */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 0xffffff;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
