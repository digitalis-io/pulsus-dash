package logs

// Source is the data source a query reads.
type Source string

// The sources.
const (
	SourcePulsusDB Source = "pulsus_db"
	SourceVirtual  Source = "virtual"
	SourceMixed    Source = "mixed"
)

// Selector is one stream selector of a text.
type Selector struct {
	From, To int
	Reserved bool
}

// Class is the classification of a text.
type Class struct {
	Source    Source
	Reserved  []string
	Selectors []Selector
}

// Classify reads the stream selectors of text. Stub.
func Classify(string) Class { return Class{} }
