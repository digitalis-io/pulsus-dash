/** True for a key typed into a text field, where Shift+T is a capital T (T22-013, T24-026). */
export function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select') !== null) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}
