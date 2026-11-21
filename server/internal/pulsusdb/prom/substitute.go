package prom

// segmentKind is how a segment maps its bytes (plan #112 §4.2).
type segmentKind int

const (
	segCopy   segmentKind = iota + 1 // byte for byte
	segInsert                        // every byte maps to rawFrom
	segAdded                         // a rewrite prefix or suffix: no position
)

// segment maps [sentFrom, sentFrom+sentLen) of a map's input side to [rawFrom, rawFrom+rawLen).
type segment struct {
	sentFrom, sentLen, rawFrom, rawLen int
	kind                               segmentKind
}
