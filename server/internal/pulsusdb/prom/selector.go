package prom

import (
	"errors"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
)

// SelectorInvalid is the message of a variable query's selector that is not a metric selector.
const SelectorInvalid = "a variable query's selector must be a metric selector"

// SubstituteSelector is the selector of a variable query on the value route (plan #289 §3.5 step
// 3): rows 1–5, 7 and 7b of Prepare with the contexts and the probe guard of T07-031, every macro
// left as written, the processing cap; then the upstream parser must read the substituted text as
// one metric selector (query.invalid). Pure; no text in an error.
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
	if parseSelector(text) != nil {
		return "", inputError("/query", "query.invalid", SelectorInvalid)
	}
	return text, nil
}

// parseSelector reads text as one metric selector with the upstream parser; a parser panic is a
// refusal.
func parseSelector(text string) (err error) {
	defer func() {
		if recover() != nil {
			err = errParse
		}
	}()
	_, err = promParser.ParseMetricSelector(text)
	return err
}

// errParse is a parser panic read as a parse error.
var errParse = errors.New("prom: the parser failed")
