package logs

// PrepareSubstitute is prepareSubstitute's text and error, for the external logs_test runner of
// unit:logql-classify (plan #121 §2): the substitution before row 9b and Classify.
func PrepareSubstitute(in Inputs) (string, *PlanError) {
	text, _, err := prepareSubstitute(in)
	return text, err
}
