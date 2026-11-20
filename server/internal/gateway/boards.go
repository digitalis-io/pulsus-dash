package gateway

import (
	"context"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// boards implements the board, starred and recent routes (stub).
type boards struct{ deps Deps }

func stubErr() api.ErrorEnvelope {
	return api.ErrorEnvelope{Error: api.ErrorBody{Code: api.Unavailable, Message: "not implemented"}}
}

func parseIfMatch(v *string) (int64, int, string) { return 0, 0, "" }

func (b *boards) ListBoards(context.Context, api.ListBoardsRequestObject) (api.ListBoardsResponseObject, error) {
	return api.ListBoards503JSONResponse(stubErr()), nil
}
func (b *boards) CreateBoard(context.Context, api.CreateBoardRequestObject) (api.CreateBoardResponseObject, error) {
	return api.CreateBoard503JSONResponse(stubErr()), nil
}
func (b *boards) GetBoard(context.Context, api.GetBoardRequestObject) (api.GetBoardResponseObject, error) {
	return api.GetBoard503JSONResponse(stubErr()), nil
}
func (b *boards) UpdateBoard(context.Context, api.UpdateBoardRequestObject) (api.UpdateBoardResponseObject, error) {
	return api.UpdateBoard503JSONResponse(stubErr()), nil
}
func (b *boards) DeleteBoard(context.Context, api.DeleteBoardRequestObject) (api.DeleteBoardResponseObject, error) {
	return api.DeleteBoard503JSONResponse(stubErr()), nil
}
func (b *boards) ListStarredBoards(context.Context, api.ListStarredBoardsRequestObject) (api.ListStarredBoardsResponseObject, error) {
	return api.ListStarredBoards503JSONResponse(stubErr()), nil
}
func (b *boards) StarBoard(context.Context, api.StarBoardRequestObject) (api.StarBoardResponseObject, error) {
	return api.StarBoard503JSONResponse(stubErr()), nil
}
func (b *boards) UnstarBoard(context.Context, api.UnstarBoardRequestObject) (api.UnstarBoardResponseObject, error) {
	return api.UnstarBoard503JSONResponse(stubErr()), nil
}
func (b *boards) ListRecentBoards(context.Context, api.ListRecentBoardsRequestObject) (api.ListRecentBoardsResponseObject, error) {
	return api.ListRecentBoards503JSONResponse(stubErr()), nil
}
func (b *boards) RecordBoardView(context.Context, api.RecordBoardViewRequestObject) (api.RecordBoardViewResponseObject, error) {
	return api.RecordBoardView503JSONResponse(stubErr()), nil
}
