package vars

import "slices"

// tokKind is the kind of a token outside strings and comments.
type tokKind uint8

const (
	tokNone   tokKind = iota
	tokIdent          // [A-Za-z0-9_:]+
	tokOp             // a run of = ! ~ | < >
	tokString         // a whole string
	tokRef            // a reference or a macro
	tokPunct          // any other byte
)

// maxTokenText bounds the text a token keeps: the longest operator, keyword or stage name.
const maxTokenText = 16

type token struct {
	kind tokKind
	text string
}

// Tracker is the token context of a query outside strings and comments (plan #289 §3.4): the
// tokens before a string, the brace and paren depth and, in LogQL, the pipeline stage. A module
// feeds it every byte outside strings and comments and asks it the context of each string it
// opens and each reference outside strings. It reads the raw text, never a value.
type Tracker struct {
	LogQL          bool
	braces, parens int
	cur            token // the identifier or operator being read
	last, prev     token // the two tokens before it
	stage          string
	stagePending   bool // a top-level | was read: the next identifier names the stage
}

func isIdentByte(c byte) bool {
	return c == '_' || c == ':' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func isOpByte(c byte) bool {
	switch c {
	case '=', '!', '~', '|', '<', '>':
		return true
	}
	return false
}

func isSpace(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return true
	}
	return false
}

// push makes tok the last token; in LogQL a top-level | starts a stage, |=, |~ and |> are line
// filters, and the identifier after a | names the stage.
func (t *Tracker) push(tok token) {
	t.prev, t.last = t.last, tok
	if !t.LogQL || t.braces > 0 {
		return
	}
	switch {
	case tok.kind == tokOp && tok.text == "|":
		t.stage, t.stagePending = "", true
	case tok.kind == tokOp && (tok.text == "|=" || tok.text == "|~" || tok.text == "|>"):
		t.stage, t.stagePending = stageLine, false
	case tok.kind == tokIdent && t.stagePending:
		t.stage, t.stagePending = tok.text, false
	case t.stagePending:
		t.stagePending = false
	}
}

// stageLine is the stage of a line filter.
const stageLine = "|line"

// End ends the token being read (white space, a comment).
func (t *Tracker) End() {
	if t.cur.kind != tokNone {
		t.push(t.cur)
		t.cur = token{}
	}
}

// Byte reads one byte outside strings and comments.
func (t *Tracker) Byte(c byte) {
	switch {
	case isSpace(c):
		t.End()
	case isIdentByte(c) || isOpByte(c):
		k := tokIdent
		if isOpByte(c) {
			k = tokOp
		}
		if t.cur.kind != k {
			t.End()
			t.cur.kind = k
		}
		if len(t.cur.text) < maxTokenText {
			t.cur.text += string(c)
		}
	default:
		t.End()
		switch c {
		case '{':
			t.braces++
		case '}':
			t.braces = max(0, t.braces-1)
		case '(':
			t.parens++
		case ')':
			t.parens = max(0, t.parens-1)
		}
		t.push(token{kind: tokPunct, text: string(c)})
	}
}

func eqOrRe(op string) (CtxKind, bool) {
	switch op {
	case "=", "!=":
		return CtxEq, true
	case "=~", "!~":
		return CtxRe, true
	}
	return CtxNone, false
}

func ctxOf(k CtxKind) Ctx {
	switch k {
	case CtxEq:
		return Ctx{Kind: CtxEq, Where: WhereEquality}
	case CtxRe:
		return Ctx{Kind: CtxRe, Where: WhereRegex}
	case CtxTop:
		return Ctx{Kind: CtxTop, Where: WhereTopLevel}
	}
	return Ctx{Kind: CtxNone, Where: WhereTopLevel}
}

func none(where string) Ctx { return Ctx{Kind: CtxNone, Where: where} }

// keywordStage is the stage when it is a stage keyword, else "".
func (t *Tracker) keywordStage() string {
	if slices.Contains(StageKeywords, t.stage) {
		return t.stage
	}
	return ""
}

// fallback is "anything else": the stage keyword, a function argument inside parentheses, or the
// top level.
func (t *Tracker) fallback() Ctx {
	if k := t.keywordStage(); k != "" {
		return none(k)
	}
	if t.parens > 0 {
		return none(WhereFunctionArgument)
	}
	return none(WhereTopLevel)
}

// labelFilter is a LogQL label-filter comparison: kind when the stage is a label name.
func (t *Tracker) labelFilter(kind CtxKind) Ctx {
	if k := t.keywordStage(); k != "" {
		return none(k)
	}
	if t.stage == "" || t.stage == stageLine {
		return t.fallback()
	}
	return ctxOf(kind)
}

// String is the context of a string opening now (the allowlist of plan #289 §3.4); the module
// calls EndString when it closes.
func (t *Tracker) String() Ctx {
	t.End()
	last, prev := t.last, t.prev
	if t.braces > 0 {
		if k, ok := eqOrRe(last.text); ok && last.kind == tokOp {
			return ctxOf(k)
		}
		return t.fallback()
	}
	if !t.LogQL {
		return t.fallback()
	}
	switch {
	case last.kind == tokOp:
		switch last.text {
		case "|=":
			return ctxOf(CtxEq)
		case "|~":
			return ctxOf(CtxRe)
		case "|>", "!>":
			return none(WherePatternFilter)
		case "!=", "!~":
			k, _ := eqOrRe(last.text)
			if prev.kind == tokIdent {
				return t.labelFilter(k)
			}
			if kw := t.keywordStage(); kw != "" {
				return none(kw)
			}
			return ctxOf(k)
		case "=", "=~":
			k, _ := eqOrRe(last.text)
			return t.labelFilter(k)
		}
	case last.kind == tokIdent && last.text == "or":
		return none(WhereOrFilter)
	case last.kind == tokIdent && slices.Contains(StageKeywords, last.text):
		return none(last.text)
	}
	return t.fallback()
}

// EndString records the string just closed as the last token.
func (t *Tracker) EndString() { t.push(token{kind: tokString}) }

// Ref is the context of a reference outside strings and comments, recorded as the last token:
// PromQL's top level (TopToken values only); in LogQL, the stage keyword or the top level, where
// only a legacy string is written.
func (t *Tracker) Ref() Ctx {
	t.End()
	defer t.push(token{kind: tokRef})
	if !t.LogQL {
		return ctxOf(CtxTop)
	}
	if k := t.keywordStage(); k != "" {
		return none(k)
	}
	return none(WhereTopLevel)
}
