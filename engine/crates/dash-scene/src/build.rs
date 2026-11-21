//! `build`: a viewport to a draw list and its summary (plan #68 §3.8, §4.1).

use dash_marks::desc::DrawList;
use dash_tokens::Rgba8;

use crate::Viewport;
use crate::summary::FrameSummary;

pub fn build(v: &Viewport) -> (DrawList, Option<FrameSummary>) {
    let list = DrawList {
        clear: Rgba8([0; 4]),
        css: (v.css.w, v.css.h),
        dpr: v.dpr,
        view_proj: [[0.0; 4]; 4],
        palette: [Rgba8([0; 4]); 9],
        clip: None,
        items: Vec::new(),
    };
    (list, None)
}
