// Package varquery reads a board variable's query (plan #289 §3.3): label_values(label) or
// label_values(selector, label), in PromQL or LogQL. The selector is planned by the language
// modules; nothing here reads it.
package varquery

import "errors"

// Query is a variable query: the label whose values are listed and the selector, "" for the
// no-selector form.
type Query struct{ Label, Selector string }

// ErrInvalid is the refusal of a text that is not a variable query. It carries no text.
var ErrInvalid = errors.New("varquery: a variable query must be label_values(label) or label_values(selector, label)")

// Parse reads text as a variable query of lang (promql or logql).
func Parse(lang, text string) (Query, error) { return Query{}, ErrInvalid }
