package logs

import (
	"strings"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
)

// SelectorInvalid is the message of a variable query's selector that is not one stream selector.
const SelectorInvalid = "a variable query's selector must be one stream selector without a pipeline"

// SubstituteSelector is the selector of a variable query on the value route (plan #289 §3.5 step
// 3): rows 1–5, 7 and 7b of Prepare with the contexts and the probe guard of T07-031, every macro
// left as written, the processing cap; then Classify must read exactly one {…} that is the whole
// text, so no pipeline follows it (query.invalid). Pure; no text in an error.
func SubstituteSelector(sel string, vs map[string]vars.Value) (string, *PlanError) {
	if e := checkInputs(Inputs{Query: sel, Vars: vs}); e != nil {
		return "", e
	}
	count := substitute(sel, vs, placeholders(), false, scanOptions{guard: &vars.Guard{}, keepMacros: true})
	if len(count.missing) > 0 {
		return "", namesError(ErrVariableMissing, count.missing, "variable.missing", "no value for variable ", "")
	}
	if names, where := count.unrepresentable(); len(names) > 0 {
		return "", unrepresentableError(names, where)
	}
	if count.size > MaxExpandedBytes {
		return "", processingCap()
	}
	text := substitute(sel, vs, placeholders(), true, scanOptions{keepMacros: true}).text
	trimmed := strings.TrimSpace(text)
	from := strings.Index(text, trimmed)
	c := Classify(text)
	if len(c.Selectors) != 1 || trimmed == "" || c.Selectors[0].From != from || c.Selectors[0].To != from+len(trimmed) ||
		!strings.HasSuffix(trimmed, "}") {
		return "", inputError("/query", "query.invalid", SelectorInvalid)
	}
	return trimmed, nil
}
