/** Quote one literal Bash argument, including embedded apostrophes. */
export function quoteBashWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
