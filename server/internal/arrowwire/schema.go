package arrowwire

import (
	"strconv"

	"github.com/apache/arrow-go/v18/arrow"
)

// The writer's schemas; wire/schemas/*.yaml is their language-neutral copy (unit:schema-yaml).
// No column is dictionary-encoded (T04-003).

var (
	u8, u16, u32, u64 = arrow.PrimitiveTypes.Uint8, arrow.PrimitiveTypes.Uint16, arrow.PrimitiveTypes.Uint32, arrow.PrimitiveTypes.Uint64
	f64, utf8, boolT  = arrow.PrimitiveTypes.Float64, arrow.BinaryTypes.String, arrow.FixedWidthTypes.Boolean
	tsMs              = &arrow.TimestampType{Unit: arrow.Millisecond, TimeZone: "UTC"}
	strs              = arrow.ListOfNonNullable(arrow.BinaryTypes.String)
)

func field(name string, t arrow.DataType, nullable bool) arrow.Field {
	return arrow.Field{Name: name, Type: t, Nullable: nullable}
}

// schemaMeta is the metadata every schema carries, then kv.
func schemaMeta(name string, kv ...string) arrow.Metadata {
	keys, vals := []string{"dash.schema", "dash.time_unit"}, []string{name, "ms"}
	for i := 0; i+1 < len(kv); i += 2 {
		keys, vals = append(keys, kv[i]), append(vals, kv[i+1])
	}
	return arrow.NewMetadata(keys, vals)
}

var labels1 = arrow.NewSchema([]arrow.Field{
	field("series_id", u32, false), field("key_hash", u64, false),
	field("label_key", utf8, true), field("label_value", utf8, true),
}, ptrMeta(schemaMeta("labels/1")))

var coverage1 = arrow.NewSchema([]arrow.Field{
	field("phase", u8, false), field("exactness", u8, false), field("rollup_level_s", u32, true),
	field("sampled_ratio", f64, true), field("truncated", boolT, false), field("truncation_reason", utf8, true),
	field("dropped_count", u64, true), field("series_returned", u32, false), field("rows_read", u64, true),
	field("bytes_read", u64, true), field("shards_failed", u16, true), field("shards_skipped", u16, true),
	field("retention_floor", tsMs, true), field("excluded_dims", strs, false), field("warnings", strs, false),
	field("infos", strs, false), field("upstream_query_ids", strs, false), field("read_cache", u8, true),
	field("read_cache_through", tsMs, true), field("data_end", tsMs, true), field("upstream_ms", u32, false),
	field("convert_ms", u32, false),
}, ptrMeta(schemaMeta("coverage/1")))

var error1 = arrow.NewSchema([]arrow.Field{
	field("code", u8, false), field("http_status", u16, false), field("message", utf8, false),
	field("position", u32, true), field("retry_after_ms", u32, true), field("suggestion", utf8, true),
}, ptrMeta(schemaMeta("error/1")))

func ptrMeta(m arrow.Metadata) *arrow.Metadata { return &m }

func labelsSchema() *arrow.Schema   { return labels1 }
func coverageSchema() *arrow.Schema { return coverage1 }
func errorSchema() *arrow.Schema    { return error1 }

// gridType is the values column of a grid of n points.
func gridType(n int) *arrow.FixedSizeListType {
	return arrow.FixedSizeListOfField(int32(n), arrow.Field{Name: "item", Type: f64, Nullable: true})
}

// gridSchema is the metric_matrix.grid/1 schema of s with n points; dash.unit and dash.planned
// only when set.
func gridSchema(s GridSpec, n int) *arrow.Schema {
	kv := []string{
		"dash.grid.start_ms", strconv.FormatInt(s.Grid.Start, 10),
		"dash.grid.requested_start_ms", strconv.FormatInt(s.RequestedStartMs, 10),
		"dash.grid.step_ms", strconv.FormatInt(s.Grid.Step, 10),
		"dash.grid.len", strconv.Itoa(n),
		"dash.labels_part", strconv.FormatUint(uint64(s.LabelsPart), 10),
		"dash.result", s.Result,
		"dash.source", s.Source,
	}
	if s.Unit != "" {
		kv = append(kv, "dash.unit", s.Unit)
	}
	if s.Planned != nil {
		kv = append(kv, "dash.planned", string(s.Planned))
	}
	return arrow.NewSchema([]arrow.Field{field("series_id", u32, false), field("values", gridType(n), false)},
		ptrMeta(schemaMeta("metric_matrix.grid/1", kv...)))
}
