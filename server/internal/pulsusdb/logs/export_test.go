package logs

// PrepareSubstitute is Prepare's substitution before row 9b and Classify, for the external
// logs_test runner of unit:logql-classify (plan #121 §2): the text it classifies, and the error.
func PrepareSubstitute(in Inputs) (string, *PlanError) {
	p, err := Prepare(in)
	if err != nil {
		return "", err
	}
	return p.Substituted(), nil
}
