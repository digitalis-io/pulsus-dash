/** Board keys `Shift+E` and `Mod+S` (plan #61 Part B §4.4). Stub. */
export type BoardKeyAction = 'toggleEdit' | 'save';

export function boardKeyAction(_e: KeyboardEvent, _mode: 'view' | 'edit'): BoardKeyAction | null {
  return null;
}
