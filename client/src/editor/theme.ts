import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const promqlHighlight = HighlightStyle.define([{ tag: tags.invalid, color: 'inherit' }]);
export const promqlTheme = EditorView.theme({});
