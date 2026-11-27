const START = '<!-- BRIEF:START -->\n';
const END = '<!-- BRIEF:END -->';

/** Returns the model-visible brief embedded in task.md between the BRIEF markers. */
export function extractBrief(taskMd: string): string {
  const start = taskMd.indexOf(START);
  const end = taskMd.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('task.md is missing BRIEF markers');
  return taskMd.slice(start + START.length, end);
}
