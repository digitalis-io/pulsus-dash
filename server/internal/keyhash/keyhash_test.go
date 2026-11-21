package keyhash

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/zeebo/xxh3"
)

var update = flag.Bool("update", false, "rewrite the generated keys of the corpus")

const corpusPath = "../../../wire/fixtures/keyhash/labels.json"

type entry struct {
	Labels [][2]string `json:"labels"`
	Key    string      `json:"key"`
}

func labelsOf(pairs [][2]string) []Label {
	out := make([]Label, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, Label{Name: p[0], Value: p[1]})
	}
	return out
}

func readCorpus(t *testing.T) []entry {
	t.Helper()
	b, err := os.ReadFile(corpusPath)
	if err != nil {
		t.Fatal(err)
	}
	var es []entry
	if err := json.Unmarshal(b, &es); err != nil {
		t.Fatal(err)
	}
	if len(es) != 9 {
		t.Fatalf("corpus has %d entries, want 9 (A.4)", len(es))
	}
	return es
}

// unit:keyhash-corpus (T04-004).
func TestCorpus(t *testing.T) {
	es := readCorpus(t)
	// Independent of Labels: the published XXH3-64 of the empty input, and the literal bytes.
	if got := Hex(Labels(nil)); got != "2d06800538d394c2" {
		t.Errorf("Labels({}) = %s, want 2d06800538d394c2", got)
	}
	if got, want := Hex(Labels([]Label{{"a", "1"}})), Hex(xxh3.Hash([]byte{0x61, 0xFF, 0x31, 0xFF})); got != want {
		t.Errorf("Labels(a=1) = %s, want %s (name 0xFF value 0xFF)", got, want)
	}
	if es[0].Key != "2d06800538d394c2" {
		t.Errorf("corpus entry 1 key %s, want the published empty-input value", es[0].Key)
	}
	for i := range es {
		in := labelsOf(es[i].Labels)
		before := slices.Clone(in)
		got := Hex(Labels(in))
		if !slices.Equal(in, before) {
			t.Errorf("entry %d: Labels modified its input", i+1)
		}
		if *update {
			es[i].Key = got
			continue
		}
		if got != es[i].Key {
			t.Errorf("entry %d %v: key %s, corpus %s", i+1, es[i].Labels, got, es[i].Key)
		}
	}
	if *update {
		var b bytes.Buffer
		b.WriteString("[\n")
		for i, e := range es {
			j, err := json.Marshal(e)
			if err != nil {
				t.Fatal(err)
			}
			b.WriteString("  " + string(j))
			if i < len(es)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString("]\n")
		if err := os.WriteFile(corpusPath, b.Bytes(), 0o644); err != nil { // #nosec G306 -- a repository fixture
			t.Fatal(err)
		}
		return
	}
	if es[2].Key != es[3].Key {
		t.Errorf("input order changed the key: %s vs %s", es[2].Key, es[3].Key)
	}
	if es[4].Key == es[0].Key {
		t.Error(`{a=""} has the key of {}`)
	}
	if es[5].Key == es[6].Key {
		t.Error(`{a="1\",b=\"2"} collides with {a="1",b="2"}`)
	}
}

func TestInputOrderIrrelevant(t *testing.T) {
	ls := []Label{{"z", "1"}, {"a", "2"}, {"m", "3"}, {"b", ""}}
	want := Labels(ls)
	if want == 0 {
		t.Fatal("Labels returned 0")
	}
	perm := slices.Clone(ls)
	for range 10 {
		perm = append(perm[1:], perm[0])
		if got := Labels(perm); got != want {
			t.Fatalf("order %v: %x, want %x", perm, got, want)
		}
	}
}

func TestHex(t *testing.T) {
	for _, c := range []struct {
		k    uint64
		want string
	}{{0, "0000000000000000"}, {0xabc, "0000000000000abc"}, {^uint64(0), "ffffffffffffffff"}} {
		if got := Hex(c.k); got != c.want || strings.ToLower(got) != got {
			t.Errorf("Hex(%x) = %q, want %q", c.k, got, c.want)
		}
	}
}
