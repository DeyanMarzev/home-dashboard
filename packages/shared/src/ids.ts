/** Source ids, metric keys and entity keys are all lower snake_case (see CLAUDE.md). */
export const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isSnakeCase(value: string): boolean {
  return SNAKE_CASE.test(value);
}
